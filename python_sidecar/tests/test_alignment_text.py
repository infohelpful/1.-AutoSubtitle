import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_text import build_alignment_text
from alignment_contract import apply_character_alignment


class AlignmentTextTests(unittest.TestCase):
    def test_clear_unit_readings_preserve_display_mapping(self):
        for display, expected in [('1초만에', '일초만에'), ('5종을', '오종을'), ('12초', '십이초'),
                                  ('1.5초', '일점오초'), ('10000원', '만원')]:
            result = build_alignment_text(display)
            self.assertEqual(result['text'], expected)
            for span in result['textSpanMap']:
                self.assertLess(span['displayStart'], span['displayEnd'])
                self.assertLess(span['alignmentStart'], span['alignmentEnd'])
            self.assertEqual(result['textSpanMap'][-1]['alignmentEnd'], len(expected))

    def test_ambiguous_counters_identifiers_and_dates_are_not_guessed(self):
        for display in ['3배', '3개', '1번', '3분', '1분의3', '2026-10-11', '010초', 'RTX4060', '1', '-3초']:
            result = build_alignment_text(display)
            self.assertEqual(result['text'], display)
            self.assertIn('ambiguous_number_reading', result['reviewReasons'])
        self.assertEqual(build_alignment_text('캡쳐')['text'], '캡쳐')

    def test_expansion_maps_times_back_to_original_word_identity(self):
        display = {'id': 'one', 'word': '12초', 'start': 0, 'end': 2}
        prepared = build_alignment_text(display['word'])
        chars = [{'char': c, 'start': .1 + i*.2, 'end': .2 + i*.2, 'score': .9}
                 for i, c in enumerate(prepared['text'])]
        result = apply_character_alignment([display], chars, {c: i for i, c in enumerate('십이초')},
                                           2, 's', 'a'*40, [prepared])[0]
        self.assertEqual(result['id'], 'one')
        self.assertEqual(result['word'], '12초')
        self.assertEqual(result['alignmentText'], '십이초')
        self.assertEqual(result['alignmentStatus'], 'aligned')
        self.assertEqual(result['sourceStart'], .1)

    def test_explicit_reading_and_missing_model_syllables_are_auditable(self):
        item = build_alignment_text('3배', '세 배')
        self.assertEqual(item['text'], '세 배')
        self.assertIn('reading_override', item['reviewReasons'])
        self.assertEqual(item['textSpanMap'][0]['displayEnd'], 2)
