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

it('uses the full video duration despite truncated or padded peaks and early-ending captions', () => {
  expect(sourceTimelineDuration(684.8,680,660)).toBe(684.8)
  expect(sourceTimelineDuration(684.8,685,660)).toBe(684.8)
  expect(sourceTimelineDuration(0,680,660)).toBe(680)
})
