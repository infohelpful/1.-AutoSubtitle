import { describe, expect, it } from 'vitest'
import { pickActiveSubtitleIndex, subtitlePresentationEnd } from './subtitlePresentation'

describe('continuous subtitle presentation', () => {
  it('holds the preceding text throughout the reported 421 ms gap and switches at the boundary', () => {
    const lines = [{ start: 10.021, end: 12.811, text: '컴퓨터 화면을' }, { start: 13.232, end: 15.6, text: '이런 경험' }]
    for (let time = 12.810; time < 13.232; time += 0.001) expect(pickActiveSubtitleIndex(lines, time)).toBe(0)
    expect(pickActiveSubtitleIndex(lines, 13.232)).toBe(1)
    expect(subtitlePresentationEnd(lines, 0)).toBe(13.232)
    expect(lines[0].end).toBe(12.811)
    expect(pickActiveSubtitleIndex(lines, 10)).toBeNull()
    expect(pickActiveSubtitleIndex(lines, 15.6)).toBeNull()
  })

  it('respects explicit silence and skips deleted rows without depending on stored row order', () => {
    const lines = [
      { start: 139.422, end: 147.020, text: '다음으로' },
      { start: 138.733, end: 139.302, text: '' },
      { start: 128.682, end: 134.916, text: '직관적입니다' },
      { start: 135, end: 136, text: '삭제', isDeleted: true }
    ]
    expect(pickActiveSubtitleIndex(lines, 135.5)).toBe(2)
    expect(pickActiveSubtitleIndex(lines, 138.8)).toBe(1)
    expect(pickActiveSubtitleIndex(lines, 139.422)).toBe(0)
    expect(subtitlePresentationEnd(lines, 2)).toBe(138.733)
  })
})
