/**
 * 단어 블록 좌·우 엣지 드래그(Edge Drag) 상태 업데이트 유틸리티 — Vrew 스타일 **끝점 흡수** 정책.
 *
 * 정책:
 *  1) **tombstone(`isDeleted: true`) 무시** — 인접·흡수 로직은 항상 *활성* 단어들 사이에서만.
 *  2) **드래그 중(preview)에는 어떤 단어 텍스트도 절대 손대지 않는다.** target 의 `start/end` 만 움직이고,
 *     침범한 이웃은 *시간만* 줄어든다(prev.end ← newStart, next.start ← newEnd).
 *  3) **흡수(Absorb)는 commit 시에만, 끝점 도달일 때만**:
 *     - 왼쪽 핸들이 `prev.start` 까지 도달(`newStart <= prev.start + eps`) → prev 통째 흡수 (`mergedByEdgeTrim`).
 *     - 오른쪽 핸들이 `next.end` 까지 도달(`newEnd >= next.end - eps`) → next 통째 흡수.
 *     - 그 외에는 commit 시에도 흡수가 발생하지 않으며, 이웃 단어는 시간만 줄어든 채로 남는다.
 *  4) **Same-card only** — 다른 카드의 단어와는 어떤 경우에도 상호작용하지 않는다(cross-line clamp).
 *  5) **Revive(de-merge)** — 이전 흡수로 tombstone 된 *같은 줄* 단어가 새 gap 안에 들어오면 자동 부활.
 *  6) **부모 SubtitleLine 동기화** — 카드의 `start/end/text` 를 활성 단어로 재계산.
 *
 * 구현 전략:
 *   (a) Flatten — `subtitles` → `(lineIndex, wordIndex)` 메타와 함께 1차원 평탄화.
 *   (b) Filter & Link — 활성 단어로 prev/next 연쇄 구성.
 *   (c) Calculate — target 의 edge 시각을 이동시켜 흡수·부활 적용 (commitMode 가 흡수 가능 여부를 결정).
 *   (d) Unflatten & Sync — 결과를 원본 위치에 되돌리고 카드 메타데이터 재계산.
 *
 * 모든 함수는 **불변(pure)** — 입력을 변형하지 않고 새 배열/객체를 반환한다. 시간 단위는 *초*.
 */
import type { SubtitleLine, SubtitleWord } from './subtitles'

/** 단어 한 칸이 가질 수 있는 최소 폭. 0 이하 / NaN 으로 무너지지 않도록 항상 양수. */
export const MIN_WORD_DURATION_SEC = 0.01

/** 어떤 단어 엣지를 잡고 있는지 */
export type WordEdge = 'start' | 'end'

/** Flatten 단계의 단일 단어 표현 */
export type FlatWord = {
  lineIndex: number
  wordIndex: number
  start: number
  end: number
  word: string
  isSilence: boolean
  isDeleted: boolean
  /** true: 트림 드래그 흡수에 의한 tombstone (stitched 파형 cut 으로는 보지 않음) */
  mergedByEdgeTrim: boolean
}

/** Filter & Link 단계의 활성 단어 인덱스 (prev/next 는 `activeOrder` 의 위치). */
export type ActiveLinkedWord = FlatWord & {
  activeIndex: number
}

export type WordRef = { lineIndex: number; wordIndex: number }

export type EdgeDragResult = {
  subtitles: SubtitleLine[]
  /** 변경된 단어 ref 들 — UI 에서 강조/디버그 용도로 사용 가능 */
  mutated: WordRef[]
  /** 병합으로 tombstone 처리된 단어 ref 들 */
  tombstoned: WordRef[]
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) Flatten
// ─────────────────────────────────────────────────────────────────────────────

/** `subtitles` 의 모든 단어를 `(lineIndex, wordIndex)` 메타와 함께 1차원 배열로 펼친다. */
export function flattenSubtitleWords(subtitles: readonly SubtitleLine[]): FlatWord[] {
  const out: FlatWord[] = []
  for (let li = 0; li < subtitles.length; li++) {
    const line = subtitles[li]!
    const words = line.words ?? []
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi]!
      out.push({
        lineIndex: li,
        wordIndex: wi,
        start: Number(w.start),
        end: Number(w.end),
        word: w.word,
        isSilence: w.isSilence === true,
        isDeleted: w.isDeleted === true,
        mergedByEdgeTrim: w.mergedByEdgeTrim === true
      })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) Filter & Link
