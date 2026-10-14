import { expect, it } from 'vitest'
import { setSubtitleVisibility, subtitlePreviewText } from './subtitleVisibility'
import { buildExportCueLines } from './exportCuePipeline'
import { subtitleLinesToSentenceTokenTimeline, sentenceTokenTimelineToSubtitleLines } from './sentenceTokenTimelineAdapter'
import { calculateVirtualTimeline } from './sentenceTokenTimeline'
import { subtitleLinesMeaningfullyChanged } from './subtitleEditHistory'
import { parseAutosubProjectFile } from './autosubProject'
import type { SubtitleLine } from './subtitles'
import { buildRenderSchedule } from './exportRenderSchedule'
import { partitionLineAtSpeechBoundaries } from './lineBreak'

const lines: SubtitleLine[] = [0, 1, 2].map(i => ({start: i * 2, end: i * 2 + 1, text: `자막${i}`,
  words: [{id: `word${i}`, start: i * 2, end: i * 2 + 1, word: `자막${i}`}]}))
it('hides captions without deleting words, shortening audio, or extending a preceding caption into the hidden row', () => {
  const hidden = setSubtitleVisibility(lines, new Set([1]), true)
  expect(hidden[0]).toBe(lines[0])
  expect(hidden[1].words).toBe(lines[1].words)
  expect(subtitlePreviewText(hidden, 2.5)).toBe('')
  expect(subtitlePreviewText(hidden, 4.5)).toBe('자막2')
  expect(buildExportCueLines(hidden, {includeWords: true}).map(c=>[c.start,c.end,c.text])).toEqual([[0,2,'자막0'],[4,5,'자막2']])
  expect(calculateVirtualTimeline(subtitleLinesToSentenceTokenTimeline(hidden))).toEqual(calculateVirtualTimeline(subtitleLinesToSentenceTokenTimeline(lines)))
  expect(subtitleLinesMeaningfullyChanged(hidden, lines)).toBe(true)
  expect(setSubtitleVisibility(hidden, new Set([1]), false)).toEqual(lines)
})
it('keeps hidden captions hidden after splitting and permits a completely caption-free export', () => {
  const hidden = setSubtitleVisibility(lines, new Set([0,1,2]), true)
  const cues = buildExportCueLines(hidden, {includeWords: true})
  expect(cues).toEqual([])
  expect(buildRenderSchedule({cues, clips: [{occurrenceId:'clip',sourceStart:0,sourceEnd:5,programStart:0}], fps:30,highlightWords:true})).toEqual([])
  const split = partitionLineAtSpeechBoundaries({...hidden[0], end: 5, words: lines.flatMap(line=>line.words!)}, [1])
  expect(split?.map(line=>line.isHidden)).toEqual([true,true])
})
it('preserves hidden rows through storage and uncached timeline conversion', () => {
  const hidden = setSubtitleVisibility(lines, new Set([0,2]), true)
  const timeline = JSON.parse(JSON.stringify(subtitleLinesToSentenceTokenTimeline(hidden)))
  expect(sentenceTokenTimelineToSubtitleLines(timeline).map(l=>!!l.isHidden)).toEqual([true,false,true])
  const parsed = parseAutosubProjectFile({
    format: 'autosubtitle-project', version: 2, savedAt: '2026-10-15T00:00:00Z',
    videoPath: null, mediaFingerprint: null, cutRanges: [], subtitles: hidden,
    subtitleStyle: { fontFamily: 'Arial', fontSize: 32, textColor: '#ffffff', fontWeight: 700,
      bgColor: '#000000', bgOpacity: 60, bgPaddingPct: 10, strokeColor: '#000000', strokeWidth: 2, x: 50, y: 10 }
  })
  expect(parsed.ok).toBe(true)
  if(parsed.ok) expect(parsed.data.subtitles).toEqual(hidden)
})
