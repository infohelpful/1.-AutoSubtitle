"""Conservative bridge from character alignment to existing display words.

Missing acoustic times stay null; legacy start/end remain explicitly estimated.
No character-count interpolation or index-only matching of engine words.
"""
from __future__ import annotations

import copy
import math
import unicodedata
from typing import Any


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalized_letters(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFC", text) if not c.isspace())


def apply_character_alignment(words: list[dict], chars: list[dict], dictionary: dict,
                              duration: float, segment_id: str, model_revision: str) -> list[dict]:
    expected = "".join(normalized_letters(str(w.get("word", ""))) for w in words)
    actual_chars = [c for c in chars if not str(c.get("char", "")).isspace()]
    actual = "".join(str(c.get("char", "")) for c in actual_chars)
    matches = actual == expected
    cursor = 0
    result = []
    for index, original in enumerate(words):
        word = copy.deepcopy(original)
        text = normalized_letters(str(word.get("word", "")))
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
                    alignmentText=unicodedata.normalize("NFC", str(word.get("word", ""))),
                    sourceStart=None, sourceEnd=None, alignmentScore=None,
                    engine="whisperx", modelRevision=model_revision,
                    alignmentStatus="unaligned", reviewReasons=reasons)
        if not reasons:
            start, end = speech_chars[0]["start"], speech_chars[-1]["end"]
            if word.get("manualStartLocked"):
                start = original.get("start")
            if word.get("manualEndLocked"):
                end = original.get("end")
            if finite(start) and finite(end) and 0 <= start < end <= duration:
                word.update(start=start, end=end, sourceStart=start, sourceEnd=end,
                            alignmentScore=sum(c["score"] for c in speech_chars) / len(speech_chars),
                            alignmentStatus="manual" if word.get("manualStartLocked") or word.get("manualEndLocked") else "aligned",
                            charSpans=copy.deepcopy(selected))
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