// ─────────────────────────────────────────────────────────────────────────────

/** 활성 단어만 추출해 `activeIndex` (활성 배열에서의 위치) 를 부여. */
export function activeWordsLinked(flat: readonly FlatWord[]): ActiveLinkedWord[] {
  const out: ActiveLinkedWord[] = []
  for (const fw of flat) {
    if (fw.isDeleted) continue
    out.push({ ...fw, activeIndex: out.length })
  }
  return out
}

/** `(lineIndex, wordIndex)` → `activeIndex` 매핑. */
export function buildActiveIndexMap(
  active: readonly ActiveLinkedWord[]
): Map<string, number> {
  const m = new Map<string, number>()
  for (const a of active) m.set(`${a.lineIndex}:${a.wordIndex}`, a.activeIndex)
  return m
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) Calculate — 핵심 알고리즘
// ─────────────────────────────────────────────────────────────────────────────

/** 한 카드 내 활성 단어들의 텍스트 join 시 공백 정리 */
function joinWords(words: readonly string[]): string {
  return words.map((w) => String(w ?? '').trim()).filter((w) => w.length > 0).join(' ')
}

/** flat 배열에서 (li, wi) 위치를 직접 찾는다. (`findFlat` 과 동일 의도, 내부 헬퍼) */
function flatAt(flat: FlatWord[], li: number, wi: number): FlatWord | null {
  for (const fw of flat) {
    if (fw.lineIndex === li && fw.wordIndex === wi) return fw
  }
  return null
}

/** flat 의 (li, wi) 위치 인덱스 — cross-line revive 시 flat 순서로 좌·우로 이동하기 위함. */
function flatIndexOf(flat: FlatWord[], li: number, wi: number): number {
  for (let i = 0; i < flat.length; i++) {
    const fw = flat[i]!
    if (fw.lineIndex === li && fw.wordIndex === wi) return i
  }
  return -1
}

/**
 * target 의 edge 시각을 newSec 로 이동시키며 흡수·부활 결과를 활성/평탄 배열에 in-place 로 반영.
 *
 * - **commitMode=false (preview)**: 텍스트는 절대 안 바뀜. target 의 edge 만 이동, 침범한 이웃의 시간만 줄어듦.
 * - **commitMode=true**: preview 와 동일하되, 핸들이 이웃의 **끝점**에 도달했을 때만 통째 흡수.
 * - **Revive(de-merge)**: 같은 줄에서 직전 흡수로 tombstone 된 단어가 새 gap 안에 들어오면 부활(preview/commit 공통).
 */
