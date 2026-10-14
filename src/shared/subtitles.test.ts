import { describe, expect, it } from 'vitest'
import {
  displayTextFromSubtitleWords,
  insertMissingTemporalSilenceGapsInLine,
  mergeConsecutiveSilenceWords,
  mergeConsecutiveSilenceWordsInLine,
  normalizeSilenceWordsForLineWords,
  parseSubtitleLines,
  subtitleLineEditDisplayText,
  subtitleCueLinesForExport
} from './subtitles'
import { scrubTimelineNoiseFromWordPiece } from './wordContract'

describe('scrubTimelineNoiseFromWordPiece', () => {
  it('strips trailing ellipsis glued to Korean', () => {
    expect(scrubTimelineNoiseFromWordPiece('지나가고 ...')).toBe('지나가고')
  })
  it('strips unicode ellipsis', () => {
    expect(scrubTimelineNoiseFromWordPiece(`말\u2026`)).toBe('말')
  })
})

describe('displayTextFromSubtitleWords', () => {
  it('joins without merged continuation crumbs on tokens', () => {
    expect(
      displayTextFromSubtitleWords([
        { start: 0, end: 1, word: 'a ...' },
        { start: 1, end: 2, word: 'b' }
      ])
    ).toBe('a b')
  })
})

describe('subtitleLineEditDisplayText', () => {
  it('omits silence and ellipsis tokens from stored line text when no words', () => {
    expect(subtitleLineEditDisplayText({ text: '-- hello ... -- world' })).toBe('hello world')
  })

  it('uses words-derived when line text matches derived', () => {
    expect(
      subtitleLineEditDisplayText({
        text: 'hi',
        words: [
          { start: 0, end: 1, word: '--', isSilence: true },
          { start: 1, end: 2, word: 'hi' }
        ]
      })
    ).toBe('hi')
  })

  it('prefers stored line text when it differs from words-derived', () => {
    expect(
      subtitleLineEditDisplayText({
        text: '사용자가 고친 문장',
        words: [{ start: 1, end: 2, word: '원본단어' }]
      })
    ).toBe('사용자가 고친 문장')
  })
})

describe('mergeConsecutiveSilenceWords', () => {
  it('does not bridge unclassified audio between separate quiet intervals', () => {
    const words = [
      { start: 0, end: .5, word: '--', isSilence: true },
      { start: .8, end: 1.5, word: '--', isSilence: true }
    ]
    expect(mergeConsecutiveSilenceWords(words)).toEqual(words)
    expect(normalizeSilenceWordsForLineWords(words)).toEqual(words)
  })

  it('keeps manually trimmed silence boundaries separate from adjoining automatic silence', () => {
    const words = [
      { start: 0, end: .5, word: '--', isSilence: true },
      { start: .5, end: 1.5, word: '--', isSilence: true, manualStartLocked: true, manualEndLocked: true }
    ]
    expect(mergeConsecutiveSilenceWords(words)).toEqual(words)
    expect(parseSubtitleLines([{ start: 0, end: 1.5, text: '', words }])[0].words).toEqual(words)
  })

  it('merges adjacent silence blocks into one interval', () => {
    const merged = mergeConsecutiveSilenceWords([
      { start: 0, end: 1, word: '--', isSilence: true },
      { start: 1, end: 2, word: '--', isSilence: true },
      { start: 2, end: 4, word: 'hi' }
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]!.start).toBeCloseTo(0, 4)
    expect(merged[0]!.end).toBeCloseTo(2, 4)
    expect(merged[0]!.word).toBe('--')
    expect(merged[0]!.isSilence).toBe(true)
    expect(merged[1]!.word).toBe('hi')
  })

  it('does not merge across deleted tombstones', () => {
    const merged = mergeConsecutiveSilenceWords([
      { start: 0, end: 1, word: '--', isSilence: true },
      { start: 1, end: 1.5, word: 'x', isDeleted: true },
      { start: 1.5, end: 2, word: '--', isSilence: true }
    ])
    expect(merged).toHaveLength(3)
  })

  it('unions adjacent silence spans (gap + leading silence before speech)', () => {
    const merged = mergeConsecutiveSilenceWords([
      { start: 31.6, end: 32.0, word: '--', isSilence: true },
      { start: 32.0, end: 33.1, word: '--', isSilence: true },
      { start: 33.1, end: 38.77, word: '역시' }
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]!.isSilence).toBe(true)
    expect(merged[0]!.start).toBeCloseTo(31.6, 4)
    expect(merged[0]!.end).toBeCloseTo(33.1, 4)
    expect(merged[1]!.word).toBe('역시')
  })
})

