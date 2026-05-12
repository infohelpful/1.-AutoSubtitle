/**
 * 단어 블록 좌·우 엣지 드래그(Edge Drag) 상태 업데이트 유틸리티.
 *
 * 정책 (Vrew 유사):
 *  1) **tombstone(`isDeleted: true`) 무시** — 인접·병합·흡수 로직은 항상 *활성* 단어들 사이에서만 수행.
 *  2) **늘리기(Expand) → 병합(Merge)** — 인접 단어 시간을 침범하면 tombstone 병합.
 *     다음 단어 구간 **안에서만** 침범이 멈추면 문자열을 시간 비율로 나눠 부분 흡수(통째 합치기 방지).
 *  3) **줄이기(Shrink) → 흡수(Absorb)** — 줄어든 만큼 인접 단어의 `start`/`end` 가 늘어나 빈 시간이 생기지 않게 함.
 *  4) **Cross-Line** — 한 카드 안의 첫/마지막 활성 단어를 넘어선 드래그는 이전/다음 카드의 활성 단어와 상호작용.
 *  5) **부모 SubtitleLine 동기화** — 카드의 `start/end/text` 를 활성 단어로 재계산하고,
 *     모든 단어가 tombstone 이면 `SubtitleLine.isDeleted = true` 로 마킹.
 *
 * 구현 전략은 사용자 요청을 그대로 따른다:
 *   (a) Flatten — `subtitles` 를 모든 단어 + `(lineIndex, wordIndex)` 메타데이터로 1차원화.
 *   (b) Filter & Link — `isDeleted` 제외한 활성 단어로 prev/next 연쇄 구성.
 *   (c) Calculate — 활성 시각열에서 target 의 edge 시각을 이동시켜 병합·흡수 적용.
 *   (d) Unflatten & Sync — 변경 결과를 원본 위치에 되돌리고 카드 메타데이터 재계산.
 *
 * 모든 함수는 **불변(pure)** — 입력을 변형하지 않고 새 배열/객체를 반환한다. 데이터의 시각 단위는 *초*.
 */
import type { SubtitleLine, SubtitleWord } from './subtitles'
import { splitWordTextAtMediaCut } from './subtitleWordTextSplit'

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
        isDeleted: w.isDeleted === true
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
 * target 의 edge 시각을 newSec 로 이동시키며 병합·흡수·**부활(de-merge)** 결과를 활성/평탄 배열에 in-place 로 반영.
 *
 * - **늘리기(Expand)**: 인접 *활성* 단어를 잠식하면 tombstone 처리 후 텍스트 병합.
 * - **줄이기(Shrink)**: 같은 줄에서 직전 병합으로 tombstone 된 **저장소 인접 단어**를 시각 영역이 다시 노출되면 revive.
 *   revive 된 단어는 원래의 `start/end/word` 를 복구하고, `target.word` 에서는 해당 단어 접두/접미사를 잘라낸다.
 * - 줄일 때 revive 대상이 없으면 종전대로 인접 활성 단어가 빈 공간을 흡수한다.
 */
