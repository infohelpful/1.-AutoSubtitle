import { describe, expect, it } from 'vitest'
import { buildExportCueLines } from './exportCuePipeline'
import { subtitleCueLinesForExport } from './subtitles'

describe('buildExportCueLines (Phase 6)', () => {
  const sample = [
    {
      start: 0,
      end: 5,
      text: 'a',
      words: [{ start: 1, end: 4, word: 'a', isDeleted: false }]
    }
  ] as const

  it('delegates to subtitleCueLinesForExport', () => {
    expect(buildExportCueLines(sample)).toEqual(subtitleCueLinesForExport(sample))
  })
})
