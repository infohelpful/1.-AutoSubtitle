import { describe, expect, it } from 'vitest'

import type { SubtitleLine } from './subtitles'
import {
  activeWordsLinked,
  applyWordEdgeDrag,
  flattenSubtitleWords,
  unflattenAndSync
} from './subtitleWordEdgeDrag'

function mkLine(start: number, end: number, words: Array<[number, number, string, boolean?]>): SubtitleLine {
  return {
    start,
    end,
    text: words
      .filter(([, , , isDel]) => !isDel)
      .map(([, , w]) => w)
      .join(' '),
    words: words.map(([s, e, w, isDel]) => ({
      start: s,
      end: e,
      word: w,
      ...(isDel ? { isDeleted: true } : {})
    }))
  }
}

describe('subtitleWordEdgeDrag — flatten/filter/link', () => {
  it('flattens with metadata and filters tombstones', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1, [
        [0.0, 0.4, '안녕'],
        [0.4, 0.8, '하세요', true]
      ]),
      mkLine(1, 2, [[1.0, 1.5, '반갑']])
    ]
    const flat = flattenSubtitleWords(subs)
    expect(flat).toHaveLength(3)
    expect(flat[0]).toMatchObject({ lineIndex: 0, wordIndex: 0, word: '안녕', isDeleted: false })
    expect(flat[1]).toMatchObject({ lineIndex: 0, wordIndex: 1, word: '하세요', isDeleted: true })
    expect(flat[2]).toMatchObject({ lineIndex: 1, wordIndex: 0, word: '반갑', isDeleted: false })

    const active = activeWordsLinked(flat)
    expect(active.map((a) => a.word)).toEqual(['안녕', '반갑'])
    expect(active.map((a) => a.activeIndex)).toEqual([0, 1])
  })
})

/**
 * 정책 — preview (commitMode 기본 false) 단계는 **이웃 텍스트를 절대 손대지 않는다**.
 * target 의 edge 만 움직이고, 침범한 이웃은 시간만 줄어든다. 흡수(tombstone)는 항상 빈 배열.
 */
describe('subtitleWordEdgeDrag — preview (no absorb, time-only neighbors)', () => {
  it('expand end into next: next.start ← newEnd, next.word intact, no tombstone', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 2.0, [
        [0.0, 1.0, '유튜브'],
        [1.0, 2.0, '영상을']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 1.4
    })
    expect(tombstoned).toEqual([])
    const w = next[0]!.words!
    expect(w[0]!.word).toBe('유튜브')
    expect(w[0]!.end).toBeCloseTo(1.4)
    expect(w[1]!.word).toBe('영상을')
    expect(w[1]!.start).toBeCloseTo(1.4)
    expect(w[1]!.end).toBeCloseTo(2.0)
  })

  it('expand start into prev: prev.end ← newStart, prev.word intact, no tombstone', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 2.0, [
        [0.0, 1.0, '유튜브'],
        [1.0, 2.0, '영상을']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'start',
      newSec: 0.5
    })
    expect(tombstoned).toEqual([])
    const w = next[0]!.words!
    expect(w[0]!.word).toBe('유튜브')
    expect(w[0]!.end).toBeCloseTo(0.5)
    expect(w[1]!.word).toBe('영상을')
    expect(w[1]!.start).toBeCloseTo(0.5)
  })

  it('preview: reaching prev.start does NOT absorb; prev is shrunk to zero-width but kept alive', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1.0, [
        [0.0, 0.5, '가'],
        [0.5, 1.0, '나']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'start',
      newSec: 0.0
    })
    expect(tombstoned).toEqual([])
    const w = next[0]!.words!
    expect(w[0]!.word).toBe('가')
    expect(w[0]!.isDeleted).toBeFalsy()
    expect(w[1]!.word).toBe('나')
    expect(w[1]!.start).toBeCloseTo(0.0)
  })

  it('preview: reaching next.end does NOT absorb; next is shrunk to zero-width but kept alive', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1.0, [
        [0.0, 0.5, '가'],
        [0.5, 1.0, '나']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 1.0
    })
    expect(tombstoned).toEqual([])
    const w = next[0]!.words!
    expect(w[1]!.word).toBe('나')
    expect(w[1]!.isDeleted).toBeFalsy()
    expect(w[0]!.end).toBeCloseTo(1.0)
  })
})

