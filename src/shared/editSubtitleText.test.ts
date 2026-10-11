import { expect, it } from 'vitest'
import { editSubtitleText } from './editSubtitleText'
import type { SubtitleLine } from './subtitles'
const line: SubtitleLine = { start: 0, end: 2, text: '오늘 날씨', words: [
  { id: 'a', start: 0, end: 1, word: '오늘', alignmentStatus: 'aligned' },
  { id: 'b', start: 1, end: 2, word: '날씨', alignmentStatus: 'aligned' }
] }
it('updates corrected labels while preserving source bounds and other words', () => {
  const next = editSubtitleText(line, '오늘 날시')
  expect(next.words?.[0]).toBe(line.words?.[0])
  expect(next.words?.[1]).toMatchObject({ id: 'b', start: 1, end: 2, word: '날시', alignmentStatus: 'stale' })
})
it('does not cut audio when text is erased or replaced across words', () => {
  for (const text of ['', '새 문장', '오늘 좋은 날씨']) {
    const next = editSubtitleText(line, text)
    expect(next.text).toBe(text)
    expect(next.words?.map(w => [w.start, w.end, w.isDeleted])).toEqual([[0, 1, undefined], [1, 2, undefined]])
    expect(next.words?.map(w => w.word).join('')).toBe(text.replace(/^오늘 /, '오늘'))
  }
})
