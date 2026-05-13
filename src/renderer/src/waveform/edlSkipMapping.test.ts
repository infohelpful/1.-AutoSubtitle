import { describe, expect, it } from 'vitest'
import { buildEdlSkipMapping } from './edlSkipMapping'

describe('buildEdlSkipMapping', () => {
  it('skip 0 개 — viewSpan == activeSpan, 매핑은 선형', () => {
    const m = buildEdlSkipMapping({ start: 10, end: 20 }, [])
    expect(m.activeSpanSec).toBeCloseTo(10, 6)
    expect(m.viewSpanSec).toBeCloseTo(10, 6)
    expect(m.mediaSecToActiveSec(15)).toBeCloseTo(5, 6)
    expect(m.activeSecToMediaSec(5)).toBeCloseTo(15, 6)
    expect(m.mediaSecToPixel(15, 200)).toBeCloseTo(100, 6)
    expect(m.pixelToMediaSec(100, 200)).toBeCloseTo(15, 6)
  })

  it('skip 1 개 — 활성 시간 합산, 픽셀 매핑이 skip 을 건너뜀', () => {
    const m = buildEdlSkipMapping({ start: 10, end: 20 }, [{ start: 12, end: 14 }])
    expect(m.activeSpanSec).toBeCloseTo(8, 6)
    expect(m.mediaSecToActiveSec(10)).toBeCloseTo(0, 6)
    expect(m.mediaSecToActiveSec(12)).toBeCloseTo(2, 6)
    expect(m.mediaSecToActiveSec(13)).toBeCloseTo(2, 6) // skip 안 → 시작으로 클램프
    expect(m.mediaSecToActiveSec(14)).toBeCloseTo(2, 6) // skip 경계도 클램프
    expect(m.mediaSecToActiveSec(15)).toBeCloseTo(3, 6)
    expect(m.mediaSecToActiveSec(20)).toBeCloseTo(8, 6)
  })

  it('skip 1 개 — activeSec → mediaSec 역변환 (skip 경계 통과)', () => {
    const m = buildEdlSkipMapping({ start: 10, end: 20 }, [{ start: 12, end: 14 }])
    expect(m.activeSecToMediaSec(0)).toBeCloseTo(10, 6)
    expect(m.activeSecToMediaSec(1)).toBeCloseTo(11, 6)
    expect(m.activeSecToMediaSec(2)).toBeCloseTo(14, 6) // skip 경계 위 → skip.end 로 점프
    expect(m.activeSecToMediaSec(3)).toBeCloseTo(15, 6)
    expect(m.activeSecToMediaSec(8)).toBeCloseTo(20, 6)
  })

  it('skip 2 개 — 비겹침, prefix 누적', () => {
    const m = buildEdlSkipMapping(
      { start: 0, end: 10 },
      [
        { start: 2, end: 3 },
        { start: 6, end: 8 }
      ]
    )
    expect(m.activeSpanSec).toBeCloseTo(7, 6)
    // 활성: [0,2] + [3,6] + [8,10] = 2 + 3 + 2 = 7
    expect(m.mediaSecToActiveSec(1)).toBeCloseTo(1, 6)
    expect(m.mediaSecToActiveSec(2)).toBeCloseTo(2, 6)
    expect(m.mediaSecToActiveSec(3)).toBeCloseTo(2, 6) // skip1 진입 — 시작에서 클램프
    expect(m.mediaSecToActiveSec(5)).toBeCloseTo(4, 6)
    expect(m.mediaSecToActiveSec(6)).toBeCloseTo(5, 6)
    expect(m.mediaSecToActiveSec(7)).toBeCloseTo(5, 6) // skip2 안
    expect(m.mediaSecToActiveSec(8)).toBeCloseTo(5, 6) // skip2 경계
    expect(m.mediaSecToActiveSec(9)).toBeCloseTo(6, 6)
    expect(m.mediaSecToActiveSec(10)).toBeCloseTo(7, 6)
  })

  it('skip 2 개 — activeSec → mediaSec', () => {
    const m = buildEdlSkipMapping(
      { start: 0, end: 10 },
      [
        { start: 2, end: 3 },
        { start: 6, end: 8 }
      ]
    )
    expect(m.activeSecToMediaSec(0)).toBeCloseTo(0, 6)
    expect(m.activeSecToMediaSec(2)).toBeCloseTo(3, 6) // skip1 경계 — 다음 활성 시작
    expect(m.activeSecToMediaSec(4)).toBeCloseTo(5, 6)
    expect(m.activeSecToMediaSec(5)).toBeCloseTo(8, 6) // skip2 경계
    expect(m.activeSecToMediaSec(6)).toBeCloseTo(9, 6)
    expect(m.activeSecToMediaSec(7)).toBeCloseTo(10, 6)
  })

  it('viewWin 밖 skip 은 무시', () => {
    const m = buildEdlSkipMapping({ start: 10, end: 20 }, [
      { start: 0, end: 5 }, // 완전 viewWin 밖
      { start: 22, end: 30 }, // 완전 viewWin 밖
      { start: 8, end: 12 } // 부분 — clamp 후 [10,12]
    ])
    expect(m.activeSpanSec).toBeCloseTo(8, 6) // 10 - 2
    expect(m.skipsClipped).toHaveLength(1)
    expect(m.skipsClipped[0]).toEqual({ start: 10, end: 12 })
  })

  it('skip 이 겹침 — merge 됨', () => {
    const m = buildEdlSkipMapping({ start: 0, end: 10 }, [
      { start: 2, end: 5 },
      { start: 4, end: 7 }
    ])
    expect(m.skipsClipped).toHaveLength(1)
    expect(m.skipsClipped[0]).toEqual({ start: 2, end: 7 })
    expect(m.activeSpanSec).toBeCloseTo(5, 6)
  })

  it('round-trip — 활성 시각은 그대로 복귀 / 경계는 skip.end 로 통과', () => {
    const m = buildEdlSkipMapping({ start: 0, end: 10 }, [{ start: 4, end: 6 }])
    // 명백한 활성 내부 시각
    for (const t of [0, 1, 2, 3.5, 7, 9, 10]) {
      const a = m.mediaSecToActiveSec(t)
      const back = m.activeSecToMediaSec(a)
      expect(back).toBeCloseTo(t, 6)
    }
    // 경계 / skip 내부: activeSec 가 같은 값으로 가지만 역변환은 *다음 활성 시작* 으로 통과
    // - t=4 (skip 시작) : activeSec = 4 → activeSecToMediaSec(4) = 6 (skip.end)
    // - t=5 (skip 내부) : activeSec = 4 → 6
    // - t=6 (skip 끝)   : activeSec = 4 → 6
    expect(m.activeSecToMediaSec(m.mediaSecToActiveSec(4))).toBeCloseTo(6, 6)
    expect(m.activeSecToMediaSec(m.mediaSecToActiveSec(5))).toBeCloseTo(6, 6)
    expect(m.activeSecToMediaSec(m.mediaSecToActiveSec(6))).toBeCloseTo(6, 6)
  })

  it('픽셀 매핑 — wPx=0 안전', () => {
    const m = buildEdlSkipMapping({ start: 0, end: 10 }, [{ start: 4, end: 6 }])
    expect(m.mediaSecToPixel(5, 0)).toBe(0)
    expect(m.pixelToMediaSec(10, 0)).toBe(0) // pixelToActiveSec=0 → activeSecToMediaSec(0) = winStart = 0
  })

  it('viewSpan 0 — degenerate (activeSpanSec=0)', () => {
    const m = buildEdlSkipMapping({ start: 5, end: 5 }, [])
    expect(m.activeSpanSec).toBe(0)
    expect(m.mediaSecToActiveSec(5)).toBe(0)
    expect(m.activeSecToMediaSec(0)).toBe(5)
  })

  it('실제 시나리오 — 단어 "계"(11.498–11.689) + tombstone "?"(11.689–11.957) + "속"(11.957–12.207), viewWin 11.20–12.25', () => {
    const m = buildEdlSkipMapping({ start: 11.2, end: 12.25 }, [{ start: 11.689, end: 11.957 }])
    expect(m.viewSpanSec).toBeCloseTo(1.05, 6)
    expect(m.activeSpanSec).toBeCloseTo(1.05 - 0.268, 6)
    // "계" 끝(11.689) 의 activeSec
    const aKeEnd = m.mediaSecToActiveSec(11.689)
    expect(aKeEnd).toBeCloseTo(11.689 - 11.2, 6)
    // "속" 시작(11.957) 의 activeSec — tombstone 직후라 같은 activeSec
    const aSokStart = m.mediaSecToActiveSec(11.957)
    expect(aSokStart).toBeCloseTo(aKeEnd, 6)
    // "속" 끝(12.207) — "속" 길이만큼 더해짐
    const aSokEnd = m.mediaSecToActiveSec(12.207)
    expect(aSokEnd - aSokStart).toBeCloseTo(0.25, 6)
  })
})
