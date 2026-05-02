"""
PNG 자막 → 투명 중간 레이어(ProRes / qtrle / PNG 프레임) → 원본과 짧은 Phase 2 overlay 로 합성.

Phase 2 는 입력 2개만 사용: [0:v][1:v]overlay=0:0[vout], 오디오는 원본 copy.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Any


def _normalize_path(raw: str) -> str:
    p = unicodedata.normalize("NFC", raw).strip().strip('"').strip("'")
    p = p.replace("¥", "\\").replace("₩", "\\")
    p = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufeff]", "", p)
    p = re.sub(r"^[\\/]+([A-Za-z]:[\\/])", r"\1", p)
    p = re.sub(r"^([A-Za-z])[\\/](?![\\/])", r"\1:\\", p)
    return os.path.normpath(p)


def _which_ffmpeg(explicit: str | None) -> str:
    if explicit:
        ep = _normalize_path(explicit)
        if os.path.isfile(ep):
            return ep
    w = shutil.which("ffmpeg")
    if w:
        return w
    raise FileNotFoundError("ffmpeg 실행 파일을 찾을 수 없습니다. PATH 또는 ffmpegPath를 확인하세요.")


def _subprocess_creationflags() -> int:
    if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        return subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
    return 0


def _ffmpeg_encoders_output(ffmpeg_exe: str) -> str:
    """`ffmpeg -encoders` 전체 출력 (stdout+stderr)."""
    r = subprocess.run(
        [ffmpeg_exe, "-hide_banner", "-encoders"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=_subprocess_creationflags(),
    )
    return (r.stdout or "") + "\n" + (r.stderr or "")


def _has_encoder(encoders_output: str, encoder_name: str) -> bool:
    """인코더 목록에 해당 이름이 있는지 확인 (단어 단위)."""
    return bool(re.search(rf"\b{re.escape(encoder_name)}\b", encoders_output))


def _encoder_attempt_allowed(hint: bool | None, encoders_output: str, encoder_name: str) -> bool:
    """
    메인 프로세스에서 넘긴 힌트와 로컬 `-encoders` 결과를 조합한다.

    - hint가 False면 해당 인코더는 시도하지 않는다(대안 파이프라인으로 바로 진행).
    - hint가 True면 메인에서 이미 프로브했으므로 시도한다.
    - hint가 None이면 params에 키가 없을 때와 동일하며, 로컬 인코더 목록만으로 판단한다.
    """
    if hint is False:
        return False
    if hint is True:
        return True
    return _has_encoder(encoders_output, encoder_name)


def build_png_only_overlay_script(
    n_png: int,
    timings: list[tuple[float, float]],
    overlay_x: int = 0,
    overlay_y: int = 0,
) -> str:
    """투명 베이스(입력 0) 위에 PNG 입력 1..n 을 시간대별 overlay → [vout]. 타임스탬프는 enable=between(t,start,end)."""
    if n_png < 1:
        raise ValueError("n_png must be >= 1")
    if len(timings) != n_png:
        raise ValueError("timings length must match n_png")

    current = "[0:v]"
    parts: list[str] = []
    for i in range(n_png):
        start, end = timings[i]
        en = f"between(t\\,{start:.6f}\\,{end:.6f})"
        out_lab = "[vout]" if i == n_png - 1 else f"[ov{i}]"
        parts.append(
            f"{current}[{i + 1}:v]overlay={overlay_x}:{overlay_y}:shortest=1:enable='{en}'{out_lab}"
        )
        current = out_lab

    return ";".join(parts)


# Phase 2: 입력 0 = 원본 영상, 입력 1 = Phase 1 자막 레이어 (짧은 단일 필터)
FINAL_MUX_FILTER_COMPLEX = "[0:v][1:v]overlay=0:0[vout]"


def _final_mux_video_encode_args(encoder_name: str) -> list[str]:
    """
    최종 합성 출력 비디오 인코더 — 메인 프로세스 선별과 동일 우선순위 문자열.
    """
    name = (encoder_name or "libx264").strip().lower()
    if name == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "23"]
    if name == "h264_qsv":
        return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23"]
    if name == "h264_amf":
        return ["-c:v", "h264_amf", "-quality", "speed"]
    return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"]


def _emit_export_progress(value: float, phase: str) -> None:
    v = max(0.0, min(100.0, float(value)))
    line = json.dumps(
        {"type": "export_progress", "value": round(v, 2), "phase": phase},
        ensure_ascii=False,
    )
    print(line, file=sys.stderr, flush=True)


def _run_ffmpeg_with_progress(
    args: list[str],
    expected_duration_sec: float,
    phase: str,
) -> None:
    expected_ms = max(1, int(expected_duration_sec * 1000))
    proc = subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=_subprocess_creationflags(),
    )
    assert proc.stderr is not None
    buf = ""
    try:
        while True:
            chunk = proc.stderr.read(4096)
            if not chunk:
                break
            buf += chunk
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.strip()
                if line.startswith("out_time_ms="):
                    try:
                        raw = int(line.split("=", 1)[1].strip())
                        if raw >= 0:
                            out_ms = raw // 1000
                            pct = max(0, min(99, int((out_ms / expected_ms) * 100)))
                            _emit_export_progress(pct, phase)
                    except (ValueError, IndexError):
                        pass
    finally:
        proc.stderr.close()
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"ffmpeg 실패 (exit {code})")
    _emit_export_progress(100.0, phase)


def _phase1_transparent_subtitle_video(
    ffmpeg_exe: str,
    lavfi: str,
    png_paths: list[str],
    script_body: str,
    intermediate_mov: str,
    overlay_dur: float,
    seq_fps: int,
    *,
    hint_prores: bool | None = None,
    hint_qtrle: bool | None = None,
) -> tuple[str, str]:
    """
    자막 전용 투명 영상(또는 PNG 프레임 폴더) 생성.

    Returns:
        (phase1_mode, phase1_second_input_path)
        phase1_mode: 'prores_ks' | 'qtrle' | 'png_sequence'
        phase1_second_input_path: Phase 2 의 두 번째 -i (mov 단일 파일 또는 frame_%06d 패턴 디렉터리)
    """
    enc_out = _ffmpeg_encoders_output(ffmpeg_exe)

    script_fd, script_path = tempfile.mkstemp(suffix=".txt", prefix="autosub-p1-", text=False)
    os.close(script_fd)
    try:
        Path(script_path).write_text(script_body, encoding="utf-8")

        argv_head: list[str] = [
            ffmpeg_exe,
            "-y",
            "-hide_banner",
            "-f",
            "lavfi",
            "-i",
            lavfi,
        ]
        for pp in png_paths:
            argv_head.extend(["-loop", "1", "-i", pp])
        argv_mid = ["-filter_complex_script", script_path, "-map", "[vout]", "-an"]

        # 1) prores_ks (힌트 False면 스킵, 그 외에는 힌트·인코더 목록에 따라 시도)
        if _encoder_attempt_allowed(hint_prores, enc_out, "prores_ks"):
            argv = [
                *argv_head,
                *argv_mid,
                "-c:v",
                "prores_ks",
                "-profile:v",
                "4",
                "-vendor",
                "apl0",
                "-pix_fmt",
                "yuva444p10le",
                "-progress",
                "pipe:2",
                "-nostats",
                intermediate_mov,
            ]
            try:
                _run_ffmpeg_with_progress(argv, max(1.0, overlay_dur), "intermediate")
                return ("prores_ks", intermediate_mov)
            except RuntimeError:
                pass

        # 2) qtrle
        if _encoder_attempt_allowed(hint_qtrle, enc_out, "qtrle"):
            argv = [
                *argv_head,
                *argv_mid,
                "-c:v",
                "qtrle",
                "-progress",
                "pipe:2",
                "-nostats",
                intermediate_mov,
            ]
            try:
                _run_ffmpeg_with_progress(argv, max(1.0, overlay_dur), "intermediate")
                return ("qtrle", intermediate_mov)
            except RuntimeError:
                pass

        # 3) PNG 프레임 시퀀스 (overlay 출력을 일정 fps 로 샘플링 → frame_%06d.png)
        seq_dir = os.path.join(os.path.dirname(intermediate_mov), "subtitle_png_seq")
        os.makedirs(seq_dir, exist_ok=True)
        for name in os.listdir(seq_dir):
            if name.lower().endswith(".png"):
                try:
                    os.unlink(os.path.join(seq_dir, name))
                except OSError:
                    pass

        script_fps = script_body + f";[vout]fps={seq_fps}[vfps]"
        Path(script_path).write_text(script_fps, encoding="utf-8")

        # 사용자 요청 형태에 맞춘 패턴 (실제 파일명은 sub_000001.png …)
        pattern = os.path.join(seq_dir, "sub_%06d.png")
        argv_png = [
            *argv_head,
            "-filter_complex_script",
            script_path,
            "-map",
            "[vfps]",
            "-an",
            "-f",
            "image2",
            "-pix_fmt",
            "rgba",
            "-start_number",
            "1",
            "-progress",
            "pipe:2",
            "-nostats",
            pattern,
        ]
        _run_ffmpeg_with_progress(argv_png, max(1.0, overlay_dur), "intermediate")
        # Phase 2: image2 로 동일 fps 로 읽기 — 패턴은 ffmpeg 규칙에 맞게 sub_%d 스타일로 통일
        # 사용자 요청 sub_%d.png 에 맞추려면 파일명을 sub_ 로 바꿔 복사하는 대신,
        # 디렉터리 + frame_%06d 로 두 번째 입력을 구성하고 반환한다.
        return ("png_sequence", pattern)
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass


def export_video_png_overlay(params: dict[str, Any]) -> dict[str, Any]:
    """
    Phase 1: Electron PNG + 타임스탬프 → 자막 전용 레이어(중간 파일).
    Phase 2: -i 원본 -i 레이어, filter_complex 는 overlay 한 줄만, → outputPath (최종 mp4 등).
    cutRanges 는 호환용으로 params 에 남을 수 있으나 Phase 2 Mux 에서는 사용하지 않는다.

    skipPhase1 이 True 이면 Phase 1 은 메인(Node)에서 이미 수행된 것으로 보고 Phase 2 만 실행한다.
    """
    input_path = _normalize_path(str(params.get("inputPath", "")))
    output_path = _normalize_path(str(params.get("outputPath", "")))
    if not input_path or not os.path.isfile(input_path):
        raise ValueError(f"inputPath 가 없습니다: {input_path}")
    if not output_path:
        raise ValueError("outputPath 가 비어 있습니다.")

    ff_param = params.get("ffmpegPath") or params.get("ffmpeg_path")
    ffmpeg_exe = _which_ffmpeg(str(ff_param).strip() if isinstance(ff_param, str) and str(ff_param).strip() else None)

    inter_raw = params.get("intermediatePath") or params.get("intermediate_path")
    if not isinstance(inter_raw, str) or not inter_raw.strip():
        raise ValueError("intermediatePath 가 필요합니다.")
    intermediate_mov = _normalize_path(inter_raw)

    dur_raw = params.get("overlayDurationSec") or params.get("overlay_duration_sec")
    overlay_dur = max(0.1, float(dur_raw)) if dur_raw is not None else float(params.get("expectedDurationSec") or params.get("expected_duration_sec") or 1.0)

    expected_final_sec = float(params.get("expectedDurationSec") or params.get("expected_duration_sec") or overlay_dur)

    seq_fps = int(params.get("pngSequenceFps") or params.get("png_sequence_fps") or 24)
    seq_fps = max(1, min(60, seq_fps))

    skip_phase1 = bool(params.get("skipPhase1") or params.get("skip_phase1"))

    if skip_phase1:
        phase1_codec = str(params.get("phase1Codec") or params.get("phase1_codec") or "").strip()
        phase1_input2 = _normalize_path(str(params.get("phase1SecondInput") or params.get("phase1_second_input") or ""))
        if not phase1_codec or not phase1_input2:
            raise ValueError("skipPhase1 일 때 phase1Codec 과 phase1SecondInput 이 필요합니다.")
        if phase1_codec == "png_sequence":
            parent = os.path.dirname(phase1_input2)
            if not os.path.isdir(parent):
                raise ValueError(f"PNG 시퀀스 디렉터리 없음: {parent}")
        else:
            if not os.path.isfile(phase1_input2):
                raise ValueError(f"중간 레이어 파일 없음: {phase1_input2}")
    else:
        raw_pngs = params.get("pngPaths") or params.get("png_paths") or []
        if not isinstance(raw_pngs, list) or not raw_pngs:
            raise ValueError("pngPaths 가 비어 있습니다.")
        png_paths = [_normalize_path(str(p)) for p in raw_pngs]
        for p in png_paths:
            if not os.path.isfile(p):
                raise ValueError(f"PNG 파일 없음: {p}")

        timing_raw = params.get("timing") or []
        if not isinstance(timing_raw, list) or len(timing_raw) != len(png_paths):
            raise ValueError("timing 길이가 pngPaths 와 일치해야 합니다.")

        timings: list[tuple[float, float]] = []
        for item in timing_raw:
            if not isinstance(item, dict):
                raise TypeError("timing 항목은 객체여야 합니다.")
            s = float(item.get("start", 0))
            e = float(item.get("end", 0))
            timings.append((s, e))

        w = int(params.get("videoWidth") or params.get("video_width") or 1920)
        h = int(params.get("videoHeight") or params.get("video_height") or 1080)
        w = max(16, w)
        h = max(16, h)

        if dur_raw is None:
            overlay_dur = max((t[1] for t in timings), default=1.0)
            overlay_dur = max(overlay_dur, float(params.get("expectedDurationSec") or params.get("expected_duration_sec") or 1.0))

        raw_hint_pr = params.get("isProResAvailable")
        hint_prores: bool | None = None if raw_hint_pr is None else bool(raw_hint_pr)
        raw_hint_qt = params.get("isQtrleAvailable")
        hint_qtrle: bool | None = None if raw_hint_qt is None else bool(raw_hint_qt)

        n = len(png_paths)
        script_pass1 = build_png_only_overlay_script(n, timings)

        lavfi = f"color=c=black@0.0:s={w}x{h}:d={overlay_dur:.6f}:r=30"

        phase1_codec, phase1_input2 = _phase1_transparent_subtitle_video(
            ffmpeg_exe,
            lavfi,
            png_paths,
            script_pass1,
            intermediate_mov,
            overlay_dur,
            seq_fps,
            hint_prores=hint_prores,
            hint_qtrle=hint_qtrle,
        )

    argv2: list[str] = [
        ffmpeg_exe,
        "-y",
        "-hide_banner",
        "-i",
        input_path,
    ]
    if phase1_codec == "png_sequence":
        argv2.extend(
            [
                "-framerate",
                str(seq_fps),
                "-start_number",
                "1",
                "-i",
                phase1_input2,
            ]
        )
    else:
        argv2.extend(["-i", phase1_input2])

    h264_enc = str(params.get("h264Encoder") or params.get("h264_encoder") or "h264_nvenc")

    argv2.extend(
        [
            "-filter_complex",
            FINAL_MUX_FILTER_COMPLEX,
            "-map",
            "[vout]",
            "-map",
            "0:a?",
            "-map",
            "-0:s",
            *_final_mux_video_encode_args(h264_enc),
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:2",
            "-nostats",
            "-sn",
            output_path,
        ]
    )

    _run_ffmpeg_with_progress(argv2, max(1.0, expected_final_sec), "final")

    return {
        "ok": True,
        "outputPath": output_path,
        "intermediatePath": intermediate_mov,
        "phase1Codec": phase1_codec,
        "phase1SecondInput": phase1_input2,
    }
