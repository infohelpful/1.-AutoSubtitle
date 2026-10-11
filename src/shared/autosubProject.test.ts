import { describe, expect, it } from 'vitest'
import { parseAutosubProjectFile } from './autosubProject'
import { ensureWordIdentities } from './wordIdentity'
import { editSubtitleText } from './editSubtitleText'
import type { SubtitleLine } from './subtitles'

export const projectFixture = () => ({
  format: 'autosubtitle-project', version: 2, savedAt: '2026-10-12T00:00:00Z', videoPath: 'C:/video.mp4',
  mediaFingerprint: { algorithm: 'sha256', size: 8, digest: 'a'.repeat(64) }, cutRanges: [{ start: 3, end: 4 }],
  subtitleStyle: { fontFamily: 'Arial', fontSize: 32, textColor: '#ffffff', fontWeight: 700,
    bgColor: '#000000', bgOpacity: 60, bgPaddingPct: 10, strokeColor: '#000000', strokeWidth: 2,
    x: 50, y: 10, wordHighlightEnabled: true, wordHighlightColor: '#123abc' },
  subtitles: [{ start: 0, end: 2, text: '일 초', words: [
    { id: 'one', start: 0, end: 1, word: '일', alignmentStatus: 'manual', manualStartLocked: true,
      sourceStart: 0.2, sourceEnd: 0.9, rawStart: 0.1, rawEnd: 1.1, alignmentScore: 0.8,
      alignmentText: '일', readingOverride: '일', modelRevision: 'abc', engine: 'whisperx', segmentId: 'seg',
      reviewReasons: ['test'], textSpanMap: [{ displayStart: 0, displayEnd: 1, alignmentStart: 0, alignmentEnd: 1 }],
      charSpans: [{ char: '일', start: 0.2, end: 0.9, score: 0.8, alignmentStart: 0, alignmentEnd: 1 }] },
    { id: 'empty', start: 1, end: 1.5, word: '', alignmentStatus: 'stale' },
    { id: 'deleted', start: 1.5, end: 2, word: '초', isDeleted: true, mergedByEdgeTrim: true, splitChain: '12' }
  ] }, { start: 3, end: 4, text: '', isDeleted: true, words: [
    { start: 3, end: 4, word: '--', isDeleted: true, isSilence: true }
  ] }],
  virtualTimeline: [{ id: 'cut', mediaStartSec: 3, mediaEndSec: 4, text: '', isDeleted: true }]
})

describe('project v2 storage', () => {
  it('round trips exact text, empty slots, tombstones, split flags, highlight and all alignment metadata', () => {
    const raw = projectFixture()
    const parsed = parseAutosubProjectFile(JSON.parse(JSON.stringify(raw)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data).toEqual(raw)
    expect(parseAutosubProjectFile(JSON.parse(JSON.stringify(parsed.data)))).toEqual(parsed)
  })
  it('migrates v1 times as estimated without realigning, preserving known extension metadata', () => {
    const raw = { ...projectFixture(), version: 1, mediaFingerprint: undefined,
      subtitles: [{ start: 0, end: 2, text: '예전 자막', words: [
        { start: 0.13, end: 0.81, word: '예전' },
        { id: 'known', start: 1, end: 2, word: '자막', alignmentStatus: 'manual', manualEndLocked: true }
      ] }] }
    const before = JSON.stringify(raw)
    const parsed = parseAutosubProjectFile(raw)
    expect(JSON.stringify(raw)).toBe(before)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.migrated).toBe(true)
    expect(parsed.data.version).toBe(2)
    expect(parsed.data.mediaFingerprint).toBeNull()
    expect(parsed.data.subtitles[0].words![0]).toMatchObject({
      start: 0.13, end: 0.81, rawStart: 0.13, rawEnd: 0.81, alignmentStatus: 'estimated', reviewReasons: ['legacy_project']
    })
    expect(parsed.data.subtitles[0].words![0].id).toBeTruthy()
    expect(parsed.data.subtitles[0].words![1]).toMatchObject({ id: 'known', alignmentStatus: 'manual', manualEndLocked: true })
    const reopened = parseAutosubProjectFile(JSON.parse(JSON.stringify(parsed.data)))
    expect(reopened.ok && reopened.data).toEqual(parsed.data)
  })
  it('rejects malformed data instead of silently dropping saved edits', () => {
    for (const bad of [
      { ...projectFixture(), version: 900 },
      { ...projectFixture(), subtitles: [{ start: 1, end: 0, text: 'bad' }] },
      { ...projectFixture(), mediaFingerprint: { algorithm: 'sha256', size: -1, digest: 'bad' } }
    ]) expect(parseAutosubProjectFile(bad).ok).toBe(false)
  })
  it('retains source slots across erase, save/reopen, retype', () => {
    const raw = projectFixture()
    const edited = editSubtitleText(raw.subtitles[0] as SubtitleLine, '')
    const parsed = parseAutosubProjectFile({ ...raw, subtitles: [edited] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const restored = editSubtitleText(parsed.data.subtitles[0], '다시 입력')
    expect(restored.words?.map(w => w.id)).toEqual(edited.words?.map(w => w.id))
    expect(restored.words?.map(w => [w.start, w.end])).toEqual(edited.words?.map(w => [w.start, w.end]))
    expect(restored.words?.[0].word).toBe('다시 입력')
  })
})

it('keeps IDs through edits/reorder and repairs only duplicate/new speech identities', () => {
  const lines: SubtitleLine[] = [{ start: 0, end: 3, text: '가 나', words: [
    { id: 'a', start: 0, end: 1, word: '가' }, { id: 'a', start: 1, end: 2, word: '나', splitChain: '2' },
    { start: 2, end: 3, word: '--', isSilence: true }
  ] }]
  const identified = ensureWordIdentities(lines)
  expect(identified[0].words![0]).toBe(lines[0].words![0])
  expect(identified[0].words![1].id).not.toBe('a')
  expect(identified[0].words![2].id).toBeUndefined()
  expect(ensureWordIdentities(identified)).toBe(identified)
  const reordered = [{ ...identified[0], words: [...identified[0].words!].reverse() }]
  expect(ensureWordIdentities(reordered)).toBe(reordered)
})