function applyEdgeChangeInPlace(
  active: ActiveLinkedWord[],
  flat: FlatWord[],
  targetActiveIdx: number,
  edge: WordEdge,
  newSec: number,
  minWidthSec: number,
  onTombstone: (a: ActiveLinkedWord) => void,
  onRevive: (fw: FlatWord) => void,
  commitMode: boolean
): void {
  if (!Number.isFinite(newSec)) return
  const target = active[targetActiveIdx]
  if (!target) return

  /**
   * **Same-card only 정책** — 다른 카드 단어와는 어떤 경우에도 상호작용하지 않는다.
   * target 의 새 edge 는 cross-line prev.end / next.start 까지로만 clamp.
   */
  const crossPrev = (() => {
    const i = active.indexOf(target)
    const p = i > 0 ? active[i - 1] : null
    return p && p.lineIndex !== target.lineIndex ? p : null
  })()
  const crossNext = (() => {
    const i = active.indexOf(target)
    const n = i >= 0 && i < active.length - 1 ? active[i + 1] : null
    return n && n.lineIndex !== target.lineIndex ? n : null
  })()

  if (edge === 'start') {
    const ownEnd = target.end
    let newStart = newSec
    if (newStart > ownEnd - minWidthSec) newStart = ownEnd - minWidthSec
    if (crossPrev && newStart < crossPrev.end) newStart = crossPrev.end

    if (newStart < target.start) {
      /**
       * Expand left — 끝점 흡수만.
       *  - prev.start < newStart < prev.end : prev 텍스트 보존, prev.end ← newStart (시간만 줄임).
       *  - newStart <= prev.start (끝점 도달) **AND** commitMode : prev 통째 흡수.
       *  - 끝점에 도달했어도 commitMode=false 이면 prev.end ← prev.start 까지만 (시각상 prev 가 0 폭).
       */
      while (true) {
        const prev = findPrevActive(active, target)
        if (!prev) break
        if (prev.lineIndex !== target.lineIndex) break
        if (newStart >= prev.end) break

        if (newStart > prev.start + 1e-9) {
          prev.end = newStart
          break
        }

        if (!commitMode) {
          /** 끝점 도달했지만 preview 단계 — prev 는 0 폭으로 보이게만 두고 흡수는 보류. */
          prev.end = prev.start
          break
        }

        /** commit + 끝점 도달 → 통째 흡수. */
        target.word = joinWords([prev.word, target.word])
        prev.isDeleted = true
        prev.mergedByEdgeTrim = true
        onTombstone(prev)
        removeActive(active, prev)
        if (newStart >= prev.start) break
      }
      target.start = newStart
    } else if (newStart > target.start) {
      /**
       * Shrink right — revive 우선, 없으면 prev.end 를 늘려 빈 공간 채움(텍스트 보존).
       *  revive 된 단어는 원래 텍스트 그대로 살아나므로 target.word 는 손대지 않는다.
       */
      const revived = reviveTombstonedPrevs(flat, target, newStart, onRevive)
      target.start = newStart
      if (revived.length === 0) {
        const prev = findPrevActive(active, target)
        if (prev && prev.lineIndex === target.lineIndex) {
          prev.end = newStart
        }
      } else {
        insertActiveBefore(active, target, revived)
        const rightmost = revived[0]
        if (rightmost && target.start > rightmost.end) target.start = rightmost.end
      }
    }
    return
  }

  // edge === 'end'
  const ownStart = target.start
  let newEnd = newSec
  if (newEnd < ownStart + minWidthSec) newEnd = ownStart + minWidthSec
  if (crossNext && newEnd > crossNext.start) newEnd = crossNext.start

  if (newEnd > target.end) {
    /**
     * Expand right — 끝점 흡수만.
     *  - next.start < newEnd < next.end : next 텍스트 보존, next.start ← newEnd (시간만 줄임).
     *  - newEnd >= next.end (끝점 도달) **AND** commitMode : next 통째 흡수.
     */
    while (true) {
      const next = findNextActive(active, target)
      if (!next) break
      if (next.lineIndex !== target.lineIndex) break
      if (newEnd <= next.start) break

      if (newEnd < next.end - 1e-9) {
        next.start = newEnd
        break
      }

      if (!commitMode) {
        next.start = next.end
        break
      }

      target.word = joinWords([target.word, next.word])
      next.isDeleted = true
      next.mergedByEdgeTrim = true
      onTombstone(next)
      removeActive(active, next)
      if (newEnd <= next.end + 1e-9) break
    }
    target.end = newEnd
  } else if (newEnd < target.end) {
    /**
     * Shrink left — revive 우선, 없으면 next.start 를 당겨 빈 공간 채움(텍스트 보존).
     */
    const revived = reviveTombstonedNexts(flat, target, newEnd, onRevive)
    target.end = newEnd
    if (revived.length === 0) {
      const next = findNextActive(active, target)
      if (next && next.lineIndex === target.lineIndex) {
        next.start = newEnd
      }
    } else {
      insertActiveAfter(active, target, revived)
      const leftmost = revived[0]
      if (leftmost && target.end < leftmost.start) target.end = leftmost.start
    }
  }
}

