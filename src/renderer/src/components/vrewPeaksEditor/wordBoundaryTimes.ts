import type { Word } from './types'

/** Peaks overlap 드래그와 유사한 최소 길이 */
export const MIN_WORD_DURATION_SEC = 0.02

export function sortWordsByStart(words: readonly Word[]): Word[] {
  return [...words].sort((a, b) => a.start - b.start)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** 경계 시간을 단어 최소 길이·타임라인 끝 안으로 제한 */
export function clampBetweenBoundary(
  sorted: Word[],
  leftIndex: number,
  newT: number,
  timelineEndSec: number
): number {
  const left = sorted[leftIndex]!
  const right = sorted[leftIndex + 1]!
  const lo = left.start + MIN_WORD_DURATION_SEC
  const hi = Math.min(right.end - MIN_WORD_DURATION_SEC, timelineEndSec)
  return clamp(newT, lo, hi)
}

export function clampFirstStart(sorted: Word[], newT: number, timelineEndSec: number): number {
  const w = sorted[0]!
  const hi = w.end - MIN_WORD_DURATION_SEC
  return clamp(newT, 0, Math.min(hi, timelineEndSec))
}

export function clampLastEnd(sorted: Word[], newT: number, timelineEndSec: number): number {
  const w = sorted[sorted.length - 1]!
  const lo = w.start + MIN_WORD_DURATION_SEC
  return clamp(newT, lo, timelineEndSec)
}

export type BoundaryDragTarget =
  | { kind: 'first-start' }
  | { kind: 'between'; leftIndex: number }
  | { kind: 'last-end' }

/** sorted 기준으로 경계 시간 적용 → id 기준으로 병합한 새 단어 배열 */
export function applyBoundaryDrag(
  prevById: Map<string, Word>,
  sorted: Word[],
  target: BoundaryDragTarget,
  newT: number,
  timelineEndSec: number
): Word[] {
  const out = new Map(prevById)

  if (sorted.length === 0) return []

  if (target.kind === 'first-start') {
    const w = sorted[0]!
    const t = clampFirstStart(sorted, newT, timelineEndSec)
    const base = out.get(w.id) ?? w
    out.set(w.id, { ...base, start: t })
    return sortWordsByStart([...out.values()])
  }

  if (target.kind === 'last-end') {
    const w = sorted[sorted.length - 1]!
    const t = clampLastEnd(sorted, newT, timelineEndSec)
    const base = out.get(w.id) ?? w
    out.set(w.id, { ...base, end: t })
    return sortWordsByStart([...out.values()])
  }

  const i = target.leftIndex
  const left = sorted[i]!
  const right = sorted[i + 1]!
  const t = clampBetweenBoundary(sorted, i, newT, timelineEndSec)
  const lb = out.get(left.id) ?? left
  const rb = out.get(right.id) ?? right
  out.set(left.id, { ...lb, end: t })
  out.set(right.id, { ...rb, start: t })
  return sortWordsByStart([...out.values()])
}
