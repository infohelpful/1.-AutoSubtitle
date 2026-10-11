import { describe, expect, it } from 'vitest'
import {
  effectiveAlignmentStatus,
  markWordEdited,
  parseWordAlignmentMeta
} from './wordAlignmentMeta'

describe('parseWordAlignmentMeta', () => {
  it('keeps valid sidecar alignment fields', () => {
    const meta = parseWordAlignmentMeta({
      id: 'seg-0:word:3',
      segmentId: 'seg-0',
      alignmentStatus: 'aligned',
      alignmentScore: 0.83,
      sourceStart: 1.25,
      sourceEnd: 1.75,
      rawStart: 1.2,
      rawEnd: 1.8,
      engine: 'whisperx',
      modelRevision: 'abc',
      alignmentText: '안녕',
      reviewReasons: ['unsupported_character'],
      manualStartLocked: true,
      manualEndLocked: false
    })
    expect(meta).toEqual({
      id: 'seg-0:word:3',
      segmentId: 'seg-0',
      alignmentStatus: 'aligned',
      alignmentScore: 0.83,
      sourceStart: 1.25,
      sourceEnd: 1.75,
      rawStart: 1.2,
      rawEnd: 1.8,
      engine: 'whisperx',
      modelRevision: 'abc',
      alignmentText: '안녕',
      reviewReasons: ['unsupported_character'],
      manualStartLocked: true
    })
  })

  it('keeps null times as null (unaligned) instead of inventing a value', () => {
    const meta = parseWordAlignmentMeta({
      alignmentStatus: 'unaligned',
      sourceStart: null,
      sourceEnd: null,
      alignmentScore: null
    })
    expect(meta.sourceStart).toBeNull()
    expect(meta.sourceEnd).toBeNull()
    expect(meta.alignmentScore).toBeNull()
    expect(meta.alignmentStatus).toBe('unaligned')
  })

  it('ignores invalid values', () => {
    const meta = parseWordAlignmentMeta({
      id: '',
      alignmentStatus: 'perfect',
      alignmentScore: Number.NaN,
      sourceStart: 'x',
      reviewReasons: [1, 'ok', null],
      manualStartLocked: 'yes'
    })
    expect(meta).toEqual({ reviewReasons: ['ok'] })
  })

  it('returns an empty object for a legacy word', () => {
    expect(parseWordAlignmentMeta({ start: 1, end: 2, word: 'a' })).toEqual({})
  })
})

describe('effectiveAlignmentStatus', () => {
  it('never reports a legacy word as aligned', () => {
    expect(effectiveAlignmentStatus({})).toBe('estimated')
    expect(effectiveAlignmentStatus({ alignmentStatus: 'aligned' })).toBe('aligned')
  })
})

describe('markWordEdited', () => {
  const aligned = {
    start: 1,
    end: 2,
    word: '안녕',
    id: 'w1',
    alignmentStatus: 'aligned' as const,
    alignmentScore: 0.9,
    sourceStart: 1,
    sourceEnd: 2
  }

  it('is a no-op for unchanged text and times (float noise tolerated)', () => {
    const next = markWordEdited(aligned, { start: 1 + 1e-9, end: 2 - 1e-9, word: '안녕' })
    expect(next.alignmentStatus).toBe('aligned')
    expect(next.manualStartLocked).toBeUndefined()
    expect(next.manualEndLocked).toBeUndefined()
    expect(next.id).toBe('w1')
  })

  it('marks an aligned word stale when its text is edited and keeps its times', () => {
    const next = markWordEdited(aligned, { start: 1, end: 2, word: '안녕하' })
    expect(next.alignmentStatus).toBe('stale')
    expect(next.reviewReasons).toContain('text_edited')
    expect(next.start).toBe(1)
    expect(next.end).toBe(2)
    expect(next.sourceStart).toBe(1)
  })

  it('locks only the moved edge and marks the word manual', () => {
    const next = markWordEdited(aligned, { start: 1, end: 2.2, word: '안녕' })
    expect(next.alignmentStatus).toBe('manual')
    expect(next.manualEndLocked).toBe(true)
    expect(next.manualStartLocked).toBeUndefined()
    expect(next.end).toBe(2.2)
    // the engine estimate is kept for audit
    expect(next.sourceEnd).toBe(2)
  })

  it('lets a manual boundary win over stale when text and time change together', () => {
    const next = markWordEdited(aligned, { start: 0.9, end: 2, word: '안녕하' })
    expect(next.alignmentStatus).toBe('manual')
    expect(next.manualStartLocked).toBe(true)
  })

  it('does not attach alignment state to a legacy word on a text-only edit', () => {
    const legacy = { start: 1, end: 2, word: 'a' }
    const next = markWordEdited(legacy, { start: 1, end: 2, word: 'b' })
    expect(next).toEqual({ start: 1, end: 2, word: 'b' })
  })

  it('records a manual boundary on a legacy word', () => {
    const legacy = { start: 1, end: 2, word: 'a' }
    const next = markWordEdited(legacy, { start: 1.5, end: 2, word: 'a' })
    expect(next.alignmentStatus).toBe('manual')
    expect(next.manualStartLocked).toBe(true)
  })

  it('leaves silence placeholders without alignment state', () => {
    const silence = { start: 0, end: 1, word: '--', isSilence: true }
    const next = markWordEdited(silence, { start: 0, end: 1.5, word: '--' })
    expect(next.alignmentStatus).toBeUndefined()
    expect(next.end).toBe(1.5)
  })

  it('keeps an unaligned word unaligned on text edit', () => {
    const u = { start: 1, end: 2, word: 'a', alignmentStatus: 'unaligned' as const }
    expect(markWordEdited(u, { start: 1, end: 2, word: 'b' }).alignmentStatus).toBe('unaligned')
  })
})
