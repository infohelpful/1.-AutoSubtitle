import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class TranscribeFallbackTests(unittest.TestCase):
    def test_lazy_cuda_error_retries_whole_transcript_without_partial_duplicates(self):
        def broken():
            yield SimpleNamespace(end=1)
            raise RuntimeError('cublas64_12.dll not found')
        cpu_segment = SimpleNamespace(end=2)
        gpu = SimpleNamespace(transcribe=lambda *a, **kw: (broken(), SimpleNamespace(duration=2)))
        cpu = SimpleNamespace(transcribe=lambda *a, **kw: ([cpu_segment], SimpleNamespace(duration=2)))
        def reload():
            main._whisper_model = cpu
            main._model_device = 'cpu'
        with patch.object(main, '_whisper_model', gpu), patch.object(main, '_model_device', 'cuda'), \
             patch.object(main, '_force_reload_model_cpu', side_effect=reload) as fallback, \
             patch.object(main, '_emit_transcribe_progress'):
            segments, _, used_cpu = main._collect_transcription('audio')
            self.assertEqual(segments, [cpu_segment])
            self.assertTrue(used_cpu)
            fallback.assert_called_once()

    def test_non_cuda_errors_are_not_hidden(self):
        model = SimpleNamespace(transcribe=lambda *a, **kw: (_ for _ in ()).throw(ValueError('bad media')))
        with patch.object(main, '_whisper_model', model), patch.object(main, '_model_device', 'cuda'):
            with self.assertRaisesRegex(ValueError, 'bad media'):
                main._collect_transcription('audio')
