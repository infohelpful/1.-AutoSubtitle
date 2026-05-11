import { describe, expect, it } from 'vitest'
import {
  findBlockIndex,
  findBlockIndexByRealMs,
  mapR2V,
  mapV2R,
  type VirtualBlockMs
} from './blockMapping'

function blocksFixture(): VirtualBlockMs[] {
  return [
    { vStartMs: 0, vEndMs: 10_000, oStartMs: 1000, oEndMs: 11_000 },
    { vStartMs: 10_000, vEndMs: 25_000, oStartMs: 50_000, oEndMs: 65_000 }
  ]
}

describe('findBlockIndex', () => {
  it('finds block with binary search', () => {
    const b = blocksFixture()
    expect(findBlockIndex(0, b)).toBe(0)
    expect(findBlockIndex(9999, b)).toBe(0)
    expect(findBlockIndex(10_000, b)).toBe(1)
    expect(findBlockIndex(24_999, b)).toBe(1)
  })

  it('returns -1 for gaps or out of range', () => {
    const b = blocksFixture()
    expect(findBlockIndex(-1, b)).toBe(-1)
    expect(findBlockIndex(99_999, b)).toBe(-1)
  })
})

describe('mapV2R / mapR2V', () => {
  it('mapV2R uses T_real = o_start + (T_virtual - v_start)', () => {
    const b = blocksFixture()
    expect(mapV2R(5000, b)).toBe(1000 + 5000)
    expect(mapV2R(10_000, b)).toBe(50_000)
  })

  it('mapR2V inverts within block', () => {
    const b = blocksFixture()
    const r = 52_000
    expect(mapR2V(r, b)).toBe(10_000 + (52_000 - 50_000))
    expect(mapV2R(mapR2V(r, b)!, b)).toBe(r)
  })

  it('findBlockIndexByRealMs mirrors virtual axis', () => {
    const b = blocksFixture()
    expect(findBlockIndexByRealMs(5000, b)).toBe(0)
    expect(findBlockIndexByRealMs(60_000, b)).toBe(1)
    expect(findBlockIndexByRealMs(66_000, b)).toBe(-1)
  })
})
