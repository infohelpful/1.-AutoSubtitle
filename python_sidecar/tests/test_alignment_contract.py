import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_contract import apply_character_alignment, alignment_summary
from alignment_quality import evaluate_boundaries


class AlignmentContractTests(unittest.TestCase):
    def apply(self, words, chars, dictionary=None):
        return apply_character_alignment(words, chars, dictionary or {"가": 0, "나": 1}, 10, "segment-a", "a" * 40)

    def test_repeated_words_use_character_occurrences(self):
        words = [{"word": "가", "start": 0, "end": 1}, {"word": "가", "start": 1, "end": 2}]
        chars = [{"char": "가", "start": .2, "end": .5, "score": .9},
                 {"char": " ", "start": .5, "end": 1, "score": .8},
                 {"char": "가", "start": 1.2, "end": 1.5, "score": .9}]
        result = self.apply(words, chars)
        self.assertEqual([w["sourceStart"] for w in result], [.2, 1.2])
        self.assertNotEqual(result[0]["id"], result[1]["id"])
        self.assertEqual(result[0]["rawStart"], 0)

    def test_unalignable_digits_and_null_scores_are_not_reported_as_aligned(self):
        words = [{"word": "3가", "start": 0, "end": 1}]
        chars = [{"char": "3", "start": .1, "end": .2, "score": .9},
                 {"char": "가", "start": .2, "end": .5, "score": .9}]
        result = self.apply(words, chars)
        self.assertEqual(result[0]["alignmentStatus"], "unaligned")
        self.assertIsNone(result[0]["sourceStart"])
        self.assertEqual(result[0]["start"], 0)
        self.assertEqual(alignment_summary(result)["alignedCoverage"], 0)

    def test_mismatched_engine_text_is_not_zipped_by_index(self):
        result = self.apply([{"word": "가", "start": 0, "end": 1}], [{"char": "나", "start": 0, "end": .5, "score": 1}])
        self.assertIn("character_mapping_mismatch", result[0]["reviewReasons"])

    def test_punctuation_does_not_extend_speech_and_manual_boundary_is_preserved(self):
        result = self.apply([{"word": "가!", "start": .15, "end": 1, "manualStartLocked": True}],
                            [{"char": "가", "start": .2, "end": .5, "score": .9}, {"char": "!", "end": 1}])
        self.assertEqual(result[0]["start"], .15)
        self.assertEqual(result[0]["end"], .5)
        self.assertEqual(result[0]["alignmentStatus"], "manual")

    def test_end_stretched_across_a_pause_is_clamped_near_the_asr_end(self):
        # 문장 끝 뒤 3초 침묵: 마지막 글자의 끝이 다음 단어 직전(4.0)까지 늘어난 경우
        words = [{"word": "가나", "start": 0, "end": 1.0}]
        chars = [{"char": "가", "start": .2, "end": .5, "score": .9},
                 {"char": "나", "start": .5, "end": 4.0, "score": .9}]
        result = self.apply(words, chars)[0]
        self.assertEqual(result["alignmentStatus"], "aligned")
        self.assertAlmostEqual(result["end"], 1.4)          # 원본 끝 1.0 + 0.4
        self.assertEqual(result["sourceEnd"], 4.0)           # 엔진 추정치는 보존
        self.assertEqual(result["rawEnd"], 1.0)
        self.assertIn("end_clamped_to_asr", result["reviewReasons"])

    def test_normal_and_slightly_late_ends_are_not_clamped(self):
        words = [{"word": "가", "start": 0, "end": 1.0}, {"word": "나", "start": 1.0, "end": 1.4}]
        chars = [{"char": "가", "start": .1, "end": 1.3, "score": .9},   # 원본 끝보다 0.3 늦음(허용)
                 {"char": "나", "start": 1.5, "end": 2.3, "score": .9}]  # 길이 0.8 < 1.0
        first, second = self.apply(words, chars)
        self.assertEqual(first["end"], 1.3)
        self.assertEqual(second["end"], 2.3)
        self.assertNotIn("end_clamped_to_asr", first["reviewReasons"] + second["reviewReasons"])

    def test_long_but_late_word_is_not_clamped_when_end_is_near_raw(self):
        # 정말 길게 발음한 단어(1.5초)가 원본 끝과 0.4초 이내면 그대로 둔다.
        words = [{"word": "가", "start": 0, "end": 1.6}]
        result = self.apply(words, [{"char": "가", "start": .1, "end": 1.9, "score": .9}])[0]
        self.assertEqual(result["end"], 1.9)

    def test_manual_end_lock_prevents_clamping(self):
        words = [{"word": "가", "start": 0, "end": 3.9, "manualEndLocked": True, "rawEnd": 1.0}]
        result = self.apply(words, [{"char": "가", "start": .1, "end": 4.0, "score": .9}])[0]
        self.assertEqual(result["end"], 3.9)
        self.assertEqual(result["alignmentStatus"], "manual")

    def test_missing_boundaries_remain_in_evaluation_denominator(self):
        labels = [{"id": "a", "start": 0, "end": 1}, {"id": "b", "start": 1, "end": 2}]
        result = evaluate_boundaries(labels, [{"id": "a", "sourceStart": .05, "sourceEnd": 1.1, "alignmentStatus": "aligned"}])
        self.assertEqual(result["coverage"], .5)
        self.assertEqual(result["missingIds"], ["b"])
        self.assertAlmostEqual(result["start"]["medianMs"], 50)

    def test_duplicate_ids_are_rejected(self):
        with self.assertRaises(ValueError):
            evaluate_boundaries([{"id": "a"}, {"id": "a"}], [])


if __name__ == '__main__':
    unittest.main()
