"""Run forced alignment in a separate interpreter and return a validated result.

The ASR runtime must not import torch/whisperx (CUDA/CTranslate2 conflicts, packaging size), so the
worker is a subprocess. Any failure raises ``AlignmentUnavailable`` and the caller falls back.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

# Pinned in docs/autosubtitle-desktop-sync-progress.md; must be a full commit SHA.
KOREAN_MODEL_REVISION = "629c9a3501c10ba128bf3fa1eebb12af3be03f61"
WORKER = Path(__file__).with_name("align_worker.py")
MAX_REPLY_BYTES = 64 * 1024 * 1024


class AlignmentUnavailable(RuntimeError):
    """Raised with a short machine-readable reason (``alignment_runtime_missing``, ...)."""


def resolve_alignment_python(explicit: str | None = None) -> str:
    candidate = (explicit or os.environ.get("AUTOSUBTITLE_ALIGN_PYTHON", "")).strip()
    if not candidate or not os.path.isfile(candidate):
        raise AlignmentUnavailable("alignment_runtime_missing")
    return candidate


def run_accurate_alignment(cues: list[dict[str, Any]], media_path: str, ffmpeg_path: str, *,
                           cache_dir: str, python: str | None = None, device: str = "cpu",
                           source_origin_sec: float = 0.0, timeout_sec: float = 1800.0,
                           revision: str = KOREAN_MODEL_REVISION,
                           worker: Path | None = None) -> dict[str, Any]:
    interpreter = resolve_alignment_python(python)
    if not ffmpeg_path:
        raise AlignmentUnavailable("ffmpeg_missing")
    request = json.dumps({"cues": cues, "media": media_path, "ffmpeg": ffmpeg_path, "cacheDir": cache_dir,
                          "revision": revision, "device": device, "sourceOrigin": source_origin_sec},
                         ensure_ascii=True, allow_nan=False)
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
           "PYTHONPATH": str(WORKER.parent) + os.pathsep + os.environ.get("PYTHONPATH", "")}
    try:
        proc = subprocess.run(
            [interpreter, "-B", str(worker or WORKER)], input=request.encode("utf-8"), capture_output=True,
            timeout=timeout_sec, env=env,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
    except subprocess.TimeoutExpired as error:
        raise AlignmentUnavailable("alignment_timeout") from error
    except OSError as error:
        raise AlignmentUnavailable(f"alignment_spawn_failed: {error}") from error
    if len(proc.stdout) > MAX_REPLY_BYTES:
        raise AlignmentUnavailable("alignment_reply_too_large")
    try:
        reply = json.loads(proc.stdout.decode("utf-8"))
    except ValueError as error:
        tail = proc.stderr.decode("utf-8", "replace")[-300:]
        raise AlignmentUnavailable(f"alignment_bad_reply (exit {proc.returncode}): {tail}") from error
    if proc.returncode != 0 or not isinstance(reply, dict) or "error" in reply:
        message = reply.get("error") if isinstance(reply, dict) else "unknown"
        raise AlignmentUnavailable(f"alignment_failed: {message}")
    subtitles = reply.get("subtitles")
    if not isinstance(subtitles, list) or len(subtitles) != len(cues):
        raise AlignmentUnavailable("alignment_cue_count_mismatch")
    for original, aligned in zip(cues, subtitles):
        if len(original.get("words") or []) != len((aligned or {}).get("words") or []):
            raise AlignmentUnavailable("alignment_word_count_mismatch")
    return reply
