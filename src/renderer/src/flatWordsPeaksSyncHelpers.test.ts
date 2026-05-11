import { describe, expect, it } from 'vitest'
import type { SegmentOptions } from 'peaks.js'
import {
  canIncrementalWordList,
  segmentOptionsPeaksUpdateEqual,
  segmentOptionsRequireFullRebuild,
  segmentOptionsUpdatePayload
} from './flatWordsPeaksSyncHelpers'
import type { Word } from './components/vrewPeaksEditor/types'

const w = (id: number, start: number, end: number): Word => ({
  id: `block_1_${id}`,
  text: 'a',
  start,
  end
})

describe('canIncrementalWordList', () => {
  it('returns false when prev null', () => {
    expect(canIncrementalWordList(null, [w(1, 0, 1)])).toBe(false)
  })

  it('returns false on length mismatch', () => {
    expect(canIncrementalWordList([w(1, 0, 1)], [w(1, 0, 1), w(2, 1, 2)])).toBe(false)
  })

  it('returns false when id order differs', () => {
    expect(canIncrementalWordList([w(1, 0, 1), w(2, 1, 2)], [w(2, 1, 2), w(1, 0, 1)])).toBe(false)
  })

  it('returns true when ids match in order', () => {
    expect(canIncrementalWordList([w(1, 0, 1), w(2, 2, 3)], [w(1, 0, 0.5), w(2, 2, 3)])).toBe(true)
  })
})

describe('segmentOptionsRequireFullRebuild', () => {
  it('detects markers change', () => {
    const a: SegmentOptions = { startTime: 0, endTime: 1, markers: false }
    const b: SegmentOptions = { startTime: 0, endTime: 1, markers: true }
    expect(segmentOptionsRequireFullRebuild(a, b)).toBe(true)
  })

  it('detects overlay change', () => {
    const a: SegmentOptions = { startTime: 0, endTime: 1, overlay: false }
    const b: SegmentOptions = { startTime: 0, endTime: 1, overlay: true }
    expect(segmentOptionsRequireFullRebuild(a, b)).toBe(true)
  })
})

describe('segmentOptionsPeaksUpdateEqual', () => {
  const eps = 1e-5
  it('compares times within eps', () => {
    const a: SegmentOptions = { startTime: 0, endTime: 1, color: '#fff' }
    const b: SegmentOptions = { startTime: eps / 2, endTime: 1, color: '#fff' }
    expect(segmentOptionsPeaksUpdateEqual(a, b, eps)).toBe(true)
  })

  it('detects color change', () => {
    const a: SegmentOptions = { startTime: 0, endTime: 1, color: '#aaa', waveformColor: '#aaa' }
    const b: SegmentOptions = { startTime: 0, endTime: 1, color: '#bbb', waveformColor: '#aaa' }
    expect(segmentOptionsPeaksUpdateEqual(a, b, eps)).toBe(false)
  })
})

describe('segmentOptionsUpdatePayload', () => {
  it('omits markers and overlay', () => {
    const o: SegmentOptions = {
      startTime: 1,
      endTime: 2,
      editable: true,
      color: 'red',
      waveformColor: 'blue',
      markers: true,
      overlay: true
    }
    const p = segmentOptionsUpdatePayload(o)
    expect(p).not.toHaveProperty('markers')
    expect(p).not.toHaveProperty('overlay')
    expect(p.startTime).toBe(1)
    expect(p.endTime).toBe(2)
  })
})
