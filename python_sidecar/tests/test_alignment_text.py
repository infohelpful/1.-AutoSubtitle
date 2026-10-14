import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_text import build_alignment_text, native_number
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
        for display in ['3배', '1번', '3분', '1분의3', '2026-10-11', '010초', 'RTX4060', '-3초']:
            result = build_alignment_text(display)
            self.assertEqual(result['text'], display)
            self.assertIn('ambiguous_number_reading', result['reviewReasons'])
        self.assertEqual(build_alignment_text('캡쳐')['text'], '캡쳐')

    def test_unknown_english_words_are_not_guessed(self):
        # 사전에 없는 소문자 영단어는 읽기를 만들지 않는다 — 정렬되지 않은 채(원본 시간) 남는 쪽이 낫다.
        for display in ['hello', 'vhad,', 'foobar를']:
            result = build_alignment_text(display)
            self.assertEqual(result['text'], display)
            self.assertNotIn('reading_generated', result['reviewReasons'])

    def test_english_acronyms_and_particles_get_a_korean_reading(self):
        for display, expected in [('ISO', '아이에스오'), ('USB에', '유에스비에'), ('USB를', '유에스비를'),
                                  ('D드라이브나', '디드라이브나'), ('V링크를', '브이링크를'), ('PC에', '피씨에'),
                                  ('SSD나', '에스에스디나'), ('GUID와', '구이드와'), ('ntfs,', '엔티에프에스,'),
                                  ('.iso', '.아이에스오'), ('-Link', '-링크'), ('vlink', '브이링크'),
                                  ('successfully', '석세스풀리'), ('The', '더')]:
            result = build_alignment_text(display)
            self.assertEqual(result['text'], expected, display)
            self.assertIn('reading_generated', result['reviewReasons'])
            self.assertEqual(result['textSpanMap'][0]['displayStart'], 0)
            self.assertEqual(result['textSpanMap'][-1]['displayEnd'], len(display))

    def test_numbers_with_units_and_counters(self):
        for display, expected in [('32kb짜리', '삼십이킬로바이트짜리'), ('8GB가', '팔기가바이트가'),
                                  ('8기가바이트나', '팔기가바이트나'), ('383바이트', '삼백팔십삼바이트'),
                                  ('1순위로', '일순위로'), ('4가지', '네가지'), ('3개', '세개'),
                                  ('2명', '두명'), ('20개', '스무개')]:
            result = build_alignment_text(display)
            self.assertEqual(result['text'], expected, display)
            self.assertIn('number_reading_normalized', result['reviewReasons'])

    def test_standalone_numbers_and_identifiers_inside_words(self):
        for display, expected in [('11', '십일'), ('1', '일'), ('fat32', '팻삼십이'), ('CRC32C', '씨알씨삼십이씨'),
                                  ('벤토이2', '벤토이이'), ('windows11clientx64', '윈도우십일클라이언트엑스육십사')]:
            result = build_alignment_text(display)
            self.assertEqual(result['text'], expected, display)
            self.assertIn('ambiguous_number_reading', result['reviewReasons'])
            self.assertIn('reading_generated', result['reviewReasons'])

    def test_native_numbers(self):
        self.assertEqual([native_number(n) for n in (1, 2, 3, 4, 10, 11, 20, 21, 99)],
                         ['한', '두', '세', '네', '열', '열한', '스무', '스물한', '아흔아홉'])
        self.assertIsNone(native_number(0))
        self.assertIsNone(native_number(100))

    def test_plain_korean_is_unchanged_and_mapped_per_character(self):
        result = build_alignment_text('안녕하세요')
        self.assertEqual(result['text'], '안녕하세요')
        self.assertEqual(result['reviewReasons'], [])
        self.assertEqual(len(result['textSpanMap']), 5)

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

    def test_generated_english_reading_aligns_and_keeps_the_displayed_word(self):
        display = {'id': 'usb', 'word': 'USB에', 'start': 0, 'end': 2}
        prepared = build_alignment_text(display['word'])
        self.assertEqual(prepared['text'], '유에스비에')
        chars = [{'char': c, 'start': .1 + i*.2, 'end': .2 + i*.2, 'score': .9}
                 for i, c in enumerate(prepared['text'])]
        dictionary = {c: i for i, c in enumerate('유에스비')}
        result = apply_character_alignment([display], chars, dictionary, 2, 's', 'a'*40, [prepared])[0]
        self.assertEqual(result['word'], 'USB에')
        self.assertEqual(result['alignmentStatus'], 'aligned')
        self.assertIn('reading_generated', result['reviewReasons'])
        self.assertAlmostEqual(result['sourceStart'], .1)
        self.assertAlmostEqual(result['sourceEnd'], .2 + 4*.2)

    def test_explicit_reading_and_missing_model_syllables_are_auditable(self):
        item = build_alignment_text('3배', '세 배')
        self.assertEqual(item['text'], '세 배')
        self.assertIn('reading_override', item['reviewReasons'])
        self.assertEqual(item['textSpanMap'][0]['displayEnd'], 2)


if __name__ == '__main__':
    unittest.main()
