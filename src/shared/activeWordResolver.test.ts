import { describe, expect, it } from 'vitest'
import {
  HIGHLIGHT_HOLD_SEC,
  HIGHLIGHT_LEAD_SEC,
  isTimeInWordSpan,
  resolveActiveWordIndex,
  resolveHighlightWordIndex
} from './activeWordResolver'

const words = [
  { start: 1, end: 2 },
  { start: 2, end: 3 },
  { start: 4, end: 5 }
]

describe('isTimeInWordSpan', () => {
  it('uses a half-open [start, end) interval', () => {
    expect(isTimeInWordSpan(1, 1, 2)).toBe(true)
    expect(isTimeInWordSpan(2 - 1e-6, 1, 2)).toBe(true)
    expect(isTimeInWordSpan(2, 1, 2)).toBe(false)
    expect(isTimeInWordSpan(1 - 1e-6, 1, 2)).toBe(false)
  })

  it('rejects non-finite input and empty spans', () => {
    expect(isTimeInWordSpan(Number.NaN, 1, 2)).toBe(false)
    expect(isTimeInWordSpan(1, Number.NaN, 2)).toBe(false)
    expect(isTimeInWordSpan(1.5, 2, 2)).toBe(false)
    expect(isTimeInWordSpan(1.5, 2, 1)).toBe(false)
  })
})

describe('resolveActiveWordIndex', () => {
  it('returns the word whose interval contains t', () => {
    expect(resolveActiveWordIndex(words, 1.5)).toBe(0)
    expect(resolveActiveWordIndex(words, 4.9)).toBe(2)
  })

  it('hands over to the next word exactly at the shared boundary', () => {
    expect(resolveActiveWordIndex(words, 2)).toBe(1)
    expect(resolveActiveWordIndex(words, 2 - 1e-6)).toBe(0)
  })

  it('returns -1 in a gap, before the first word and at the last word end', () => {
    expect(resolveActiveWordIndex(words, 3.5)).toBe(-1)
    expect(resolveActiveWordIndex(words, 0.5)).toBe(-1)
    expect(resolveActiveWordIndex(words, 5)).toBe(-1)
  })

  it('does not extend a word to the next start (gap stays empty)', () => {
    expect(resolveActiveWordIndex(words, 3)).toBe(-1)
    expect(resolveActiveWordIndex(words, 3.999)).toBe(-1)
  })

  it('skips deleted and silence words by default', () => {
    const mixed = [
      { start: 0, end: 1, isSilence: true },
      { start: 1, end: 2, isDeleted: true },
      { start: 2, end: 3 }
    ]
    expect(resolveActiveWordIndex(mixed, 0.5)).toBe(-1)
    expect(resolveActiveWordIndex(mixed, 1.5)).toBe(-1)
    expect(resolveActiveWordIndex(mixed, 2.5)).toBe(2)
  })

  it('can opt in to silence words', () => {
    const mixed = [{ start: 0, end: 1, isSilence: true }]
    expect(resolveActiveWordIndex(mixed, 0.5, { skipSilence: false })).toBe(0)
  })

  it('keeps overlapping words (overlapped speech) resolvable by first match', () => {
    const overlap = [
      { start: 0, end: 2 },
      { start: 1, end: 3 }
    ]
    expect(resolveActiveWordIndex(overlap, 1.5)).toBe(0)
    expect(resolveActiveWordIndex(overlap, 2.5)).toBe(1)
  })

  it('handles empty input', () => {
    expect(resolveActiveWordIndex([], 1)).toBe(-1)
    expect(resolveActiveWordIndex(words, Number.NaN)).toBe(-1)
  })
})

