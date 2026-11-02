import copy
import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_endings import trim_quiet_word_ends


class AlignmentEndingsTests(unittest.TestCase):
    def setUp(self):
        self.audio = np.zeros(16000 * 2, dtype=np.float32)
        self.audio[:16000] = .1
        self.word = {'start': .4, 'end': 1.3, 'sourceEnd': 1.3, 'alignmentStatus': 'aligned',
                     'charSpans': [{'char': '다', 'start': .8, 'end': 1.3, 'score': .9}]}

    def test_sustained_silence_trim_preserves_engine_estimate_and_input(self):
        before = copy.deepcopy(self.word)
        after, = trim_quiet_word_ends([self.word], self.audio)
        self.assertAlmostEqual(after['end'], 1.02)
        self.assertEqual(after['sourceEnd'], 1.3)
        self.assertEqual(after['charSpans'][0]['end'], after['end'])
        self.assertEqual(self.word, before)

    def test_short_internal_dip_and_quiet_consonant_release_are_retained(self):
        self.audio[12800:13440] = 0  # 40ms internal dip
        self.audio[16000:17600] = .004  # quiet 100ms ending
        after, = trim_quiet_word_ends([self.word], self.audio)
        self.assertAlmostEqual(after['end'], 1.12)

    def test_manual_end_and_uncertain_alignment_are_untouched(self):
        for extra in [{'manualEndLocked': True}, {'alignmentStatus': 'unaligned'}]:
            word = {**self.word, **extra}
            self.assertEqual(trim_quiet_word_ends([word], self.audio), [word])

    def test_background_or_missing_audio_cannot_establish_a_quiet_tail(self):
        for audio in [np.full(32000, .03), np.zeros(32000), np.full(32000, np.nan)]:
            self.assertEqual(trim_quiet_word_ends([self.word], audio), [self.word])
