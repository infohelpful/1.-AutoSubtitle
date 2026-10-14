import { describe, expect, it } from 'vitest'
import { buildScheduledMediaSegments, buildScheduledMediaSegmentsFromSubtitleWords } from './playbackSchedule'
import { buildTimelineClips, createTimelineMapping, programDurationSec } from './mapping'

describe('continuous source playback', () => {
  it('keeps the speech tail and row gaps, ending at the media end rather than the last aligned word', () => {
    const clips = buildTimelineClips([], 150)
    expect(buildScheduledMediaSegments(clips, 128.682, null)).toEqual([
      { clipId: 1, startMediaSec: 128.682, endMediaSec: 150 }
    ])
  })

  it('skips only the explicitly deleted word and maps the shorter display clock both ways', () => {
    const map = createTimelineMapping([{ start: 24.264, end: 24.6 }], 150, { masterMode: 'passthrough' })
    expect(buildScheduledMediaSegments(map.clips, 24, null)).toEqual([
      { clipId: 1, startMediaSec: 24, endMediaSec: expect.closeTo(24.264, 8) },
      { clipId: 2, startMediaSec: 24.6, endMediaSec: 150 }
    ])
    expect(programDurationSec(map.clips)).toBeCloseTo(149.664, 6)
    expect(map.mediaToProgramSec(24.6)).toBeCloseTo(24.264, 6)
    expect(map.programToMediaSec(map.clips[1].editStart)).toBeCloseTo(24.6, 6)
  })
})
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
