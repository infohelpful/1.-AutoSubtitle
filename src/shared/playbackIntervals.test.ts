import { describe, expect, it } from 'vitest'
import {
  hasPlayableSubtitleWordIntervals,
  intersectMediaIntervalsWithRange,
  lastPlaybackEndSec,
  playbackIntervalsFromSubtitleLines,
  type MediaPlaybackInterval
} from './playbackIntervals'
import type { SubtitleLine } from './subtitles'

function line(words: SubtitleLine['words'], start = 0, end = 999): SubtitleLine {
  return {
    start,
    end,
    text: '',
    words: words ?? []
  }
}

describe('playbackIntervalsFromSubtitleLines', () => {
  it('단어 없음 / 전부 삭제 → 빈 배열', () => {
    expect(playbackIntervalsFromSubtitleLines([])).toEqual([])
    expect(
      playbackIntervalsFromSubtitleLines([
        line([
          { start: 1, end: 2, word: 'a', isDeleted: true },
          { start: 3, end: 4, word: 'b', isDeleted: true }
        ])
      ])
    ).toEqual([])
  })

  it('삭제 안 된 단어 하나', () => {
    expect(playbackIntervalsFromSubtitleLines([line([{ start: 10, end: 12.5, word: 'hi' }])])).toEqual([
      { start: 10, end: 12.5 }
    ])
  })

  it('여러 줄에 흩어진 단어 — start 순 정렬·병합 없음(mergeGap=0, 인접만)', () => {
    const lines: SubtitleLine[] = [
      line([{ start: 5, end: 6, word: 'b' }]),
      line([{ start: 1, end: 2, word: 'a' }]),
      line([{ start: 8, end: 9, word: 'c' }])
    ]
    expect(playbackIntervalsFromSubtitleLines(lines)).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
      { start: 8, end: 9 }
    ])
  })

  it('겹치는 구간은 하나로 합침', () => {
    const lines: SubtitleLine[] = [
      line([
        { start: 1, end: 3, word: 'a' },
        { start: 2, end: 4, word: 'b' }
      ])
    ]
    expect(playbackIntervalsFromSubtitleLines(lines)).toEqual([{ start: 1, end: 4 }])
  })

  it('mergeGapSec — 근접 구간 병합', () => {
    const lines: SubtitleLine[] = [
      line([
        { start: 1, end: 2, word: 'a' },
        { start: 2.05, end: 3, word: 'b' }
      ])
    ]
    expect(playbackIntervalsFromSubtitleLines(lines, { mergeGapSec: 0 })).toEqual([
      { start: 1, end: 2 },
      { start: 2.05, end: 3 }
    ])
    expect(playbackIntervalsFromSubtitleLines(lines, { mergeGapSec: 0.1 })).toEqual([{ start: 1, end: 3 }])
  })

  it('기본적으로 무음 gap-fill 단어는 제외', () => {
    const lines: SubtitleLine[] = [
      line([
        { start: 1, end: 2, word: 'a' },
        { start: 2, end: 3, word: '--', isSilence: true }
      ])
    ]
    expect(playbackIntervalsFromSubtitleLines(lines)).toEqual([{ start: 1, end: 2 }])
    // 무음 포함 시 [1,2]·[2,3] 은 끝점 접촉으로 하나로 합쳐짐
    expect(playbackIntervalsFromSubtitleLines(lines, { includeSilenceSegments: true })).toEqual([
      { start: 1, end: 3 }
    ])
  })

  it('start >= end 인 단어는 무시', () => {
    expect(
      playbackIntervalsFromSubtitleLines([
        line([
          { start: 5, end: 5, word: 'x' },
          { start: 6, end: 5, word: 'y' },
          { start: 1, end: 2, word: 'ok' }
        ])
      ])
    ).toEqual([{ start: 1, end: 2 }])
  })
})

describe('hasPlayableSubtitleWordIntervals', () => {
  it('자막 없음·전부 삭제·무음만 → false', () => {
    expect(hasPlayableSubtitleWordIntervals([])).toBe(false)
    expect(
      hasPlayableSubtitleWordIntervals([
        line([
          { start: 1, end: 2, word: 'a', isDeleted: true },
          { start: 2, end: 3, word: '--', isSilence: true }
        ])
      ])
    ).toBe(false)
  })

  it('삭제 안 된 단어 하나면 true', () => {
    expect(hasPlayableSubtitleWordIntervals([line([{ start: 0, end: 1, word: 'x' }])])).toBe(true)
  })
})

describe('intersectMediaIntervalsWithRange', () => {
  it('윈도와 겹치는 부분만 자름', () => {
    const intervals: MediaPlaybackInterval[] = [
      { start: 0, end: 2 },
      { start: 5, end: 10 }
    ]
    expect(intersectMediaIntervalsWithRange(intervals, 1, 7)).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 7 }
    ])
  })

  it('rangeEnd null 이면 시작점 이후 전부', () => {
    expect(
      intersectMediaIntervalsWithRange(
        [
          { start: 1, end: 3 },
          { start: 10, end: 20 }
        ],
        2,
        null
      )
    ).toEqual([
      { start: 2, end: 3 },
      { start: 10, end: 20 }
    ])
  })
})

describe('lastPlaybackEndSec', () => {
  it('빈 배열이면 null', () => {
    expect(lastPlaybackEndSec([])).toBeNull()
  })

  it('마지막 구간의 end', () => {
    const intervals: MediaPlaybackInterval[] = [
      { start: 1, end: 2 },
      { start: 10, end: 50 }
    ]
    expect(lastPlaybackEndSec(intervals)).toBe(50)
  })
})
