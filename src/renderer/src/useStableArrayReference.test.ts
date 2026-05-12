import { describe, expect, it } from 'vitest'
import {
  cutRangeShallowEqual,
  reuseArrayReferenceIfElementsEqual
} from './useStableArrayReference'

describe('reuseArrayReferenceIfElementsEqual', () => {
  it('동일 reference 면 그대로 반환', () => {
    const a = [{ x: 1 }]
    expect(reuseArrayReferenceIfElementsEqual(a, a)).toBe(a)
  })

  it('원소가 모두 같은 reference 면 prev 반환', () => {
    const a = { x: 1 }
    const b = { x: 2 }
    const arr1 = [a, b]
    const arr2 = [a, b]
    expect(reuseArrayReferenceIfElementsEqual(arr1, arr2)).toBe(arr1)
  })

  it('원소 하나라도 reference 가 다르면 next 반환', () => {
    const a = { x: 1 }
    const b = { x: 2 }
    const b2 = { x: 2 }
    const arr1 = [a, b]
    const arr2 = [a, b2]
    expect(reuseArrayReferenceIfElementsEqual(arr1, arr2)).toBe(arr2)
  })

  it('길이가 다르면 next 반환', () => {
    const a = { x: 1 }
    const b = { x: 2 }
    expect(reuseArrayReferenceIfElementsEqual([a, b], [a])).toEqual([a])
    expect(reuseArrayReferenceIfElementsEqual([a, b], [a, b, b])).toEqual([a, b, b])
  })

  it('cutRangeShallowEqual 비교자 — 같은 start/end 면 prev 유지', () => {
    const r1a = { start: 1, end: 2 }
    const r1b = { start: 1, end: 2 }
    const r2 = { start: 3, end: 4 }
    const arr1 = [r1a, r2]
    const arr2 = [r1b, r2]
    expect(reuseArrayReferenceIfElementsEqual(arr1, arr2, cutRangeShallowEqual)).toBe(arr1)
  })

  it('cutRangeShallowEqual — start/end 가 다르면 next', () => {
    const r1 = { start: 1, end: 2 }
    const r2 = { start: 3, end: 4 }
    const r3 = { start: 3, end: 5 }
    expect(reuseArrayReferenceIfElementsEqual([r1, r2], [r1, r3], cutRangeShallowEqual)).not.toBe(
      [r1, r2] as unknown
    )
  })
})
