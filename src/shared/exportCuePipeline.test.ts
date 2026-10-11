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
  ]

  it('delegates to subtitleCueLinesForExport', () => {
    expect(buildExportCueLines(sample)).toEqual(subtitleCueLinesForExport(sample))
  })
})

describe('buildExportCueLines with words', () => {
  const lines = [
    { start: 0, end: 1, text: '', words: [{ start: 0, end: 1, word: 'x', isDeleted: true }] },
    {
      start: 1,
      end: 4,
      text: 'a b',
      words: [
        { start: 1, end: 2, word: 'a' },
        { start: 2, end: 2.5, word: '--', isSilence: true },
        { start: 2.5, end: 3, word: 'b' }
      ]
    }
  ]

  it('is unchanged without the option', () => {
    expect(buildExportCueLines(lines)).toEqual(subtitleCueLinesForExport(lines))
  })

  it('attaches word pieces that join to the cue text and skip silence/tombstones', () => {
    const cues = buildExportCueLines(lines, { includeWords: true })
    expect(cues).toHaveLength(1)
    expect(cues[0]!.text).toBe('a b')
    expect(cues[0]!.words).toEqual([
      { start: 1, end: 2, text: 'a' },
      { start: 2.5, end: 3, text: 'b' }
    ])
    expect(cues[0]!.words!.map((w) => w.text).join(' ')).toBe(cues[0]!.text)
  })
})