/**
 * 정책 — commit (commitMode=true, 마우스를 뗀 순간) 단계는 **핸들이 이웃의 끝점에 도달했을 때만**
 * 통째 흡수한다. 부분 위치에서는 이웃 텍스트가 보존되며 시간만 줄어든다.
 */
describe('subtitleWordEdgeDrag — commit (endpoint-only absorb)', () => {
  it('start edge crossing prev.start absorbs prev fully (mergedByEdgeTrim)', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1.5, [
        [0.2, 0.5, '안녕'],
        [0.5, 1.0, '하세요'],
        [1.0, 1.5, '여러분']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'start',
      newSec: 0.15,
      commitMode: true
    })
    expect(tombstoned).toEqual([{ lineIndex: 0, wordIndex: 0 }])
    const words = next[0]!.words!
    expect(words[0]!.isDeleted).toBe(true)
    expect(words[0]!.mergedByEdgeTrim).toBe(true)
    expect(words[1]!.word).toBe('안녕 하세요')
    expect(words[1]!.start).toBeCloseTo(0.15)
    expect(words[1]!.end).toBeCloseTo(1.0)
  })

  it('end edge reaching next.end absorbs next fully', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1.5, [
        [0.0, 0.5, '안녕'],
        [0.5, 1.0, '하세요'],
        [1.0, 1.5, '여러분']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'end',
      newSec: 1.5,
      commitMode: true
    })
    expect(tombstoned).toEqual([{ lineIndex: 0, wordIndex: 2 }])
    const words = next[0]!.words!
    expect(words[1]!.word).toBe('하세요 여러분')
    expect(words[1]!.end).toBeCloseTo(1.5)
    expect(words[2]!.isDeleted).toBe(true)
    expect(words[2]!.mergedByEdgeTrim).toBe(true)
  })

  it('commit + mid-prev position does NOT absorb — prev.word kept, prev.end shrunk', () => {
    /**
     * 사용자가 prev 의 내부에서 손을 뗀 경우 — prev.start 까지 끌지 않았으므로 흡수 미발생.
     * prev 의 텍스트는 그대로, prev 의 시간만 줄어든다. (사용자 요구사항의 핵심)
     */
    const subs: SubtitleLine[] = [
      mkLine(0, 2.0, [
        [0.0, 1.0, '유튜브'],
        [1.0, 2.0, '영상을']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'start',
      newSec: 0.5,
      commitMode: true
    })
    expect(tombstoned).toEqual([])
    const w = next[0]!.words!
    expect(w[0]!.word).toBe('유튜브')
    expect(w[0]!.isDeleted).toBeFalsy()
    expect(w[0]!.end).toBeCloseTo(0.5)
    expect(w[1]!.word).toBe('영상을')
    expect(w[1]!.start).toBeCloseTo(0.5)
  })

  it('commit + mid-next position does NOT absorb — next.word kept, next.start shrunk', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 2.0, [
        [0.0, 1.0, '유튜브'],
        [1.0, 2.0, '영상을']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 1.6,
      commitMode: true
    })
    expect(tombstoned).toEqual([])
    const w = next[0]!.words!
    expect(w[0]!.word).toBe('유튜브')
    expect(w[0]!.end).toBeCloseTo(1.6)
    expect(w[1]!.word).toBe('영상을')
    expect(w[1]!.start).toBeCloseTo(1.6)
  })

  it('commit + 1-char neighbor mid-position: still no absorb (no near-collapse policy)', () => {
    /**
     *  이전 정책은 next 가 minWidth 이하로 짜부라지면 “near-collapse 흡수” 가 발생했으나,
     *  새 정책에선 **끝점 도달만** 흡수 — mid-position 은 무조건 시간만 줄어든다.
     */
    const subs: SubtitleLine[] = [
      mkLine(0, 1.0, [
        [0.0, 0.5, '가'],
        [0.5, 1.0, '나']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 0.995,
      commitMode: true
    })
    expect(tombstoned).toEqual([])
    expect(next[0]!.words![1]!.isDeleted).toBeFalsy()
    expect(next[0]!.words![1]!.word).toBe('나')
  })

  it('commit + crossing 1-char neighbor.end absorbs fully', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1.0, [
        [0.0, 0.5, '가'],
        [0.5, 1.0, '나']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 1.0,
      commitMode: true
    })
    expect(tombstoned).toEqual([{ lineIndex: 0, wordIndex: 1 }])
    expect(next[0]!.words![0]!.word).toBe('가 나')
    expect(next[0]!.words![1]!.isDeleted).toBe(true)
    expect(next[0]!.words![1]!.mergedByEdgeTrim).toBe(true)
  })

  it('commit merges multiple consecutive prev words on a big jump', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 2, [
        [0.0, 0.3, 'A'],
        [0.3, 0.6, '나다라'],
        [0.6, 1.0, 'C'],
        [1.0, 2.0, 'D']
      ])
    ]
    /** D.start = 0.0 — A, 나다라, C 모두 끝점을 가로지른다 → 셋 다 흡수. */
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 3 },
      edge: 'start',
      newSec: 0.0,
      commitMode: true
    })
    expect(tombstoned).toEqual([
      { lineIndex: 0, wordIndex: 2 },
      { lineIndex: 0, wordIndex: 1 },
      { lineIndex: 0, wordIndex: 0 }
    ])
    const words = next[0]!.words!
    expect(words[0]!.isDeleted).toBe(true)
    expect(words[1]!.isDeleted).toBe(true)
    expect(words[2]!.isDeleted).toBe(true)
    expect(words[3]!.word).toBe('A 나다라 C D')
    expect(words[3]!.start).toBeCloseTo(0.0)
  })

  it('commit on mid-prev with big jump — passes through fully-crossed prevs, stops on partial', () => {
    /**
     * D.start = 0.4: C(0.6~1.0) 는 끝점을 완전히 가로지름 → 흡수. 나다라(0.3~0.6) 는 mid → 흡수 안 됨, 시간만.
     */
    const subs: SubtitleLine[] = [
      mkLine(0, 2, [
        [0.0, 0.3, 'A'],
        [0.3, 0.6, '나다라'],
        [0.6, 1.0, 'C'],
        [1.0, 2.0, 'D']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 3 },
      edge: 'start',
      newSec: 0.4,
      commitMode: true
    })
    expect(tombstoned).toEqual([{ lineIndex: 0, wordIndex: 2 }])
    const words = next[0]!.words!
    expect(words[0]!.isDeleted).toBeFalsy()
    expect(words[1]!.isDeleted).toBeFalsy()
    expect(words[1]!.word).toBe('나다라')
    expect(words[1]!.end).toBeCloseTo(0.4)
    expect(words[2]!.isDeleted).toBe(true)
    expect(words[3]!.word).toBe('C D')
    expect(words[3]!.start).toBeCloseTo(0.4)
  })
})

