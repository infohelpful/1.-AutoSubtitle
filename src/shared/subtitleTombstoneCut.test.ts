import { describe, expect, it } from 'vitest'
import {
  applyProgramTimeRangeTombstoneCutToSubtitleLines,
  tombstoneSplitSubtitleWord
} from './subtitleTombstoneCut'

describe('tombstoneSplitSubtitleWord', () => {
  it('marks a fully overlapped word deleted', () => {
    const out = tombstoneSplitSubtitleWord({ start: 1, end: 3, word: 'hello' }, 1, 3)
    expect(out).toHaveLength(1)
    expect(out[0]!.isDeleted).toBe(true)
    expect(out[0]!.word).toBe('hello')
  })

  it('splits prefix overlap into tombstone head + visible tail', () => {
    const out = tombstoneSplitSubtitleWord({ start: 0, end: 4, word: 'abcd' }, 0, 2)
    expect(out.some((w) => w.isDeleted)).toBe(true)
    expect(out.some((w) => !w.isDeleted && w.word === 'cd')).toBe(true)
  })
})

describe('applyProgramTimeRangeTombstoneCutToSubtitleLines', () => {
  it('reverts when the cut would remove all visible words', () => {
    const lines = [{ start: 0, end: 2, text: 'hi', words: [{ start: 0, end: 2, word: 'hi' }] }]
    const next = applyProgramTimeRangeTombstoneCutToSubtitleLines(lines, 0, 2)
    expect(next).toEqual(lines)
  })

  it('tombstones one word and keeps another line', () => {
    const lines = [
      { start: 0, end: 2, text: 'a', words: [{ start: 0, end: 2, word: 'a' }] },
      { start: 5, end: 7, text: 'b', words: [{ start: 5, end: 7, word: 'b' }] }
    ]
    const next = applyProgramTimeRangeTombstoneCutToSubtitleLines(lines, 0, 2)
    expect(next).toHaveLength(1)
    expect(next[0]!.words!.some((w) => w.word === 'b')).toBe(true)
  })
})
