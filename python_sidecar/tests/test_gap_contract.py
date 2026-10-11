import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from main import _fill_unvoiced_gaps


class GapContractTests(unittest.TestCase):
    def cue(self, start, end, text="말"):
        return {"start": start, "end": end, "text": text,
                "words": [{"id": "word-1", "start": start, "end": end, "word": text,
                           "alignmentStatus": "manual", "manualEndLocked": True}]}

    def test_small_gaps_extend_display_but_not_speech(self):
        raw = [self.cue(0, 1), self.cue(1.05, 2)]
        before = copy.deepcopy(raw)
        result = _fill_unvoiced_gaps(raw, 2.05)
        self.assertEqual(result[0]["end"], 1.05)
        self.assertEqual(result[0]["words"][0]["end"], 1)
        self.assertEqual(result[1]["words"][0]["end"], 2)
        self.assertEqual(result[0]["words"][0]["alignmentStatus"], "manual")
        self.assertTrue(result[0]["words"][0]["manualEndLocked"])
        self.assertEqual(raw, before)

    def test_overlapping_speakers_are_not_deleted_or_shifted(self):
        result = _fill_unvoiced_gaps([self.cue(0, 2), self.cue(1, 1.5, "겹말")], 3)
        self.assertEqual(result[1]["start"], 1)
        self.assertEqual(result[1]["end"], 1.5)
        self.assertEqual(result[2]["start"], 2)

    def test_nonfinite_boundaries_are_rejected(self):
        result = _fill_unvoiced_gaps([self.cue(0, float("inf"))], 2)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["text"].strip(), "--")


if __name__ == '__main__':
    unittest.main()