describe('subtitleWordEdgeDrag — shrink (preview = commit)', () => {
  it('previous word.end is pulled to the new start when shrinking', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1.5, [
        [0.0, 0.5, 'A'],
        [0.5, 1.0, 'B'],
        [1.0, 1.5, 'C']
      ])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'start',
      newSec: 0.7
    })
    const w = next[0]!.words!
    expect(w[0]!.end).toBeCloseTo(0.7)
    expect(w[1]!.start).toBeCloseTo(0.7)
    expect(w[1]!.end).toBeCloseTo(1.0)
  })

  it('next word.start is pulled to the new end when shrinking', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1.5, [
        [0.0, 0.5, 'A'],
        [0.5, 1.0, 'B'],
        [1.0, 1.5, 'C']
      ])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'end',
      newSec: 0.8
    })
    const w = next[0]!.words!
    expect(w[1]!.end).toBeCloseTo(0.8)
    expect(w[2]!.start).toBeCloseTo(0.8)
  })
})

describe('subtitleWordEdgeDrag — same-card only (cross-line is no-op/clamp)', () => {
  it('start edge pulled into previous card is clamped — no cross-line absorb', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1, [[0.5, 1.0, '안녕']]),
      mkLine(1, 2, [
        [1.0, 1.5, '하세요'],
        [1.5, 2.0, '여러분']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 1, wordIndex: 0 },
      edge: 'start',
      newSec: 0.45,
      commitMode: true
    })
    expect(tombstoned).toEqual([])
    expect(next[0]!.isDeleted).toBeFalsy()
    expect(next[0]!.words![0]!.word).toBe('안녕')
    expect(next[1]!.words![0]!.word).toBe('하세요')
    expect(next[1]!.words![0]!.start).toBeCloseTo(1.0)
  })

  it('end edge pulled into next card is clamped — no cross-line absorb', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1, [
        [0.0, 0.5, 'A'],
        [0.5, 1.0, 'B']
      ]),
      mkLine(1, 1.5, [[1.0, 1.5, 'C']])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'end',
      newSec: 1.5,
      commitMode: true
    })
    expect(tombstoned).toEqual([])
    expect(next[0]!.words![1]!.word).toBe('B')
    expect(next[0]!.words![1]!.end).toBeCloseTo(1.0)
    expect(next[1]!.words![0]!.word).toBe('C')
    expect(next[1]!.words![0]!.start).toBeCloseTo(1.0)
  })

  it('respects tombstones — pre-existing isDeleted word is skipped as neighbor', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1, [
        [0.0, 0.4, 'A'],
        [0.4, 0.7, 'X', true],
        [0.7, 1.0, 'B']
      ])
    ]
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 2 },
      edge: 'start',
      newSec: 0,
      commitMode: true
    })
    expect(tombstoned).toEqual([{ lineIndex: 0, wordIndex: 0 }])
    expect(next[0]!.words![0]!.isDeleted).toBe(true)
    expect(next[0]!.words![1]!.isDeleted).toBe(true)
    expect(next[0]!.words![2]!.word).toBe('A B')
  })
})

