import { describe, expect, it } from 'vitest'
import {
  alignScriptToTimedLines,
  decodeTextBuffer,
  parseSubtitleCues,
  splitScriptText,
  srtCuesToSubtitleLines
} from './scriptImport'
import { displayTextFromSubtitleWords, type SubtitleLine, type SubtitleWord } from './subtitles'

describe('decodeTextBuffer', () => {
  it('decodes UTF-8 with and without BOM', () => {
    const body = new TextEncoder().encode('안녕')
    expect(decodeTextBuffer(body)).toEqual({ text: '안녕', encoding: 'utf-8' })
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body])
    expect(decodeTextBuffer(withBom)).toEqual({ text: '안녕', encoding: 'utf-8' })
  })

  it('decodes UTF-16LE with BOM', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00])
    expect(decodeTextBuffer(bytes)).toEqual({ text: 'Hi', encoding: 'utf-16le' })
  })

  it('falls back to EUC-KR when bytes are not valid UTF-8', () => {
    // "안녕" in CP949 / EUC-KR
    const bytes = new Uint8Array([0xbe, 0xc8, 0xb3, 0xe7])
    expect(decodeTextBuffer(bytes)).toEqual({ text: '안녕', encoding: 'euc-kr' })
  })
})

describe('parseSubtitleCues', () => {
  const srt = [
    '﻿1',
    '00:00:01,000 --> 00:00:03,500',
    '안녕하세요',
    '여러분',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,000',
    '<i>반갑습니다</i> {\\an8}',
    '',
    '3',
    'not a timing line',
    '내용만 있음',
    ''
  ].join('\r\n')

  it('parses SRT cues, joins multi-line text and strips markup', () => {
    const { cues, skippedBlocks } = parseSubtitleCues(srt)
    expect(cues).toEqual([
      { start: 1, end: 3.5, text: '안녕하세요 여러분' },
      { start: 4, end: 6, text: '반갑습니다' }
    ])
    expect(skippedBlocks).toBe(1)
  })

  it('parses WebVTT timings without hours', () => {
    const vtt = 'WEBVTT\n\n00:01.500 --> 00:02.250\nhello\n'
    expect(parseSubtitleCues(vtt).cues).toEqual([{ start: 1.5, end: 2.25, text: 'hello' }])
  })

  it('reads short fractions as milliseconds', () => {
    const { cues } = parseSubtitleCues('1\n00:00:01,5 --> 00:00:02,25\nx\n')
    expect(cues[0]).toEqual({ start: 1.5, end: 2.25, text: 'x' })
  })

  it('returns nothing for empty or non-subtitle text', () => {
    expect(parseSubtitleCues('').cues).toEqual([])
    expect(parseSubtitleCues('그냥 대본 한 줄').cues).toEqual([])
  })
})

describe('srtCuesToSubtitleLines', () => {
  it('does not extend a short cue into the next cue to fit estimated words', () => {
    const [line] = srtCuesToSubtitleLines([{ start: 300, end: 300.02, text: '하나 둘 셋 넷 다섯' }])
    expect(line.end).toBe(300.02)
    expect(line.words!.every(w => w.start >= 300 && w.end <= 300.02 && w.end > w.start)).toBe(true)
  })
  it('keeps cue times and spreads word times inside the cue', () => {
    const lines = srtCuesToSubtitleLines([{ start: 1, end: 3, text: '가나 다라마바' }])
    expect(lines).toHaveLength(1)
    const line = lines[0]!
    expect([line.start, line.end, line.text]).toEqual([1, 3, '가나 다라마바'])
    const words = line.words!
    expect(words.map((w) => w.word)).toEqual(['가나', '다라마바'])
    expect(words[0]!.start).toBe(1)
    expect(words[words.length - 1]!.end).toBeCloseTo(3, 6)
    expect(words[0]!.end).toBeCloseTo(words[1]!.start, 6)
    expect(words[0]!.end - words[0]!.start).toBeLessThan(words[1]!.end - words[1]!.start)
    expect(words.every((w) => w.alignmentStatus === 'estimated' && w.engine === 'srt-import')).toBe(true)
  })
})

describe('splitScriptText', () => {
  const raw = '안녕하세요. 반갑습니다!\n두 번째 줄 / 슬래시 뒤\r\n\n마지막'

  it('splits on line breaks by default', () => {
    expect(splitScriptText(raw)).toEqual(['안녕하세요. 반갑습니다!', '두 번째 줄 / 슬래시 뒤', '마지막'])
  })

  it('can join lines, and split on punctuation and slashes', () => {
    expect(splitScriptText(raw, { atLinebreak: false, atPunctuation: true, atSlash: true })).toEqual([
      '안녕하세요.',
      '반갑습니다!',
      '두 번째 줄',
      '슬래시 뒤 마지막'
    ])
  })
})

function timedLine(tokens: Array<[string, number, number]>): SubtitleLine {
  const words: SubtitleWord[] = tokens.map(([word, start, end]) => ({ word, start, end }))
  return {
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text: displayTextFromSubtitleWords(words),
    words
  }
}

