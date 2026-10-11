import { describe, expect, it } from 'vitest'
import { clipPlanFromCuts, mapSourceIntervalToProgram, programDuration, validateClipPlan } from './clipPlan'

describe('shared media and subtitle clip plan', () => {
  it('cuts the first two seconds from both program duration and cue times', () => {
    const clips = clipPlanFromCuts(6, [{ start: 0, end: 2 }])
    expect(programDuration(clips)).toBe(4)
    expect(mapSourceIntervalToProgram(2.5, 3, clips)).toEqual([{ start: 0.5, end: 1, occurrenceId: 'clip-0' }])
  })
  it('clamps out-of-file cuts and unions overlaps without losing the tail', () => {
    const clips = clipPlanFromCuts(10, [{ start: 20, end: 30 }, { start: -1, end: 2 }, { start: 1, end: 3 }])
    expect(programDuration(clips)).toBe(7)
    expect(clips[0].sourceStart).toBe(3)
  })
  it('splits crossing cues and excludes deleted cues', () => {
    const clips = clipPlanFromCuts(6, [{ start: 2, end: 4 }])
    expect(mapSourceIntervalToProgram(1, 5, clips).map(({ start, end }) => [start, end])).toEqual([[1, 2], [2, 3]])
    expect(mapSourceIntervalToProgram(2, 4, clips)).toEqual([])
  })
  it('supports reordered and repeated occurrences', () => {
    const clips = validateClipPlan([
      { occurrenceId: 'a', sourceStart: 4, sourceEnd: 6, programStart: 0 },
      { occurrenceId: 'b', sourceStart: 0, sourceEnd: 2, programStart: 2 },
      { occurrenceId: 'c', sourceStart: 4, sourceEnd: 6, programStart: 4 }
    ], 6)
    expect(mapSourceIntervalToProgram(4.5, 5, clips).map(({ start }) => start)).toEqual([0.5, 4.5])
  })
  it('rejects invalid data and empty output at the export boundary', () => {
    expect(() => clipPlanFromCuts(5, [{ start: NaN, end: 1 }])).toThrow()
    expect(() => validateClipPlan(clipPlanFromCuts(5, [{ start: 0, end: 6 }]), 5)).toThrow()
    expect(() => validateClipPlan([{ occurrenceId: 'a', sourceStart: 0, sourceEnd: 2, programStart: 1 }], 5)).toThrow()
  })
})
