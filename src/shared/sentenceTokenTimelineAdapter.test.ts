import { describe, expect, it } from 'vitest'
import {
  sentenceTokenTimelineToSubtitleLines,
  subtitleLinesToSentenceTokenTimeline
} from './sentenceTokenTimelineAdapter'

describe('sentenceTokenTimelineAdapter', () => {
  it('round-trips simple two-line subtitles', () => {
    const lines = [
      {
        start: 0,
        end: 2,
        text: 'a b',
        words: [
          { start: 0, end: 1, word: 'a' },
          { start: 1, end: 2, word: 'b' }
        ]
      },
      {
        start: 3,
        end: 4,
        text: 'c',
        words: [{ start: 3, end: 4, word: 'c' }]
      }
    ]
    const tl = subtitleLinesToSentenceTokenTimeline(lines)
    expect(tl.length).toBe(2)
    expect(tl[0]!.tokens.length).toBe(2)
    const back = sentenceTokenTimelineToSubtitleLines(tl)
    expect(back.length).toBe(2)
    expect(back[0]!.words?.length).toBe(2)
    expect(back[0]!.words?.[0]!.word).toBe('a')
    expect(back[1]!.words?.[0]!.word).toBe('c')
  })

  it('preserves isDeleted and isSilence', () => {
    const lines = [
      {
        start: 0,
        end: 2,
        text: 'x',
        words: [
          { start: 0, end: 1, word: 'gone', isDeleted: true },
          { start: 1, end: 2, word: '--', isSilence: true }
        ]
      }
    ]
    const back = sentenceTokenTimelineToSubtitleLines(subtitleLinesToSentenceTokenTimeline(lines))
    expect(back[0]!.words?.[0]!.isDeleted).toBe(true)
    expect(back[0]!.words?.[1]!.isSilence).toBe(true)
  })

  it('maps wordless line to single token and back', () => {
    const lines = [{ start: 0, end: 1, text: 'hello', words: undefined }]
    const back = sentenceTokenTimelineToSubtitleLines(subtitleLinesToSentenceTokenTimeline(lines))
    expect(back[0]!.words?.length).toBe(1)
    expect(back[0]!.words?.[0]!.word).toContain('hello')
  })

  it('line start/end follow visible words only (tombstone outside span)', () => {
    const lines = [
      {
        start: 0,
        end: 10,
        text: 'x',
        words: [
          { start: 0, end: 1, word: 'gone', isDeleted: true },
          { start: 5, end: 7, word: 'keep' }
        ]
      }
    ]
    const back = sentenceTokenTimelineToSubtitleLines(subtitleLinesToSentenceTokenTimeline(lines))
    expect(back[0]!.start).toBe(5)
    expect(back[0]!.end).toBe(7)
    expect(back[0]!.text).toBe('keep')
  })
})
