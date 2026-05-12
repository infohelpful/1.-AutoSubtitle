import { describe, expect, it } from 'vitest'
import {
  buildActiveBlocksSnapshotFromSubtitles,
  buildWordBlocksFromSubtitleLines,
  cutRangesFromDeletedBlocks,
  deriveVisibleSubtitleLinesForUi,
  mergedDeletedBlocksForProjectSave,
  mergeDeletedMediaIntoTimeline,
  mergeWaveformPeaksStitchCutRanges,
  parseVirtualTimeline,
  subtitleLinesAfterSoftDeleteWordRange,
  sumActiveBlockMediaDurationSec,
  tombstoneBlocksFromSoftDeletedSubtitleWords,
  virtualTombstonesFromCutRanges,
  visibleSubtitleLinesFromBlocks
} from './virtualTimeline'

  describe('virtualTimeline', () => {
  it('soft-delete cut clamps to alive neighbors when silence span overlaps next speech (merged timestamps)', () => {
    /** 무음 블록이 실제로는 12에서 끝나야 하는데 구 타임스탬프가 다음 단어와 겹침 */
    const lines = [
      {
        start: 9,
        end: 25,
        text: 'a',
        words: [
          { start: 9, end: 11, word: 'hey' },
          { start: 11, end: 22, word: '', isSilence: true },
          { start: 12, end: 22, word: 'there' }
        ]
      }
    ]
    const out = subtitleLinesAfterSoftDeleteWordRange(lines, 0, 1, 2, [])
    expect(out).not.toBeNull()
    expect(out!.mediaCutsForVirtual.length).toBe(1)
    expect(out!.mediaCutsForVirtual[0]!.end).toBeLessThanOrEqual(12 + 0.02)
    expect(out!.mediaCutsForVirtual[0]!.start).toBeGreaterThanOrEqual(11 - 0.02)
  })

  it('mergeDeletedMediaIntoTimeline merges overlapping tombstones', () => {
    const a = mergeDeletedMediaIntoTimeline([], { start: 1, end: 2 })
    const b = mergeDeletedMediaIntoTimeline(a, { start: 1.5, end: 3 })
    const cuts = cutRangesFromDeletedBlocks(b.filter((x) => x.isDeleted))
    expect(cuts.length).toBe(1)
    expect(cuts[0]!.start).toBeLessThanOrEqual(1)
    expect(cuts[0]!.end).toBeGreaterThanOrEqual(3)
  })

  it('virtualTombstonesFromCutRanges matches cuts', () => {
    const t = virtualTombstonesFromCutRanges([
      { start: 10, end: 11 },
      { start: 20, end: 21 }
    ])
    expect(t.every((b) => b.isDeleted)).toBe(true)
    expect(cutRangesFromDeletedBlocks(t).length).toBe(2)
  })

  it('parseVirtualTimeline accepts snake_case', () => {
    const blocks = parseVirtualTimeline([
      {
        id: 'block_1',
        start_time: 0,
        end_time: 2.5,
        text: '안녕',
        is_deleted: false
      },
      {
        id: 'block_2',
        start_time: 2.5,
        end_time: 4.1,
        text: '삭제됨',
        is_deleted: true
      }
    ])
    expect(blocks.length).toBe(2)
    expect(blocks[1]!.isDeleted).toBe(true)
    expect(sumActiveBlockMediaDurationSec(blocks)).toBeCloseTo(2.5, 5)
  })

  it('subtitleLinesAfterSoftDeleteWordRange tombstone only — no ripple, media times preserved', () => {
    const lines = [
      {
        start: 9,
        end: 14,
        text: 'a b c',
        words: [
          { start: 9, end: 10, word: 'a' },
          { start: 10, end: 11, word: 'b' },
          { start: 11, end: 14, word: 'c' }
        ]
      }
    ]
    const out = subtitleLinesAfterSoftDeleteWordRange(lines, 0, 1, 2, [])
    expect(out).not.toBeNull()
    const w = out!.lines[0]!.words!
    // 앞 단어는 그대로
    expect(w[0]!.start).toBeCloseTo(9, 4)
    expect(w[0]!.end).toBeCloseTo(10, 4)
    // 삭제 단어는 isDeleted 만 켜지고 원본 미디어 start/end 유지
    expect(w[1]!.isDeleted).toBe(true)
    expect(w[1]!.start).toBeCloseTo(10, 4)
    expect(w[1]!.end).toBeCloseTo(11, 4)
    // 뒤 단어도 미디어 축 그대로 — 리플 X
    expect(w[2]!.start).toBeCloseTo(11, 4)
    expect(w[2]!.end).toBeCloseTo(14, 4)
    // 미디어 컷 (파형 스티치 입력) 은 삭제 미디어 구간 그대로
    expect(out!.mediaCutsForVirtual.length).toBe(1)
    expect(out!.mediaCutsForVirtual[0]!.start).toBeCloseTo(10, 4)
    expect(out!.mediaCutsForVirtual[0]!.end).toBeCloseTo(11, 4)
  })

  it('subtitleLinesAfterSoftDeleteWordRange does not touch words on following lines (EDL ripples on read)', () => {
    const lines = [
      {
        start: 0,
        end: 3,
        text: 'a b',
        words: [
          { start: 0, end: 1, word: 'a' },
          { start: 1, end: 2, word: 'gone' },
          { start: 2, end: 3, word: 'c' }
        ]
      },
      {
        start: 5,
        end: 8,
        text: 'd e',
        words: [
          { start: 5, end: 6, word: 'd' },
          { start: 6, end: 8, word: 'e' }
        ]
      }
    ]
    const out = subtitleLinesAfterSoftDeleteWordRange(lines, 0, 1, 2, [])
    expect(out).not.toBeNull()
    const l0 = out!.lines[0]!.words!
    expect(l0[0]!.start).toBeCloseTo(0, 4)
    expect(l0[0]!.end).toBeCloseTo(1, 4)
    expect(l0[1]!.isDeleted).toBe(true)
    expect(l0[1]!.start).toBeCloseTo(1, 4)
    expect(l0[1]!.end).toBeCloseTo(2, 4)
    expect(l0[2]!.start).toBeCloseTo(2, 4)
    expect(l0[2]!.end).toBeCloseTo(3, 4)
    // 다른 줄(line 1)은 절대 건드리지 않음
    const l1 = out!.lines[1]!.words!
    expect(l1[0]!.start).toBeCloseTo(5, 4)
    expect(l1[0]!.end).toBeCloseTo(6, 4)
    expect(l1[1]!.start).toBeCloseTo(6, 4)
    expect(l1[1]!.end).toBeCloseTo(8, 4)
    // 삭제된 1초 구간만 미디어 컷에 기록
    expect(out!.mediaCutsForVirtual.length).toBe(1)
    expect(out!.mediaCutsForVirtual[0]!.start).toBeCloseTo(1, 4)
    expect(out!.mediaCutsForVirtual[0]!.end).toBeCloseTo(2, 4)
  })

  it('mergeWaveformPeaksStitchCutRanges merges hard cuts, soft-deleted words, and virtual deleted blocks', () => {
    const lines = [
      {
        start: 0,
        end: 3,
        text: 'x',
        words: [
          { start: 0, end: 1, word: 'a' },
          { start: 1, end: 2, word: 'gone', isDeleted: true },
          { start: 2, end: 3, word: 'b' }
        ]
      }
    ]
    const virtual = [
      {
        id: 'v1',
        mediaStartSec: 8,
        mediaEndSec: 9,
        text: '',
        isDeleted: true as const
      }
    ]
    const merged = mergeWaveformPeaksStitchCutRanges([{ start: 5, end: 6 }], lines, virtual)
    expect(merged.length).toBe(3)
    expect(merged.some((r) => r.start <= 5 && r.end >= 6)).toBe(true)
    expect(merged.some((r) => r.start <= 1 && r.end >= 2)).toBe(true)
    expect(merged.some((r) => r.start <= 8 && r.end >= 9)).toBe(true)
  })

  it('tombstoneBlocksFromSoftDeletedSubtitleWords maps isDeleted words to media tombstones', () => {
    const blocks = tombstoneBlocksFromSoftDeletedSubtitleWords(
      [
        {
          start: 0,
          end: 3,
          text: 'x',
          words: [
            { start: 0, end: 1, word: 'a' },
            { start: 1, end: 2, word: 'gone', isDeleted: true },
            { start: 2, end: 3, word: 'b' }
          ]
        }
      ],
      []
    )
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.isDeleted).toBe(true)
    expect(blocks[0]!.mediaStartSec).toBeCloseTo(1, 4)
    expect(blocks[0]!.mediaEndSec).toBeCloseTo(2, 4)
  })

  it('tombstoneBlocksFromSoftDeletedSubtitleWords skips trim-merge tombstones (mergedByEdgeTrim)', () => {
    /**
     *  단어 트림(엣지 드래그) 흡수로 인한 tombstone 은 텍스트가 이미 인접 단어로 옮겨졌고
     *  미디어 오디오는 그대로 유지된다. stitched 파형 cut 으로 들어가면 commit 직후 파형이
     *  좌측으로 “접혀” 보여 사용자가 점프로 체감하므로 cut 후보에서 제외해야 한다.
     */
    const blocks = tombstoneBlocksFromSoftDeletedSubtitleWords(
      [
        {
          start: 0,
          end: 3,
          text: 'x',
          words: [
            { start: 0, end: 1, word: 'a' },
            { start: 1, end: 2, word: 'gone-trim', isDeleted: true, mergedByEdgeTrim: true },
            { start: 2, end: 3, word: 'b' }
          ]
        }
      ],
      []
    )
    expect(blocks.length).toBe(0)
  })

  it('deriveVisibleSubtitleLinesForUi strips soft-deleted words (empty deletedMediaBlocks)', () => {
    const derived = deriveVisibleSubtitleLinesForUi(
      [
        {
          start: 0,
          end: 3,
          text: 'b',
          words: [
            { start: 0, end: 1, word: 'a', isDeleted: true },
            { start: 1, end: 3, word: 'b' }
          ]
        }
      ],
      [],
      []
    )
    expect(derived.length).toBe(1)
    expect(derived[0]!.words?.length).toBe(1)
    expect(derived[0]!.words?.[0]!.word).toBe('b')
  })

  it('mergedDeletedBlocksForProjectSave merges session tombstones with soft-delete spans', () => {
    const existing = virtualTombstonesFromCutRanges([{ start: 10, end: 11 }])
    const lines = [
      {
        start: 0,
        end: 5,
        text: 'y',
        words: [{ start: 2, end: 3, word: 'z', isDeleted: true }]
      }
    ]
    const merged = mergedDeletedBlocksForProjectSave(existing, lines, [])
    const cuts = cutRangesFromDeletedBlocks(merged)
    expect(cuts.some((c) => c.start <= 10.01 && c.end >= 10.99)).toBe(true)
    expect(cuts.some((c) => c.start <= 2.01 && c.end >= 2.99)).toBe(true)
  })

  it('buildWordBlocksFromSubtitleLines skips soft-deleted words', () => {
    const lines = [
      {
        start: 0,
        end: 2,
        text: 'a b',
        words: [
          { start: 0, end: 1, word: 'a', isDeleted: true },
          { start: 1, end: 2, word: 'b' }
        ]
      }
    ]
    const blocks = buildWordBlocksFromSubtitleLines(lines, [])
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.text).toBe('b')
  })

  it('buildActiveBlocksSnapshotFromSubtitles maps edit to media with empty cuts', () => {
    const lines = [
      {
        start: 0,
        end: 2,
        text: 'ab',
        words: [
          { start: 0, end: 1, word: 'a' },
          { start: 1, end: 2, word: 'b' }
        ]
      }
    ]
    const snap = buildActiveBlocksSnapshotFromSubtitles(lines, [])
    expect(snap.length).toBe(2)
    expect(snap.every((b) => !b.isDeleted)).toBe(true)
  })

  it('round-trip: blocks → visible lines restores subtitle lines (empty cuts)', () => {
    const lines = [
      {
        start: 0,
        end: 3,
        text: 'a b',
        words: [
          { start: 0, end: 1, word: 'a' },
          { start: 1.5, end: 3, word: 'b' }
        ]
      },
      {
        start: 5,
        end: 6,
        text: 'c',
        words: [{ start: 5, end: 6, word: 'c' }]
      }
    ]
    const cuts: { start: number; end: number }[] = []
    const blocks = buildWordBlocksFromSubtitleLines(lines, cuts)
    const back = visibleSubtitleLinesFromBlocks(blocks, cuts)
    expect(back.length).toBe(2)
    expect(back[0]!.words?.length).toBe(2)
    expect(back[1]!.words?.length).toBe(1)
    expect(back[0]!.words![0]!.start).toBeCloseTo(0, 4)
    expect(back[0]!.words![1]!.start).toBeCloseTo(1.5, 4)
    expect(back[1]!.words![0]!.start).toBeCloseTo(5, 4)
  })
})
