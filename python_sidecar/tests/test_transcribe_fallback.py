import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from alignment_runner import AlignmentUnavailable
import rms_vad_word_align


class TranscribeFallbackTests(unittest.TestCase):
    def test_rms_decode_failure_keeps_whisper_times_and_reports_actual_engine(self):
        segment = SimpleNamespace(start=.5, end=1, text='말', words=[SimpleNamespace(start=.5, end=1, word='말')])
        with patch.object(main, '_whisper_model', object()), \
             patch.object(main, '_resolve_existing_file', return_value='test.mp4'), \
             patch.object(main, '_collect_transcription', return_value=([segment], SimpleNamespace(duration=1), False)), \
             patch.object(main, '_emit_transcribe_progress'), \
             patch.object(rms_vad_word_align, '_which_ffmpeg', return_value='ffmpeg'), \
             patch.object(rms_vad_word_align, '_decode_mono_f32_chunks', side_effect=RuntimeError('decoder unavailable')):
            result = main.handle('transcribe', {'path': 'test.mp4', 'alignment_mode': 'fast'})
        self.assertEqual(result['alignmentSummary']['appliedEngine'], 'whisper')
        self.assertIn('rms_failed: decoder unavailable', result['alignmentSummary']['reviewReasons'])
        word = next(w for c in result['subtitles'] for w in c['words'] if w['word'] == '말')
        self.assertEqual((word['start'], word['end']), (.5, 1))

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

    def test_initial_accuracy_selection_uses_runtime_and_reports_unavailable_or_non_korean(self):
        segment = SimpleNamespace(start=0, end=1, text='말', words=[SimpleNamespace(start=0, end=1, word='말')])
        for language in ('ko', 'en'):
            info = SimpleNamespace(duration=1, language=language)
            with patch.object(main, '_whisper_model', object()), \
                 patch.object(main, '_resolve_existing_file', return_value='test.mp4'), \
                 patch.object(main, '_collect_transcription', return_value=([segment], info, False)), \
                 patch.object(main, '_which_ffmpeg', return_value='ffmpeg'), \
                 patch.object(main, '_emit_transcribe_progress'), \
                 patch.object(main, 'run_accurate_alignment', side_effect=AlignmentUnavailable('alignment_runtime_missing')) as align, \
                 patch.object(main, 'apply_rms_vad_word_align', side_effect=lambda cues, *args, **kwargs: cues):
                result = main.handle('transcribe', {'path': 'test.mp4', 'alignment_mode': 'accurate', 'alignment_python': 'isolated-python'})
                self.assertEqual(result['alignmentSummary']['requestedEngine'], 'whisperx')
                self.assertEqual(result['alignmentSummary']['appliedEngine'], 'rms')
                self.assertTrue(result['alignmentSummary']['reviewReasons'])
                if language == 'ko':
                    self.assertEqual(align.call_args.kwargs['python'], 'isolated-python')
                else:
                    align.assert_not_called()

    def test_prepared_audio_is_shared_by_asr_rms_and_peaks_without_replacing_original_path(self):
        segment = SimpleNamespace(start=.5, end=1, text='말', words=[SimpleNamespace(start=.5, end=1, word='말')])
        info = SimpleNamespace(duration=3, language='ko')
        with patch.object(main, '_whisper_model', object()), \
             patch.object(main, '_current_video_path', None), \
             patch.object(main, '_resolve_existing_file', side_effect=lambda path: path), \
             patch.object(main, '_collect_transcription', return_value=([segment], info, False)) as asr, \
             patch.object(main, '_emit_transcribe_progress'), \
             patch.object(main, 'apply_rms_vad_word_align', side_effect=lambda cues, *a, **kw: cues) as rms, \
             patch.object(main, '_waveform_peaks_impl', return_value={'ok': True}) as peaks:
            result = main.handle('transcribe', {'path': 'original.mp4', 'prepared_audio_path': 'canonical.wav',
                                               'alignment_mode': 'fast', 'waveform_out_json_path': 'peaks.json'})
            self.assertEqual(main._current_video_path, 'original.mp4')
            self.assertEqual(asr.call_args.args[0], 'canonical.wav')
            self.assertEqual(rms.call_args.args[1], 'canonical.wav')
            self.assertEqual(peaks.call_args.args[0], 'canonical.wav')
            self.assertEqual(result['raw_subtitles'][0]['words'][0]['start'], .5)
