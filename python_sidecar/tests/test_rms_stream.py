import copy
import os
import subprocess
import sys
import tempfile
import unittest
import wave
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rms_vad_word_align as rms


class RmsStreamTests(unittest.TestCase):
    def test_arbitrary_chunk_boundaries_preserve_global_frame_grid(self):
        samples = np.random.default_rng(17).normal(0, .1, 32017).astype(np.float32)
        expected, hop, _, _ = rms._rms_db_frames(samples)
        for size in [1, 7, 239, 240, 1600, 16384, len(samples)]:
            with self.subTest(size=size):
                actual, actual_hop, count = rms._rms_db_chunks(samples[i:i + size] for i in range(0, len(samples), size))
                self.assertEqual((actual_hop, count), (hop, len(samples)))
                np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-9)

    def test_short_audio_and_empty_decoder(self):
        frames, hop, count = rms._rms_db_chunks([np.zeros(239, dtype=np.float32)])
        self.assertEqual((frames.tolist(), hop, count), ([-100.0], .01, 239))
        with self.assertRaisesRegex(RuntimeError, 'empty'):
            rms._rms_db_chunks([])

    def test_speech_silence_mask_and_word_bounds_match_previous_whole_audio_algorithm(self):
        samples = np.zeros(48000, dtype=np.float32)
        samples[8000:17600] = .2 * np.sin(np.arange(9600) * .2)
        samples[28800:38400] = .2 * np.sin(np.arange(9600) * .2)
        old, hop, _, _ = rms._rms_db_frames(samples)
        new, _, _ = rms._rms_db_chunks(samples[i:i + 701] for i in range(0, len(samples), 701))
        np.testing.assert_array_equal(rms._binary_mask(old, rms._dynamic_threshold_db(old)),
                                      rms._binary_mask(new, rms._dynamic_threshold_db(new)))
        cues = [{'start': .48, 'end': 2.5, 'text': '하나 둘', 'words': [
            {'start': .48, 'end': 1.15, 'word': '하나'}, {'start': 1.75, 'end': 2.5, 'word': '둘'}]}]
        with patch.object(rms, '_decode_mono_f32_chunks', side_effect=lambda *a, **kw: (x for x in [samples])):
            actual = rms.apply_rms_vad_word_align(copy.deepcopy(cues), 'input', 'ffmpeg', total_duration=3)
            with patch.object(rms, '_rms_db_chunks', return_value=(old, hop, len(samples))):
                expected = rms.apply_rms_vad_word_align(copy.deepcopy(cues), 'input', 'ffmpeg', total_duration=3)
        self.assertEqual(actual, expected)

    def test_frame_kernel_input_is_bounded_even_for_a_large_caller_chunk(self):
        sizes = []
        original = rms._rms_db_frames

        def measured(samples):
            sizes.append(len(samples))
            return original(samples)

        with patch.object(rms, '_rms_db_frames', side_effect=measured):
            frames, _, count = rms._rms_db_chunks([np.zeros(16000 * 60, dtype=np.float32)])
        self.assertEqual(count, 960000)
        self.assertEqual(len(frames), 5999)
        self.assertLessEqual(max(sizes), 16384 + 239)

    def fake_decoder(self, code):
        children = []
        original = subprocess.Popen

        def start(_args, **kwargs):
            child = original([sys.executable, '-u', '-c', code], **kwargs)
            children.append(child)
            return child

        return patch.object(rms.subprocess, 'Popen', side_effect=start), children

    def test_decoder_timeout_and_early_close_reap_child(self):
        fake, children = self.fake_decoder('import time; time.sleep(60)')
        with fake, self.assertRaises(subprocess.TimeoutExpired):
            list(rms._decode_mono_f32_chunks('unused', 'unused', timeout_sec=.2))
        self.assertIsNotNone(children[0].poll())
        fake, children = self.fake_decoder("import sys,time; sys.stdout.buffer.write(bytes(65536)); sys.stdout.flush(); time.sleep(60)")
        with fake, closing(rms._decode_mono_f32_chunks('unused', 'unused')) as chunks:
            self.assertEqual(len(next(chunks)), 16384)
        self.assertIsNotNone(children[0].poll())

    def test_decoder_drains_large_stderr_and_rejects_partial_float(self):
        fake, _ = self.fake_decoder("import sys; sys.stderr.write('error'*40000); sys.stdout.buffer.write(bytes(8))")
        with fake:
            self.assertEqual(sum(len(x) for x in rms._decode_mono_f32_chunks('unused', 'unused')), 2)
        fake, _ = self.fake_decoder("import sys; sys.stdout.buffer.write(bytes(5))")
        with fake, self.assertRaisesRegex(RuntimeError, 'incomplete'):
            list(rms._decode_mono_f32_chunks('unused', 'unused'))

    @unittest.skipUnless(os.environ.get('AUTOSUBTITLE_TEST_FFMPEG_DIR'), 'Set AUTOSUBTITLE_TEST_FFMPEG_DIR for FFmpeg integration')
    def test_real_ffmpeg_decodes_exact_samples_in_bounded_chunks(self):
        ffmpeg = str(Path(os.environ['AUTOSUBTITLE_TEST_FFMPEG_DIR']) / ('ffmpeg.exe' if sys.platform == 'win32' else 'ffmpeg'))
        samples = np.random.default_rng(2).integers(-32000, 32000, size=80003, dtype=np.int16)
        with tempfile.TemporaryDirectory() as directory:
            source = str(Path(directory) / 'audio.wav')
            with wave.open(source, 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(samples.astype('<i2').tobytes())
            chunks = list(rms._decode_mono_f32_chunks(source, ffmpeg))
        self.assertLessEqual(max(len(x) for x in chunks), 16384)
        np.testing.assert_array_equal(np.concatenate(chunks), samples.astype(np.float32) / 32768)


if __name__ == '__main__':
    unittest.main()
