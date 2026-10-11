import { expect, it } from 'vitest'
import { setWordReading } from './wordReading'
import type { SubtitleWord } from './subtitles'

it('changes only pronunciation and stale estimates, retaining display, identity and manual boundaries', () => {
  const word: SubtitleWord = { id: 'three', word: '3배', start: 1, end: 2, manualStartLocked: true,
    alignmentStatus: 'manual', alignmentScore: .8, sourceStart: 1.1, sourceEnd: 1.9,
    alignmentText: '삼배', readingOverride: '삼배', charSpans: [{char: '삼', start: 1.1, end: 1.4, score: .8}],
    textSpanMap: [{displayStart: 0, displayEnd: 2, alignmentStart: 0, alignmentEnd: 2}] }
  const next = setWordReading(word, ' 세배 ')
  expect(next).toMatchObject({ id: 'three', word: '3배', start: 1, end: 2, manualStartLocked: true,
    readingOverride: '세배', alignmentStatus: 'stale', alignmentScore: null, sourceStart: null, sourceEnd: null })
  expect(next.charSpans).toBeUndefined()
  expect(next.textSpanMap).toBeUndefined()
  expect(word.readingOverride).toBe('삼배')
  expect(setWordReading(next, '세배')).toBe(next)
  expect(setWordReading(next, '').readingOverride).toBeUndefined()
  expect(() => setWordReading(word, '가'.repeat(257))).toThrow()
})