describe('resolveHighlightWordIndex (화면에 보이는 하이라이트)', () => {
  it('matches the strict resolver while t is inside a word', () => {
    expect(resolveHighlightWordIndex(words, 1.5)).toBe(0)
    expect(resolveHighlightWordIndex(words, 2)).toBe(1)
    expect(resolveHighlightWordIndex(words, 2 - 1e-6)).toBe(0)
    expect(resolveHighlightWordIndex(words, 4.9)).toBe(2)
  })

  it('keeps the previous word highlighted through a gap instead of switching off', () => {
    // 3~4 구간은 틈. 직전 단어(1)를 유지한다.
    expect(resolveHighlightWordIndex(words, 3)).toBe(1)
    expect(resolveHighlightWordIndex(words, 3.5)).toBe(1)
    expect(resolveHighlightWordIndex(words, 3.999)).toBe(1)
    expect(resolveHighlightWordIndex(words, 4)).toBe(2)
  })

  it('keeps the last word highlighted after it ends, but only for the hold time', () => {
    expect(resolveHighlightWordIndex(words, 5)).toBe(2)
    expect(resolveHighlightWordIndex(words, 5 + HIGHLIGHT_HOLD_SEC)).toBe(2)
    expect(resolveHighlightWordIndex(words, 5 + HIGHLIGHT_HOLD_SEC + 0.01)).toBe(-1)
  })

  it('goes dark in a gap longer than the hold time', () => {
    const sparse = [
      { start: 0, end: 1 },
      { start: 5, end: 6 }
    ]
    expect(resolveHighlightWordIndex(sparse, 1.5)).toBe(0)
    expect(resolveHighlightWordIndex(sparse, 2.5)).toBe(-1)
    // 다음 단어가 곧 시작해도, 앞선 단어가 있으면 미리 켜지 않는다.
    expect(resolveHighlightWordIndex(sparse, 4.9)).toBe(-1)
  })

  it('lights the first word slightly early when nothing precedes it', () => {
    const line = [{ start: 10, end: 10.5 }, { start: 10.5, end: 11 }]
    expect(resolveHighlightWordIndex(line, 10 - HIGHLIGHT_LEAD_SEC + 0.01)).toBe(0)
    expect(resolveHighlightWordIndex(line, 10 - HIGHLIGHT_LEAD_SEC - 0.01)).toBe(-1)
  })

  it('prefers the most recently started word when words overlap', () => {
    // 늘어난 원본 시간의 단어(0~3)와 그 안에서 시작한 단어(1~2): 새로 시작한 단어가 현재 단어다.
    const overlap = [
      { start: 0, end: 3 },
      { start: 1, end: 2 }
    ]
    expect(resolveHighlightWordIndex(overlap, 0.5)).toBe(0)
    expect(resolveHighlightWordIndex(overlap, 1.5)).toBe(1)
    // 겹친 단어가 끝난 뒤에는 아직 남은 긴 단어로 돌아간다.
    expect(resolveHighlightWordIndex(overlap, 2.5)).toBe(0)
  })

  it('holds the word that ended last, not the one listed last', () => {
    const mixed = [
      { start: 0, end: 4 },
      { start: 1, end: 2 }
    ]
    expect(resolveHighlightWordIndex(mixed, 4.3)).toBe(0)
  })

  it('skips deleted and silence words by default and can opt in', () => {
    const mixedWords = [
      { start: 0, end: 1, isSilence: true },
      { start: 1, end: 2, isDeleted: true },
      { start: 2, end: 3 }
    ]
    expect(resolveHighlightWordIndex(mixedWords, 0.5, { leadSec: 0 })).toBe(-1)
    expect(resolveHighlightWordIndex(mixedWords, 1.5, { leadSec: 0 })).toBe(-1)
    expect(resolveHighlightWordIndex(mixedWords, 2.5)).toBe(2)
    expect(resolveHighlightWordIndex(mixedWords, 0.5, { skipSilence: false })).toBe(0)
  })

  it('can disable hold and lead', () => {
    expect(resolveHighlightWordIndex(words, 3.5, { holdSec: 0 })).toBe(-1)
    expect(resolveHighlightWordIndex([{ start: 5, end: 6 }], 4.8, { leadSec: 0 })).toBe(-1)
  })

  it('handles empty and invalid input', () => {
    expect(resolveHighlightWordIndex([], 1)).toBe(-1)
    expect(resolveHighlightWordIndex(words, Number.NaN)).toBe(-1)
  })
})
