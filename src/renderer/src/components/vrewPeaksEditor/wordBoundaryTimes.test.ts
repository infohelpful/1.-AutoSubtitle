import { describe, expect, it } from 'vitest'
import { applyBoundaryDrag, sortWordsByStart } from './wordBoundaryTimes'
import type { Word } from './types'

describe('wordBoundaryTimes', () => {
  it('moves shared boundary between two words', () => {
    const w1: Word = { id: 'block_1_1', text: 'x', start: 1, end: 3 }
    const w2: Word = { id: 'block_1_2', text: 'y', start: 3, end: 5 }
    const sorted = sortWordsByStart([w1, w2])
    const map = new Map<string, Word>([
      [w1.id, w1],
      [w2.id, w2]
    ])
    const next = applyBoundaryDrag(map, sorted, { kind: 'between', leftIndex: 0 }, 3.5, 100)
    expect(next.find((w) => w.id === w1.id)!.end).toBeCloseTo(3.5)
    expect(next.find((w) => w.id === w2.id)!.start).toBeCloseTo(3.5)
  })
})