describe('subtitleWordEdgeDrag — parent SubtitleLine sync', () => {
  it('recomputes start/end/text from active words', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 2, [
        [0.0, 0.4, '하나'],
        [0.4, 0.9, '둘'],
        [0.9, 1.5, '셋']
      ])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'end',
      newSec: 1.5,
      commitMode: true
    })
    expect(next[0]!.start).toBeCloseTo(0.0)
    expect(next[0]!.end).toBeCloseTo(1.5)
    expect(next[0]!.text).toBe('하나 둘 셋')
    expect(next[0]!.isDeleted).toBe(false)
  })

  it('marks line as isDeleted when all active words become empty text (visibleText 0)', () => {
    const subs: SubtitleLine[] = [
      {
        start: 1,
        end: 2,
        text: '',
        words: [
          { start: 1.0, end: 1.5, word: '', isDeleted: false },
          { start: 1.5, end: 2.0, word: '   ', isDeleted: false }
        ]
      }
    ]
    const flat = flattenSubtitleWords(subs)
    const result = unflattenAndSync(subs, flat)
    expect(result[0]!.isDeleted).toBe(true)
    expect(result[0]!.words![0]!.isDeleted).toBe(true)
    expect(result[0]!.words![1]!.isDeleted).toBe(true)
  })
})

describe('subtitleWordEdgeDrag — guards', () => {
  it('non-finite newSec is a no-op', () => {
    const subs: SubtitleLine[] = [mkLine(0, 1, [[0, 1, 'x']])]
    const { subtitles } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'start',
      newSec: Number.NaN
    })
    expect(subtitles[0]!.words![0]!.start).toBeCloseTo(0)
    expect(subtitles[0]!.words![0]!.end).toBeCloseTo(1)
  })

  it('targeting a tombstoned word is a no-op', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1, [
        [0.0, 0.5, 'A', true],
        [0.5, 1.0, 'B']
      ])
    ]
    const { subtitles, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'start',
      newSec: 0.7
    })
    expect(tombstoned).toEqual([])
    expect(subtitles[0]!.words![0]!.isDeleted).toBe(true)
    expect(subtitles[0]!.words![1]!.start).toBeCloseTo(0.5)
  })

  it('honors minWordWidthSec — clamps so word never collapses', () => {
    const subs: SubtitleLine[] = [mkLine(0, 1, [[0.0, 1.0, 'A']])]
    const { subtitles } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 0.000001,
      minWordWidthSec: 0.05
    })
    const w = subtitles[0]!.words![0]!
    expect(w.end - w.start).toBeGreaterThanOrEqual(0.05 - 1e-9)
  })
})

