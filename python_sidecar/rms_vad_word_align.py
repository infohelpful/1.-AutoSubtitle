"""
Whisper 단어 타임스탬프를 PCM RMS 기반 VAD로 정제한다.

1) 16kHz 모노 float32 디코드 → hop(10ms)·window(15ms) RMS → dB = 20*log10(RMS+ε)
2) 하위 10% 평균 dB + offset → 동적 임계, 이진 마스크 후 min 무음/말 길이 디바운스
3) 각 단어 [start,end]를 ±150ms 안에서 마스크 0→1 / 1→0 경계에 스냅, 시작은 pre-roll
4) 인접 단어 사이 간격 ≥300ms 이고 구간이 전부 무음이면 `--` 단어 삽입 (isSilence=True)
"""

from __future__ import annotations

import math
import subprocess
from typing import Any

import numpy as np

from processor import _subprocess_creationflags, _which_ffmpeg

# --- 1단계: 프레임 ---
SR = 16_000
HOP_MS = 10.0
WIN_MS = 15.0
RMS_EPS = 1e-6

# --- 2단계: 동적 임계 + 디바운스 ---
BOTTOM_FRAC = 0.10
DYNAMIC_OFFSET_DB = 8.0  # 하위 10% 평균 + 8dB (5~10 중앙)
THRESH_DB_MIN = -55.0
THRESH_DB_MAX = -22.0
DEBOUNCE_MIN_SILENCE_SEC = 0.30
DEBOUNCE_MIN_SPEECH_SEC = 0.10
DEBOUNCE_PASSES = 2

# --- 3단계: 스냅 ---
SNAP_SEARCH_SEC = 0.15
PREPAD_SEC = 0.04  # 자음 앞 40ms
# 끝 경계를 단어 앞쪽에서 너무 일찍 잡으면(내부 dip·RMS 노이즈) 단어가 수십 ms로 붕괴하고 다음 토큰이 말을 삼킴
END_SNAP_MIN_AFTER_START_SEC = 0.055
END_SNAP_FRAC_OF_WHISPER_DUR = 0.22
# 스냅 후에도 이보다 짧으면 Whisper 원구간 쪽으로 복원
MIN_SNAPPED_WORD_SEC = 0.06
MIN_SNAPPED_TO_WHISPER_RATIO = 0.36

# --- 4단계: 무음 칩 ---
GAP_INSERT_SILENCE_SEC = 0.30


def _decode_mono_f32_16k(media_path: str, ffmpeg_exe: str) -> np.ndarray:
    """ffmpeg → raw f32le mono 16kHz, shape (n_samples,)"""
    cflags = _subprocess_creationflags()
    r = subprocess.run(
        [
            ffmpeg_exe,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            media_path,
            "-ac",
            "1",
            "-ar",
            str(SR),
            "-f",
            "f32le",
            "-",
        ],
        capture_output=True,
        timeout=3 * 60 * 60,
        creationflags=cflags,
    )
    if r.returncode != 0:
        err = (r.stderr or b"").decode("utf-8", errors="replace")
        raise RuntimeError(err.strip() or f"ffmpeg decode exit {r.returncode}")
    raw = r.stdout or b""
    if len(raw) < 4:
        raise RuntimeError("ffmpeg produced empty audio")
    n = len(raw) // 4
    return np.frombuffer(raw[: n * 4], dtype=np.float32).copy()


def _rms_db_frames(samples: np.ndarray) -> tuple[np.ndarray, float, int, int]:
    """각 hop 프레임의 dBFS 유사 스케일 (20*log10(RMS+ε)). O(n) 누적합."""
    hop = max(1, int(SR * (HOP_MS / 1000.0)))
    win = max(hop, int(SR * (WIN_MS / 1000.0)))
    n = len(samples)
    if n < win:
        return np.array([-100.0], dtype=np.float64), HOP_MS / 1000.0, hop, win
    sq = samples.astype(np.float64) * samples.astype(np.float64)
    cs = np.empty(n + 1, dtype=np.float64)
    cs[0] = 0.0
    np.cumsum(sq, out=cs[1:])
    n_frames = 1 + (n - win) // hop
    out = np.empty(n_frames, dtype=np.float64)
    hop_sec = hop / float(SR)
    for i in range(n_frames):
        s0 = i * hop
        s1 = s0 + win
        mean_sq = (cs[s1] - cs[s0]) / float(win)
        rms = float(math.sqrt(max(mean_sq, 1e-24)))
        out[i] = 20.0 * math.log10(rms + RMS_EPS)
    return out, hop_sec, hop, win


