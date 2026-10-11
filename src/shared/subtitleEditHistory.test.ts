import { expect, it } from 'vitest'
import { subtitleLinesMeaningfullyChanged } from './subtitleEditHistory'
import type { SubtitleLine } from './subtitles'

it('records alignment and pronunciation edits even if the display and bounds stay unchanged', () => {
  const prev: SubtitleLine[] = [{start: 0, end: 1, text: '3배', words: [{id: 'x', word: '3배', start: 0, end: 1}]}]
  expect(subtitleLinesMeaningfullyChanged(JSON.parse(JSON.stringify(prev)), prev)).toBe(false)
  for (const patch of [{readingOverride: '세배'}, {alignmentStatus: 'aligned'}, {manualStartLocked: true}, {mergedByEdgeTrim: true}]) {
    const next = JSON.parse(JSON.stringify(prev))
    Object.assign(next[0].words[0], patch)
    expect(subtitleLinesMeaningfullyChanged(next, prev)).toBe(true)
  }
  expect(subtitleLinesMeaningfullyChanged([{...prev[0], isDeleted: true}], prev)).toBe(true)
})
