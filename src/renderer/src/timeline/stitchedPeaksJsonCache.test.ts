import { describe, expect, it } from 'vitest'
import type { JsonWaveformData } from 'peaks.js'
import { StitchedPeaksJsonLruCache } from './stitchedPeaksJsonCache'

function makeJson(pixels: number): JsonWaveformData {
  const data: number[] = new Array(pixels * 2)
  for (let p = 0; p < pixels; p += 1) {
    data[p * 2] = p % 128
    data[p * 2 + 1] = (p + 1) % 128
  }
  return {
    sample_rate: 48000,
    samples_per_pixel: 480,
    bits: 8,
    length: pixels,
    data
  } as JsonWaveformData
}

describe('StitchedPeaksJsonLruCache', () => {
  it('exact hit 은 같은 reference 를 돌려준다', () => {
    const c = new StitchedPeaksJsonLruCache({ maxEntries: 4, maxBytes: 100 * 1024 * 1024 })
    const a = makeJson(10)
    c.set('vid', 'sig-a', { mergedCuts: [], out: a })
    const hit1 = c.get('vid', 'sig-a')
    const hit2 = c.get('vid', 'sig-a')
    expect(hit1?.out).toBe(a)
    expect(hit2?.out).toBe(a)
  })

  it('새 srcKey 가 들어오면 이전 항목은 모두 evict 된다', () => {
    const c = new StitchedPeaksJsonLruCache()
    c.set('vidA', 'sig-1', { mergedCuts: [], out: makeJson(5) })
    expect(c.size()).toBe(1)
    c.set('vidB', 'sig-1', { mergedCuts: [], out: makeJson(5) })
    expect(c.size()).toBe(1)
    expect(c.get('vidA', 'sig-1')).toBeNull()
    expect(c.get('vidB', 'sig-1')).not.toBeNull()
  })

  it('maxEntries 초과 시 LRU 부터 evict', () => {
    const c = new StitchedPeaksJsonLruCache({ maxEntries: 2, maxBytes: 100 * 1024 * 1024 })
    c.set('vid', 'a', { mergedCuts: [], out: makeJson(2) })
    c.set('vid', 'b', { mergedCuts: [], out: makeJson(2) })
    // a 를 touch → MRU
    c.get('vid', 'a')
    c.set('vid', 'c', { mergedCuts: [], out: makeJson(2) }) // b 가 evict
    expect(c.get('vid', 'b')).toBeNull()
    expect(c.get('vid', 'a')).not.toBeNull()
    expect(c.get('vid', 'c')).not.toBeNull()
  })

  it('maxBytes 초과 시에도 LRU 부터 evict', () => {
    // 한 entry 가 ~16바이트로 추정되도록 작은 픽셀 사용 (pixels*2*4)
    const c = new StitchedPeaksJsonLruCache({ maxEntries: 100, maxBytes: 80 })
    c.set('vid', 'a', { mergedCuts: [], out: makeJson(4) }) // ~32B
    c.set('vid', 'b', { mergedCuts: [], out: makeJson(4) }) // ~32B → 64B
    c.set('vid', 'c', { mergedCuts: [], out: makeJson(4) }) // ~96B > 80B → a evict
    expect(c.get('vid', 'a')).toBeNull()
    expect(c.get('vid', 'b')).not.toBeNull()
    expect(c.get('vid', 'c')).not.toBeNull()
  })

  it('peekMru 는 마지막에 사용된 항목을 반환 (excludeCutSig 가 자기 자신 스킵)', () => {
    const c = new StitchedPeaksJsonLruCache()
    c.set('vid', 'a', { mergedCuts: [], out: makeJson(2) })
    c.set('vid', 'b', { mergedCuts: [], out: makeJson(2) })
    c.set('vid', 'c', { mergedCuts: [], out: makeJson(2) })
    // 가장 최근은 c
    expect(c.peekMru('vid')?.mergedCuts).toEqual([])
    // c 제외 시에는 b
    const mruExC = c.peekMru('vid', 'c')
    expect(mruExC).not.toBeNull()
    // a 를 touch → MRU 로 승격
    c.get('vid', 'a')
    expect(c.peekMru('vid')?.mergedCuts).toEqual([])
    // a 제외 → 그 다음 MRU 는 c
    expect(c.peekMru('vid', 'a')).not.toBeNull()
  })
})
