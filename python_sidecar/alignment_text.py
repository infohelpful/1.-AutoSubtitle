"""Korean model input and its explicit mapping back to the displayed spelling.

The displayed word is never changed. Only the text handed to the forced-alignment
model is converted to a Korean reading, and every converted piece is recorded in
`textSpanMap` so the result can be audited.

Conversion is all-or-nothing per word: when any part of a word cannot be read with
confidence (unknown English word, date, model number, ambiguous counter such as
번/배/분), the whole word falls back to the legacy behaviour and stays unaligned
instead of being aligned against a made-up reading.
"""
from __future__ import annotations

import re
import unicodedata

_DIGITS = '영일이삼사오육칠팔구'
_NUMBER = re.compile(r'\d+(?:\.\d+)?', re.ASCII)
_UNIT = re.compile(r'^(?:초|종|원|킬로그램|그램|킬로미터|미터|퍼센트)(?:$|[가-힣])')
_RUN = re.compile(r'([A-Za-z]+)|(\d+(?:\.\d+)?)|([가-힣]+)|(.)', re.DOTALL)

# 영문 한 글자 이름
_LETTERS = {
    'a': '에이', 'b': '비', 'c': '씨', 'd': '디', 'e': '이', 'f': '에프', 'g': '지', 'h': '에이치', 'i': '아이',
    'j': '제이', 'k': '케이', 'l': '엘', 'm': '엠', 'n': '엔', 'o': '오', 'p': '피', 'q': '큐', 'r': '알',
    's': '에스', 't': '티', 'u': '유', 'v': '브이', 'w': '더블유', 'x': '엑스', 'y': '와이', 'z': '제트',
}

# 자주 나오는 영문 단어·약어의 한국어 읽기. 목록에 없는 소문자 영단어는 추측하지 않는다.
_WORDS = {
    # 저장 장치·파일 시스템·파일 형식
    'iso': '아이에스오', 'usb': '유에스비', 'ssd': '에스에스디', 'hdd': '에이치디디', 'cpu': '씨피유',
    'gpu': '지피유', 'ram': '램', 'pc': '피씨', 'os': '오에스', 'ntfs': '엔티에프에스', 'exfat': '이엑스팻',
    'fat': '팻', 'mbr': '엠비알', 'gpt': '지피티', 'guid': '구이드', 'uefi': '유이에프아이', 'efi': '이에프아이',
    'bios': '바이오스', 'vhd': '브이에이치디', 'vhdx': '브이에이치디엑스', 'wim': '윔', 'img': '아이엠지',
    'exe': '이엑스이', 'crc': '씨알씨', 'dll': '디엘엘', 'zip': '집', 'rar': '라', 'pdf': '피디에프',
    'jpg': '제이펙', 'png': '피엔지', 'gif': '지프', 'mp3': '엠피쓰리', 'mp4': '엠피포', 'txt': '텍스트',
    'hdmi': '에이치디엠아이', 'wifi': '와이파이', 'lan': '랜', 'ip': '아이피', 'url': '유알엘',
    'html': '에이치티엠엘', 'css': '씨에스에스', 'js': '제이에스', 'json': '제이슨', 'api': '에이피아이',
    'ui': '유아이', 'ux': '유엑스', 'ai': '에이아이', 'cmd': '씨엠디', 'sdk': '에스디케이', 'cd': '씨디',
    'dvd': '디브이디', 'rgb': '알지비', 'gui': '쥐유아이', 'ftp': '에프티피', 'vpn': '브이피엔',
    'ok': '오케이', 'tv': '티비', 'vs': '브이에스', 'faq': '에프에이큐',
    # 단위
    'kb': '킬로바이트', 'mb': '메가바이트', 'gb': '기가바이트', 'tb': '테라바이트', 'hz': '헤르츠',
    'khz': '킬로헤르츠', 'mhz': '메가헤르츠', 'ghz': '기가헤르츠', 'fps': '에프피에스', 'px': '픽셀',
    'ms': '밀리초', 'kg': '킬로그램', 'cm': '센티미터', 'mm': '밀리미터', 'km': '킬로미터',
    # 제품·서비스·일반 용어
    'windows': '윈도우', 'window': '윈도우', 'linux': '리눅스', 'ubuntu': '우분투', 'ventoy': '벤토이',
    'vlink': '브이링크', 'vlnk': '브이링크', 'link': '링크', 'file': '파일', 'files': '파일즈',
    'create': '크리에이트', 'created': '크리에이티드', 'successfully': '석세스풀리', 'success': '석세스',
    'the': '더', 'to': '투', 'point': '포인트', 'client': '클라이언트', 'server': '서버', 'drive': '드라이브',
    'mac': '맥', 'apple': '애플', 'google': '구글', 'microsoft': '마이크로소프트', 'download': '다운로드',
    'install': '인스톨', 'setup': '셋업', 'boot': '부트', 'secure': '시큐어', 'update': '업데이트',
    'error': '에러', 'open': '오픈', 'save': '세이브', 'new': '뉴', 'edit': '에디트', 'copy': '카피',
    'paste': '페이스트', 'yes': '예스', 'no': '노', 'version': '버전', 'pro': '프로', 'home': '홈',
    'start': '스타트', 'stop': '스톱', 'select': '셀렉트', 'cancel': '캔슬', 'delete': '딜리트',
    'format': '포맷', 'partition': '파티션', 'disk': '디스크', 'folder': '폴더', 'program': '프로그램',
    'youtube': '유튜브', 'chrome': '크롬', 'edge': '엣지', 'github': '깃허브',
}

