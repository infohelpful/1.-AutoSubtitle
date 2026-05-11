"""
Stdin/stdout line-delimited JSON protocol.

Each line is one JSON object:
  Request:  {"id": "<uuid>", "method": "<name>", "params": { ... } }
  Response: {"id": "<uuid>", "result": <any>} | {"id": "<uuid>", "error": {"message": "..."}}

Download progress (during Hugging Face snapshot_download) is printed as JSON lines to **stderr**
so stdout stays valid for RPC:
  {"type": "download_progress", "value": <percent 0..100>}

stdout는 RPC 전용이므로 진행률은 print(..., file=sys.stderr)로 출력합니다.
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any

from processor import _subprocess_creationflags, _which_ffmpeg, export_video_png_overlay

# ---------------------------------------------------------------------------
# Paths & model configuration
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _models_root() -> Path:
    """
    Electron이 설정하는 AUTOSUBTITLE_MODELS_DIR(예: %AppData%/AutoSubtitle/models).
    없으면 개발용으로 저장소 루트의 ./models.
    """
    raw = os.environ.get("AUTOSUBTITLE_MODELS_DIR", "").strip()
    if raw:
        p = Path(raw).expanduser()
        try:
            return p.resolve()
        except OSError:
            return p
    return (PROJECT_ROOT / "models").resolve()


MODELS_ROOT = _models_root()
# Turbo CT2 모델 (faster-whisper / CTranslate2). 최신 명칭은 HF에서 확인.
HF_REPO_ID = "deepdml/faster-whisper-large-v3-turbo-ct2"
LOCAL_MODEL_DIR = MODELS_ROOT / "deepdml-faster-whisper-large-v3-turbo-ct2"

# ---------------------------------------------------------------------------
# App state
# ---------------------------------------------------------------------------

_current_video_path: str | None = None
_whisper_model: Any | None = None
_model_device: str | None = None

# prepare_model 한 번 동안만 단조 증가(게이지 역행·100% 조기 표시 방지)
_prepare_progress_max: float = -1.0


def _reset_prepare_progress() -> None:
    global _prepare_progress_max
    _prepare_progress_max = -1.0


def _emit_transcribe_progress(value: float) -> None:
    """transcribe 구간 0~100% (stderr JSON, stdout RPC와 분리)."""
    v = max(0.0, min(100.0, float(value)))
    line = json.dumps({"type": "progress", "value": round(v, 2)}, ensure_ascii=False)
    print(line, file=sys.stderr, flush=True)


def _emit_download_progress(value: float) -> None:
    """0~100% JSON을 stderr로 보냄. 값은 항상 이전보다 작아지지 않음."""
    global _prepare_progress_max
    capped = max(0.0, min(100.0, float(value)))
    v = max(_prepare_progress_max, capped)
    if _prepare_progress_max >= 0 and v <= _prepare_progress_max + 0.02 and v < 99.98:
        return
    _prepare_progress_max = v
    line = json.dumps({"type": "download_progress", "value": round(v, 2)}, ensure_ascii=False)
    print(line, file=sys.stderr, flush=True)


def _repo_download_bytes_total() -> int | None:
    """허브에 등록된 파일 크기 합(바이트). 알 수 없으면 None → tqdm 비율로 대체."""
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(HF_REPO_ID)
        total = 0
        for s in info.siblings or []:
            sz = getattr(s, "size", None)
            if sz is not None:
                total += int(sz)
        return total if total > 0 else None
    except Exception:
        return None


def _is_ct2_model_dir(path: Path) -> bool:
    """CTranslate2 faster-whisper 레포에 보통 포함되는 model.bin 존재 여부로 판단."""
    return path.is_dir() and (path / "model.bin").is_file()


def _ensure_model_downloaded() -> bool:
    """
    MODELS_ROOT/<local_name> 에 CT2 모델이 없으면 huggingface_hub 로 내려받는다.
    Returns True if a download run was started (even if repo was already complete).
    """
    MODELS_ROOT.mkdir(parents=True, exist_ok=True)
    if _is_ct2_model_dir(LOCAL_MODEL_DIR):
        # 다운로드 생략 — 100%는 Whisper 로드 끝난 뒤에만 올림
        return False

    _emit_download_progress(0.0)

    try:
        from huggingface_hub import snapshot_download
        from tqdm.auto import tqdm as std_tqdm
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("huggingface_hub and tqdm are required for download") from e

    grand_total = _repo_download_bytes_total()
    # 다운로드 구간만 0~90% (나머지 90~100%는 GPU/CPU 로드 구간)
    download_cap = 90.0

    def make_json_tqdm(grand: int | None) -> type:
        class JsonProgressTqdm(std_tqdm):
            def __init__(self, *args: Any, **kwargs: Any):
                kwargs.setdefault("mininterval", 0.12)
                super().__init__(*args, **kwargs)
                self._last_emitted: float = -1.0

            def update(self, n: int | float = 1) -> bool | None:
                r = super().update(n)
                if grand and grand > 0:
                    pct = download_cap * min(float(self.n), float(grand)) / float(grand)
                else:
                    t = float(self.total) if self.total else 0.0
                    if t <= 0:
                        return r
                    # HF가 total을 늘리며 갱신하므로 n/total은 종종 역행처럼 보임 → 단조 보정은 _emit 쪽에서 처리
                    pct = download_cap * min(float(self.n), t) / t
                if pct - self._last_emitted >= 0.4 or pct <= 0.2 or pct >= download_cap - 0.01:
                    self._last_emitted = pct
                    _emit_download_progress(pct)
                return r

            def close(self) -> None:
                # tqdm 종료 시 100%를 찍지 않음(아직 Whisper 로드 전)
                super().close()

        return JsonProgressTqdm

    JsonProgressTqdm = make_json_tqdm(grand_total)

    snapshot_download(
        repo_id=HF_REPO_ID,
        local_dir=str(LOCAL_MODEL_DIR),
        local_dir_use_symlinks=False,
        tqdm_class=JsonProgressTqdm,
    )

    if not _is_ct2_model_dir(LOCAL_MODEL_DIR):
        raise RuntimeError("Download finished but model.bin not found in models directory")

    _emit_download_progress(90.0)
    return True


def _load_whisper_model() -> dict[str, Any]:
    """device=cuda 우선, 실패 시 cpu."""
    global _whisper_model, _model_device

    if _whisper_model is not None:
        _emit_download_progress(100.0)
        return {"reused": True, "device": _model_device, "path": str(LOCAL_MODEL_DIR.resolve())}

    if not _is_ct2_model_dir(LOCAL_MODEL_DIR):
        raise RuntimeError("Model files missing; call prepare_model or download first")

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("faster-whisper is required to load the model") from e

    path = str(LOCAL_MODEL_DIR.resolve())
    _emit_download_progress(92.0)

    nvidia_ok = _has_nvidia_gpu()
    if nvidia_ok:
        try:
            _whisper_model = WhisperModel(path, device="cuda", compute_type="float16")
            _model_device = "cuda"
            _emit_download_progress(100.0)
            return {
                "reused": False,
                "device": "cuda",
                "compute_type": "float16",
                "path": path,
            }
        except Exception as e_cuda:
            _whisper_model = None
            _model_device = None
            try:
                _whisper_model = WhisperModel(path, device="cpu", compute_type="int8")
                _model_device = "cpu"
                _emit_download_progress(100.0)
                return {
                    "reused": False,
                    "device": "cpu",
                    "compute_type": "int8",
                    "path": path,
                    "cuda_error": str(e_cuda),
                }
            except Exception as e_cpu:
                _whisper_model = None
                _model_device = None
                raise RuntimeError(f"cuda load failed ({e_cuda!r}); cpu load failed ({e_cpu!r})") from e_cpu
    try:
        _whisper_model = WhisperModel(path, device="cpu", compute_type="int8")
        _model_device = "cpu"
        _emit_download_progress(100.0)
        return {
            "reused": False,
            "device": "cpu",
            "compute_type": "int8",
            "path": path,
            "reason": "nvidia gpu not detected",
        }
    except Exception as e_cpu:
        _whisper_model = None
        _model_device = None
        raise RuntimeError(f"cpu load failed ({e_cpu!r})") from e_cpu


def _has_nvidia_gpu() -> bool:
    """NVIDIA GPU 장착 여부를 가볍게 판별 (없으면 CPU 모드로 준비)."""
    try:
        r = subprocess.run(
            ["nvidia-smi", "-L"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if r.returncode != 0:
            return False
        out = f"{r.stdout}\n{r.stderr}".lower()
        return "gpu " in out or "nvidia" in out
    except Exception:
        return False


def _force_reload_model_cpu() -> dict[str, Any]:
    """GPU 런타임 누락 시 CPU 모델로 강제 재로딩."""
    global _whisper_model, _model_device
    from faster_whisper import WhisperModel

    path = str(LOCAL_MODEL_DIR.resolve())
    _whisper_model = WhisperModel(path, device="cpu", compute_type="int8")
    _model_device = "cpu"
    return {"reloaded": True, "device": "cpu", "compute_type": "int8", "path": path}


def _is_cuda_runtime_missing_error(err: Exception) -> bool:
    msg = str(err).lower()
    return ("cublas64_12.dll" in msg) or ("cudnn" in msg) or ("cuda" in msg and "cannot be loaded" in msg)


def _normalize_input_path(raw: str) -> str:
    """드롭/IPC로 넘어온 Windows 경로를 최대한 파일시스템 친화적으로 정규화."""
    p = unicodedata.normalize("NFC", raw).strip().strip('"').strip("'")
    p = p.replace("¥", "\\").replace("₩", "\\")
    # 보이지 않는 제어문자/방향문자 제거 (드래그 소스에 섞이는 경우 방지)
    p = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufeff]", "", p)
    # /D:/... 혹은 \D:\... -> D:\...
    p = re.sub(r"^[\\/]+([A-Za-z]:[\\/])", r"\1", p)
    # D\foo -> D:\foo
    p = re.sub(r"^([A-Za-z])[\\/](?![\\/])", r"\1:\\", p)
    return os.path.normpath(p)


def _resolve_existing_file(p: str) -> str | None:
    """한글/공백/긴 경로: Windows에서는 extended path(\\\\?\\)로만 열리는 경우를 보조한다."""
    if os.path.isfile(p):
        return p
    if os.name == "nt":
        ap = os.path.abspath(p)
        if not ap.startswith("\\\\?\\") and not ap.startswith("\\\\"):
            long_p = "\\\\?\\" + ap
            if os.path.isfile(long_p):
                return long_p
    return None


# --- Peaks.js용 사전 피크 JSON (BBC audiowaveform CLI + FFmpeg 파이프) -----------------

# 80 → samples_per_pixel≈600 @48kHz — Peaks가 더 ‘줌 아웃’할 수 없어 짧은 자막 줄이 화면 왼쪽에만 몰림.
# 800 전후면 spp≈60 수준이라 수 초 단위 줄이 뷰 너비를 채울 수 있음(파일 용량은 커짐).
_PEAKS_PIXELS_PER_SECOND = 800
_PEAKS_BITS = 8
# 캐시된 JSON이 이보다 거친 해상도면 자동 재생성(구버전 80pps 파일 무효화)
_PEAKS_MAX_SAMPLES_PER_PIXEL_STALE = 128

# audiowaveform 입력: MP3/WAV/… — 컨테이너 영상은 FFmpeg로 WAV 스트림만 추출
_DIRECT_AUDIO_EXTS = frozenset({".mp3", ".wav", ".flac", ".ogg", ".oga", ".opus"})


def _should_regenerate_peaks(media: Path, peaks_json: Path) -> bool:
    if not peaks_json.is_file():
        return True
    try:
        if media.stat().st_mtime > peaks_json.stat().st_mtime:
            return True
    except OSError:
        return True
    try:
        with open(peaks_json, encoding="utf-8") as f:
            d = json.load(f)
        spp = int(d.get("samples_per_pixel") or 0)
        if spp <= 0 or spp > _PEAKS_MAX_SAMPLES_PER_PIXEL_STALE:
            return True
    except (OSError, ValueError, TypeError):
        return True
    return False


def _resolve_audiowaveform_exe() -> Path | None:
    env = os.environ.get("AUTOSUBTITLE_AUDIOWAVEFORM_PATH", "").strip()
    if env:
        ep = Path(env)
        if ep.is_file():
            return ep
    name = "audiowaveform.exe" if sys.platform == "win32" else "audiowaveform"
    here = PROJECT_ROOT / "resources" / "bin" / name
    if here.is_file():
        return here
    return None


def _media_uses_ffmpeg_to_wav(path: Path) -> bool:
    return path.suffix.lower() not in _DIRECT_AUDIO_EXTS


def _run_audiowaveform_to_json(
    media_resolved: str,
    out_json: Path,
    ffmpeg_exe: str,
    aw_exe: Path,
) -> dict[str, Any]:
    """
    Peaks.js / waveform-data 호환 JSON 생성.
    영상·mkv 등: ffmpeg -f wav - | audiowaveform -i - --input-format wav …
    """
    media = Path(media_resolved)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_json.with_suffix(out_json.suffix + ".part")
    try:
        if tmp.is_file():
            tmp.unlink()
    except OSError:
        pass
    cflags = _subprocess_creationflags()
    if _media_uses_ffmpeg_to_wav(media):
        ff = subprocess.Popen(
            [
                ffmpeg_exe,
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(media),
                "-f",
                "wav",
                "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=cflags,
        )
        try:
            r = subprocess.run(
                [
                    str(aw_exe),
                    "-i",
                    "-",
                    "--input-format",
                    "wav",
                    "-o",
                    str(tmp),
                    "--output-format",
                    "json",
                    "-b",
                    str(_PEAKS_BITS),
                    "--pixels-per-second",
                    str(_PEAKS_PIXELS_PER_SECOND),
                ],
                stdin=ff.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=3 * 60 * 60,
                creationflags=cflags,
            )
        finally:
            if ff.stdout:
                ff.stdout.close()
            ff.wait(timeout=120)
        if r.returncode != 0:
            err = (r.stderr or b"").decode("utf-8", errors="replace")
            return {"ok": False, "path": None, "reason": err.strip() or f"audiowaveform exit {r.returncode}"}
    else:
        r = subprocess.run(
            [
                str(aw_exe),
                "-i",
                str(media),
                "-o",
                str(tmp),
                "--output-format",
                "json",
                "-b",
                str(_PEAKS_BITS),
                "--pixels-per-second",
                str(_PEAKS_PIXELS_PER_SECOND),
            ],
            capture_output=True,
            timeout=3 * 60 * 60,
            creationflags=cflags,
        )
        if r.returncode != 0:
            err = (r.stderr or b"").decode("utf-8", errors="replace")
            return {"ok": False, "path": None, "reason": err.strip() or f"audiowaveform exit {r.returncode}"}

    try:
        tmp.replace(out_json)
    except OSError as e:
        return {"ok": False, "path": None, "reason": str(e)}
    return {"ok": True, "path": str(out_json.resolve()), "reason": None}


def _waveform_peaks_impl(
    audio_path: str,
    *,
    ffmpeg_exe: str | None,
    out_path: Path,
) -> dict[str, Any]:
    resolved = _resolve_existing_file(_normalize_input_path(audio_path))
    if resolved is None:
        raise ValueError(f"not a file or missing: {audio_path}")
    aw = _resolve_audiowaveform_exe()
    if aw is None:
        return {
            "ok": False,
            "path": None,
            "reason": "audiowaveform binary not found (set AUTOSUBTITLE_AUDIOWAVEFORM_PATH or place under resources/bin)",
        }
    dest = out_path
    if not _should_regenerate_peaks(Path(resolved), dest):
        return {"ok": True, "path": str(dest.resolve()), "reason": None, "cached": True}
    try:
        ff = ffmpeg_exe if (ffmpeg_exe and os.path.isfile(ffmpeg_exe)) else _which_ffmpeg(None)
    except FileNotFoundError as e:
        return {"ok": False, "path": None, "reason": str(e)}
    return _run_audiowaveform_to_json(resolved, dest, ff, aw)


def _ensure_stderr_utf8() -> None:
    """진행률 JSON(stderr)만 UTF-8 텍스트 모드로 맞춘다."""
    try:
        if getattr(sys.stderr, "buffer", None) is None:
            return
        sys.stderr = io.TextIOWrapper(
            sys.stderr.buffer,
            encoding="utf-8",
            errors="replace",
            newline="\n",
            line_buffering=True,
        )
    except Exception:
        pass


def _rpc_write(obj: dict[str, Any]) -> None:
    """stdout은 항상 UTF-8 바이트로 쓴다(Electron 파이프와 동일). cp949 텍스트 레이어를 거치지 않음."""
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(line.encode("utf-8"))
    sys.stdout.buffer.flush()


# 무음 삽입 vs 미세 간격(stitch): 이 임계값 이상이면 "-- " 블록 삽입, 미만이면 이전 cue의 end를 다음 start에 맞춤
_GAP_THRESHOLD_SEC = 0.1
# STT 직후 무음 구간 자동 삽입 시 단일 플레이스홀더 — 렌더러 `SILENCE_PLACEHOLDER_TEXT` 와 동일
_SILENCE_GAP_TEXT = "-- "
_UNKNOWN_WORD_LABEL = "???"


def _silence_gap_cue(start: float, end: float) -> dict[str, Any]:
    """이전 세그먼트 end ~ 현재 세그먼트 start 사이 무음(편집용 플레이스홀더)."""
    s = float(start)
    e = float(end)
    if not (e > s):
        s, e = min(s, e), max(s, e)
        if not (e > s):
            s, e = 0.0, max(0.01, e)
    token = _SILENCE_GAP_TEXT.strip() or "--"
    return {
        "start": s,
        "end": e,
        "text": _SILENCE_GAP_TEXT,
        "words": [{"start": s, "end": e, "word": token}],
    }


def _extend_last_cue_end(out: list[dict[str, Any]], new_end: float) -> None:
    """미세 간격(< GAP_THRESHOLD): 직전 cue의 종료를 new_end까지 연장(마지막 word.end 동기화)."""
    if not out:
        return
    ne = float(new_end)
    last = out[-1]
    last["end"] = ne
    words = last.get("words")
    if isinstance(words, list) and len(words) > 0:
        lw = words[-1]
        if isinstance(lw, dict):
            try:
                lw["end"] = ne
            except (TypeError, ValueError):
                pass


def _normalize_cue_words_and_empty_text(c: dict[str, Any]) -> dict[str, Any] | None:
    try:
        s = float(c.get("start", 0))
        e = float(c.get("end", 0))
    except (TypeError, ValueError):
        return None
    if not (e > s):
        return None
    text = str(c.get("text") or "").strip()
    words_out: list[dict[str, Any]] = []
    raw_words = c.get("words")
    if isinstance(raw_words, list):
        for w in raw_words:
            if not isinstance(w, dict):
                continue
            try:
                ws = float(w.get("start", s))
                we = float(w.get("end", e))
            except (TypeError, ValueError):
                continue
            ww = str(w.get("word", "")).strip()
            if not ww:
                continue
            words_out.append({"start": ws, "end": we, "word": ww})
    if not text and not words_out:
        text = _UNKNOWN_WORD_LABEL
        words_out = [{"start": s, "end": e, "word": _UNKNOWN_WORD_LABEL}]
    return {"start": s, "end": e, "text": text, "words": words_out}


def _fill_unvoiced_gaps(raw_cues: list[dict[str, Any]], total_dur: float) -> list[dict[str, Any]]:
    """
    STT 직후: prev_end(초기 0) ~ 각 세그먼트 start 사이를 점검.
    - 간격 >= 0.1s → `--` 무음 블록 1행 삽입
    - 간격 0.1s 미만 → 무음 대신 *이전* cue의 end를 현재 start에 맞춤(끊김 제거)
    - total_dur > 0이면 마지막 세그먼트 end ~ 영상 끝도 동일 규칙으로 맞춤(빈틈 없이)
    """
    td = max(0.0, float(total_dur or 0))
    normalized: list[dict[str, Any]] = []
    for c in raw_cues:
        n = _normalize_cue_words_and_empty_text(c)
        if n is not None:
            normalized.append(n)
    normalized.sort(key=lambda x: float(x["start"]))

    if not normalized:
        if td > 0:
            return [_silence_gap_cue(0.0, td)]
        return []

    out: list[dict[str, Any]] = []
    prev_end = 0.0

    for c in normalized:
        s = float(c["start"])
        e = float(c["end"])
        if td > 0:
            if s >= td:
                continue
            e = min(e, td)
        if not (e > s):
            continue
        s = max(0.0, s)

        # 이미 배치된 타임라인과 겹치면 시작만 당김
        if s < prev_end:
            s = prev_end
        if e <= s:
            continue

        gap = s - prev_end
        if gap > 1e-9:
            if gap >= _GAP_THRESHOLD_SEC:
                out.append(_silence_gap_cue(prev_end, s))
            elif out:
                _extend_last_cue_end(out, s)

        out.append(
            {
                "start": s,
                "end": e,
                "text": c["text"],
                "words": c["words"],
            }
        )
        prev_end = e

    if td > 0:
        gap_tail = td - prev_end
        if gap_tail >= _GAP_THRESHOLD_SEC:
            out.append(_silence_gap_cue(prev_end, td))
        elif gap_tail > 1e-9 and out:
            _extend_last_cue_end(out, td)

    return out


def handle(method: str, params: dict[str, Any]) -> Any:
    global _current_video_path

    if method == "ping":
        return {"pong": True, "echo": params.get("message", "")}
    if method == "add":
        a = float(params.get("a", 0))
        b = float(params.get("b", 0))
        return {"sum": a + b}
    if method == "set_video_path":
        path = params.get("path")
        if not path or not isinstance(path, str):
            raise ValueError("path must be a non-empty string")
        norm_path = _normalize_input_path(path)
        resolved = _resolve_existing_file(norm_path)
        if resolved is None:
            raise ValueError(f"not a file or missing: {norm_path}")
        _current_video_path = resolved
        return {"ok": True, "path": resolved}
    if method == "get_video_path":
        return {"path": _current_video_path}
    if method == "prepare_model":
        _reset_prepare_progress()
        downloaded = _ensure_model_downloaded()
        load_info = _load_whisper_model()
        return {
            "ok": True,
            "repo_id": HF_REPO_ID,
            "model_dir": str(LOCAL_MODEL_DIR.resolve()),
            "downloaded": downloaded,
            "load": load_info,
        }
    if method == "get_model_status":
        return {
            "repo_id": HF_REPO_ID,
            "model_dir": str(LOCAL_MODEL_DIR.resolve()),
            "model_present": _is_ct2_model_dir(LOCAL_MODEL_DIR),
            "loaded": _whisper_model is not None,
            "device": _model_device,
        }
    if method == "transcribe":
        if _whisper_model is None:
            raise RuntimeError("model not loaded; call prepare_model first")
        raw_path = params.get("path")
        if isinstance(raw_path, str) and raw_path.strip():
            audio_path = _normalize_input_path(raw_path)
            resolved = _resolve_existing_file(audio_path)
            if resolved is None:
                raise ValueError(f"not a file or missing: {audio_path}")
            audio_path = resolved
            _current_video_path = audio_path
        elif _current_video_path:
            audio_path = _current_video_path
        else:
            raise ValueError("no video path; pass path in params or call set_video_path first")

        beam_size = int(params.get("beam_size", 5))
        raw_lang = params.get("language")
        language = raw_lang if isinstance(raw_lang, str) and raw_lang.strip() else None
        vad_filter = bool(params.get("vad_filter", True))
        device_before = _model_device
        did_fallback_to_cpu = False
        t0 = time.perf_counter()

        _emit_transcribe_progress(0.0)
        try:
            segments, info = _whisper_model.transcribe(
                audio_path,
                beam_size=beam_size,
                language=language,
                vad_filter=vad_filter,
                word_timestamps=True,
            )
        except Exception as e:
            if _is_cuda_runtime_missing_error(e) and _model_device == "cuda":
                _force_reload_model_cpu()
                did_fallback_to_cpu = True
                segments, info = _whisper_model.transcribe(
                    audio_path,
                    beam_size=beam_size,
                    language=language,
                    vad_filter=vad_filter,
                    word_timestamps=True,
                )
            else:
                raise
        total_dur = float(getattr(info, "duration", 0) or 0)
        subtitles: list[dict[str, Any]] = []
        for i, seg in enumerate(segments):
            subtitles.append(
                {
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": (getattr(seg, "text", None) or "").strip(),
                    "words": [
                        {
                            "start": float(getattr(w, "start", seg.start)),
                            "end": float(getattr(w, "end", seg.end)),
                            "word": str(getattr(w, "word", "")).strip(),
                        }
                        for w in (getattr(seg, "words", None) or [])
                    ],
                }
            )
            if total_dur > 0:
                pct = 100.0 * min(float(seg.end), total_dur) / total_dur
            else:
                pct = min(99.0, float(i + 1) * 3.0)
            _emit_transcribe_progress(pct)
        subtitles = _fill_unvoiced_gaps(subtitles, total_dur)
        _emit_transcribe_progress(100.0)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        waveform_peaks: dict[str, Any]
        try:
            env_ff = os.environ.get("AUTOSUBTITLE_FFMPEG_PATH", "").strip()
            wf_out = params.get("waveform_out_json_path")
            if not (isinstance(wf_out, str) and wf_out.strip()):
                waveform_peaks = {
                    "ok": False,
                    "path": None,
                    "reason": "waveform_out_json_path missing (main process must pass userData cache path)",
                }
            else:
                dest_peaks = Path(_normalize_input_path(str(wf_out).strip()))
                waveform_peaks = _waveform_peaks_impl(
                    audio_path,
                    ffmpeg_exe=env_ff if env_ff else None,
                    out_path=dest_peaks,
                )
        except Exception as e:  # noqa: BLE001
            waveform_peaks = {"ok": False, "path": None, "reason": str(e)}
        return {
            "subtitles": subtitles,
            "language": getattr(info, "language", None),
            "duration": getattr(info, "duration", None),
            "device": _model_device,
            "device_before": device_before,
            "fallback_to_cpu": did_fallback_to_cpu,
            "transcribe_ms": elapsed_ms,
            "waveform_peaks": waveform_peaks,
        }
    if method == "waveform_peaks":
        raw_path = params.get("path")
        if isinstance(raw_path, str) and raw_path.strip():
            ap = _normalize_input_path(raw_path)
        elif _current_video_path:
            ap = _current_video_path
        else:
            raise ValueError("no media path; pass path in params or call set_video_path first")
        ff_raw = params.get("ffmpeg_path")
        ffmpeg_param: str | None = (
            str(ff_raw).strip() if isinstance(ff_raw, str) and str(ff_raw).strip() else None
        )
        env_ff = os.environ.get("AUTOSUBTITLE_FFMPEG_PATH", "").strip()
        out_raw = params.get("out_json_path")
        if not (isinstance(out_raw, str) and str(out_raw).strip()):
            return {
                "ok": False,
                "path": None,
                "reason": "out_json_path is required (Electron main passes userData/WaveformCache path)",
            }
        dest = Path(_normalize_input_path(str(out_raw).strip()))
        return _waveform_peaks_impl(ap, ffmpeg_exe=ffmpeg_param or (env_ff if env_ff else None), out_path=dest)
    if method == "export_video_png_overlay":
        return export_video_png_overlay(params)
    raise ValueError(f"unknown method: {method}")


def main() -> None:
    _ensure_stderr_utf8()
    bio = getattr(sys.stdin, "buffer", None)
    if bio is None:
        raise RuntimeError("stdin buffer unavailable (required for UTF-8 JSON-RPC)")
    while True:
        raw = bio.readline()
        if not raw:
            break
        try:
            line = raw.decode("utf-8").strip()
        except UnicodeDecodeError as e:
            _rpc_write({"id": "unknown", "error": {"message": f"stdin UTF-8 decode error: {e}"}})
            continue
        if not line:
            continue
        try:
            req = json.loads(line)
            rid = req["id"]
            method = req["method"]
            params = req.get("params") or {}
            if not isinstance(params, dict):
                raise TypeError("params must be an object")
            result = handle(str(method), params)
            _rpc_write({"id": rid, "result": result})
        except Exception as e:  # noqa: BLE001 — sidecar must not crash on bad input
            rid = "unknown"
            try:
                rid = json.loads(line).get("id", "unknown")
            except Exception:
                pass
            err = {"message": str(e)}
            _rpc_write({"id": rid, "error": err})


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
    except SystemExit as e:
        raise e
    except BaseException:
        import traceback

        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        sys.exit(1)