/**
 * target 의 storage-prev (왼쪽) tombstone 들 중, 새 left-edge `newStart` 가 만든
 * **gap `[oldStart, newStart]`** 안으로 들어오는 단어를 부활시킨다.
 *
 * 각 단어 `fw = [origStart, origEnd]` 에 대해:
 *  - `origStart >= newStart` : 단어 전체가 새 target 범위 안 → 부활하지 않음 (계속 다음 prev 확인)
 *  - `origStart < newStart < origEnd` : straddle → 부분 부활 `[newStart, origEnd]`. **계속** 더 왼쪽 검사.
 *    (gap 의 오른쪽 경계가 이 단어의 `origStart` 보다 왼쪽이므로 추가 prev 부활은 보통 없음)
 *  - `origEnd <= newStart` : 단어 전체가 gap 안 → 완전 부활 `[origStart, origEnd]`. 계속 검사.
 *  - 살아있는 단어를 만나면 정지.
 */
function reviveTombstonedPrevs(
  flat: FlatWord[],
  target: ActiveLinkedWord,
  newStart: number,
  onRevive: (fw: FlatWord) => void
): FlatWord[] {
  const revived: FlatWord[] = []
  const targetFlatIdx = flatIndexOf(flat, target.lineIndex, target.wordIndex)
  if (targetFlatIdx < 0) return revived
  for (let i = targetFlatIdx - 1; i >= 0; i--) {
    const fw = flat[i]!
    /** same-card only — 다른 카드 단어 까지 부활하면 cross-line 변형이 일어난다. */
    if (fw.lineIndex !== target.lineIndex) break
    if (!fw.isDeleted) break
    const origStart = fw.start
    const origEnd = fw.end
    if (origStart >= newStart - 1e-9) break
    fw.isDeleted = false
    /** revive 시 트림 흡수 메타도 함께 해제 — 다시 살아난 단어는 일반 활성 단어로 취급. */
    fw.mergedByEdgeTrim = false
    if (origEnd <= newStart + 1e-9) {
      fw.start = origStart
      fw.end = origEnd
    } else {
      fw.start = origStart
      fw.end = newStart
    }
    onRevive(fw)
    revived.push(fw)
  }
  return revived
}

/**
 * target 의 storage-next (오른쪽) tombstone 들 중, 새 right-edge `newEnd` 가 만든
 * **gap `[newEnd, oldEnd]`** 안으로 들어오는 단어를 부활시킨다.
 *
 *  - `origEnd <= newEnd` : 단어 전체가 새 target 범위 안 → 부활하지 않음 (다음 next 검사)
 *  - `origStart < newEnd < origEnd` : straddle → 부분 부활 `[newEnd, origEnd]`. 계속 다음 검사.
 *  - `origStart >= newEnd` : 단어 전체가 gap 안 → 완전 부활. 계속.
 *  - 살아있는 단어를 만나면 정지.
 */
function reviveTombstonedNexts(
  flat: FlatWord[],
  target: ActiveLinkedWord,
  newEnd: number,
  onRevive: (fw: FlatWord) => void
): FlatWord[] {
  const revived: FlatWord[] = []
  const targetFlatIdx = flatIndexOf(flat, target.lineIndex, target.wordIndex)
  if (targetFlatIdx < 0) return revived
  for (let i = targetFlatIdx + 1; i < flat.length; i++) {
    const fw = flat[i]!
    /** same-card only — 다른 카드로 건너가면 cross-line 변형이 일어난다. */
    if (fw.lineIndex !== target.lineIndex) break
    if (!fw.isDeleted) break
    const origStart = fw.start
    const origEnd = fw.end
    if (origEnd <= newEnd + 1e-9) continue
    fw.isDeleted = false
    fw.mergedByEdgeTrim = false
    if (origStart >= newEnd - 1e-9) {
      fw.start = origStart
      fw.end = origEnd
    } else {
      fw.start = newEnd
      fw.end = origEnd
    }
    onRevive(fw)
    revived.push(fw)
  }
  return revived
}

function insertActiveAfter(active: ActiveLinkedWord[], anchor: ActiveLinkedWord, items: FlatWord[]): void {
  const i = active.indexOf(anchor)
  if (i < 0) return
  const wrap: ActiveLinkedWord[] = items.map((fw) => ({ ...fw, activeIndex: 0 }))
  active.splice(i + 1, 0, ...wrap)
}

