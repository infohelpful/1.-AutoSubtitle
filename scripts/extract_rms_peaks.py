#!/usr/bin/env python3
"""
오디오에서 RMS 진폭을 추출해 10ms(초당 100샘플)로 다운샘플 후 JSON / 바이너리 저장.

의존성: pip install librosa numpy soundfile

바이너리 형식 (.bin):
  magic "ASRF" (4) | sample_rate uint32 LE | count uint32 LE | float32[count]

Electron IPC 로 큰 JSON 대신 .bin + ArrayBuffer 로 전달하는 것을 권장.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

try:
    import librosa
except ImportError:
    print("Install: pip install librosa numpy soundfile", file=sys.stderr)
    raise

MAGIC = b"ASRF"
HOP_MS = 10
SR_TARGET = 100  # samples per second of output timeline


def load_audio(path: Path, mono: bool = True) -> tuple[np.ndarray, int]:
    y, sr = librosa.load(str(path), sr=None, mono=mono)
    return y.astype(np.float32), int(sr)


def rms_downsample(y: np.ndarray, sr: int, hop_ms: float = HOP_MS) -> tuple[np.ndarray, int]:
    hop = max(1, int(sr * hop_ms / 1000.0))
    if y.size < hop:
        return np.array([float(np.sqrt(np.mean(np.square(y))))], dtype=np.float32), sr

    n_frames = 1 + (y.size - 1) // hop
    rms = np.empty(n_frames, dtype=np.float32)
    for i in range(n_frames):
        sl = y[i * hop : i * hop + hop]
        rms[i] = float(np.sqrt(np.mean(np.square(sl)))) if sl.size else 0.0

    # 초당 SR_TARGET 개로 리샘플 (선형 보간)
    dur_sec = y.size / float(sr)
    target_n = max(1, int(np.ceil(dur_sec * SR_TARGET)))
    x_old = np.linspace(0.0, dur_sec, num=rms.size, endpoint=False)
    x_new = np.linspace(0.0, dur_sec, num=target_n, endpoint=False)
    out = np.interp(x_new, x_old, rms).astype(np.float32)

    # 정규화 [0,1]
    mx = float(np.max(out)) if out.size else 1.0
    if mx > 1e-12:
        out = np.clip(out / mx, 0.0, 1.0)
    return out, SR_TARGET


def write_json(path: Path, samples: np.ndarray, samples_per_sec: int, source_sr: int) -> None:
    payload = {
        "samples_per_sec": samples_per_sec,
        "source_sample_rate": source_sr,
        "hop_ms": HOP_MS,
        "rms_normalized": samples.tolist(),
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def write_bin(path: Path, samples: np.ndarray, samples_per_sec: int) -> None:
    raw = samples.astype(np.float32).tobytes()
    header = MAGIC + struct.pack("<II", samples_per_sec, samples.size)
    path.write_bytes(header + raw)


def main() -> None:
    ap = argparse.ArgumentParser(description="Extract normalized RMS peaks (10ms-style downsampling)")
    ap.add_argument("input", type=Path, help="Audio file (wav/mp3/...)")
    ap.add_argument("--json-out", type=Path, help="Output JSON path")
    ap.add_argument("--bin-out", type=Path, help="Output binary path")
    args = ap.parse_args()

    if not args.json_out and not args.bin_out:
        ap.error("Provide at least one of --json-out or --bin-out")

    y, sr_in = load_audio(args.input)
    rms, sps = rms_downsample(y, sr_in)

    if args.json_out:
        write_json(args.json_out, rms, sps, sr_in)
        print(f"Wrote JSON: {args.json_out} ({rms.size} samples, {sps}/sec)")
    if args.bin_out:
        write_bin(args.bin_out, rms, sps)
        print(f"Wrote BIN: {args.bin_out} ({rms.size} floats)")


if __name__ == "__main__":
    main()
