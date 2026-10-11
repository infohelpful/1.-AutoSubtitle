"""Validated text-only re-alignment; does not load or rerun the ASR model."""
from __future__ import annotations
import copy
import math


def validate_realign_cues(cues, duration):
    if not isinstance(duration, (float, int)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError('Invalid media duration')
    if not isinstance(cues, list) or not 0 < len(cues) <= 100:
        raise ValueError('Select 1 to 100 subtitle lines')
    seen = set()
    result = copy.deepcopy(cues)
    count = 0
    for cue in result:
        words = cue.get('words') if isinstance(cue, dict) else None
        if not isinstance(words, list) or not words:
            raise ValueError('Every line needs words')
        for word in words:
            count += 1
            if count > 10000 or not isinstance(word, dict):
                raise ValueError('Invalid word count')
            identity = word.get('id')
            if not isinstance(identity, str) or not identity or identity in seen:
                raise ValueError('Words need unique stable IDs')
            seen.add(identity)
            if not isinstance(word.get('word'), str) or not word['word'].strip() or len(word['word']) > 256:
                raise ValueError('Invalid word text')
            start, end = word.get('start'), word.get('end')
            if not all(isinstance(t, (int, float)) and not isinstance(t, bool) and math.isfinite(t) for t in (start, end)):
                raise ValueError('Invalid word timing')
            if not 0 <= start < end <= duration + .05 or word.get('isDeleted') or word.get('isSilence'):
                raise ValueError('Only visible speech words can be aligned')
            reading = word.get('readingOverride')
            if reading is not None and (not isinstance(reading, str) or not reading.strip() or len(reading) > 256):
                raise ValueError('Invalid pronunciation override')
        start, end = cue.get('start'), cue.get('end')
        if not all(isinstance(t, (int, float)) and not isinstance(t, bool) and math.isfinite(t) for t in (start, end)) or not 0 <= start < end:
            raise ValueError('Invalid line context')
        # A text replacement may occupy an old word slot while blank slots still
        # contain speech. Keep the entire line as acoustic context in that case.
        cue['start'] = max(0, min(start, min(w['start'] for w in words)) - .2)
        cue['end'] = min(duration, max(end, max(w['end'] for w in words)) + .2)
    return result
