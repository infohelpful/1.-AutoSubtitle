import { describe, expect, it } from 'vitest'
import type { ProgramClip } from './clipPlan'
import { buildRenderSchedule, type ScheduleCue } from './exportRenderSchedule'

const clip = (id: string, sourceStart: number, sourceEnd: number, programStart: number): ProgramClip => ({
  occurrenceId: id,
  sourceStart,
  sourceEnd,
  programStart
})

const whole = [clip('c0', 0, 20, 0)]

describe('buildRenderSchedule', () => {
  it('renders a plain cue as one state over its frames', () => {
    const cues: ScheduleCue[] = [{ start: 1, end: 2, text: 'hello world' }]
    expect(buildRenderSchedule({ cues, clips: whole, fps: 30, highlightWords: false })).toEqual([
      { startFrame: 30, endFrame: 60, text: 'hello world', activeIndex: -1 }
    ])
  })

  it('splits a cue per active word with hard hand-over at the shared boundary', () => {
    const cues: ScheduleCue[] = [
      {
        start: 1,
        end: 2,
        text: 'a b',
        words: [
          { start: 1, end: 1.5, text: 'a' },
          { start: 1.5, end: 2, text: 'b' }
        ]
      }
    ]
    expect(buildRenderSchedule({ cues, clips: whole, fps: 30, highlightWords: true })).toEqual([
      { startFrame: 30, endFrame: 45, text: 'a b', words: ['a', 'b'], activeIndex: 0 },
      { startFrame: 45, endFrame: 60, text: 'a b', words: ['a', 'b'], activeIndex: 1 }
    ])
  })

  it('switches the highlight off in a silent gap while the line stays visible', () => {
    const cues: ScheduleCue[] = [
      {
        start: 1,
        end: 2,
        text: 'a b',
        words: [
          { start: 1, end: 1.2, text: 'a' },
          { start: 1.5, end: 1.8, text: 'b' }
        ]
      }
    ]
    const states = buildRenderSchedule({ cues, clips: whole, fps: 30, highlightWords: true })
    expect(states.map((s) => [s.startFrame, s.endFrame, s.activeIndex])).toEqual([
      [30, 36, 0],
      [36, 45, -1],
      [45, 54, 1],
      [54, 60, -1]
    ])
    expect(states.every((s) => s.text === 'a b')).toBe(true)
  })

  it('does not stretch the last word to the end of the displayed cue', () => {
    const cues: ScheduleCue[] = [
      { start: 1, end: 3, text: 'a', words: [{ start: 1, end: 1.5, text: 'a' }] }
    ]
    const states = buildRenderSchedule({ cues, clips: whole, fps: 30, highlightWords: true })
    expect(states.map((s) => [s.startFrame, s.endFrame, s.activeIndex])).toEqual([
      [30, 45, 0],
      [45, 90, -1]
    ])
  })

  it('drops a word shorter than one frame without breaking its neighbours', () => {
    const cues: ScheduleCue[] = [
      {
        start: 1,
        end: 1.5,
        text: 'a b c',
        words: [
          { start: 1, end: 1.2, text: 'a' },
          { start: 1.2 + 0.005, end: 1.2 + 0.01, text: 'b' },
          { start: 1.3, end: 1.5, text: 'c' }
        ]
      }
    ]
    const states = buildRenderSchedule({ cues, clips: whole, fps: 30, highlightWords: true })
    expect(states.map((s) => s.activeIndex)).not.toContain(1)
    expect(states[0]).toMatchObject({ startFrame: 30, activeIndex: 0 })
    expect(states[states.length - 1]).toMatchObject({ endFrame: 45, activeIndex: 2 })
    for (let i = 1; i < states.length; i += 1) {
      expect(states[i]!.startFrame).toBe(states[i - 1]!.endFrame)
    }
  })

  it('maps a cue across a cut by clip occurrence', () => {
    const clips = [clip('c0', 0, 2, 0), clip('c1', 4, 6, 2)]
    const cues: ScheduleCue[] = [
      {
        start: 1.5,
        end: 5,
        text: 'a b c',
        words: [
          { start: 1.5, end: 2, text: 'a' },
          { start: 4, end: 4.5, text: 'b' },
          { start: 4.5, end: 5, text: 'c' }
        ]
      }
    ]
    const states = buildRenderSchedule({ cues, clips, fps: 30, highlightWords: true })
    expect(states.map((s) => [s.startFrame, s.endFrame, s.activeIndex])).toEqual([
      [45, 60, 0],
      [60, 75, 1],
      [75, 90, 2]
    ])
  })

  it('renders every occurrence of a repeated clip with its own highlight timing', () => {
    const clips = [clip('r0', 0, 1, 0), clip('r1', 0, 1, 1)]
    const cues: ScheduleCue[] = [
      {
        start: 0,
        end: 1,
        text: 'a b',
        words: [
          { start: 0, end: 0.5, text: 'a' },
          { start: 0.5, end: 1, text: 'b' }
        ]
      }
    ]
    const states = buildRenderSchedule({ cues, clips, fps: 30, highlightWords: true })
    expect(states.map((s) => [s.startFrame, s.endFrame, s.activeIndex])).toEqual([
      [0, 15, 0],
      [15, 30, 1],
      [30, 45, 0],
      [45, 60, 1]
    ])
  })

  it('falls back to a plain line when word text does not match the cue text', () => {
    const cues: ScheduleCue[] = [
      { start: 1, end: 2, text: 'edited line', words: [{ start: 1, end: 2, text: 'original' }] }
    ]
    const states = buildRenderSchedule({ cues, clips: whole, fps: 30, highlightWords: true })
    expect(states).toEqual([{ startFrame: 30, endFrame: 60, text: 'edited line', activeIndex: -1 }])
  })

  it('lets the earliest-start cue win where cues overlap, like the legacy overlay', () => {
    const cues: ScheduleCue[] = [
      { start: 0, end: 1, text: 'first' },
      { start: 0.5, end: 2, text: 'second' },
      { start: 0.2, end: 0.4, text: 'hidden' }
    ]
    const states = buildRenderSchedule({ cues, clips: whole, fps: 30, highlightWords: false })
    expect(states.map((s) => [s.text, s.startFrame, s.endFrame])).toEqual([
      ['first', 0, 30],
      ['second', 30, 60]
    ])
  })

  it('ignores empty text and cues outside the program', () => {
    const cues: ScheduleCue[] = [
      { start: 0, end: 1, text: '   ' },
      { start: 30, end: 31, text: 'outside' }
    ]
    expect(buildRenderSchedule({ cues, clips: whole, fps: 30, highlightWords: false })).toEqual([])
  })

  it('works with NTSC fractional frame rates', () => {
    const cues: ScheduleCue[] = [{ start: 1, end: 2, text: 'x' }]
    const [s] = buildRenderSchedule({ cues, clips: whole, fps: 30000 / 1001, highlightWords: false })
    expect(s!.startFrame).toBe(30)
    expect(s!.endFrame).toBe(60)
  })

  it('rejects an invalid frame rate', () => {
    expect(() => buildRenderSchedule({ cues: [], clips: whole, fps: 0, highlightWords: false })).toThrow()
  })
})