# 숫자 바로 뒤에서 한자어 수사로 읽는 한글 단위(정확한 단위만)
_SINO_UNITS = ('킬로바이트', '메가바이트', '기가바이트', '테라바이트', '바이트', '비트', '순위', '단계',
               '퍼센트', '헤르츠', '프레임', '픽셀', '킬로그램', '그램', '킬로미터', '미터', '센티미터',
               '밀리미터', '초', '종', '원', '년', '프로', '위', '주차')
# 고유어 수사로 읽는 셈 단위
_NATIVE_COUNTERS = ('가지', '개', '명', '마리', '곳')
# 단독 숫자 뒤에 올 수 있는 조사(숫자를 한자어로 읽는다)
_PARTICLES = ('은', '는', '이', '가', '을', '를', '의', '에', '도', '와', '과', '로', '으로', '만', '부터', '까지',
              '보다', '이나', '나', '이랑', '랑', '에서', '이고', '이라', '이며')
_LATIN_UNITS = frozenset({'kb', 'mb', 'gb', 'tb', 'hz', 'khz', 'mhz', 'ghz', 'fps', 'px', 'ms', 'kg', 'cm', 'mm', 'km'})
_NATIVE_ONES = ('', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉')
_NATIVE_TENS = ('', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔')


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


def native_number(value: int) -> str | None:
    """셈 단위(개·명·가지…) 앞에서 쓰는 고유어 수사. 1~99 만 지원한다."""
    if not 1 <= value <= 99:
        return None
    tens, ones = divmod(value, 10)
    if value == 20:
        return '스무'
    return _NATIVE_TENS[tens] + _NATIVE_ONES[ones]


def _latin_reading(token: str) -> str | None:
    lower = token.lower()
    if lower in _WORDS:
        return _WORDS[lower]
    if len(token) == 1:
        return _LETTERS[lower]
    # 대문자 약어(2~6자)는 글자 이름으로 읽는다. 소문자 일반 단어는 추측하지 않는다.
    if token.isupper() and 2 <= len(token) <= 6:
        return ''.join(_LETTERS[c] for c in lower)
    # 사전 단어 + 사전 단어/한 글자의 붙여 쓴 복합어(clientx → client + x). 모든 조각을 읽을 수 있을 때만.
    if len(token) >= 4:
        for cut in range(2, len(token) - 0):
            left, right = lower[:cut], lower[cut:]
            if left in _WORDS and (right in _WORDS or len(right) == 1):
                return _WORDS[left] + (_WORDS[right] if right in _WORDS else _LETTERS[right])
    return None


def _read_number(piece: str, rest_text: str, next_latin: str | None) -> tuple[str, str] | None:
    """숫자 조각을 한국어로 읽는다. (읽기, 사유) 또는 읽을 수 없으면 None."""
    whole, *fraction = piece.split('.')
    if len(whole) > 1 and whole[0] == '0':
        return None  # 식별자·전화번호 등
    sino = sino_number(whole)
    if sino is None:
        return None
    # 1) 셈 단위 앞: 고유어 수사 ('4가지' → '네가지')
    if not fraction and any(rest_text.startswith(c) for c in _NATIVE_COUNTERS):
        native = native_number(int(whole))
        if native is not None:
            return native, 'number_reading_normalized'
        return sino, 'number_reading_normalized'
    decimal = '점' + ''.join(_DIGITS[int(c)] for c in fraction[0]) if fraction else ''
    # 2) 확실한 단위 앞: 한자어 수사
    if (next_latin is not None and next_latin.lower() in _LATIN_UNITS) or \
            any(rest_text.startswith(u) for u in _SINO_UNITS):
        return sino + decimal, 'number_reading_normalized'
    # 3) 단위가 없으면: 끝이거나 조사·영문(식별자 안의 숫자: fat32, x64)이 이어질 때만 한자어 수사로 읽는다(모호함 표시).
    if rest_text == '' or next_latin is not None or any(rest_text.startswith(p) for p in _PARTICLES):
        return sino + decimal, 'ambiguous_number_reading'
    return None


def _generated_reading(display: str) -> dict | None:
    """영문·숫자가 섞인 단어를 정렬용 한국어 읽기로 바꾼다. 하나라도 읽을 수 없으면 None."""
    runs = _split_runs(display)
    if not any(kind in ('latin', 'digit') for kind, *_ in runs):
        return None
    text, spans, reasons = '', [], set()
    for index, (kind, piece, start, end) in enumerate(runs):
        previous = runs[index - 1] if index else None
        following = runs[index + 1] if index + 1 < len(runs) else None
        if kind == 'latin':
            # 영문 약어 바로 뒤의 긴 숫자(RTX4060 같은 모델 번호)는 읽기가 모호하다.
            if following and following[0] == 'digit' and len(following[1].split('.')[0]) >= 3:
                return None
            reading = _latin_reading(piece)
            if reading is None:
                return None
            reasons.add('reading_generated')
        elif kind == 'digit':
            if previous and previous[0] == 'other' and previous[1] in ('-', '+'):
                return None  # 날짜·범위·부호
            if following and following[0] == 'other' and following[1] in '-/:' and \
                    index + 2 < len(runs) and runs[index + 2][0] == 'digit':
                return None  # 2026-10-11 같은 날짜·시각
            if previous and previous[0] == 'latin' and len(piece.split('.')[0]) >= 3:
                return None  # RTX4060 같은 모델 번호
            rest_text = display[end:]
            next_latin = following[1] if following and following[0] == 'latin' else None
            read = _read_number(piece, rest_text, next_latin)
            if read is None:
                return None
            reading, reason = read
            reasons.add(reason)
            if reason == 'ambiguous_number_reading':
                reasons.add('reading_generated')
        else:
            # 한글·기호는 그대로. 글자 단위로 매핑을 남긴다.
            for offset, ch in enumerate(piece):
                spans.append({'displayStart': start + offset, 'displayEnd': start + offset + 1,
                              'alignmentStart': len(text), 'alignmentEnd': len(text) + 1})
                text += ch
            continue
        spans.append({'displayStart': start, 'displayEnd': end,
                      'alignmentStart': len(text), 'alignmentEnd': len(text) + len(reading)})
        text += reading
    return {'text': text, 'textSpanMap': spans, 'reviewReasons': sorted(reasons)}


def _split_runs(display: str) -> list[tuple[str, str, int, int]]:
    """(종류, 문자열, 시작, 끝) — 종류는 latin / digit / hangul / other."""
    runs = []
    for m in _RUN.finditer(display):
        kind = 'latin' if m.group(1) else 'digit' if m.group(2) else 'hangul' if m.group(3) else 'other'
        runs.append((kind, m.group(), m.start(), m.end()))
    return runs


def _legacy_alignment_text(display: str) -> dict:
    """읽기를 확신할 수 없을 때의 보수적 동작: 명확한 단위만 펼치고 나머지는 그대로 둔다."""
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


def build_alignment_text(display: str, reading: str | None = None) -> dict:
    display = unicodedata.normalize('NFC', display)
    if reading is not None:
        text = unicodedata.normalize('NFC', reading).strip()
        if not text:
            raise ValueError('Pronunciation override must not be empty')
        return {'text': text, 'textSpanMap': [{'displayStart': 0, 'displayEnd': len(display),
                 'alignmentStart': 0, 'alignmentEnd': len(text)}], 'reviewReasons': ['reading_override']}
    generated = _generated_reading(display)
    if generated is not None:
        return generated
    return _legacy_alignment_text(display)
