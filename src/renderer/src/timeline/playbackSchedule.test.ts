import { describe, expect, it } from 'vitest'
import { buildScheduledMediaSegmentsFromSubtitleWords } from './playbackSchedule'
import type { SubtitleLine } from '../../../shared/subtitles'

describe('buildScheduledMediaSegmentsFromSubtitleWords', () => {
  it('단어 구간을 ScheduledMediaSegment 로 변환하고 윈도로 자름', () => {
    const lines: SubtitleLine[] = [
      {
        start: 0,
        end: 100,
        text: '',
        words: [
          { start: 1, end: 3, word: 'a' },
          { start: 10, end: 12, word: 'b', isDeleted: true },
          { start: 20, end: 25, word: 'c' }
        ]
      }
    ]
    const segs = buildScheduledMediaSegmentsFromSubtitleWords(lines, 0, null)
    expect(segs).toEqual([
      { clipId: 1, startMediaSec: 1, endMediaSec: 3 },
      { clipId: 2, startMediaSec: 20, endMediaSec: 25 }
    ])
  })

  it('시작 미디어 시각이 첫 구간 밖이면 그 구간은 스킵하고 다음 살아 있는 구간부터', () => {
    const lines: SubtitleLine[] = [
      {
        start: 0,
        end: 100,
        text: '',
        words: [
          { start: 1, end: 5, word: 'a' },
          { start: 30, end: 40, word: 'b' }
        ]
      }
    ]
    const segs = buildScheduledMediaSegmentsFromSubtitleWords(lines, 8, null)
    expect(segs).toEqual([{ clipId: 1, startMediaSec: 30, endMediaSec: 40 }])
  })
})
