import { describe, expect, it } from 'vitest'
import {
  buildTimelineClips,
  createTimelineMapping,
  jumpVideoPastClipTailIfNeeded,
  mapMediaToProgramSec,
  mapProgramToMediaSec,
  programDurationSec,
  skipCutRangeAt
} from './mapping'
import type { CutRange } from '../../../shared/ipc'

const EPS = 1e-6

describe('buildTimelineClips + mapProgramToMediaSec / mapMediaToProgramSec', () => {
  it('컷 없음 — 항등 매핑', () => {
    const clips = buildTimelineClips([], 100)
    expect(clips.length).toBe(1)
    expect(clips[0]?.id).toBe(1)
    expect(clips[0]?.editStart).toBeCloseTo(0, 5)
    expect(clips[0]?.editEnd).toBeCloseTo(100, 5)
    expect(clips[0]?.mediaStart).toBeCloseTo(0, 5)
    expect(clips[0]?.mediaEnd).toBeCloseTo(100, 5)
    expect(mapProgramToMediaSec(12.34, clips)).toBeCloseTo(12.34, 5)
    expect(mapMediaToProgramSec(12.34, clips)).toBeCloseTo(12.34, 5)
  })

  it('단일 삭제 구간 [1,2] — 프로그램↔미디어 왕복 (유지 구간만)', () => {
    const cuts: CutRange[] = [{ start: 1, end: 2 }]
    const clips = buildTimelineClips(cuts, 10)
    expect(clips.length).toBe(2)

    const pairs: Array<{ p: number; m: number }> = [
      { p: 0, m: 0 },
      { p: 0.5, m: 0.5 },
      { p: 1 - EPS, m: 1 - EPS },
      { p: 1, m: 2 },
      { p: 2, m: 3 },
      { p: 8, m: 9 }
    ]
    for (const { p, m } of pairs) {
      expect(mapProgramToMediaSec(p, clips)).toBeCloseTo(m, 5)
      expect(mapMediaToProgramSec(m, clips)).toBeCloseTo(p, 5)
    }

    expect(programDurationSec(clips)).toBeCloseTo(9, 5)
  })

  it('EDL 클립을 프로그램 시간 기준으로 이진 탐색 매핑', () => {
    const cuts: CutRange[] = [{ start: 2, end: 4 }]
    const clips = buildTimelineClips(cuts, 8)
    expect(clips.length).toBe(2)
    // clip2: edit[2,6) -> media[4,8)
    expect(clips[1]?.id).toBe(2)
    expect(clips[1]?.editStart).toBeCloseTo(2, 5)
    expect(clips[1]?.editEnd).toBeCloseTo(6, 5)
    expect(clips[1]?.mediaStart).toBeCloseTo(4, 5)
    expect(clips[1]?.mediaEnd).toBeCloseTo(8, 5)
    expect(mapProgramToMediaSec(2.2, clips)).toBeCloseTo(4.2, 5)
  })

  it('왕복: 임의 표본 프로그램 시간', () => {
    const cuts: CutRange[] = [
      { start: 1, end: 2 },
      { start: 5, end: 6 }
    ]
    const clips = buildTimelineClips(cuts, 20)
    const samples = [0, 0.01, 1, 1.5, 3, 10]
    for (const p of samples) {
      const m = mapProgramToMediaSec(p, clips)
      const p2 = mapMediaToProgramSec(m, clips)
      expect(p2).toBeCloseTo(p, 5)
    }
  })

  it('인접 컷 병합 전제 — mergeCutRanges 는 shared 에서 처리', () => {
    const cuts: CutRange[] = [
      { start: 1, end: 1.5 },
      { start: 1.5, end: 2 }
    ]
    const mapping = createTimelineMapping(cuts, 10)
    expect(mapping.mergedCuts.length).toBe(1)
    expect(mapping.mergedCuts[0]!.end).toBeCloseTo(2, 5)
  })
})

