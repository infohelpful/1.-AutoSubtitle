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

describe('subtitleWordEdgeDrag — expand → merge (within line)', () => {
  it('merges previous word into target when extending start across its boundary', () => {
    /** 부분 침범이 아니게 prev.start 왼쪽까지 당겨 전량 tombstone 병합 */
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
      newSec: 0.15 // prev 전체가 target 왼쪽으로 넘어가도록 prev.start(0.2) 보다 왼쪽
    })

    expect(tombstoned).toEqual([{ lineIndex: 0, wordIndex: 0 }])
    const words = next[0]!.words!
    expect(words[0]!.isDeleted).toBe(true)
    expect(words[1]!.word).toBe('안녕 하세요')
    expect(words[1]!.start).toBeCloseTo(0.15)
    expect(words[1]!.end).toBeCloseTo(1.0)
    expect(words[2]!.start).toBeCloseTo(1.0)
  })

  it('merges next word into target when extending end across its boundary', () => {
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
      newSec: 1.5 // 다음 단어 끝까지 — 부분 침범 아닌 전량 tombstone
    })

    expect(tombstoned).toEqual([{ lineIndex: 0, wordIndex: 2 }])
    const words = next[0]!.words!
    expect(words[1]!.word).toBe('하세요 여러분')
    expect(words[1]!.end).toBeCloseTo(1.5)
    expect(words[2]!.isDeleted).toBe(true)
  })

  it('partially absorbs next word text when end expands only partway through it', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 2.0, [
        [0.0, 1.0, '유튜브'],
        [1.0, 2.0, '영상을']
      ])
    ]
    /** [1.0,2.0] 에서 1.333 근처 절단 → 앞 ~1글자 "영" 흡수 (공백 없이 직접 concat) */
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 1.0 + (2.0 - 1.0) / 3
    })
    expect(tombstoned.length).toBe(0)
    const words = next[0]!.words!
    expect(words[0]!.word).toBe('유튜브영')
    expect(words[1]!.word).toBe('상을')
    expect(words[1]!.start).toBeCloseTo(1.0 + (2.0 - 1.0) / 3, 5)
  })

  it('partial absorb then shrink round-trip: 유튜브 + 영상을 → 유튜브영 / 상을 → 유튜브 / 영상을', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 2.0, [
        [0.0, 1.0, '유튜브'],
        [1.0, 2.0, '영상을']
      ])
    ]
    /** 1) 부분 흡수 — '유튜브' + '영' */
    const step1 = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 1.0 + 1.0 / 3
    })
    expect(step1.subtitles[0]!.words![0]!.word).toBe('유튜브영')
    expect(step1.subtitles[0]!.words![1]!.word).toBe('상을')

    /** 2) 분해 — 다시 1.0 로 줄이기 (1글자 만큼 next 앞으로 prepend) */
    const step2 = applyWordEdgeDrag({
      subtitles: step1.subtitles,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 1.0
    })
    const w = step2.subtitles[0]!.words!
    expect(w[0]!.word).toBe('유튜브')
    expect(w[0]!.end).toBeCloseTo(1.0)
    expect(w[1]!.word).toBe('영상을')
    expect(w[1]!.start).toBeCloseTo(1.0)
    expect(w[1]!.end).toBeCloseTo(2.0)
  })

  it('partial absorb (start edge) then shrink round-trip', () => {
    /** "유튜브" "영상을" — 두 번째 단어의 start 를 왼쪽으로 살짝 당겨 '브' 1글자 흡수 → 다시 분해 */
    const subs: SubtitleLine[] = [
      mkLine(0, 2.0, [
        [0.0, 1.0, '유튜브'],
        [1.0, 2.0, '영상을']
      ])
    ]
    const step1 = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'start',
      newSec: 2.0 / 3
    })
    expect(step1.subtitles[0]!.words![0]!.word).toBe('유튜')
    expect(step1.subtitles[0]!.words![1]!.word).toBe('브영상을')

    const step2 = applyWordEdgeDrag({
      subtitles: step1.subtitles,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'start',
      newSec: 1.0
    })
    const w = step2.subtitles[0]!.words!
    expect(w[0]!.word).toBe('유튜브')
    expect(w[0]!.end).toBeCloseTo(1.0)
    expect(w[1]!.word).toBe('영상을')
    expect(w[1]!.start).toBeCloseTo(1.0)
  })

  it('merges multiple consecutive prev words on big jump', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 2, [
        [0.0, 0.3, 'A'],
        [0.3, 0.6, '나다라'],
        [0.6, 1.0, 'C'],
        [1.0, 2.0, 'D']
      ])
    ]
    /**
     * D 의 start 를 0.4 까지 — 먼저 C 전량 병합 후 '나다라' 구간 안(0.4) 에서 부분 분할.
     * 부분 흡수는 양쪽에 최소 1글자가 남는 경우에만 일어난다(빈 단어 보호).
     */
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 3 },
      edge: 'start',
      newSec: 0.4
    })
    const words = next[0]!.words!
    expect(words[0]!.isDeleted).not.toBe(true)
    expect(words[1]!.isDeleted).not.toBe(true)
    expect(words[1]!.word.length).toBeGreaterThanOrEqual(1)
    expect(words[1]!.start).toBeCloseTo(0.3)
    expect(words[1]!.end).toBeCloseTo(0.4)
    expect(words[2]!.isDeleted).toBe(true)
    expect(words[3]!.word).toMatch(/D/)
    expect(words[3]!.start).toBeCloseTo(0.4)
  })
})

