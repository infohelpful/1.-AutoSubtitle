import { expect, it } from 'vitest'
import { findSubtitleMatches, replaceAllSubtitleMatches, replaceSubtitleMatch } from './subtitleSearch'
import { subtitleLineEditDisplayText, type SubtitleLine } from './subtitles'

const row = (text: string, extra: Partial<SubtitleLine> = {}): SubtitleLine => ({
  start: 0, end: 1, text, words: text.split(' ').map((word, i) => ({ id: `${text}-${i}`, word, start: i * .1, end: i * .1 + .1 })), ...extra
})
const lines = [row('Apple 사과 apple'), row('사과 주스'), row('삭제됨 사과', { isDeleted: true })]

it('finds caption matches in order and skips removed rows', () => {
  expect(findSubtitleMatches(lines, '사과')).toEqual([{ line: 0, start: 6, end: 8 }, { line: 1, start: 0, end: 2 }])
  expect(findSubtitleMatches(lines, 'apple').map(m => m.start)).toEqual([0, 9])
  expect(findSubtitleMatches(lines, 'apple', { caseSensitive: true }).map(m => m.start)).toEqual([9])
  expect(findSubtitleMatches(lines, '')).toEqual([])
})

it('replaces one match in the caption without touching source chips', () => {
  const [m] = findSubtitleMatches(lines, '사과')
  const out = replaceSubtitleMatch(lines, m!, '배')
  expect(subtitleLineEditDisplayText(out[0]!)).toBe('Apple 배 apple')
  expect(out[0]!.words).toBe(lines[0]!.words)
  expect(out[1]).toBe(lines[1])
})

it('replaces all matches and reports the count', () => {
  const { lines: out, count } = replaceAllSubtitleMatches(lines, 'apple', 'pear')
  expect(count).toBe(2)
  expect(subtitleLineEditDisplayText(out[0]!)).toBe('pear 사과 pear')
  expect(out[1]).toBe(lines[1])
  expect(out[2]).toBe(lines[2])
})
