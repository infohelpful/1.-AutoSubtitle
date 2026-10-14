"""Conservative bridge from character alignment to existing display words.

Missing acoustic times stay null; legacy start/end remain explicitly estimated.
No character-count interpolation or index-only matching of engine words.
"""
from __future__ import annotations

import copy
import math
import unicodedata
from typing import Any


#: 정렬된 끝이 ASR 원본 끝보다 이만큼(초) 넘게 뒤로 가면 늘어난 단어로 본다.
END_OVERHANG_SEC = 0.4
#: 늘어난 단어로 판정하려면 정렬된 길이가 이보다 길어야 한다(정상적인 긴 발음을 자르지 않기 위해).
STRETCHED_MIN_SEC = 1.0
#: 자른 뒤에도 단어에 남겨 두는 최소 길이.
STRETCHED_KEEP_MIN_SEC = 0.3


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def clamp_stretched_end(start: float, end: float, raw_end: Any) -> float | None:
    """다음 발화까지 끝이 늘어난 단어를 ASR 원본 끝 근처로 자른다. 자를 필요가 없으면 None.

    문장 끝 뒤의 긴 침묵에서 CTC 정렬이 마지막 글자의 끝을 다음 단어 직전까지 늘리는 경우가 있다.
    그러면 하이라이트가 침묵 동안 한 단어에 몇 초씩 머문다. 엔진이 낸 `sourceEnd` 는 건드리지 않고
    화면·재생이 쓰는 `end` 만 줄인다.
    """
    if not finite(raw_end) or not finite(start) or not finite(end):
        return None
    if end - start <= STRETCHED_MIN_SEC or end <= raw_end + END_OVERHANG_SEC:
        return None
    return max(raw_end + END_OVERHANG_SEC, start + STRETCHED_KEEP_MIN_SEC)


def normalized_letters(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFC", text) if not c.isspace())


def apply_character_alignment(words: list[dict], chars: list[dict], dictionary: dict,
                              duration: float, segment_id: str, model_revision: str,
                              alignment_inputs: list[dict] | None = None) -> list[dict]:
    if alignment_inputs is not None and len(alignment_inputs) != len(words):
        raise ValueError('Alignment input count must match display words')
    inputs = alignment_inputs or [{"text": str(w.get("word", ""))} for w in words]
    expected = "".join(normalized_letters(i["text"]) for i in inputs)
    actual_chars = [c for c in chars if not str(c.get("char", "")).isspace()]
    actual = "".join(str(c.get("char", "")) for c in actual_chars)
    matches = actual == expected
    cursor = 0
    result = []
    for index, original in enumerate(words):
        word = copy.deepcopy(original)
        input_text = inputs[index]
        text = normalized_letters(input_text["text"])
        selected = actual_chars[cursor:cursor + len(text)] if matches else []
        cursor += len(text)
        # Punctuation has no independent acoustic boundary.
        speech_chars = [c for c in selected if any(ch.isalnum() for ch in str(c.get("char", "")))]
        reasons = []
        if not matches:
            reasons.append("character_mapping_mismatch")
        if any(c.isalnum() and c.lower() not in dictionary for c in text):
            reasons.append("unsupported_character")
        if not speech_chars or any(not finite(c.get("start")) or not finite(c.get("end")) or
                                   not finite(c.get("score")) or not 0 <= c["start"] < c["end"] <= duration
                                   for c in speech_chars):
            reasons.append("missing_or_invalid_character_timing")
        if not reasons and any(a["start"] > b["start"] or a["end"] > b["end"]
                               for a, b in zip(speech_chars, speech_chars[1:])):
            reasons.append("reversed_character_timing")
        word.update(id=word.get("id") or f"{segment_id}:word:{index}", segmentId=segment_id,
                    rawStart=word.get("rawStart", word.get("start")), rawEnd=word.get("rawEnd", word.get("end")),
                    alignmentText=unicodedata.normalize("NFC", input_text["text"]),
                    sourceStart=None, sourceEnd=None, alignmentScore=None,
                    engine="whisperx", modelRevision=model_revision,
                    alignmentStatus="unaligned", reviewReasons=list(reasons) + input_text.get('reviewReasons', []))
        word.pop('charSpans', None)
        word.pop('textSpanMap', None)
        if 'textSpanMap' in input_text:
            word['textSpanMap'] = copy.deepcopy(input_text['textSpanMap'])
        if not reasons:
            start, end = speech_chars[0]["start"], speech_chars[-1]["end"]
            if word.get("manualStartLocked"):
                start = original.get("start")
            if word.get("manualEndLocked"):
                end = original.get("end")
            else:
                clamped = clamp_stretched_end(start, end, word.get("rawEnd"))
                if clamped is not None:
                    end = clamped
                    word["reviewReasons"].append("end_clamped_to_asr")
            if finite(start) and finite(end) and 0 <= start < end <= duration:
                word.update(start=start, end=end, sourceStart=speech_chars[0]['start'], sourceEnd=speech_chars[-1]['end'],
                            alignmentScore=sum(c["score"] for c in speech_chars) / len(speech_chars),
                            alignmentStatus="manual" if word.get("manualStartLocked") or word.get("manualEndLocked") else "aligned",
                            charSpans=[{**copy.deepcopy(char), 'alignmentStart': pos, 'alignmentEnd': pos + 1}
                                       for char, pos in zip(selected, [i for i, c in enumerate(input_text['text']) if not c.isspace()])])
            else:
                word["reviewReasons"].append("manual_boundary_conflict")
        result.append(word)
    return result


def alignment_summary(words: list[dict]) -> dict:
    counts = {state: sum(w.get("alignmentStatus") == state for w in words)
              for state in ("aligned", "estimated", "manual", "unaligned", "stale")}
    return {"totalWords": len(words), "counts": counts,
            "alignedCoverage": counts["aligned"] / len(words) if words else 0,
            "reviewWords": sum(bool(w.get("reviewReasons")) for w in words)}