describe('subtitleWordEdgeDrag — shrink → absorb', () => {
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
    /** 이전 카드의 단어 영역(0.5) 으로 끌어도 target 의 lineLo(1.0) 로 clamp — 변화 없음. */
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 1, wordIndex: 0 },
      edge: 'start',
      newSec: 0.45
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
      newSec: 1.5
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
        [0.4, 0.7, 'X', true], // tombstone — invisible 인접
        [0.7, 1.0, 'B']
      ])
    ]
    /** B.start 를 0 으로 — A 전량 tombstone (부분 안쪽 0.3 아님) */
    const { subtitles: next, tombstoned } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 2 },
      edge: 'start',
      newSec: 0
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
      newSec: 1.5 // '셋' 전량 tombstone 병합 (1.2 는 단어 안쪽 부분 침범)
    })
    expect(next[0]!.start).toBeCloseTo(0.0)
    expect(next[0]!.end).toBeCloseTo(1.5)
    expect(next[0]!.text).toBe('하나 둘 셋')
    expect(next[0]!.isDeleted).toBe(false)
  })

  it('marks line as isDeleted when all active words become empty text (visibleText 0)', () => {
    /**
     * 외부에서 모든 active 단어의 글자가 비어 들어오면 `unflattenAndSync` 가 라인을 tombstone 처리.
     * — 빈 카드(단어 없는 카드)가 잔존하지 않게 하기 위한 안전망.
     */
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

describe('subtitleWordEdgeDrag — shrink → revive tombstoned neighbor (de-merge)', () => {
  it('shrinking right edge through a tombstoned next-neighbor revives it fully', () => {
    /** 시나리오: '하나' 가 '둘' 을 흡수해 (병합) 그 후 다시 줄여 '둘' 복원 */
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
    expect(words[0]!.word).toBe('하나')
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
    /** '둘' 이 '하나' 를 흡수했던 상황 → start 를 다시 밀어 '하나' 복원 */
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
    expect(words[1]!.word).toBe('둘')
    expect(words[1]!.start).toBeCloseTo(0.5)
    expect(words[1]!.end).toBeCloseTo(1.0)
  })

  it('shrinking past multiple consecutive tombstoned next-neighbors revives them all (snaps target to closest revived)', () => {
    /** A 가 B, C 두 단어를 모두 흡수한 상태 → A.end 를 줄여서 B, C 동시에 분해.
     *  full revive 시 target.end 는 인접 부활 단어(B)의 start 로 스냅된다 — 사이클(merge→split→merge) 안정성. */
    const merged: SubtitleLine[] = [
      mkLine(0, 1.5, [
        [0.0, 1.5, 'A B C'],
        [0.4, 0.8, 'B', true],
        [0.8, 1.2, 'C', true],
        [1.2, 1.5, 'D']
      ])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: merged,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 0.3
    })
    const words = next[0]!.words!
    /** target.end 는 사용자가 끌어둔 0.3 이 아니라 B.start(0.4) 로 스냅 — gap 제거로 다음 re-merge 가 작은 드래그로 가능 */
    expect(words[0]!.end).toBeCloseTo(0.4)
    expect(words[1]!.isDeleted).toBeFalsy()
    expect(words[1]!.start).toBeCloseTo(0.4)
    expect(words[1]!.end).toBeCloseTo(0.8)
    expect(words[2]!.isDeleted).toBeFalsy()
    expect(words[2]!.start).toBeCloseTo(0.8)
    expect(words[2]!.end).toBeCloseTo(1.2)
  })

  it('full revive past origEnd snaps target.start to revived.end (cycle stability)', () => {
    /** 사용자가 target.start 를 부활 단어의 origEnd 보다 훨씬 오른쪽으로 끌어도,
     *  re-merge 가 작은 드래그로 가능하도록 인접 부활 단어 우측 끝(=revived.end)으로 스냅. */
    const merged: SubtitleLine[] = [
      mkLine(0, 1.0, [
        [0.004, 0.13968, '이전', true],
        [0.004, 0.5, '이전 안녕'],
        [0.5, 1.0, '하세요']
      ])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: merged,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'start',
      newSec: 0.41176
    })
    const words = next[0]!.words!
    expect(words[0]!.isDeleted).toBeFalsy()
    expect(words[0]!.start).toBeCloseTo(0.004)
    expect(words[0]!.end).toBeCloseTo(0.13968)
    /** 핵심: target.start 는 사용자가 끌어둔 0.41176 이 아니라 0.13968 로 스냅 */
    expect(words[1]!.start).toBeCloseTo(0.13968)
  })

  it('shrinking only partially into the SECOND merged neighbor revives only that one', () => {
    /** A 가 B, C 모두 흡수. A.end 를 C 의 내부까지만 줄임 → C 부분 부활, B 는 여전히 흡수됨 */
    const merged: SubtitleLine[] = [
      mkLine(0, 1.5, [
        [0.0, 1.5, 'A B C'],
        [0.4, 0.8, 'B', true],
        [0.8, 1.2, 'C', true]
      ])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: merged,
      target: { lineIndex: 0, wordIndex: 0 },
      edge: 'end',
      newSec: 1.0
    })
    const words = next[0]!.words!
    expect(words[0]!.end).toBeCloseTo(1.0)
    expect(words[1]!.isDeleted).toBe(true) // B 는 아직 A 의 새 범위 안
    expect(words[2]!.isDeleted).toBeFalsy() // C 는 부분 부활
    expect(words[2]!.start).toBeCloseTo(1.0)
    expect(words[2]!.end).toBeCloseTo(1.2)
  })

  it('shrinking start edge does not touch cross-line previous word', () => {
    /** Same-card 정책 — cross-line prev 는 시각/글자 모두 그대로. */
    const subs: SubtitleLine[] = [
      mkLine(0, 0.13968, [[0.004, 0.13968, '이전']]),
      mkLine(0.13968, 1.0, [
        [0.13968, 0.5, '안녕'],
        [0.5, 1.0, '하세요']
      ])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 1, wordIndex: 0 },
      edge: 'start',
      newSec: 0.41176
    })
    const line0 = next[0]!
    expect(line0.words![0]!.start).toBeCloseTo(0.004)
    expect(line0.words![0]!.end).toBeCloseTo(0.13968)
    expect(line0.words![0]!.word).toBe('이전')
    const line1 = next[1]!
    expect(line1.words![0]!.start).toBeCloseTo(0.41176)
    expect(line1.words![0]!.word).toBe('안녕')
  })

  it('shrinking end edge does not touch cross-line next word', () => {
    const subs: SubtitleLine[] = [
      mkLine(0, 0.5, [
        [0.0, 0.25, '안녕'],
        [0.25, 0.5, '하세요']
      ]),
      mkLine(0.5, 1.0, [[0.5, 1.0, '다음']])
    ]
    const { subtitles: next } = applyWordEdgeDrag({
      subtitles: subs,
      target: { lineIndex: 0, wordIndex: 1 },
      edge: 'end',
      newSec: 0.3
    })
    const line1 = next[1]!
    expect(line1.words![0]!.start).toBeCloseTo(0.5)
    expect(line1.words![0]!.end).toBeCloseTo(1.0)
    expect(line1.words![0]!.word).toBe('다음')
  })

  it('cross-line tombstone is NOT revived (same-card only revive)', () => {
    /**
     * Same-card 정책 — 이전 카드의 tombstone 단어는 부활 대상이 아니다.
     * 사용자가 target.start 를 끌어도 line0 의 tombstone '여러분' 은 그대로 유지된다.
     */
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
    /** line0 의 tombstone 그대로 유지 */
    expect(line0Words[1]!.isDeleted).toBe(true)
    expect(line0Words[0]!.word).toBe('안녕')
    /** target 은 자기 카드 안 lineLo(0.5) 로 clamp — newSec(1.0) 가 그 안이라 그대로 적용 */
    expect(line1Words[0]!.word).toBe('여러분 A')
    expect(line1Words[0]!.start).toBeCloseTo(1.0)
  })

  it('partial absorb keeps at least one char in both sides (no empty word)', () => {
    /** newEnd 가 next 의 거의 끝 (right 가 비게 될) 위치이면 부분 흡수 대신 통째 tombstone 으로 fallthrough */
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
      newSec: 0.99
    })
    /** 1글자뿐인 '나' 의 right 가 비기 때문에 통째 tombstone */
    expect(tombstoned).toEqual([{ lineIndex: 0, wordIndex: 1 }])
    expect(next[0]!.words![0]!.word).toBe('가 나')
    expect(next[0]!.words![1]!.isDeleted).toBe(true)
  })

  it('shrink without any tombstoned neighbor still absorbs to next active', () => {
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
