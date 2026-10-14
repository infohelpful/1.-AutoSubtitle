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

  it('does not let an overlapping silence-only row take over while speech is playing', () => {
    // 실제 문제 영상(299초 부근): 음성 줄(299.02~300.60) 위에 무음 전용 줄(299.04~299.36)이 겹쳐 생긴다.
    const speech = {
      start: 299.02,
      end: 300.6,
      text: '설치가 완료되면',
      words: [
        { start: 299.4, end: 299.9, word: '설치가' },
        { start: 299.9, end: 300.6, word: '완료되면' }
      ]
    }
    const silence = {
      start: 299.04,
      end: 299.36,
      text: '',
      words: [{ start: 299.04, end: 299.36, word: '--', isSilence: true }]
    }
    const before = { start: 295.18, end: 298.97, text: '', words: [{ start: 295.18, end: 298.97, word: '--', isSilence: true }] }
    const lines = [before, speech, silence]
    expect(pickActiveSubtitleIndex(lines, 299.1)).toBe(1)
    expect(pickActiveSubtitleIndex(lines, 299.2)).toBe(1)
    expect(pickActiveSubtitleIndex(lines, 299.5)).toBe(1)
    // 겹치지 않는 진짜 무음 구간은 그대로 무음 줄이 맡는다.
    expect(pickActiveSubtitleIndex(lines, 297)).toBe(0)
  })

  it('does not show the next sentence long before its first word is spoken', () => {
    // 실제 문제 영상(469초 부근): 줄 시작이 첫 단어(474.82)보다 5.4초 앞서 있고, 그 사이는 무음 전용 줄이다.
    const speech = {
      start: 469.4,
      end: 500.94,
      text: '그 다음 USB에',
      words: [
        { start: 474.82, end: 474.9, word: '그' },
        { start: 474.93, end: 475.23, word: '다음' },
        { start: 475.2, end: 476.08, word: 'USB에' }
      ]
    }
    const silence = {
      start: 469.52,
      end: 474.8,
      text: '',
      words: [{ start: 469.52, end: 474.8, word: '--', isSilence: true }]
    }
    const lines = [speech, silence]
    expect(pickActiveSubtitleIndex(lines, 470)).toBe(1)
    expect(pickActiveSubtitleIndex(lines, 473)).toBe(1)
    expect(pickActiveSubtitleIndex(lines, 474.5)).toBe(0)
    expect(pickActiveSubtitleIndex(lines, 476)).toBe(0)
  })

  it('keeps a silence-only row for the part that no speech row covers', () => {
    const speech = {
      start: 10,
      end: 12,
      text: '말',
      words: [{ start: 10, end: 12, word: '말' }]
    }
    const silence = {
      start: 9,
      end: 11,
      text: '',
      words: [{ start: 9, end: 11, word: '--', isSilence: true }]
    }
    const lines = [speech, silence]
    expect(pickActiveSubtitleIndex(lines, 9.5)).toBe(1)
    expect(pickActiveSubtitleIndex(lines, 10.5)).toBe(0)
    expect(pickActiveSubtitleIndex(lines, 11.5)).toBe(0)
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
