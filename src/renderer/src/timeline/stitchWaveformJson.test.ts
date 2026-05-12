import { describe, expect, it } from 'vitest'
import type { JsonWaveformData } from 'peaks.js'
import type { CutRange } from '../../../shared/ipc'
import {
  buildMediaKeepRangesAfterCuts,
  cutRangesSignature,
  cutRemovedIntervalsExpandOnly,
  exactTimelineDurationSecFromWaveformJson,
  stitchWaveformJsonByCuts,
  stitchWaveformJsonExpandCutsIncremental,
  stitchedEditAxisDurationSecFromCuts
} from './stitchWaveformJson'

function makeJson(pixels: number, spp: number, sr: number): JsonWaveformData {
  const data: number[] = new Array(pixels * 2)
  for (let p = 0; p < pixels; p += 1) {
    data[p * 2] = p % 128
    data[p * 2 + 1] = (p + 1) % 128
  }
  return {
    sample_rate: sr,
    samples_per_pixel: spp,
    bits: 8,
    length: pixels,
    data
  } as JsonWaveformData
}

describe('cutRangesSignature', () => {
  it('병합 순서와 무관하게 동일 컷은 같은 문자열', () => {
    const a: CutRange[] = [
      { start: 1, end: 2 },
      { start: 3, end: 5 }
    ]
    const b: CutRange[] = [{ start: 3, end: 5 }, { start: 1, end: 2 }]
    expect(cutRangesSignature(a)).toBe(cutRangesSignature(b))
  })
})

describe('buildMediaKeepRangesAfterCuts', () => {
  it('10초 중 2~4초 삭제 시 앞·뒤만 남음', () => {
    const k = buildMediaKeepRangesAfterCuts(10, [{ start: 2, end: 4 }])
    expect(k).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 10 }
    ])
  })
})

describe('exactTimelineDurationSecFromWaveformJson', () => {
  it('spp·sr 가 있으면 픽셀 수로 미디어 길이를 구함', () => {
    const sr = 48000
    const spp = 480
    const sec = 928
    const pixels = Math.ceil((sec * sr) / spp)
    const j = makeJson(pixels, spp, sr)
    expect(exactTimelineDurationSecFromWaveformJson(j)).toBeCloseTo(sec, 0)
  })

  it('spp 없으면 힌트 duration 으로 spp 역산 후 길이를 구함', () => {
    const data: number[] = new Array(100 * 2)
    for (let p = 0; p < 100; p += 1) {
      data[p * 2] = p % 128
      data[p * 2 + 1] = (p + 1) % 128
    }
    const j = {
      sample_rate: 48000,
      bits: 8,
      length: 100,
      data
    } as JsonWaveformData
    expect(exactTimelineDurationSecFromWaveformJson(j, 938)).toBeCloseTo(938, 3)
  })
})

describe('stitchedEditAxisDurationSecFromCuts', () => {
  it('전체 스티치 JSON 의 exact 타임라인 길이와 일치', () => {
    const sr = 48000
    const spp = 480
    const mediaSec = 10
    const pixels = Math.ceil((mediaSec * sr) / spp)
    const j = makeJson(pixels, spp, sr)
    const cuts: CutRange[] = [{ start: 2, end: 4 }]
    const stitched = stitchWaveformJsonByCuts(j, cuts, mediaSec)!
    const fromJson = exactTimelineDurationSecFromWaveformJson(stitched, mediaSec)
    const fromCuts = stitchedEditAxisDurationSecFromCuts(j, cuts, mediaSec, mediaSec)
    expect(fromCuts).not.toBeNull()
    expect(fromJson).not.toBeNull()
    expect(fromCuts!).toBeCloseTo(fromJson!, 9)
  })
})

describe('stitchWaveformJsonExpandCutsIncremental', () => {
  it('컷만 늘어날 때 전체 스티치와 동일한 픽셀 길이', () => {
    const sr = 48000
    const spp = 480
    const mediaSec = 10
    const pixels = Math.ceil((mediaSec * sr) / spp)
    const j = makeJson(pixels, spp, sr)
    const a: CutRange[] = [{ start: 2, end: 4 }]
    const b: CutRange[] = [
      { start: 2, end: 4 },
      { start: 6, end: 7 }
    ]
    expect(cutRemovedIntervalsExpandOnly(a, b)).toBe(true)
    const fullA = stitchWaveformJsonByCuts(j, a, mediaSec)!
    const inc = stitchWaveformJsonExpandCutsIncremental(fullA, a, j, b, mediaSec)
    expect(inc).not.toBeNull()
    const fullB = stitchWaveformJsonByCuts(j, b, mediaSec)!
    expect(inc!.length).toBe(fullB.length)
    expect(inc!.data?.length).toBe(fullB.data?.length)
    expect(inc!.data).toEqual(fullB.data)
  })

  it('삭제 되돌리기(컷 축소)면 incremental 불가 → null', () => {
    const sr = 48000
    const spp = 480
    const mediaSec = 10
    const pixels = Math.ceil((mediaSec * sr) / spp)
    const j = makeJson(pixels, spp, sr)
    const a: CutRange[] = [
      { start: 2, end: 4 },
      { start: 6, end: 7 }
    ]
    const b: CutRange[] = [{ start: 2, end: 4 }]
    expect(cutRemovedIntervalsExpandOnly(a, b)).toBe(false)
    const fullA = stitchWaveformJsonByCuts(j, a, mediaSec)!
    expect(stitchWaveformJsonExpandCutsIncremental(fullA, a, j, b, mediaSec)).toBeNull()
  })
})

describe('stitchWaveformJsonByCuts', () => {
  it('컷 없으면 null', () => {
    const j = makeJson(100, 4800, 48000)
    expect(stitchWaveformJsonByCuts(j, [], 10)).toBeNull()
  })

  it('픽셀 수가 삭제 길이에 비례해 줄어듦', () => {
    const sr = 48000
    const spp = 480
    const mediaSec = 10
    const pixels = Math.ceil((mediaSec * sr) / spp)
    const j = makeJson(pixels, spp, sr)
    const cuts: CutRange[] = [{ start: 2, end: 4 }]
    const out = stitchWaveformJsonByCuts(j, cuts, mediaSec)
    expect(out).not.toBeNull()
    expect(out!.length).toBe(Math.floor((out!.data?.length ?? 0) / 2))
    const removedPixels = Math.round(((4 - 2) * sr) / spp)
    expect(out!.length!).toBeCloseTo(pixels - removedPixels, 0)
  })
})
