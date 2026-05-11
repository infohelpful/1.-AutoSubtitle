import { describe, expect, it } from 'vitest'
import {
  calculateVirtualTimeline,
  findSegmentIndexByVirtualMs,
  getOriginalTime,
  getVirtualTime,
  splitTokenAtOriginalTime,
  secToMs,
  type SentenceTokenTimeline
} from './sentenceTokenTimeline'

const sampleTimeline: SentenceTokenTimeline = [
  {
    id: 's1',
    tokens: [
      { id: 't1', text: '안녕', start_original: 0, end_original: 1.0, is_deleted: false },
      { id: 't2', text: '하세요', start_original: 1.0, end_original: 2.5, is_deleted: false }
    ]
  }
]

describe('sentenceTokenTimeline', () => {
  it('calculateVirtualTimeline stacks segments without gaps in virtual ms', () => {
    const vt = calculateVirtualTimeline(sampleTimeline)
    expect(vt.segments.length).toBe(2)
    expect(vt.segments[0]!.virtual_start_ms).toBe(0)
    expect(vt.segments[0]!.virtual_end_ms).toBe(secToMs(1))
    expect(vt.segments[1]!.virtual_start_ms).toBe(secToMs(1))
    expect(vt.segments[1]!.virtual_end_ms).toBe(secToMs(2.5))
    expect(vt.total_virtual_duration_ms).toBe(secToMs(2.5))
  })

  it('skips deleted sentence and token', () => {
    const vt = calculateVirtualTimeline([
      {
        id: 's0',
        is_deleted: true,
        tokens: [{ id: 'x', text: 'a', start_original: 0, end_original: 1 }]
      },
      {
        id: 's1',
        tokens: [
          { id: 'a', text: 'a', start_original: 0, end_original: 1 },
          { id: 'b', text: 'b', start_original: 1, end_original: 2, is_deleted: true },
          { id: 'c', text: 'c', start_original: 2, end_original: 3 }
        ]
      }
    ])
    expect(vt.segments.map((s) => s.tokenId)).toEqual(['a', 'c'])
  })

  it('getOriginalTime / getVirtualTime round-trip at segment interior', () => {
    const vt = calculateVirtualTimeline(sampleTimeline)
    const v = 1.25
    const orig = getOriginalTime(sampleTimeline, v, vt)
    expect(orig).toBeGreaterThan(1.0)
    expect(orig).toBeLessThan(2.5)
    const back = getVirtualTime(sampleTimeline, orig, vt)
    expect(Math.abs(back - v)).toBeLessThan(0.02)
  })

  it('findSegmentIndexByVirtualMs is O(log n)', () => {
    const vt = calculateVirtualTimeline(sampleTimeline)
    expect(findSegmentIndexByVirtualMs(vt.segments, secToMs(0.5))).toBe(0)
    expect(findSegmentIndexByVirtualMs(vt.segments, secToMs(1.25))).toBe(1)
  })

  it('splitTokenAtOriginalTime produces two tokens', () => {
    const next = splitTokenAtOriginalTime(sampleTimeline, 's1', 't2', 1.75)
    const s1 = next.find((s) => s.id === 's1')!
    expect(s1.tokens.length).toBe(3)
    expect(s1.tokens[1]!.text.length).toBeGreaterThan(0)
    expect(s1.tokens[2]!.text.length).toBeGreaterThan(0)
    expect(s1.tokens[1]!.end_original).toBeCloseTo(1.75, 5)
    expect(s1.tokens[2]!.start_original).toBeCloseTo(1.75, 5)
  })
})
