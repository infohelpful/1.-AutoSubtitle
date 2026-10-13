"""Measure the RMS envelope path without loading an ASR/alignment model.

--compare additionally decodes the entire file as a regression reference. Use
that only for short fixtures; the normal mode is suitable for long media.
Traced allocation is Python/NumPy memory, not total RSS or FFmpeg/model memory.
"""
import argparse
import json
import subprocess
import sys
import time
import tracemalloc
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python_sidecar'))
import rms_vad_word_align as rms

parser = argparse.ArgumentParser()
parser.add_argument('--media', required=True)
parser.add_argument('--ffmpeg', required=True)
parser.add_argument('--compare', action='store_true')
args = parser.parse_args()
kernel = rms._rms_db_frames
max_samples = 0


def measured(samples):
    global max_samples
    max_samples = max(max_samples, len(samples))
    return kernel(samples)


tracemalloc.start()
started = time.perf_counter()
with patch.object(rms, '_rms_db_frames', new=measured), closing(rms._decode_mono_f32_chunks(args.media, args.ffmpeg)) as chunks:
    frames, hop, count = rms._rms_db_chunks(chunks)
elapsed = time.perf_counter() - started
_, peak = tracemalloc.get_traced_memory()
tracemalloc.stop()
report = {'duration': count / rms.SR, 'frames': len(frames), 'hopSec': hop,
          'envelopeBytes': frames.nbytes, 'peakTracedBytes': peak,
          'maxKernelSamples': max_samples, 'elapsedSec': elapsed}
assert max_samples <= 16384 + 239
if args.compare:
    decoded = subprocess.run([args.ffmpeg, '-v', 'error', '-i', args.media, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'],
                             capture_output=True, check=True, creationflags=rms._subprocess_creationflags())
    old, _, _, _ = kernel(np.frombuffer(decoded.stdout, dtype='<f4'))
    report['maxDbDifference'] = float(np.max(np.abs(old - frames)))
    old_mask = rms._debounce_mask(rms._binary_mask(old, rms._dynamic_threshold_db(old)), hop)
    new_mask = rms._debounce_mask(rms._binary_mask(frames, rms._dynamic_threshold_db(frames)), hop)
    report['maskDifferences'] = int(np.count_nonzero(old_mask != new_mask))
    assert report['maskDifferences'] == 0
print(json.dumps(report, indent=2))