def _dynamic_threshold_db(db_frames: np.ndarray) -> float:
    v = db_frames[np.isfinite(db_frames)]
    if v.size == 0:
        return -40.0
    vs = np.sort(v)
    n10 = max(1, int(math.ceil(vs.size * BOTTOM_FRAC)))
    floor_mean = float(np.mean(vs[:n10]))
    t = floor_mean + DYNAMIC_OFFSET_DB
    return float(max(THRESH_DB_MIN, min(THRESH_DB_MAX, t)))


def _binary_mask(db_frames: np.ndarray, thresh: float) -> np.ndarray:
    return (db_frames > thresh).astype(np.int8)


def _debounce_mask(mask: np.ndarray, hop_sec: float) -> np.ndarray:
    m = mask.astype(np.int8).copy()
    nfr = m.size
    min_sil_fr = max(1, int(math.ceil(DEBOUNCE_MIN_SILENCE_SEC / hop_sec)))
    min_sp_fr = max(1, int(math.ceil(DEBOUNCE_MIN_SPEECH_SEC / hop_sec)))
    for _ in range(DEBOUNCE_PASSES):
        i = 0
        while i < nfr:
            v = int(m[i])
            j = i + 1
            while j < nfr and int(m[j]) == v:
                j += 1
            runlen = j - i
            if v == 0 and runlen < min_sil_fr:
                m[i:j] = 1
            elif v == 1 and runlen < min_sp_fr:
                m[i:j] = 0
            i = j
    return m


def _first_voice_onset_sec(mask: np.ndarray, hop_sec: float, t_lo: float, t_hi: float) -> float | None:
    """[t_lo,t_hi] 안에서 0→1 전이의 첫 (k+1)*hop (초)."""
    n = mask.size
    k0 = max(0, int(math.floor(t_lo / hop_sec)))
    k1 = min(n - 2, int(math.ceil(t_hi / hop_sec)))
    for k in range(k0, k1 + 1):
        if int(mask[k]) == 0 and int(mask[k + 1]) == 1:
            return float((k + 1) * hop_sec)
    return None


def _first_voice_offset_sec(
    mask: np.ndarray, hop_sec: float, t_lo: float, t_hi: float
) -> float | None:
    """[t_lo,t_hi] 안에서 1→0 전이의 첫 경계 (초) = (k+1)*hop."""
    n = mask.size
    k0 = max(0, int(math.floor(t_lo / hop_sec)))
    k1 = min(n - 2, int(math.ceil(t_hi / hop_sec)))
    for k in range(k0, k1 + 1):
        if int(mask[k]) == 1 and int(mask[k + 1]) == 0:
            return float((k + 1) * hop_sec)
    return None


def _interval_fully_silent(mask: np.ndarray, hop_sec: float, t0: float, t1: float) -> bool:
    if not (t1 > t0 + 1e-9):
        return True
    n = mask.size
    k0 = max(0, int(math.floor(t0 / hop_sec)))
    k1 = min(n - 1, int(math.floor(t1 / hop_sec)))
    for k in range(k0, k1 + 1):
        if int(mask[k]) != 0:
            return False
    return True


