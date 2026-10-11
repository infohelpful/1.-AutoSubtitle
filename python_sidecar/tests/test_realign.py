import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from realign import validate_realign_cues


class RealignTests(unittest.TestCase):
    def setUp(self):
        self.cues = [{'start': 1, 'end': 2, 'words': [
            {'id': 'w1', 'word': '말', 'start': 1, 'end': 2, 'manualStartLocked': True}]}]

    def test_context_padding_does_not_change_locked_word_boundaries(self):
        result = validate_realign_cues(self.cues, 2.1)
        self.assertEqual(result[0]['start'], .8)
        self.assertEqual(result[0]['end'], 2.1)
        self.assertEqual(result[0]['words'], self.cues[0]['words'])
        self.assertEqual(self.cues[0]['start'], 1)

    def test_duplicate_identity_invalid_times_and_non_speech_are_rejected(self):
        duplicate = copy.deepcopy(self.cues)
        duplicate[0]['words'] *= 2
        with self.assertRaisesRegex(ValueError, 'unique'):
            validate_realign_cues(duplicate, 3)
        for patch in [{'start': float('nan')}, {'end': .5}, {'isDeleted': True}, {'isSilence': True}, {'readingOverride': ''}]:
            cues = copy.deepcopy(self.cues)
            cues[0]['words'][0].update(patch)
            with self.assertRaises(ValueError):
                validate_realign_cues(cues, 3)

    def test_replacement_keeps_full_line_context_beyond_the_original_word_slot(self):
        self.cues[0]['end'] = 5
        result = validate_realign_cues(self.cues, 10)
        self.assertEqual(result[0]['end'], 5.2)
