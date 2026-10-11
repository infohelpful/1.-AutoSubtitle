"""Compare Whisper raw / current RMS correction / WhisperX forced alignment on SAPI test speech.

Run with the isolated alignment interpreter (needs faster-whisper, whisperx, numpy):
  .venv-alignment/Scripts/python.exe scripts/alignment-tts-bench.py --tts-dir <dir> --whisper-model <ct2 dir> \
      --ffmpeg <ffmpeg.exe> --cache-dir <hf cache> --output report.json

Reference caveat: SAPI word events precede the audible onset by roughly 15-80 ms, so word-vs-event errors are
biased. The first word of each clip is therefore also compared with an acoustic onset (5% of peak RMS).
This is synthetic speech: it says nothing about noise, music, overlapping or spontaneous speech.
"""
from __future__ import annotations

import argparse
import copy
import difflib
import json
import math
import statistics
import subprocess
import sys
import unicodedata
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python_sidecar"))
from alignment_runner import KOREAN_MODEL_REVISION  # noqa: E402
from forced_align import align_korean  # noqa: E402
from rms_vad_word_align import apply_rms_vad_word_align  # noqa: E402


def norm(word: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFC", word) if c.isalnum())


def load_audio(ffmpeg: str, path: str) -> np.ndarray:
    # Decoded here because the PoC venv's PyAV does not match faster-whisper's own loader.
    proc = subprocess.run([ffmpeg, "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                          capture_output=True, check=True)
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


def acoustic_onset(path: str) -> float:
    with wave.open(path) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    hop = 80
    n = len(x) // hop
    rms = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)
    return float(np.argmax(rms > rms.max() * 0.05) * 0.005)


def summarize(values: list[float]) -> dict | None:
    if not values:
        return None
    a = sorted(abs(v) for v in values)
    return {"n": len(values), "signedMedianMs": round(statistics.median(values), 1),
            "absMedianMs": round(statistics.median(a), 1),
            "absP95Ms": round(a[max(0, math.ceil(len(a) * 0.95) - 1)], 1), "absMaxMs": round(a[-1], 1),
            "within50ms": round(sum(v <= 50 for v in a) / len(a), 3),
            "within100ms": round(sum(v <= 100 for v in a) / len(a), 3)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tts-dir", required=True)
    ap.add_argument("--whisper-model", required=True)
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    from faster_whisper import WhisperModel
    model = WhisperModel(args.whisper_model, device="cpu", compute_type="int8")
    tts = Path(args.tts_dir)
    names = ("whisper", "rms", "whisperx")
    vs_event: dict[str, list[float]] = {n: [] for n in names}
    first_vs_onset: dict[str, list[float]] = {n: [] for n in names}
    refs_total = 0
    unmatched = {n: 0 for n in names}
    for wav in sorted(tts.glob("s*.wav"), key=lambda p: int(p.stem[1:])):
        events = [(float(p[0]), p[3]) for p in
                  (line.rstrip("\n").split("\t") for line in
                   (tts / f"{wav.stem}.events.tsv").read_text(encoding="utf-8-sig").splitlines()) if len(p) >= 4]
        refs_total += len(events)
        with wave.open(str(wav)) as w:
            duration = w.getnframes() / w.getframerate()
        segments, _ = model.transcribe(load_audio(args.ffmpeg, str(wav)), beam_size=5, language="ko",
                                       vad_filter=True, word_timestamps=True, temperature=0.0,
                                       condition_on_previous_text=False, no_speech_threshold=0.6)
        cues = [{"start": float(s.start), "end": float(s.end), "text": s.text.strip(),
                 "words": [{"start": float(x.start), "end": float(x.end), "word": x.word.strip()}
                           for x in (s.words or [])]} for s in segments]
        variants: dict[str, list[tuple[float | None, str]]] = {}
        flat = lambda cs: [(w["start"], w["word"]) for c in cs for w in c.get("words", [])]  # noqa: E731
        variants["whisper"] = flat(cues)
        variants["rms"] = flat(apply_rms_vad_word_align(copy.deepcopy(cues), str(wav), args.ffmpeg,
                                                        total_duration=duration))
        out = align_korean(copy.deepcopy(cues), str(wav), args.ffmpeg, args.cache_dir, KOREAN_MODEL_REVISION,
                           strict=False)
        variants["whisperx"] = [(w.get("sourceStart"), w["word"]) for c in out["subtitles"] for w in c["words"]]
        onset = acoustic_onset(str(wav))
        for name, hyp in variants.items():
            ref_words = [norm(w) for _, w in events]
            hyp_words = [norm(w) for _, w in hyp]
            matcher = difflib.SequenceMatcher(a=ref_words, b=hyp_words, autojunk=False)
            matched = 0
            for tag, i1, i2, j1, j2 in matcher.get_opcodes():
                if tag != "equal":
                    continue
                for k in range(i2 - i1):
                    matched += 1
                    start = hyp[j1 + k][0]
                    if start is None:
                        continue
                    vs_event[name].append((start - events[i1 + k][0]) * 1000.0)
            unmatched[name] += len(events) - matched
            if hyp and hyp[0][0] is not None:
                first_vs_onset[name].append((hyp[0][0] - onset) * 1000.0)
    report = {
        "referenceWords": refs_total,
        "referenceWordsNotMatchedByText": unmatched,
        "wordStartVsSapiEvent": {n: summarize(v) for n, v in vs_event.items()},
        "firstWordStartVsAcousticOnset": {n: summarize(v) for n, v in first_vs_onset.items()},
        "caveats": ["synthetic TTS speech only", "SAPI events precede audible onset (biased reference)",
                    "no noise/music/overlap/spontaneous speech"],
    }
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True))


if __name__ == "__main__":
    main()
