import { expect, it } from 'vitest'
import { isRemovedSubtitleRow, pickActiveEditorRow, resolveEditorHighlight, sourceTimelineDuration } from './editorPlayback'
import { subtitlePreviewText } from './subtitleVisibility'

it('highlights silence at its exact time even when the next caption has a display lead', () => {
  const lines = [
    { start: 0, end: 3, text: '', words: [{start:0,end:3,word:'--',isSilence:true}] },
    { start: 2, end: 5, text: '말', words: [{start:3,end:5,word:'말'}] }
  ]
  expect(subtitlePreviewText(lines, 2.8)).toBe('말')
  expect(pickActiveEditorRow(lines, 2.8)).toBe(0)
  expect(resolveEditorHighlight(lines[0].words, 2.8)).toBe(0)
  expect(resolveEditorHighlight(lines[0].words, 3)).toBe(-1)
  expect(pickActiveEditorRow(lines, 3)).toBe(1)
})

it('prioritizes actual speech over overlapping gap markers, without resurrecting older words', () => {
  const words = [{start:0,end:10,word:'old'}, {start:2,end:3,word:'new'}]
  expect(resolveEditorHighlight(words, 4.5)).toBe(-1)
  expect(isRemovedSubtitleRow({start:0,end:1,text:'',words:[{start:0,end:1,word:'a',isDeleted:true}]})).toBe(true)
  expect(isRemovedSubtitleRow({start:0,end:1,text:'',isHidden:true})).toBe(false)
})

it('keeps the active word-chip row aligned with the caption across overlapping speech timings', () => {
  const lines = [
    { start: 52.164, end: 54.236, text: '월간 업데이터를 통해', words: [
      { start: 53.17, end: 53.472, word: '월간' },
      { start: 53.512, end: 54.015, word: '업데이터를' },
      { start: 54.095, end: 54.236, word: '통해' }
    ] },
    { start: 53.9, end: 56.443, text: '기능을 조금씩 미리 배포하되', words: [
      { start: 53.9, end: 54.363, word: '기능을' }
    ] }
  ]
  expect(pickActiveEditorRow(lines, 54.1)).toBe(0)
  expect(pickActiveEditorRow(lines, 54.235)).toBe(0)
  expect(pickActiveEditorRow(lines, 54.236)).toBe(1)
})

it('uses the full video duration despite truncated or padded peaks and early-ending captions', () => {
  expect(sourceTimelineDuration(684.8,680,660)).toBe(684.8)
  expect(sourceTimelineDuration(684.8,685,660)).toBe(684.8)
  expect(sourceTimelineDuration(0,680,660)).toBe(680)
})

it('highlights the preceding spoken chip throughout a trailing audio chip', () => {
  const words = [
    { start: 0, end: 1, word: '앞' },
    { start: 1, end: 2, word: '끝' },
    { start: 2, end: 4, word: '오디오', isSilence: true, gapKind: 'unclassified' as const }
  ]
  expect(resolveEditorHighlight(words, 3.5)).toBe(1)
  expect(resolveEditorHighlight(words, 4)).toBe(-1)
})
