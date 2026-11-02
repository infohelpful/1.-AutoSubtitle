import { describe, expect, it } from 'vitest'
import { buildExportCueLines } from './exportCuePipeline'
import { buildRenderSchedule } from './exportRenderSchedule'
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
  it('exports the same continuous display boundaries and keeps word timing paired after sorting', () => {
    const lines = [
      { start: 13.232, end: 15, text: '이런 경험', words: [{ start: 13.332, end: 15, word: '이런 경험' }] },
      { start: 10.021, end: 12.811, text: '컴퓨터', words: [{ start: 10.021, end: 12.811, word: '컴퓨터' }] }
    ]
    const cues = buildExportCueLines(lines, { includeWords: true })
    expect(cues[0]).toEqual({ start: 10.021, end: 13.232, text: '컴퓨터', words: [{ start: 10.021, end: 12.811, text: '컴퓨터' }] })
    expect(cues[1].words?.[0].text).toBe('이런 경험')
    expect(cues[1].start).toBe(cues[0].end)
    expect(cues[1].words?.[0].start).toBe(13.332)
    expect(buildExportCueLines(lines.map(({words, ...line}) => line))[0].end).toBe(13.232)
  })

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

  it('keeps the last spoken word highlighted through trailing audio until the next caption', () => {
    const cues = buildExportCueLines([
      { start: 0, end: 3.4, text: '첫 마지막', words: [
        { start: 0, end: 1, word: '첫' },
        { start: 1, end: 3.4, word: '마지막' },
        { start: 3.4, end: 5, word: '오디오', isSilence: true, gapKind: 'unclassified' as const }
      ] },
      { start: 5, end: 6, text: '다음', words: [{ start: 5, end: 6, word: '다음' }] }
    ], { includeWords: true })
    expect(cues[0]).toMatchObject({ end: 5, words: [
      { end: 1, text: '첫' }, { end: 5, text: '마지막' }
    ] })
    const states = buildRenderSchedule({ cues,
      clips: [{ occurrenceId: 'whole', sourceStart: 0, sourceEnd: 6, programStart: 0 }],
      fps: 30, highlightWords: true })
    expect(states.find(state => state.startFrame <= 4 * 30 && 4 * 30 < state.endFrame)?.activeIndex).toBe(1)
    expect(states.find(state => state.startFrame <= 5 * 30 && 5 * 30 < state.endFrame)?.text).toBe('다음')
  })
})