describe('normalizeSilenceWordsForLineWords', () => {
  it('preserves continuation tokens between quiet spans instead of labeling unverified audio as silence', () => {
    const ell = '\u2026'
    const out = normalizeSilenceWordsForLineWords([
      { start: 0, end: 1, word: 'A' },
      { start: 1, end: 1.1, word: ell },
      { start: 1.1, end: 1.3, word: '--', isSilence: true },
      { start: 1.3, end: 1.4, word: ell },
      { start: 1.4, end: 1.6, word: '--', isSilence: true },
      { start: 1.6, end: 3, word: 'B' }
    ])
    expect(out).toHaveLength(6)
    expect(out[0]!.word).toBe('A')
    expect(out[1]!.isSilence).toBeUndefined()
    expect(out[1]!.word).toBe(ell)
    expect(out[3]!.isSilence).toBeUndefined()
    expect(out[3]!.word).toBe(ell)
    expect(out[5]!.word).toBe('B')
  })

  it('does not merge a single -- plus trailing continuation (same-word split tail)', () => {
    const ell = '\u2026'
    const out = normalizeSilenceWordsForLineWords([
      { start: 0, end: 1, word: 'Hello' },
      { start: 1, end: 2, word: '--', isSilence: true },
      { start: 2, end: 3, word: ell }
    ])
    expect(out).toHaveLength(3)
    expect(out[1]!.isSilence).toBe(true)
    expect(out[2]!.word).toBe(ell)
  })
})

describe('insertMissingTemporalSilenceGapsInLine', () => {
  it('inserts -- when two words leave a temporal hole without silence', () => {
    const line = insertMissingTemporalSilenceGapsInLine(
      {
        start: 31,
        end: 39,
        text: '저 역시',
        words: [
          { start: 31.6, end: 32.0, word: '저' },
          { start: 33.5, end: 38.77, word: '역시' }
        ]
      },
      0.08
    )
    const sil = line.words!.filter((w) => w.isSilence === true)
    expect(sil.length).toBeGreaterThanOrEqual(1)
    expect(sil[0]!.start).toBeCloseTo(32.0, 4)
    expect(sil[0]!.end).toBeCloseTo(33.5, 4)
  })

  it('skips insert when overlapping silence already exists', () => {
    const line = insertMissingTemporalSilenceGapsInLine({
      start: 31,
      end: 39,
      text: '저 -- 역시',
      words: [
        { start: 31.6, end: 32.0, word: '저' },
        { start: 32.0, end: 33.5, word: '--', isSilence: true },
        { start: 33.5, end: 38.77, word: '역시' }
      ]
    })
    expect(line.words!.filter((w) => w.isSilence === true)).toHaveLength(1)
  })

  it('skips when gap shorter than threshold', () => {
    const before = {
      start: 0,
      end: 5,
      text: 'a b',
      words: [
        { start: 0, end: 1, word: 'a' },
        { start: 1.04, end: 2, word: 'b' }
      ]
    }
    const line = insertMissingTemporalSilenceGapsInLine(before, 0.08)
    expect(line).toBe(before)
  })

  it('skips when line has tombstones', () => {
    const before = {
      start: 0,
      end: 5,
      text: 'a b',
      words: [
        { start: 0, end: 1, word: 'a' },
        { start: 1, end: 1.5, word: 'x', isDeleted: true },
        { start: 2.5, end: 4, word: 'b' }
      ]
    }
    expect(insertMissingTemporalSilenceGapsInLine(before)).toBe(before)
  })
})

