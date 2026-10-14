"""Measure mapped decode, optionally compare real alignment with the old decoder.

--cues accepts a transcription JSON containing raw_subtitles. It runs the model
twice in separate offline CPU workers; use a short real recording for this mode.
Traced memory excludes model, FFmpeg and OS page cache/RSS.
"""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import tracemalloc

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python_sidecar'))
from alignment_audio import mapped_alignment_audio


@contextmanager
def legacy_audio(media_path, ffmpeg_path, source_origin_sec=0):
    decoded = subprocess.run([
        ffmpeg_path, '-v', 'error', '-copyts', '-i', media_path, '-vn', '-map', '0:a:0',
        '-af', f'asetpts=PTS-({float(source_origin_sec)})/TB,aresample=async=1:first_pts=0',
        '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'
    ], capture_output=True, check=True, timeout=300,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
    yield np.frombuffer(decoded.stdout, dtype=np.float32).copy()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--media', required=True)
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--cues')
    parser.add_argument('--cache-dir')
    parser.add_argument('--origin', type=float, default=0)
    parser.add_argument('--output', required=True)
    parser.add_argument('--worker', choices=['legacy', 'mapped'], help=argparse.SUPPRESS)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if output.exists():
        raise ValueError('Choose a new output report')
    if args.worker:
        import forced_align
        from alignment_runner import KOREAN_MODEL_REVISION
        if args.worker == 'legacy':
            forced_align.mapped_alignment_audio = legacy_audio
        cues = json.loads(Path(args.cues).read_text(encoding='utf-8'))['raw_subtitles']
        result = forced_align.align_korean(cues, args.media, args.ffmpeg, args.cache_dir,
                                          KOREAN_MODEL_REVISION, source_origin_sec=args.origin,
                                          strict=True)
    else:
        with tempfile.TemporaryDirectory(prefix='alignment-bench-') as scratch:
            tracemalloc.start()
            started = time.perf_counter()
            try:
                with mapped_alignment_audio(args.media, args.ffmpeg, args.origin, temp_dir=scratch) as audio:
                    result = {'duration': len(audio) / 16000, 'mappedBytes': audio.nbytes,
                              'lastSample': float(audio[-1])}
                    result['peakTracedBytes'] = tracemalloc.get_traced_memory()[1]
                result['decodeSec'] = time.perf_counter() - started
            finally:
                tracemalloc.stop()
            result['tempFilesAfterClose'] = len(list(Path(scratch).iterdir()))
            assert result['tempFilesAfterClose'] == 0
            if args.cues:
                if not args.cache_dir:
                    raise ValueError('--cache-dir is required with --cues')
                results = []
                for mode in ('legacy', 'mapped'):
                    worker_output = Path(scratch) / f'{mode}.json'
                    command = [sys.executable, '-B', str(Path(__file__).resolve()),
                               '--media', args.media, '--ffmpeg', args.ffmpeg, '--cues', args.cues,
                               '--cache-dir', args.cache_dir, '--origin', str(args.origin),
                               '--worker', mode, '--output', str(worker_output)]
                    started = time.perf_counter()
                    with output.with_suffix(f'.{mode}.log').open('xb') as log:
                        subprocess.run(command, stdout=log, stderr=log, check=True, timeout=600,
                                       env={**os.environ, 'HF_HUB_OFFLINE': '1', 'PYTHONUTF8': '1',
                                            'PYTHONDONTWRITEBYTECODE': '1'},
                                       creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
                    result[f'{mode}Sec'] = time.perf_counter() - started
                    results.append(json.loads(worker_output.read_text(encoding='utf-8')))
                result['exactAlignmentMatch'] = results[0] == results[1]
                result['alignmentSummary'] = results[1]['alignmentSummary']
                assert result['exactAlignmentMatch'], 'Alignment output changed'
    with output.open('x', encoding='utf-8') as report:
        json.dump(result, report, ensure_ascii=False, indent=2)
    if not args.worker:
        print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == '__main__':
    main()
