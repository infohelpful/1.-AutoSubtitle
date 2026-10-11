"""Experimental Korean forced alignment adapter; isolated from the production ASR runtime."""
from __future__ import annotations

import copy
import contextlib
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

from alignment_contract import alignment_summary, apply_character_alignment
from alignment_text import build_alignment_text
from alignment_windows import plan_alignment_windows, merge_window_alignments

KOREAN_MODEL = "kresnik/wav2vec2-large-xlsr-korean"


def _unaligned_cue(cue: dict, index: int, reason: str) -> dict:
    """Keep the raw ASR times and mark every word as not aligned (never claim precision)."""
    result = copy.deepcopy(cue)
    segment_id = str(cue.get("id") or f"segment:{index}")
    words = []
    for word_index, word in enumerate(result.get("words") or []):
        word.setdefault("id", f"{segment_id}:word:{word_index}")
        word.pop('charSpans', None)
        word.pop('textSpanMap', None)
        word.update(segmentId=segment_id, rawStart=word.get("rawStart", word.get("start")),
                    rawEnd=word.get("rawEnd", word.get("end")), sourceStart=None, sourceEnd=None,
                    alignmentScore=None, alignmentStatus="unaligned",
                    reviewReasons=sorted(set(word.get("reviewReasons") or []) | {reason}))
        words.append(word)
    result["words"] = words
    return result


def align_korean(cues: list[dict], media_path: str, ffmpeg_path: str, cache_dir: str,
                 revision: str, device: str = "cpu", source_origin_sec: float = 0,
                 strict: bool = True) -> dict:
    """Use a pinned HF commit, absolute source times and no VAD concatenation.

    Long segments use ASR-anchored cores and context-only overlap. Words are emitted
    exactly once; disagreement at a seam remains unaligned, with original times.
    """
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Alignment model revision must be a full 40-character commit SHA")
    if device not in ("cpu", "cuda"):
        raise ValueError("Unsupported alignment device")
    import numpy as np
    from huggingface_hub import snapshot_download
    # Third-party libraries may print while loading. stdout remains RPC-safe.
    with contextlib.redirect_stdout(sys.stderr):
        import whisperx
        model_path = snapshot_download(KOREAN_MODEL, revision=revision, cache_dir=cache_dir,
                                       allow_patterns=["*.json", "*.bin", "*.safetensors"])
        model, metadata = whisperx.load_align_model("ko", device, model_name=model_path)
        decoded = subprocess.run([
            ffmpeg_path, "-v", "error", "-copyts", "-i", media_path, "-vn", "-map", "0:a:0",
            "-af", f"asetpts=PTS-({float(source_origin_sec)})/TB,aresample=async=1:first_pts=0",
            "-ac", "1", "-ar", "16000", "-f", "f32le", "-"
        ], capture_output=True, check=True, timeout=300,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
        audio = np.frombuffer(decoded.stdout, dtype=np.float32).copy()
        duration = len(audio) / 16000
        output = []
        for index, cue in enumerate(cues):
            identified = copy.deepcopy(cue)
            segment_id = str(cue.get('id') or f'segment:{index}')
            words = identified.get("words") or []
            for wi, word in enumerate(words):
                word.setdefault('id', f'{segment_id}:word:{wi}')
            try:
                windows = plan_alignment_windows(identified, duration)
            except ValueError:
                if strict:
                    raise
                output.append(_unaligned_cue(cue, index, "segment_bounds_unsupported"))
                continue
            if not words:
                if strict:
                    raise ValueError(f"Segment {index} needs raw ASR words to preserve identity")
                output.append(copy.deepcopy(cue))
                continue
            results = []
            for window in windows:
                window_words = words[window.first:window.last]
                alignment_inputs = [build_alignment_text(str(w['word']).strip(), w.get('readingOverride')) for w in window_words]
                text = ' '.join(item['text'] for item in alignment_inputs)
                try:
                    aligned = whisperx.align([{"start": window.start, "end": window.end, "text": text}],
                                         model, metadata, audio, device, return_char_alignments=True,
                                         print_progress=False)
                    chars = [char for segment in aligned["segments"] for char in (segment.get("chars") or [])]
                    results.append(apply_character_alignment(window_words, chars, metadata["dictionary"], duration,
                                                             segment_id, revision, alignment_inputs))
                except Exception as error:  # noqa: BLE001 - one bad window must not discard the rest
                    if strict:
                        raise
                    print(f"alignment failed for segment {index} window {window}: {error!r}", file=sys.stderr, flush=True)
                    results.append(_unaligned_cue({'words': window_words}, index, "alignment_exception")['words'])
            next_cue = copy.deepcopy(cue)
            next_cue["words"] = merge_window_alignments(words, windows, results)
            output.append(next_cue)
        return {"schemaVersion": 1, "subtitles": output, "raw_subtitles": copy.deepcopy(cues),
                "alignmentSummary": alignment_summary([w for c in output for w in c["words"]]),
                "engine": "whisperx", "modelId": KOREAN_MODEL, "modelRevision": revision, "device": device}