function insertActiveBefore(active: ActiveLinkedWord[], anchor: ActiveLinkedWord, items: FlatWord[]): void {
  const i = active.indexOf(anchor)
  if (i < 0) return
  const wrap: ActiveLinkedWord[] = items.map((fw) => ({ ...fw, activeIndex: 0 }))
  active.splice(i, 0, ...wrap)
}

function findPrevActive(active: ActiveLinkedWord[], from: ActiveLinkedWord): ActiveLinkedWord | null {
  const i = active.indexOf(from)
  return i > 0 ? active[i - 1]! : null
}

function findNextActive(active: ActiveLinkedWord[], from: ActiveLinkedWord): ActiveLinkedWord | null {
  const i = active.indexOf(from)
  return i >= 0 && i < active.length - 1 ? active[i + 1]! : null
}

function removeActive(active: ActiveLinkedWord[], target: ActiveLinkedWord): void {
  const i = active.indexOf(target)
  if (i >= 0) active.splice(i, 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// (d) Unflatten & Sync
// ─────────────────────────────────────────────────────────────────────────────

/** flat 배열의 최신 값으로 원본 `subtitles` 를 새 객체로 재구성 + SubtitleLine 메타 동기화. */
export function unflattenAndSync(
  original: readonly SubtitleLine[],
  flat: readonly FlatWord[]
): SubtitleLine[] {
  /** lineIndex → wordIndex → 최신 FlatWord */
  const byLine: FlatWord[][] = original.map(() => [])
  for (const fw of flat) {
    const arr = byLine[fw.lineIndex]
    if (arr) arr[fw.wordIndex] = fw
  }

  const out: SubtitleLine[] = original.map((line, li) => {
    const flatRow = byLine[li] ?? []
    const newWords: SubtitleWord[] = (line.words ?? []).map((w, wi) => {
      const fw = flatRow[wi]
      if (!fw) return w
      const next: SubtitleWord = {
        ...w,
        start: fw.start,
        end: fw.end,
        word: fw.word,
        isDeleted: fw.isDeleted ? true : false
      }
      /**
       * `mergedByEdgeTrim` 플래그 — 트림 드래그 흡수로 tombstone 된 단어만 true.
       *  - true 인 동안에는 stitched 파형 cut 으로 보지 않는다 (오디오는 그대로 재생).
       *  - revive 되면 false, 일반 삭제(`isDeleted=true` + flag=false)면 일반 cut 으로 처리.
       */
      if (fw.mergedByEdgeTrim) next.mergedByEdgeTrim = true
      else if (next.mergedByEdgeTrim) delete next.mergedByEdgeTrim
      return next
    })

    const activeWords = newWords.filter((w) => w.isDeleted !== true)
    if (activeWords.length === 0) {
      return {
        ...line,
        words: newWords,
        isDeleted: true
      }
    }

    /**
     * 모든 active 단어의 텍스트가 trim 후 0 글자라면 라인은 시각만 남고 글자가 비어 보인다.
     * 카드 UI 에 “단어블록 하나 없이 빈 단어카드” 가 남는 걸 막기 위해 줄 전체를 tombstone 처리.
     */
    const visibleText = joinWords(activeWords.map((w) => w.word)).trim()
    if (visibleText.length === 0) {
      const tombstoned: SubtitleWord[] = newWords.map((w) =>
        w.isDeleted === true ? w : { ...w, isDeleted: true }
      )
      return {
        ...line,
        words: tombstoned,
        isDeleted: true
      }
    }

    const first = activeWords[0]!
    const last = activeWords[activeWords.length - 1]!
    return {
      ...line,
      start: first.start,
      end: last.end,
      text: joinWords(activeWords.map((w) => w.word)),
      words: newWords,
      isDeleted: false
    }
  })

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — 한 번의 엣지 드래그 결과를 적용
// ─────────────────────────────────────────────────────────────────────────────

export type ApplyWordEdgeDragInput = {
  subtitles: readonly SubtitleLine[]
  /** 드래그 대상 단어의 원본 위치 (`isDeleted` 인 단어를 target 으로 주면 작업을 건너뛴다) */
  target: WordRef
  /** 어떤 엣지를 잡았는지 */
  edge: WordEdge
  /** 마우스가 가리킨 새 시각 (초). NaN/Infinity 는 무시. */
  newSec: number
  /** 최소 단어 폭 (초). 기본 `MIN_WORD_DURATION_SEC`. */
  minWordWidthSec?: number
  /**
   * true (= 마우스를 뗀 순간) 일 때만 끝점 흡수가 발생한다.
   * 드래그 중(preview)에는 이웃 텍스트가 절대 변하지 않으며, 침범한 이웃은 시간만 줄어든다.
   * 기본 false — 안전한 preview 모드.
   */
  commitMode?: boolean
}

/**
 * 한 번의 엣지 드래그(마우스 이동 한 프레임 또는 손 뗀 한 번) 결과를 `subtitles` 상태 트리에 반영한다.
 *
 * - 입력을 변형하지 않으며 새 `subtitles` 배열을 반환.
 * - target 단어가 tombstone 이거나 존재하지 않으면 입력과 동치인 결과를 그대로 반환.
 * - **흡수는 `commitMode=true` 일 때만**, 핸들이 이웃의 끝점에 도달했을 때에 한해 일어난다.
 */
export function applyWordEdgeDrag(input: ApplyWordEdgeDragInput): EdgeDragResult {
  const {
    subtitles,
    target,
    edge,
    newSec,
    minWordWidthSec = MIN_WORD_DURATION_SEC,
    commitMode = false
  } = input

  if (!Number.isFinite(newSec)) {
    return { subtitles: subtitles.slice(), mutated: [], tombstoned: [] }
  }

  const flat = flattenSubtitleWords(subtitles)
  const active = activeWordsLinked(flat)
  const indexMap = buildActiveIndexMap(active)

  const targetKey = `${target.lineIndex}:${target.wordIndex}`
  const targetActiveIdx = indexMap.get(targetKey)
  if (targetActiveIdx == null) {
    return { subtitles: subtitles.slice(), mutated: [], tombstoned: [] }
  }

  const tombstonedRefs: WordRef[] = []
  const revivedRefs: WordRef[] = []
  applyEdgeChangeInPlace(
    active,
    flat,
    targetActiveIdx,
    edge,
    newSec,
    Math.max(1e-6, minWordWidthSec),
    (a) => {
      tombstonedRefs.push({ lineIndex: a.lineIndex, wordIndex: a.wordIndex })
    },
    (fw) => {
      revivedRefs.push({ lineIndex: fw.lineIndex, wordIndex: fw.wordIndex })
    },
    commitMode
  )

  /** active 의 (start/end/word) 변경 사항을 flat 으로 되돌려 반영. */
  for (const a of active) {
    const fw = findFlat(flat, a.lineIndex, a.wordIndex)
    if (!fw) continue
    fw.start = a.start
    fw.end = a.end
    fw.word = a.word
    fw.isDeleted = false
    fw.mergedByEdgeTrim = false
  }
  /**
   * tombstone 표시 — active 에서 빠진 단어. `mergedByEdgeTrim` 도 함께 마킹해 stitched 파형 cut
   * 으로 들어가지 않도록 한다(SubtitleWord.mergedByEdgeTrim 플래그가 그 효과를 만든다).
   */
  for (const ref of tombstonedRefs) {
    const fw = findFlat(flat, ref.lineIndex, ref.wordIndex)
    if (fw) {
      fw.isDeleted = true
      fw.mergedByEdgeTrim = true
    }
  }

  const nextSubtitles = unflattenAndSync(subtitles, flat)

  const mutated: WordRef[] = [{ lineIndex: target.lineIndex, wordIndex: target.wordIndex }]
  for (const r of revivedRefs) mutated.push(r)
  return { subtitles: nextSubtitles, mutated, tombstoned: tombstonedRefs }
}

function findFlat(flat: FlatWord[], li: number, wi: number): FlatWord | null {
  // flat 배열은 (lineIndex, wordIndex) 사전순으로 들어 있으므로 선형 탐색이 충분히 빠르다.
  for (const fw of flat) {
    if (fw.lineIndex === li && fw.wordIndex === wi) return fw
  }
  return null
}
