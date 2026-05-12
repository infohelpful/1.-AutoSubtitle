import { describe, expect, it } from 'vitest'

import { computeWordContextWindow } from './lineZoomWindow'

describe('computeWordContextWindow — cross-line zoom extend', () => {
  it('extends windowStart left when extendWindowStartToIncludeSec is earlier than lineStart - pad', () => {
    /** 줄 경계에 큰 무음이 있어도 이전 줄 마지막 단어까지 왼쪽으로 줌이 닿아야 merge 드래그 가능 */
    const words = [
      { start: 0.5, end: 0.9 },
      { start: 1.0, end: 1.5 }
    ]
    const wi = 0
    const base = computeWordContextWindow(words, wi, 0, 0, { mediaDurationSec: 100 })
    expect(base).not.toBeNull()
    const extended = computeWordContextWindow(words, wi, 0, 0, {
      mediaDurationSec: 100,
      extendWindowStartToIncludeSec: 0.004
    })
    expect(extended).not.toBeNull()
    expect(extended!.windowStart).toBeLessThan(base!.windowStart - 1e-6)
    expect(extended!.windowStart).toBeLessThanOrEqual(0.004 + 1e-6)
  })

  it('extends windowEnd right when extendWindowEndToIncludeSec is later than lineEnd + pad', () => {
    const words = [
      { start: 0.0, end: 0.4 },
      { start: 0.5, end: 0.8 }
    ]
    const wi = 1
    const base = computeWordContextWindow(words, wi, 0, 0, { mediaDurationSec: 100 })
    const extended = computeWordContextWindow(words, wi, 0, 0, {
      mediaDurationSec: 100,
      extendWindowEndToIncludeSec: 2.0
    })
    expect(extended!.windowEnd).toBeGreaterThan(base!.windowEnd - 1e-9)
    expect(extended!.windowEnd).toBeGreaterThanOrEqual(2.0 - 1e-6)
  })
})
