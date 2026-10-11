"""Bounded alignment windows anchored to ASR words, with context-only overlap.

Every original word belongs to exactly one core. Neighbour words provide overlap
context but never produce a second output word. No times are interpolated.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from alignment_contract import finite


@dataclass(frozen=True)
class AlignmentWindow:
    start: float
    end: float
    first: int
    last: int  # exclusive context words
    core_first: int
    core_last: int  # exclusive emitted words


def plan_alignment_windows(cue: dict, duration: float, max_context: float = 30,
                           core_seconds: float = 24, padding: float = .5) -> list[AlignmentWindow]:
    start, end = cue.get('start'), cue.get('end')
    words = cue.get('words') or []
    if not finite(start) or not finite(end) or not 0 <= start < end <= duration + .05:
        raise ValueError('Invalid segment source bounds')
    if not words:
        return []
    if end - start <= max_context:
        return [AlignmentWindow(start, min(end, duration), 0, len(words), 0, len(words))]
    bounds = []
    for word in words:
        a, b = word.get('start'), word.get('end')
        if not finite(a) or not finite(b) or not start <= a < b <= end + .05:
            raise ValueError('Long segment requires word time anchors inside its context')
        if bounds and (a < bounds[-1][0] or b < bounds[-1][1]):
            raise ValueError('Long segment requires monotonic word time anchors')
        if b - a > max_context - 2 * padding:
            raise ValueError('A single word exceeds the alignment context limit')
        bounds.append((a, b))
    windows = []
    first = 0
    while first < len(words):
        last = first + 1
        while last < len(words) and bounds[last][1] - bounds[first][0] <= core_seconds:
            last += 1
        left, right = first, last
        # One neighbouring word on each side, only when it fits. Large silence
        # gaps are not forced into a window just to manufacture overlap.
        if left > 0 and bounds[right - 1][1] - bounds[left - 1][0] <= max_context - 2 * padding:
            left -= 1
        if right < len(words) and bounds[right][1] - bounds[left][0] <= max_context - 2 * padding:
            right += 1
        a = max(start, bounds[left][0] - padding)
        b = min(end, duration, bounds[right - 1][1] + padding)
        windows.append(AlignmentWindow(a, b, left, right, first, last))
        first = last
    return windows


def merge_window_alignments(words: list[dict], windows: list[AlignmentWindow],
                            results: list[list[dict]], disagreement_sec: float = .2) -> list[dict]:
    """Emit core once. Conflicting overlap falls back to original estimated bounds."""
    if len(windows) != len(results):
        raise ValueError('Missing alignment window result')
    output = [None] * len(words)
    candidates: dict[int, list[dict]] = {}
    for window, aligned in zip(windows, results):
        if len(aligned) != window.last - window.first:
            raise ValueError('Alignment window word count mismatch')
        for offset, word in enumerate(aligned):
            index = window.first + offset
            if word.get('id') != words[index].get('id') or word.get('word') != words[index].get('word'):
                raise ValueError('Alignment window word identity mismatch')
            candidates.setdefault(index, []).append(word)
            if window.core_first <= index < window.core_last:
                if output[index] is not None:
                    raise ValueError('Duplicate core word')
                output[index] = copy.deepcopy(word)
    if any(word is None for word in output):
        raise ValueError('Missing core word')
    conflicts = set()
    for index, estimates in candidates.items():
        good = [w for w in estimates if w.get('alignmentStatus') in ('aligned', 'manual')
                and finite(w.get('sourceStart')) and finite(w.get('sourceEnd'))]
        if len(good) > 1 and (max(w['sourceStart'] for w in good) - min(w['sourceStart'] for w in good) > disagreement_sec
                             or max(w['sourceEnd'] for w in good) - min(w['sourceEnd'] for w in good) > disagreement_sec):
            conflicts.add(index)
    for previous, following in zip(windows, windows[1:]):
        i, j = previous.core_last - 1, following.core_first
        a, b = output[i], output[j]
        if a['start'] > b['start'] or a['end'] > b['end']:
            conflicts.update((i, j))
    for index in conflicts:
        word = output[index]
        word.update(start=words[index]['start'], end=words[index]['end'], sourceStart=None, sourceEnd=None,
                    alignmentScore=None, alignmentStatus='unaligned',
                    reviewReasons=sorted(set(word.get('reviewReasons') or []) | {'chunk_boundary_conflict'}))
        word.pop('charSpans', None)
    return output