def _snap_word_pair(
    ws: float,
    we: float,
    mask: np.ndarray,
    hop_sec: float,
    dur_max: float,
    prev_end: float,
) -> tuple[float, float]:
    ws0, we0 = float(ws), float(we)
    if not (we0 > ws0 + 1e-6):
        return ws0, we0

    whisper_dur = we0 - ws0
    lo_s = max(0.0, ws0 - SNAP_SEARCH_SEC)
    hi_s = min(dur_max, ws0 + SNAP_SEARCH_SEC)
    onset = _first_voice_onset_sec(mask, hop_sec, lo_s, hi_s)
    if onset is not None and onset < we0 - 1e-4:
        ws1 = max(prev_end + 1e-4, onset - PREPAD_SEC)
        ws1 = min(ws1, we0 - 1e-4)
        if ws1 < ws0 - 1e-4:
            ws1 = ws0
    else:
        ws1 = max(prev_end + 1e-4, ws0)

    # 끝 스냅: 시작 직후가 아니라 Whisper 길이의 일정 비율 이후부터 찾아 첫 dip에 잘리지 않게 함
    end_floor = min(
        whisper_dur * 0.92,
        max(END_SNAP_MIN_AFTER_START_SEC, END_SNAP_FRAC_OF_WHISPER_DUR * whisper_dur),
    )
    lo_e = max(ws1 + end_floor, we0 - SNAP_SEARCH_SEC)
    hi_e = min(dur_max, we0 + SNAP_SEARCH_SEC)
    off = _first_voice_offset_sec(mask, hop_sec, lo_e, hi_e)
    if off is not None and off > ws1 + 1e-4:
        we1 = min(off, hi_e)
    else:
        we1 = we0

    if we1 <= ws1 + 1e-6:
        we1 = min(dur_max, ws1 + max(1e-3, we0 - ws0))

    # 붕괴 방지: 스냅 결과가 Whisper 대비 지나치게 짧으면 경계 스냅을 완화(원 타임스탬프 우선)
    snapped = we1 - ws1
    need = max(MIN_SNAPPED_WORD_SEC, MIN_SNAPPED_TO_WHISPER_RATIO * whisper_dur)
    need = float(min(need, whisper_dur))
    if whisper_dur > 0.11 and snapped + 1e-9 < need:
        ws_fb = max(prev_end + 1e-4, ws0)
        we_fb = min(dur_max, we0)
        if we_fb > ws_fb + need * 0.9:
            return ws_fb, we_fb
        we1 = min(dur_max, max(we1, ws1 + max(need, whisper_dur * 0.85)))
        if we1 <= ws1 + 1e-6:
            we1 = min(dur_max, ws1 + whisper_dur)
    return ws1, we1


def _is_silence_token(w: dict[str, Any]) -> bool:
    if w.get("isSilence") is True or w.get("is_silence") is True:
        return True
    ww = str(w.get("word", "") or "").strip()
    return ww == "--" or ww == "-- "


def _is_pause_or_filler_token(w: dict[str, Any]) -> bool:
    """말끊김·숨 고름 등 — onset/offset 스냅으로 말 구간을 삼키지 않음"""
    if _is_silence_token(w):
        return True
    ww = str(w.get("word", "") or "").strip()
    if not ww:
        return False
    if ww in ("…", "...", "..", "."):
        return True
    if all(ch in "…." for ch in ww):
        return True
    return False