describe('mergeConsecutiveSilenceWordsInLine', () => {
  it('updates line bounds and text when silence merged', () => {
    const line = mergeConsecutiveSilenceWordsInLine({
      start: 0,
      end: 5,
      text: '-- -- hi',
      words: [
        { start: 0, end: 1, word: '--', isSilence: true },
        { start: 1, end: 2, word: '--', isSilence: true },
        { start: 2, end: 5, word: 'hi' }
      ]
    })
    expect(line.words).toHaveLength(2)
    expect(line.start).toBeCloseTo(0, 4)
    expect(line.end).toBeCloseTo(5, 4)
    expect(line.text).toBe('hi')
  })
})

describe('subtitleCueLinesForExport', () => {
  it('narrows start/end to visible words when tombstones present', () => {
    const cues = subtitleCueLinesForExport([
      {
        start: 0,
        end: 10,
        text: 'hello world',
        words: [
          { start: 0, end: 2, word: 'skip', isDeleted: true },
          { start: 2, end: 5, word: 'hello' },
          { start: 5, end: 10, word: 'world' }
        ]
      }
    ])
    expect(cues).toHaveLength(1)
    expect(cues[0]!.start).toBeCloseTo(2, 4)
    expect(cues[0]!.end).toBeCloseTo(10, 4)
    expect(cues[0]!.text).toBe('hello world')
  })

  it('drops lines with only deleted words', () => {
    expect(
      subtitleCueLinesForExport([
        {
          start: 0,
          end: 2,
          text: '',
          words: [{ start: 0, end: 2, word: 'gone', isDeleted: true }]
        }
      ])
    ).toHaveLength(0)
  })

  it('passes through lines without words using line text', () => {
    const cues = subtitleCueLinesForExport([{ start: 1, end: 3, text: 'plain', words: undefined }])
    expect(cues).toEqual([{ start: 1, end: 3, text: 'plain' }])
  })
})

describe('parseSubtitleLines alignment metadata', () => {
  const payload = [
    {
      start: 0,
      end: 2,
      text: '안녕 하세요',
      words: [
        {
          start: 0,
          end: 1,
          word: '안녕',
          id: 'seg-0:word:0',
          alignmentStatus: 'aligned',
          alignmentScore: 0.8,
          sourceStart: 0,
          sourceEnd: 1,
          rawStart: 0.1,
          rawEnd: 1.1,
          engine: 'whisperx',
          modelRevision: 'rev'
        },
        { start: 1, end: 2, word: '하세요', alignmentStatus: 'unaligned', sourceStart: null, sourceEnd: null }
      ]
    }
  ]

  it('preserves ids, status and engine estimates', () => {
    const [line] = parseSubtitleLines(payload)
    expect(line!.words![0]).toMatchObject({
      id: 'seg-0:word:0',
      alignmentStatus: 'aligned',
      sourceStart: 0,
      rawStart: 0.1,
      engine: 'whisperx'
    })
    expect(line!.words![1]).toMatchObject({ alignmentStatus: 'unaligned', sourceStart: null })
  })

  it('round-trips through JSON without losing metadata', () => {
    const once = parseSubtitleLines(payload)
    const twice = parseSubtitleLines(JSON.parse(JSON.stringify(once)))
    expect(twice).toEqual(once)
  })

  it('leaves legacy words without a status', () => {
    const [line] = parseSubtitleLines([{ start: 0, end: 1, text: 'a', words: [{ start: 0, end: 1, word: 'a' }] }])
    expect(line!.words![0]!.alignmentStatus).toBeUndefined()
  })

  it('does not attach alignment state to silence placeholders', () => {
    const [line] = parseSubtitleLines([
      { start: 0, end: 1, text: '', words: [{ start: 0, end: 1, word: '--', isSilence: true, alignmentStatus: 'aligned' }] }
    ])
    expect(line!.words![0]!.alignmentStatus).toBeUndefined()
  })
})
