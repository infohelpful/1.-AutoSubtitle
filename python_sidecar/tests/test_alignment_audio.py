import os
import subprocess
import sys
import tempfile
import time
import tracemalloc
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import alignment_audio


class AlignmentAudioTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def mapped(self, **kwargs):
        return alignment_audio.mapped_alignment_audio('source', 'ffmpeg', temp_dir=self.directory.name, **kwargs)

    def assert_temp_files_removed(self):
        # Windows may finish delete-on-close just after the child exit handle
        # signals. Observe bounded eventual removal; never delete test evidence.
        deadline = time.monotonic() + 2
        while list(Path(self.directory.name).iterdir()) and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_exact_samples_writable_view_and_cleanup_even_with_retained_reference(self):
        samples = np.arange(16000, dtype=np.float32) / 16000

        def decode(_command, **kwargs):
            kwargs['stdout'].write(samples.tobytes())
            return SimpleNamespace(wait=lambda **_: 0, poll=lambda: 0)

        with patch.object(alignment_audio.subprocess, 'Popen', side_effect=decode):
            with self.mapped() as audio:
                self.assertIsInstance(audio, np.memmap)
                self.assertTrue(audio.flags.writeable)
                self.assertTrue(np.array_equal(audio, samples))
                self.assertTrue(np.shares_memory(audio, audio[200:800]))
            self.assertTrue(audio._mmap.closed)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_three_hour_mapping_has_no_full_audio_heap_allocation(self):
        size = 16000 * 4 * 10800

        def decode(_command, **kwargs):
            kwargs['stdout'].truncate(size)
            return SimpleNamespace(wait=lambda **_: 0, poll=lambda: 0)

        with patch.object(alignment_audio.subprocess, 'Popen', new=decode):
            tracemalloc.start()
            try:
                with self.mapped() as audio:
                    self.assertEqual(audio.nbytes, size)
                    self.assertEqual(float(audio[-1]), 0)
                    _, peak = tracemalloc.get_traced_memory()
                self.assertLess(peak, 1024 * 1024)
            finally:
                tracemalloc.stop()
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_decode_failure_empty_data_and_model_exception_close_temp_files(self):
        for data, code in [(b'', 0), (b'abc', 0), (b'abcd', 1)]:
            def decode(_command, **kwargs):
                kwargs['stdout'].write(data)
                kwargs['stderr'].write(b'decode failure')
                return SimpleNamespace(wait=lambda **_: code, poll=lambda: code)
            with self.subTest(data=data, code=code), patch.object(alignment_audio.subprocess, 'Popen', side_effect=decode):
                with self.assertRaises(RuntimeError), self.mapped():
                    pass
            self.assertEqual(list(Path(self.directory.name).iterdir()), [])
        with patch.object(alignment_audio.subprocess, 'Popen', side_effect=decode):
            # Use a complete sample for a failure after mapping succeeds.
            data, code = b'1234', 0
            with self.assertRaisesRegex(ValueError, 'model failure'), self.mapped():
                raise ValueError('model failure')
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_actual_process_timeout_cleans_temp_files(self):
        spawn = subprocess.Popen

        def sleeping(_command, **kwargs):
            return spawn([sys.executable, '-c', 'import time; time.sleep(60)'], **kwargs)

        with patch.object(alignment_audio.subprocess, 'Popen', side_effect=sleeping):
            with self.assertRaises(subprocess.TimeoutExpired), self.mapped(timeout_sec=.2):
                pass
        self.assert_temp_files_removed()

    def test_insufficient_temp_space_does_not_start_decoder_or_leave_files(self):
        with patch.object(alignment_audio.shutil, 'disk_usage', return_value=SimpleNamespace(free=0)), \
             patch.object(alignment_audio.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'temporary disk space'), self.mapped():
                pass
            spawn.assert_not_called()
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_temp_space_query_failure_is_reported_before_decode(self):
        with patch.object(alignment_audio.shutil, 'disk_usage', side_effect=OSError('drive unavailable')), \
             patch.object(alignment_audio.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'temporary disk space'), self.mapped():
                pass
            spawn.assert_not_called()
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_estimated_output_must_fit_in_addition_to_reserve(self):
        with patch.object(alignment_audio, '_estimate_decode_bytes', return_value=1000000), \
             patch.object(alignment_audio.shutil, 'disk_usage', return_value=SimpleNamespace(free=alignment_audio.TEMP_RESERVE_BYTES+999999)), \
             patch.object(alignment_audio.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'temporary disk space'), self.mapped():
                pass
            spawn.assert_not_called()
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_space_lost_during_decode_kills_child_and_cleans_partial_output(self):
        spawn = subprocess.Popen
        children = []
        def slow_decode(_command, **kwargs):
            child = spawn([sys.executable, '-c', 'import sys,time; sys.stdout.buffer.write(bytes(65536)); sys.stdout.flush(); time.sleep(60)'], **kwargs)
            children.append(child)
            return child
        plenty = SimpleNamespace(free=10*alignment_audio.TEMP_RESERVE_BYTES)
        with patch.object(alignment_audio.shutil, 'disk_usage', side_effect=[plenty, plenty, plenty, SimpleNamespace(free=0)]), \
             patch.object(alignment_audio.subprocess, 'Popen', side_effect=slow_decode):
            with self.assertRaisesRegex(RuntimeError, 'temporary disk space'), self.mapped():
                pass
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        # Windows 는 강제 종료된 자식의 핸들을 비동기로 닫는다. delete-on-close 파일이 사라질 때까지 잠시 기다린다.
        deadline = time.monotonic() + 5
        while list(Path(self.directory.name).iterdir()) and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_os_cleans_mapping_after_worker_is_force_killed(self):
        script = '''
import sys,time
from types import SimpleNamespace
sys.path.insert(0,sys.argv[1])
import alignment_audio
def decode(command, **kwargs):
    kwargs['stdout'].write(bytes(16000))
    return SimpleNamespace(wait=lambda **_: 0, poll=lambda: 0)
alignment_audio.subprocess.Popen=decode
with alignment_audio.mapped_alignment_audio('source','ffmpeg',temp_dir=sys.argv[2]) as audio:
    print('ready',flush=True)
    time.sleep(60)
'''
        child = subprocess.Popen([sys.executable, '-B', '-c', script, str(Path(alignment_audio.__file__).parent), self.directory.name],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
        try:
            # Bound the readiness wait as well as the child lifetime.
            import threading
            timer = threading.Timer(10, child.kill)
            timer.start()
            try:
                self.assertEqual(child.stdout.readline().strip(), b'ready')
                child.kill()
                child.communicate(timeout=10)
            finally:
                timer.cancel()
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    @unittest.skipUnless(os.environ.get('AUTOSUBTITLE_TEST_FFMPEG_DIR'), 'Set AUTOSUBTITLE_TEST_FFMPEG_DIR for FFmpeg integration')
    def test_real_ffmpeg_matches_original_absolute_sample_grid_with_padding_and_trim(self):
        ffmpeg = str(Path(os.environ['AUTOSUBTITLE_TEST_FFMPEG_DIR']) / ('ffmpeg.exe' if sys.platform == 'win32' else 'ffmpeg'))
        source = str(Path(self.directory.name) / 'source.wav')
        samples = np.random.default_rng(11).integers(-32000, 32000, size=(48003, 2), dtype=np.int16)
        with wave.open(source, 'wb') as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(48000)
            wav.writeframes(samples.astype('<i2').tobytes())
        for origin in (0, .013, -.037):
            with self.subTest(origin=origin):
                old = subprocess.run([ffmpeg, '-v', 'error', '-copyts', '-i', source, '-vn', '-map', '0:a:0',
                    '-af', f'asetpts=PTS-({float(origin)})/TB,aresample=async=1:first_pts=0',
                    '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], capture_output=True, check=True,
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
                with alignment_audio.mapped_alignment_audio(source, ffmpeg, origin, temp_dir=self.directory.name) as audio:
                    np.testing.assert_array_equal(audio, np.frombuffer(old.stdout, dtype='<f4'))
                    estimate = alignment_audio._estimate_decode_bytes(source, ffmpeg, origin, 30)
                    self.assertGreaterEqual(estimate, audio.nbytes)
                    self.assertLess(estimate, audio.nbytes + 131072)
        self.assertEqual([p.name for p in Path(self.directory.name).iterdir()], ['source.wav'])


if __name__ == '__main__':
    unittest.main()
