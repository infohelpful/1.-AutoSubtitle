"""Evaluation uses every reference word in the denominator, including missing results."""
from __future__ import annotations
import math
import statistics
from alignment_contract import finite


def edit_distance(reference, hypothesis):
    row = list(range(len(hypothesis) + 1))
    for i, left in enumerate(reference, 1):
        current = [i]
        for j, right in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, row[j] + 1, row[j - 1] + (left != right)))
        row = current
    return row[-1]


def evaluate_boundaries(reference: list[dict], predicted: list[dict]) -> dict:
    def by_id(words):
        result = {}
        for word in words:
            if not isinstance(word.get("id"), str) or not word["id"] or word["id"] in result:
                raise ValueError("Evaluation requires unique nonempty word IDs")
            result[word["id"]] = word
        return result
    expected = by_id(reference)
    actual = by_id(predicted)
    start_errors, end_errors = [], []
    missing = []
    for key, label in expected.items():
        if not finite(label.get("start")) or not finite(label.get("end")) or label["end"] <= label["start"]:
            raise ValueError("Invalid reference boundary")
        word = actual.get(key, {})
        if word.get("alignmentStatus") not in ("aligned", "manual") or not finite(word.get("sourceStart")) or not finite(word.get("sourceEnd")):
            missing.append(key)
            continue
        start_errors.append(abs(word["sourceStart"] - label["start"]) * 1000)
        end_errors.append(abs(word["sourceEnd"] - label["end"]) * 1000)
    def summarize(values):
        return {"medianMs": statistics.median(values) if values else None,
                "p95Ms": sorted(values)[math.ceil(len(values) * .95) - 1] if values else None}
    return {"referenceWords": len(expected), "measuredWords": len(start_errors),
            "coverage": len(start_errors) / len(expected) if expected else 0,
            "missingIds": missing, "extraIds": sorted(actual.keys() - expected.keys()),
            "start": summarize(start_errors), "end": summarize(end_errors)}