def _rebuild_cue_text(words: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for w in words:
        t = str(w.get("word", "") or "").strip()
        if t:
            parts.append(t)
    return " ".join(parts).strip()


def apply_rms_vad_word_align(
    cues: list[dict[str, Any]],
    media_path: str,
    ffmpeg_exe: str | None,
    *,
    total_duration: float,
) -> list[dict[str, Any]]:
    """
    cues: transcribe 직후 세그먼트 목록 (각 dict에 start,end,text,words).
    total_duration: info.duration (초), 마스크 상한.
    """
    if not cues:
        return cues
    try:
        ff = ffmpeg_exe if (ffmpeg_exe and str(ffmpeg_exe).strip()) else _which_ffmpeg(None)
    except FileNotFoundError:
        return cues

    try:
        samples = _decode_mono_f32_16k(media_path, ff)
    except (RuntimeError, OSError, subprocess.TimeoutExpired):
        return cues

    dur_audio = len(samples) / float(SR)
    dur_max = float(total_duration) if total_duration and total_duration > 0 else dur_audio
    dur_max = min(dur_max, dur_audio + 0.5)

    db_frames, hop_sec, _hop, _win = _rms_db_frames(samples)
    thresh = _dynamic_threshold_db(db_frames)
    mask = _binary_mask(db_frames, thresh)
    mask = _debounce_mask(mask, hop_sec)

    out_cues: list[dict[str, Any]] = []
    prev_global_end = 0.0

    for cue in cues:
        if not isinstance(cue, dict):
            continue
        raw_words = cue.get("words")
        if not isinstance(raw_words, list) or len(raw_words) == 0:
            out_cues.append(dict(cue))
            continue

        words_in: list[dict[str, Any]] = []
        for w in raw_words:
            if not isinstance(w, dict):
                continue
            try:
                ws = float(w.get("start", 0))
                we = float(w.get("end", 0))
            except (TypeError, ValueError):
                continue
            ww = str(w.get("word", "") or "").strip()
            if not ww and not _is_silence_token(w):
                continue
            words_in.append(dict(w))

        if not words_in:
            out_cues.append(dict(cue))
            continue

        words_in.sort(key=lambda x: float(x["start"]))

        snapped: list[dict[str, Any]] = []
        for w in words_in:
            if _is_silence_token(w):
                ws = max(0.0, min(dur_max, float(w.get("start", 0))))
                we = max(ws + 1e-4, min(dur_max, float(w.get("end", 0))))
                snapped.append(
                    {
                        "start": ws,
                        "end": we,
                        "word": "--",
                        "isSilence": True,
                    }
                )
                prev_global_end = max(prev_global_end, we)
                continue

            ws = float(w["start"])
            we = float(w["end"])
            pe = max(prev_global_end, 0.0)
            if _is_pause_or_filler_token(w):
                nws = max(pe + 1e-4, min(dur_max, ws))
                nwe = max(nws + 1e-4, min(dur_max, we))
                snapped.append({**w, "start": nws, "end": nwe})
                prev_global_end = max(prev_global_end, nwe)
                continue

            nws, nwe = _snap_word_pair(ws, we, mask, hop_sec, dur_max, pe)
            nws = max(pe + 1e-4, nws)
            if nwe <= nws + 1e-6:
                nwe = min(dur_max, nws + max(1e-3, we - ws))
            snapped.append({**w, "start": nws, "end": nwe})
            prev_global_end = max(prev_global_end, nwe)

        # 4단계: 긴 무음 갭에 `--` 삽입
        merged: list[dict[str, Any]] = []
        for i, w in enumerate(snapped):
            merged.append(w)
            if i >= len(snapped) - 1:
                break
            a = w
            b = snapped[i + 1]
            if _is_pause_or_filler_token(a) or _is_pause_or_filler_token(b):
                continue
            gap_s = float(b["start"]) - float(a["end"])
            if gap_s >= GAP_INSERT_SILENCE_SEC - 1e-6:
                t0, t1 = float(a["end"]), float(b["start"])
                if _interval_fully_silent(mask, hop_sec, t0, t1):
                    merged.append(
                        {
                            "start": t0,
                            "end": t1,
                            "word": "--",
                            "isSilence": True,
                        }
                    )

        merged.sort(key=lambda x: float(x["start"]))
        # 겹침 제거
        eps = 1e-4
        for i in range(len(merged) - 1):
            a, b = merged[i], merged[i + 1]
            if float(a["end"]) > float(b["start"]) + eps:
                a["end"] = max(float(a["start"]) + eps, float(b["start"]) - eps)

        new_cue = {
            "start": min(float(x["start"]) for x in merged),
            "end": max(float(x["end"]) for x in merged),
            "text": _rebuild_cue_text(merged),
            "words": merged,
        }
        out_cues.append(new_cue)

    return out_cues