describe('subtitleWordEdgeDrag — revive (de-merge) of tombstoned neighbors', () => {
  it('shrinking right edge through a tombstoned next-neighbor revives it fully', () => {
    const merged: SubtitleLine[] = [
      mkLine(0, 1.0, [
        [0.0, 1.0, '하나 둘'],
        [0.5, 1.0, '둘', true],
        [1.0, 1.5, '셋']
      ])
    ]
    const { subtitles: next, mutated } = applyWordEdgeDrag({
      subtitles: merged,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 0.5
    })
    const words = next[0]!.words!
    /** target.word 는 손대지 않는다(글자 split 정책 제거). 부활한 '둘' 은 원래 텍스트로 살아남. */
    expect(words[0]!.start).toBeCloseTo(0.0)
    expect(words[0]!.end).toBeCloseTo(0.5)
    expect(words[1]!.isDeleted).toBeFalsy()
    expect(words[1]!.word).toBe('둘')
    expect(words[1]!.start).toBeCloseTo(0.5)
    expect(words[1]!.end).toBeCloseTo(1.0)
    expect(mutated.length).toBeGreaterThanOrEqual(2)
  })

  it('partial shrink revives only the overlapping portion of the tombstoned word', () => {
    const merged: SubtitleLine[] = [
      mkLine(0, 1.0, [
        [0.0, 1.0, '하나 둘'],
        [0.5, 1.0, '둘', true]
      ])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: merged,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 0.7
    })
    const words = next[0]!.words!
    expect(words[0]!.end).toBeCloseTo(0.7)
    expect(words[1]!.isDeleted).toBeFalsy()
    expect(words[1]!.start).toBeCloseTo(0.7)
    expect(words[1]!.end).toBeCloseTo(1.0)
  })

  it('shrinking left edge revives tombstoned prev-neighbor', () => {
    const merged: SubtitleLine[] = [
      mkLine(0, 1.0, [
        [0.0, 0.5, '하나', true],
        [0.0, 1.0, '하나 둘']
      ])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: merged,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'start',
      newSec: 0.5
    })
    const words = next[0]!.words!
    expect(words[0]!.isDeleted).toBeFalsy()
    expect(words[0]!.word).toBe('하나')
    expect(words[0]!.start).toBeCloseTo(0.0)
    expect(words[0]!.end).toBeCloseTo(0.5)
    expect(words[1]!.start).toBeCloseTo(0.5)
    expect(words[1]!.end).toBeCloseTo(1.0)
  })

  it('cross-line tombstone is NOT revived (same-card only revive)', () => {
    const merged: SubtitleLine[] = [
      mkLine(0, 1.0, [
        [0.0, 0.5, '안녕'],
        [0.5, 1.0, '여러분', true]
      ]),
      mkLine(1.0, 2.0, [
        [0.5, 1.5, '여러분 A'],
        [1.5, 2.0, 'B']
      ])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: merged,
      target: { lineIndex: 1, wordIndex: 0 },
      edge: 'start',
      newSec: 1.0
    })
    const line0Words = next[0]!.words!
    const line1Words = next[1]!.words!
    expect(line0Words[1]!.isDeleted).toBe(true)
    expect(line0Words[0]!.word).toBe('안녕')
    expect(line1Words[0]!.start).toBeCloseTo(1.0)
  })

  it('shrink without any tombstoned neighbor still pulls next.start to fill gap', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 1.5, [
        [0.0, 1.0, '하나'],
        [1.0, 1.5, '둘']
      ])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 0.6
    })
    const words = next[0]!.words!
    expect(words[0]!.end).toBeCloseTo(0.6)
    expect(words[1]!.start).toBeCloseTo(0.6)
    expect(words[1]!.end).toBeCloseTo(1.5)
  })
})

describe('subtitleWordEdgeDrag — unflattenAndSync direct usage', () => {
  it('keeps unmodified words intact', () => {
    const subs: SubtitleLine[] = [mkLine(0, 1, [[0, 1, 'x']])]
    const flat = flattenSubtitleWords(subs)
    const next = unflattenAndSync(subs, flat)
    expect(next[0]!.words![0]!.word).toBe('x')
    expect(next[0]!.start).toBeCloseTo(0)
    expect(next[0]!.end).toBeCloseTo(1)
    expect(next[0]!.isDeleted).toBe(false)
  })
})
