"""Trim only sustained quiet tails; never extend guesses across unknown speech."""
from __future__ import annotations

import copy
import numpy as np


def trim_quiet_word_ends(words: list[dict], audio: np.ndarray, sample_rate: int = 16000) -> list[dict]:
    result = []
    hop = max(1, round(sample_rate * .01))
    for original in words:
        word = copy.deepcopy(original)
        result.append(word)
        if word.get('manualEndLocked') or word.get('alignmentStatus') not in ('aligned', 'manual'):
            continue
        start, end = word['start'], word['end']
        # Only the last 600ms are inspected. Long ambiguous/quiet words remain
        # reviewable rather than being relocated to an unrelated earlier sound.
        first, last = max(0, int(max(start, end - .6) * sample_rate)), min(len(audio), int(end * sample_rate))
        samples = audio[first:last]
        count = len(samples) // hop
        if count < 12 or not np.isfinite(samples).all():
            continue
        rms = np.sqrt(np.mean(samples[:count * hop].reshape(count, hop) ** 2, axis=1))
        level = float(np.percentile(rms, 90))
        if level < .01:  # insufficient evidence in very quiet/empty windows
            continue
        gate = max(10 ** (-55 / 20), level * .02)
        active = np.flatnonzero(rms > gate)
        if len(active) < 5 or count - int(active[-1]) - 1 < 8:
            continue
        candidate = (first + (int(active[-1]) + 1) * hop) / sample_rate + .02
        if candidate < start + .08 or end - candidate < .06:
            continue
        # Keep the last measured syllable, including a quiet consonant release.
        spoken = [c for c in word.get('charSpans', []) if str(c.get('char', '')).isalnum()]
        if spoken and candidate < spoken[-1]['start'] + .02:
            continue
        word['end'] = round(candidate, 6)
        word['reviewReasons'] = list(dict.fromkeys([*word.get('reviewReasons', []), 'quiet_tail_trimmed']))
        # sourceEnd preserves the engine estimate. Editing spans must stay within
        # the usable word interval; punctuation has no independent audio span.
        if 'charSpans' in word:
            word['charSpans'] = [{**c, 'end': min(c['end'], word['end'])}
                                 for c in word['charSpans'] if c.get('start', end) < word['end']]
    return result