describe('alignScriptToTimedLines', () => {
  it('preserves matched speech anchors when inserted words have no free gap', () => {
    const source = [timedLine([['컴퓨터', 300, 300.5], ['확인하세요', 300.5, 301], ['끝입니다', 301, 302]])]
    const result = alignScriptToTimedLines(['컴퓨터 새로운 단어를 확인하세요 끝입니다'], source)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const words = result.lines[0].words!
    expect(words.find(w => w.word === '확인하세요')).toMatchObject({ start: 300.5, end: 301 })
    expect(words.find(w => w.word === '끝입니다')).toMatchObject({ start: 301, end: 302 })
    expect(words.filter(w => !w.rawStart).every(w => w.end <= 300.5)).toBe(true)
    expect(words.find(w => w.word === '새로운')?.reviewReasons).toContain('script_time_overlap')
  })

  it('bounds leading interpolations by the first recognized anchor', () => {
    const result = alignScriptToTimedLines(['추가 문장입니다 컴퓨터 확인하세요'], [timedLine([['컴퓨터', .01, .5], ['확인하세요', .5, 1]])])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines[0].words!.find(w => w.word === '컴퓨터')).toMatchObject({ start: .01, end: .5 })
    expect(result.lines[0].words!.slice(0, 2).every(w => w.end <= .01)).toBe(true)
  })
  // 음성 인식 결과(오인식 포함) — "오늘은 날씨가 정말 좋습니다 산책을 합니다"
  const asr = [
    timedLine([
      ['오늘은', 0.0, 0.5],
      ['날씨가', 0.6, 1.1],
      ['정말', 1.2, 1.6],
      ['좋습니다', 1.7, 2.3]
    ]),
    timedLine([
      ['산책을', 4.0, 4.6],
      ['합니다', 4.7, 5.2]
    ])
  ]

  it('transfers recognized word times to script lines', () => {
    const result = alignScriptToTimedLines(['오늘은 날씨가 정말 좋습니다', '산책을 합니다'], asr)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0]!.text).toBe('오늘은 날씨가 정말 좋습니다')
    expect(result.lines[0]!.start).toBe(0)
    expect(result.lines[0]!.end).toBe(2.3)
    expect(result.lines[1]!.start).toBe(4)
    expect(result.stats.matched).toBe(6)
    expect(result.stats.interpolated).toBe(0)
  })

  it('uses the script text and interpolates words the recognizer got wrong', () => {
    // "날씨가" 가 "날시가" 로, "정말" 이 "저말" 로 오인식된 경우 — 대본 철자를 유지한다.
    const noisy = [
      timedLine([
        ['오늘은', 0.0, 0.5],
        ['날시가', 0.6, 1.1],
        ['저말', 1.2, 1.6],
        ['좋습니다', 1.7, 2.3]
      ])
    ]
    const result = alignScriptToTimedLines(['오늘은 날씨가 정말 좋습니다'], noisy)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines[0]!.words!.map((w) => w.word)).toEqual(['오늘은', '날씨가', '정말', '좋습니다'])
  })

  it('interpolates script words that have no recognized counterpart, monotonically', () => {
    const result = alignScriptToTimedLines(['오늘은 정말 맑은 날씨가 정말 좋습니다', '산책을 합니다'], asr)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stats.interpolated).toBeGreaterThan(0)
    const words = result.lines.flatMap((l) => l.words ?? [])
    for (let i = 1; i < words.length; i += 1) {
      expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.end - 1e-9)
      expect(words[i]!.end).toBeGreaterThan(words[i]!.start)
    }
    const flagged = words.filter((w) => w.reviewReasons?.includes('script_time_interpolated'))
    expect(flagged.length).toBe(result.stats.interpolated)
  })

  it('fails clearly when the script does not resemble the recognized text', () => {
    const result = alignScriptToTimedLines(['전혀 다른 내용의 대본 입니다 하나 둘 셋'], asr)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('low_match')
  })

  it('fails when there is no timed source or no script', () => {
    const none = alignScriptToTimedLines(['대본'], [])
    expect(none.ok === false && none.reason).toBe('no_timing_source')
    const empty = alignScriptToTimedLines(['   '], asr)
    expect(empty.ok === false && empty.reason).toBe('no_script')
  })

  it('ignores silence, deleted and noise tokens in the timed source', () => {
    const withNoise: SubtitleLine = {
      start: 0,
      end: 3,
      text: '',
      words: [
        { word: '안녕', start: 0, end: 0.5 },
        { word: '--', start: 0.5, end: 1, isSilence: true },
        { word: '지워짐', start: 1, end: 1.5, isDeleted: true },
        { word: '하세요', start: 1.5, end: 2 }
      ]
    }
    const result = alignScriptToTimedLines(['안녕 하세요'], [withNoise])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stats.asrTokens).toBe(2)
    expect(result.stats.matched).toBe(2)
  })
})
