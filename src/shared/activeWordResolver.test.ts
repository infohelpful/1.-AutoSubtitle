import { describe, expect, it } from 'vitest'
import { isTimeInWordSpan, resolveActiveWordIndex } from './activeWordResolver'

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
