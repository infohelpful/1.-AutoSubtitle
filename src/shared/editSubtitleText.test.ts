import { expect, it } from 'vitest'
import { editSubtitleText } from './editSubtitleText'
import { sentenceTokenTimelineToSubtitleLines, subtitleLinesToSentenceTokenTimeline } from './sentenceTokenTimelineAdapter'
import { buildExportCueLines } from './exportCuePipeline'
import type { SubtitleLine } from './subtitles'

const line: SubtitleLine = { start: 0, end: 2, text: '오늘 날씨', words: [
  { id: 'a', start: 0, end: 1, word: '오늘', alignmentStatus: 'aligned' },
  { id: 'b', start: 1, end: 2, word: '날씨', alignmentStatus: 'aligned' }
] }

it('keeps source chips identical while the caption is cleared and rewritten', () => {
  const cleared = editSubtitleText(line, '')
  const rewritten = editSubtitleText(cleared, '새로운 문장')
  expect(cleared.words).toBe(line.words)
  expect(rewritten.words).toBe(line.words)
  expect(rewritten.words?.map(word => word.word)).toEqual(['오늘', '날씨'])
  expect(rewritten.captionText).toBe('새로운 문장')
  expect(buildExportCueLines([cleared])).toEqual([])
  expect(buildExportCueLines([rewritten])).toEqual([{ start: 0, end: 2, text: '새로운 문장' }])
})

it('preserves the edited caption and source chips through timeline storage', () => {
  const edited = editSubtitleText(line, '오늘 날시')
  const stored = JSON.parse(JSON.stringify(subtitleLinesToSentenceTokenTimeline([edited])))
  const [restored] = sentenceTokenTimelineToSubtitleLines(stored)
  expect(restored.text).toBe('오늘 날시')
  expect(restored.captionText).toBe('오늘 날시')
  expect(restored.words?.map(word => [word.word, word.start, word.end])).toEqual([
    ['오늘', 0, 1], ['날씨', 1, 2]
  ])
  expect(buildExportCueLines([restored], { includeWords: true })).toEqual([
    { start: 0, end: 2, text: '오늘 날시', words: [
      { start: 0, end: 1, text: '오늘' }, { start: 1, end: 2, text: '날시' }
    ] }
  ])
})

it('exports a rewritten caption with a different word count without changing source chips', () => {
  const edited = editSubtitleText(line, '오늘은 정말 좋은 날씨')
  expect(edited.words).toBe(line.words)
  const [cue] = buildExportCueLines([edited], { includeWords: true })
  expect(cue.text).toBe('오늘은 정말 좋은 날씨')
  expect(cue.words?.map(word => word.text).join(' ')).toBe(cue.text)
  expect(cue.words?.[0].start).toBe(0)
  expect(cue.words?.at(-1)?.end).toBe(2)
})