describe('mapMediaToProgramSec — 삭제 미디어 구간(클립 밖)', () => {
  it('삭제로 비워진 미디어 구간 안이면 다음 클립 editStart', () => {
    const cuts: CutRange[] = [{ start: 1, end: 2 }]
    const clips = buildTimelineClips(cuts, 10)
    expect(mapMediaToProgramSec(1.5, clips)).toBeCloseTo(1, 5)
  })

  it('선두 삭제 후 첫 미디어 이전 — 편집 축으로 선형 보간', () => {
    const cuts: CutRange[] = [{ start: 0, end: 1 }]
    const clips = buildTimelineClips(cuts, 10)
    expect(clips[0]!.mediaStart).toBeGreaterThan(0)
    expect(mapMediaToProgramSec(0.3, clips)).toBeCloseTo(Math.max(0, 0 + (0.3 - clips[0]!.mediaStart)), 5)
  })
})

describe('skipCutRangeAt', () => {
  it('삭제 구간 내부 시간을 밖으로 밀어냄', () => {
    const cuts: CutRange[] = [{ start: 1, end: 2 }]
    const t = skipCutRangeAt(1.5, cuts)
    expect(t).toBeGreaterThanOrEqual(2 + 2e-4 - 1e-9)
  })
})

describe('jumpVideoPastClipTailIfNeeded', () => {
  it('클립 끝 직전이면 다음 클립의 mediaStart 로 점프', () => {
    const cuts: CutRange[] = [{ start: 1, end: 2 }]
    const clips = buildTimelineClips(cuts, 10)
    const r = jumpVideoPastClipTailIfNeeded(0.99, clips, 0.02)
    expect(r.jumped).toBe(true)
    if (r.jumped) {
      expect(r.toMediaSec).toBeCloseTo(2, 5)
      expect(r.fromClipId).toBe(1)
      expect(r.toClipId).toBe(2)
    }
  })

  it('클립 중간이면 점프하지 않음', () => {
    const cuts: CutRange[] = [{ start: 1, end: 2 }]
    const clips = buildTimelineClips(cuts, 10)
    expect(jumpVideoPastClipTailIfNeeded(0.3, clips, 0.02).jumped).toBe(false)
  })

  it('마지막 클립 꼬리는 점프하지 않음', () => {
    const cuts: CutRange[] = [{ start: 1, end: 2 }]
    const clips = buildTimelineClips(cuts, 10)
    // 마지막 클립의 mediaEnd ≈ 10
    expect(jumpVideoPastClipTailIfNeeded(9.99, clips, 0.02).jumped).toBe(false)
  })
})

describe('createTimelineMapping masterMode', () => {
  it('컷 있음 — 기본 stitched: program ↔ master 항등', () => {
    const cuts: CutRange[] = [{ start: 10, end: 11 }]
    const m = createTimelineMapping(cuts, 100)
    expect(m.masterMode).toBe('stitched')
    expect(m.programToMasterAudioSec(3.33)).toBeCloseTo(3.33, 5)
    expect(m.masterAudioToProgramSec(7)).toBeCloseTo(7, 5)
    // 프로그램 10초 = 미디어에서 삭제 직후 11초 (마스터는 편집 축이라 10과 대응)
    expect(m.programToMediaSec(10)).toBeCloseTo(11, 5)
    expect(m.programToMasterAudioSec(10)).toBeCloseTo(10, 5)
  })

  it('컷 없음 — passthrough: master 축 = 미디어 축', () => {
    const m = createTimelineMapping([], 50)
    expect(m.masterMode).toBe('passthrough')
    const p = 12.3
    expect(m.programToMasterAudioSec(p)).toBeCloseTo(m.programToMediaSec(p), 5)
    expect(m.masterAudioToProgramSec(8)).toBeCloseTo(m.mediaToProgramSec(8), 5)
  })

  it('명시 masterMode:passthrough — 컷 있어도 패스스루 덮어쓰기', () => {
    const cuts: CutRange[] = [{ start: 1, end: 2 }]
    const m = createTimelineMapping(cuts, 10, { masterMode: 'passthrough' })
    expect(m.masterMode).toBe('passthrough')
    expect(m.programToMasterAudioSec(1)).toBeCloseTo(m.programToMediaSec(1), 5)
  })
})
