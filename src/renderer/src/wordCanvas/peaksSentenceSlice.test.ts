import { describe, expect, it } from 'vitest'
import type { JsonWaveformData } from '../../../shared/waveformJson'
import { slicePeaksJsonToRmsChunk, slicePeaksJsonToRmsChunkCached } from './peaksSentenceSlice'

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

describe('slicePeaksJsonToRmsChunk', () => {
  it('null json 이면 빈 배열', () => {
    expect(slicePeaksJsonToRmsChunk(null, 0, 1)).toEqual([])
  })

  it('전체 길이와 동일 구간이면 비어 있지 않은 포인트들', () => {
    const sr = 8000
    const spp = 100
    const pixels = 100
    const j = makeJson(pixels, spp, sr)
    const dur = (pixels * spp) / sr
    const chunk = slicePeaksJsonToRmsChunk(j, 0, dur, { mediaDurationHintSec: dur, targetPoints: 16 })
    expect(chunk.length).toBeGreaterThan(0)
    expect(chunk.every((x) => Number.isFinite(x))).toBe(true)
  })

  it('역순 start/end 도 정규화되어 슬라이스', () => {
    const sr = 8000
    const spp = 100
    const pixels = 50
    const j = makeJson(pixels, spp, sr)
    const dur = (pixels * spp) / sr
    const a = slicePeaksJsonToRmsChunk(j, 0, dur * 0.5, { mediaDurationHintSec: dur })
    const b = slicePeaksJsonToRmsChunk(j, dur * 0.5, 0, { mediaDurationHintSec: dur })
    expect(a.length).toBe(b.length)
  })
})

describe('slicePeaksJsonToRmsChunkCached', () => {
  it('동일 인자면 비캐시와 동일 배열', () => {
    const sr = 8000
    const spp = 100
    const pixels = 100
    const j = makeJson(pixels, spp, sr)
    const dur = (pixels * spp) / sr
    const opts = { mediaDurationHintSec: dur, targetPoints: 16 }
    const a = slicePeaksJsonToRmsChunk(j, 0, dur * 0.3, opts)
    const b = slicePeaksJsonToRmsChunkCached(j, 0, dur * 0.3, opts)
    expect(b).toEqual(a)
  })
})
