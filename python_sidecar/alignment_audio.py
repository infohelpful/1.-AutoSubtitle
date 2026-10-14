"""Disk-backed alignment input with the same absolute sample grid as full decode.

TemporaryFile unlinks on POSIX and uses delete-on-close on Windows. The OS can
reclaim decoded pages; this removes full stdout/ndarray heap copies, not model
memory or a promise of constant total process RSS.
"""
from __future__ import annotations

from contextlib import contextmanager
import math
import os
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np

TEMP_RESERVE_BYTES = 256 * 1024 * 1024


def _check_temp_space(directory: str, output_bytes: int = 0) -> None:
    try:
        free = shutil.disk_usage(directory).free
    except OSError as error:
        raise RuntimeError(f'Cannot check alignment temporary disk space: {error}') from error
    required = TEMP_RESERVE_BYTES + output_bytes
    if free < required:
        raise RuntimeError(f'Insufficient alignment temporary disk space: '
                           f'need {math.ceil(required / 1048576)} MiB, free {free // 1048576} MiB')


def _estimate_decode_bytes(media_path: str, ffmpeg_path: str, origin: float, timeout: float) -> int:
    """Estimate absolute-grid mono float32 output; monitoring also covers unknown durations."""
    ffprobe = Path(ffmpeg_path).with_name('ffprobe.exe' if sys.platform == 'win32' else 'ffprobe')
    if not ffprobe.is_file():
        return 0
    probe = subprocess.run([str(ffprobe), '-v', 'error', '-select_streams', 'a:0',
                            '-show_entries', 'format=duration,start_time:stream=duration,start_time',
                            '-of', 'json', media_path], capture_output=True, timeout=min(timeout, 30),
                           creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
    if probe.returncode:
        raise RuntimeError('Cannot inspect alignment audio duration')
    data = json.loads(probe.stdout)
    ends = []
    for item in [data.get('format', {}), *data.get('streams', [])]:
        try:
            duration = float(item.get('duration', 0))
            start = float(item.get('start_time', 0))
        except (TypeError, ValueError):
            continue
        if math.isfinite(duration) and duration > 0 and math.isfinite(start):
            ends.append(max(0, start + duration - origin))
    return math.ceil(max(ends) * 16000) * 4 + 65536 if ends else 0


def _decode_to_file(command: list[str], pcm, errors, directory: str, timeout: float) -> None:
    """Let FFmpeg write directly to disk; stop and reap it if TEMP becomes low."""
    proc = subprocess.Popen(command, stdout=pcm, stderr=errors,
                            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
    deadline = time.monotonic() + timeout
    try:
        while True:
            _check_temp_space(directory)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout)
            try:
                code = proc.wait(timeout=min(.1, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
        if code:
            errors.seek(0, 2)
            errors.seek(max(0, errors.tell() - 4000))
            detail = errors.read().decode('utf-8', 'replace').strip()
            raise RuntimeError(detail or f'Alignment audio decode failed: {code}')
        _check_temp_space(directory)
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()


@contextmanager
def mapped_alignment_audio(media_path: str, ffmpeg_path: str, source_origin_sec: float = 0,
                           *, timeout_sec: float = 300, temp_dir: str | None = None):
    """Yield a writable copy-on-write float32 map; do not retain it after exit."""
    if not math.isfinite(source_origin_sec):
        raise ValueError('Invalid audio source origin')
    if not math.isfinite(timeout_sec) or timeout_sec <= 0:
        raise ValueError('Invalid audio decode timeout')
    directory = os.path.abspath(temp_dir or tempfile.gettempdir())
    _check_temp_space(directory)
    required = _estimate_decode_bytes(media_path, ffmpeg_path, source_origin_sec, timeout_sec)
    _check_temp_space(directory, required)
    with tempfile.TemporaryFile(prefix='autosubtitle-align-', suffix='.f32', dir=directory) as pcm, \
         tempfile.TemporaryFile(prefix='autosubtitle-align-', suffix='.log', dir=directory) as errors:
        _decode_to_file([
            ffmpeg_path, '-nostdin', '-v', 'error', '-copyts', '-i', media_path, '-vn', '-map', '0:a:0',
            '-af', f'asetpts=PTS-({float(source_origin_sec)})/TB,aresample=async=1:first_pts=0',
            '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'
        ], pcm, errors, directory, timeout_sec)
        pcm.flush()
        size = os.fstat(pcm.fileno()).st_size
        if size <= 0 or size % 4:
            raise RuntimeError('Alignment audio is empty or has an incomplete sample')
        # mode='c' provides a writable NumPy view for torch.from_numpy without
        # modifying the file. No full-file read/copy or timestamp rebasing.
        audio = np.memmap(pcm, dtype='<f4', mode='c', shape=(size // 4,))
        try:
            yield audio
        finally:
            # Close the map before TemporaryFile, especially for Windows deletion.
            audio._mmap.close()
