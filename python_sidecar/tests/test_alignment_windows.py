import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_windows import plan_alignment_windows, merge_window_alignments


class AlignmentWindowTests(unittest.TestCase):
    def setUp(self):
        self.cue = {'start': 0, 'end': 80, 'words': [
            {'id': f'w{i}', 'start': i * 2 + .2, 'end': i * 2 + 1.5, 'word': '말'} for i in range(40)]}

    def results(self, windows):
        return [[dict(w, alignmentStatus='aligned', sourceStart=w['start'], sourceEnd=w['end'])
                 for w in self.cue['words'][c.first:c.last]] for c in windows]

    def test_short_cue_keeps_full_context(self):
        cue = {'start': 0, 'end': 10, 'words': self.cue['words'][:3]}
        window, = plan_alignment_windows(cue, 80)
        self.assertEqual((window.start, window.end, window.core_first, window.core_last), (0, 10, 0, 3))

    def test_long_cue_covers_every_word_once_with_bounded_overlapping_context(self):
        before = copy.deepcopy(self.cue)
        windows = plan_alignment_windows(self.cue, 80)
        self.assertGreater(len(windows), 2)
        self.assertTrue(all(w.end - w.start <= 30 for w in windows))
        self.assertEqual([i for w in windows for i in range(w.core_first, w.core_last)], list(range(40)))
        self.assertLess(windows[1].first, windows[0].last)
        merged = merge_window_alignments(self.cue['words'], windows, self.results(windows))
        self.assertEqual([w['id'] for w in merged], [w['id'] for w in self.cue['words']])
        self.assertTrue(all(w['alignmentStatus'] == 'aligned' for w in merged))
        self.assertEqual(self.cue, before)

    def test_seam_disagreement_keeps_original_manual_bounds_and_marks_review(self):
        windows = plan_alignment_windows(self.cue, 80)
        index = windows[1].first
        self.cue['words'][index]['manualStartLocked'] = True
        results = self.results(windows)
        results[1][0]['sourceStart'] += .5
        merged = merge_window_alignments(self.cue['words'], windows, results)
        self.assertEqual(merged[index]['start'], self.cue['words'][index]['start'])
        self.assertEqual(merged[index]['alignmentStatus'], 'unaligned')
        self.assertIn('chunk_boundary_conflict', merged[index]['reviewReasons'])
        self.assertTrue(merged[index]['manualStartLocked'])

    def test_bad_anchors_and_missing_or_duplicate_results_are_rejected(self):
        bad = copy.deepcopy(self.cue)
        bad['words'][1]['start'] = -1
        with self.assertRaises(ValueError): plan_alignment_windows(bad, 80)
        windows = plan_alignment_windows(self.cue, 80)
        with self.assertRaises(ValueError): merge_window_alignments(self.cue['words'], windows, self.results(windows)[:-1])
        with self.assertRaises(ValueError): merge_window_alignments(self.cue['words'], windows + windows[:1], self.results(windows + windows[:1]))

    def test_long_silence_is_not_forced_into_context(self):
        cue = {'start': 0, 'end': 300, 'words': [self.cue['words'][0], {'id': 'last', 'word': '끝', 'start': 295, 'end': 297}]}
        windows = plan_alignment_windows(cue, 300)
        self.assertEqual(len(windows), 2)
        self.assertTrue(all(w.end - w.start < 5 for w in windows))
