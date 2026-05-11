import { describe, expect, it } from 'vitest'
import { subtitleCueLinesForExport } from './subtitles'

describe('subtitleCueLinesForExport', () => {
  it('narrows start/end to visible words when tombstones present', () => {
    const cues = subtitleCueLinesForExport([
      {
        start: 0,
        end: 10,
        text: 'hello world',
        words: [
          { start: 0, end: 2, word: 'skip', isDeleted: true },
          { start: 2, end: 5, word: 'hello' },
          { start: 5, end: 10, word: 'world' }
        ]
      }
    ])
    expect(cues).toHaveLength(1)
    expect(cues[0]!.start).toBeCloseTo(2, 4)
    expect(cues[0]!.end).toBeCloseTo(10, 4)
    expect(cues[0]!.text).toBe('hello world')
  })

  it('drops lines with only deleted words', () => {
    expect(
      subtitleCueLinesForExport([
        {
          start: 0,
          end: 2,
          text: '',
          words: [{ start: 0, end: 2, word: 'gone', isDeleted: true }]
        }
      ])
    ).toHaveLength(0)
  })

  it('passes through lines without words using line text', () => {
    const cues = subtitleCueLinesForExport([{ start: 1, end: 3, text: 'plain', words: undefined }])
    expect(cues).toEqual([{ start: 1, end: 3, text: 'plain' }])
  })
})