function applyEdgeChangeInPlace(
  active: ActiveLinkedWord[],
  flat: FlatWord[],
  targetActiveIdx: number,
  edge: WordEdge,
  newSec: number,
  minWidthSec: number,
  onTombstone: (a: ActiveLinkedWord) => void,
  onRevive: (fw: FlatWord) => void
): void {
  if (!Number.isFinite(newSec)) return
  const target = active[targetActiveIdx]
  if (!target) return

  /**
   * **Same-card only 정책** — 사용자가 cross-line 병합/분해는 어렵다고 요청.
   * 같은 라인 안에서는 시각·글자 모두 자유롭게 움직이지만, target 의 새 edge 가 다른 카드 단어
   * 영역으로 침범하지 못하게 cross-line prev.end / next.start 까지로만 clamp 한다.
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
    /** 위 카드 마지막 active 단어의 end 보다 왼쪽으로는 못 간다 — cross-line 흡수 차단. */
    if (crossPrev && newStart < crossPrev.end) newStart = crossPrev.end

    if (newStart < target.start) {
      /** Expand 왼쪽 — prev 의 영역을 침범하는 만큼 병합(부분 침범 시 문자 단위 분할). */
      while (true) {
        const prev = findPrevActive(active, target)
        if (!prev) break
        /** Same-card only — cross-line prev 는 건드리지 않는다 (clamp 로 거의 도달 못함, 안전망). */
        if (prev.lineIndex !== target.lineIndex) break
        if (newStart >= prev.end) break

        if (newStart > prev.start + 1e-9 && newStart < prev.end - 1e-9) {
          /** 같은 줄 — 글자 단위 부분 흡수. */
          const { left, right } = splitWordTextAtMediaCut(prev.word, prev.start, prev.end, newStart)
          if (left.length > 0 && right.length > 0) {
            prev.end = newStart
            prev.word = left
            target.word = right + target.word
            target.start = newStart
            break
          }
          /** 한 쪽이 비면 통째 흡수 fallthrough — 빈 글자 단어가 남지 않게 */
        }

        target.word = joinWords([prev.word, target.word])
        prev.isDeleted = true
        onTombstone(prev)
        removeActive(active, prev)
        if (newStart >= prev.start) break
      }
      target.start = newStart
    } else if (newStart > target.start) {
      /**
       * Shrink 오른쪽으로 — target 의 **앞쪽 글자**를 시간 비율로 떼어 prev.word 끝에 append.
       * 같은 카드 prev 가 있으면 글자/시각 부분 분해(부분 흡수의 역연산) 가 일어난다.
       * 이전 expand 로 tombstone 된 같은 줄 단어가 새 gap 안에 들어오면 revive 한다.
       */
      const oldStart = target.start
      const ownEnd2 = target.end
      const revived = reviveTombstonedPrevs(flat, target, newStart, onRevive)
      target.start = newStart
      if (revived.length === 0) {
        const prev = findPrevActive(active, target)
        if (prev && prev.lineIndex === target.lineIndex) {
          /** 같은 카드 — 글자 단위 부분 분해. target 의 앞 글자를 prev 끝에 흘려보냄. */
          transferCharsTargetStartToPrevEnd(target, prev, oldStart, ownEnd2, newStart)
        }
      } else {
        insertActiveBefore(active, target, revived)
        stripPrefixWords(target, revived)
        /**
         * full revive (newStart > origEnd) 일 때 사용자가 끌어 둔 newStart 와 부활 단어의 우측 끝 사이에
         * 큰 gap 이 생기면, 다음 re-merge 가 viewport 밖에 놓여 사이클(합치기→분해→합치기)이 한 번 만에 막힌다.
         * → 가장 인접한(=storage 상 직전, revived[0]) 부활 단어의 end 로 target.start 를 스냅해 인접 상태로 둔다.
         */
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
  /** 아래 카드 첫 active 단어의 start 보다 오른쪽으로는 못 간다 — cross-line 흡수 차단. */
  if (crossNext && newEnd > crossNext.start) newEnd = crossNext.start

  if (newEnd > target.end) {
    /** Expand 오른쪽 — next 침범. 다음 단어 **내부** 에서만 멈추면 문자 단위 부분 흡수. */
    while (true) {
      const next = findNextActive(active, target)
      if (!next) break
      /** Same-card only — cross-line next 는 건드리지 않는다 (clamp 로 거의 도달 못함, 안전망). */
      if (next.lineIndex !== target.lineIndex) break
      if (newEnd <= next.start) break

      if (newEnd < next.end - 1e-9) {
        /** 같은 줄 — 글자 단위 부분 흡수. */
        const { left, right } = splitWordTextAtMediaCut(next.word, next.start, next.end, newEnd)
        if (left.length > 0 && right.length > 0) {
          target.word = target.word + left
          target.end = newEnd
          next.start = newEnd
          next.word = right
          break
        }
        /** 한 쪽이 비면 통째 흡수 fallthrough — 빈 글자 단어가 남지 않게 */
      }

      target.word = joinWords([target.word, next.word])
      next.isDeleted = true
      onTombstone(next)
      removeActive(active, next)
      if (newEnd <= next.end + 1e-9) break
    }
    target.end = newEnd
  } else if (newEnd < target.end) {
    /**
     * Shrink 왼쪽으로 — target 의 **뒤쪽 글자**를 시간 비율로 떼어 next.word 앞에 prepend.
     * 같은 카드 next 가 있으면 글자/시각 부분 분해.
     * 이전 expand 로 tombstone 된 같은 줄 단어가 새 gap 안에 들어오면 revive 한다.
     */
    const oldEnd = target.end
    const ownStart2 = target.start
    const revived = reviveTombstonedNexts(flat, target, newEnd, onRevive)
    target.end = newEnd
    if (revived.length === 0) {
      const next = findNextActive(active, target)
      if (next && next.lineIndex === target.lineIndex) {
        /** 같은 카드 — 글자 단위 부분 분해. target 의 뒤 글자를 next 앞으로 흘려보냄. */
        transferCharsTargetEndToNextStart(target, next, ownStart2, oldEnd, newEnd)
      }
    } else {
      insertActiveAfter(active, target, revived)
      stripSuffixWords(target, revived)
      /** start-edge 와 대칭 — 인접한 부활 단어의 start 로 target.end 를 스냅해 사이클 안정성을 유지. */
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

/**
 * 같은 줄 안에서 target.end 가 줄어든 만큼, target.word 의 **뒤쪽 글자**를 시간 비율로 떼어
 * next.word 앞에 직접 prepend(공백 없이)한다. next.start 도 newEnd 로 당겨진다.
 *
 * 부분 흡수(`target.word = target.word + left`)의 역연산 — 글자 단위 round-trip 을 유지.
 */
function transferCharsTargetEndToNextStart(
  target: ActiveLinkedWord,
  next: ActiveLinkedWord,
  oldTargetStart: number,
  oldTargetEnd: number,
  newTargetEnd: number
): void {
  const dur = oldTargetEnd - oldTargetStart
  if (!(dur > 1e-9)) {
    next.start = newTargetEnd
    return
  }
  const g = Array.from(target.word)
  const n = g.length
  if (n === 0) {
    next.start = newTargetEnd
    return
  }
  const lostRatio = (oldTargetEnd - newTargetEnd) / dur
  /** target 에 최소 1글자 남김 — 빈 글자 단어가 카드에 남아 “빈 단어카드” 가 보이지 않게 */
  const cutFromEnd = Math.max(0, Math.min(n - 1, Math.round(lostRatio * n)))
  if (cutFromEnd <= 0) {
    next.start = newTargetEnd
    return
  }
  const left = g.slice(0, n - cutFromEnd).join('')
  const right = g.slice(n - cutFromEnd).join('')
  target.word = left
  next.word = right + next.word
  next.start = newTargetEnd
}

/**
 * 같은 줄 안에서 target.start 가 늘어난 만큼, target.word 의 **앞쪽 글자**를 시간 비율로 떼어
 * prev.word 끝에 직접 append(공백 없이)한다. prev.end 도 newStart 로 당겨진다.
 */
function transferCharsTargetStartToPrevEnd(
  target: ActiveLinkedWord,
  prev: ActiveLinkedWord,
  oldTargetStart: number,
  oldTargetEnd: number,
  newTargetStart: number
): void {
  const dur = oldTargetEnd - oldTargetStart
  if (!(dur > 1e-9)) {
    prev.end = newTargetStart
    return
  }
  const g = Array.from(target.word)
  const n = g.length
  if (n === 0) {
    prev.end = newTargetStart
    return
  }
  const lostRatio = (newTargetStart - oldTargetStart) / dur
  /** target 에 최소 1글자 남김 */
  const cutFromStart = Math.max(0, Math.min(n - 1, Math.round(lostRatio * n)))
  if (cutFromStart <= 0) {
    prev.end = newTargetStart
    return
  }
  const left = g.slice(0, cutFromStart).join('')
  const right = g.slice(cutFromStart).join('')
  target.word = right
  prev.word = prev.word + left
  prev.end = newTargetStart
}

function insertActiveBefore(active: ActiveLinkedWord[], anchor: ActiveLinkedWord, items: FlatWord[]): void {
  const i = active.indexOf(anchor)
  if (i < 0) return
  const wrap: ActiveLinkedWord[] = items.map((fw) => ({ ...fw, activeIndex: 0 }))
  active.splice(i, 0, ...wrap)
}

/** target.word 에서 revive 된 *접미* 단어들을 잘라낸다 (오른쪽 줄이기 경로). 못 잘라내면 원본 유지. */
function stripSuffixWords(target: ActiveLinkedWord, revived: FlatWord[]): void {
  let cur = target.word
  // revived 는 storage 순서(좌→우) — 접미사로는 마지막부터 떼어 본다
  for (let i = revived.length - 1; i >= 0; i--) {
    const w = revived[i]!.word.trim()
    if (w.length === 0) continue
    const trimmed = cur.trimEnd()
    if (trimmed.endsWith(w)) {
      cur = trimmed.slice(0, trimmed.length - w.length).trimEnd()
    }
  }
  target.word = cur
}

/** target.word 에서 revive 된 *접두* 단어들을 잘라낸다 (왼쪽 줄이기 경로). */
function stripPrefixWords(target: ActiveLinkedWord, revived: FlatWord[]): void {
  let cur = target.word
  // revived 는 storage 역순(우→좌) — 접두로는 첫 번째(원래 가장 왼쪽)부터 떼어 본다
  for (let i = revived.length - 1; i >= 0; i--) {
    const w = revived[i]!.word.trim()
    if (w.length === 0) continue
    const trimmed = cur.trimStart()
    if (trimmed.startsWith(w)) {
      cur = trimmed.slice(w.length).trimStart()
    }
  }
  target.word = cur
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
      return {
        ...w,
        start: fw.start,
        end: fw.end,
        word: fw.word,
        isDeleted: fw.isDeleted ? true : false
      }
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
}

/**
 * 한 번의 엣지 드래그(마우스 이동 한 프레임) 결과를 `subtitles` 상태 트리에 반영한다.
 *
 * - 입력을 변형하지 않으며 새 `subtitles` 배열을 반환.
 * - target 단어가 tombstone 이거나 존재하지 않으면 입력과 동치인 결과를 그대로 반환.
 * - cross-line 병합/흡수는 활성 단어 평탄화 덕분에 자동으로 처리된다.
 */
export function applyWordEdgeDrag(input: ApplyWordEdgeDragInput): EdgeDragResult {
  const {
    subtitles,
    target,
    edge,
    newSec,
    minWordWidthSec = MIN_WORD_DURATION_SEC
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
    }
  )

  /** active 의 (start/end/word) 변경 사항을 flat 으로 되돌려 반영. */
  for (const a of active) {
    const fw = findFlat(flat, a.lineIndex, a.wordIndex)
    if (!fw) continue
    fw.start = a.start
    fw.end = a.end
    fw.word = a.word
    fw.isDeleted = false
  }
  // tombstone 표시는 active 에서 빠진 단어들 — flat 에서 `isDeleted: true` 로 마킹
  for (const ref of tombstonedRefs) {
    const fw = findFlat(flat, ref.lineIndex, ref.wordIndex)
    if (fw) fw.isDeleted = true
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
