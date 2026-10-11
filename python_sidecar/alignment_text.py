"""Korean model input and its explicit mapping back to the displayed spelling.

Only unambiguous Sino-Korean units are expanded automatically. Counters such as
개/명/번/배, identifiers, dates and isolated numbers require a supplied reading.
Unsupported syllables are never replaced by a similar-looking model token.
"""
from __future__ import annotations

import re
import unicodedata

_DIGITS = '영일이삼사오육칠팔구'
_NUMBER = re.compile(r'\d+(?:\.\d+)?', re.ASCII)
_UNIT = re.compile(r'^(?:초|종|원|킬로그램|그램|킬로미터|미터|퍼센트)(?:$|[가-힣])')


def sino_number(value: str) -> str | None:
    if len(value) > 12 or (len(value) > 1 and value[0] == '0'):
        return None
    number = int(value)
    if number == 0:
        return '영'
    parts = []
    for group, suffix in ((number // 100000000, '억'), ((number // 10000) % 10000, '만'), (number % 10000, '')):
        if not group:
            continue
        chunk = ''
        for power, unit in ((1000, '천'), (100, '백'), (10, '십'), (1, '')):
            digit = group // power % 10
            if digit:
                chunk += ('' if digit == 1 and unit else _DIGITS[digit]) + unit
        parts.append(('' if chunk == '일' and suffix == '만' else chunk) + suffix)
    return ''.join(parts)


def build_alignment_text(display: str, reading: str | None = None) -> dict:
    display = unicodedata.normalize('NFC', display)
    if reading is not None:
        text = unicodedata.normalize('NFC', reading).strip()
        if not text:
            raise ValueError('Pronunciation override must not be empty')
        return {'text': text, 'textSpanMap': [{'displayStart': 0, 'displayEnd': len(display),
                 'alignmentStart': 0, 'alignmentEnd': len(text)}], 'reviewReasons': ['reading_override']}
    text, spans, reasons = '', [], []
    cursor = 0
    while cursor < len(display):
        match = _NUMBER.match(display, cursor)
        end, piece = cursor + 1, display[cursor]
        if match:
            end, piece = match.end(), match.group()
            prefix_ok = cursor == 0 or display[cursor - 1].isspace()
            if prefix_ok and _UNIT.match(display[end:]):
                whole, *fraction = piece.split('.')
                expanded = sino_number(whole)
                if expanded is not None:
                    piece = expanded + ('점' + ''.join(_DIGITS[int(c)] for c in fraction[0]) if fraction else '')
                    reasons.append('number_reading_normalized')
                else:
                    reasons.append('ambiguous_number_reading')
            else:
                reasons.append('ambiguous_number_reading')
        spans.append({'displayStart': cursor, 'displayEnd': end,
                      'alignmentStart': len(text), 'alignmentEnd': len(text) + len(piece)})
        text += piece
        cursor = end
    return {'text': text, 'textSpanMap': spans, 'reviewReasons': sorted(set(reasons))}
