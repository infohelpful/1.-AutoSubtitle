import type { CutRange } from './ipc'

/** cutRanges·IPC 로그에 쓸 초 단위 스냅 — 부동소수점 잡음(0.009583332…) 제거 */
const SNAP_SEC = 1e-5

export function snapTimelineSec(t: number): number {
  if (!Number.isFinite(t)) return 0
  return Math.round(t / SNAP_SEC) * SNAP_SEC
}

/** 겹치는 구간 병합 — 재생 스킵·타임라인 접기 공통 */
export function mergeCutRanges(ranges: CutRange[]): CutRange[] {
  const sorted = [...ranges]
    .map((r) => ({ start: snapTimelineSec(r.start), end: snapTimelineSec(r.end) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start)
  if (sorted.length === 0) return []
  if (sorted.length === 1) return [sorted[0]!]
  const out: CutRange[] = [sorted[0]!]
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]!
    const last = out[out.length - 1]!
    if (cur.start <= last.end + 0.001) {
      last.end = Math.max(last.end, cur.end)
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

const EPS = 1e-9

/**
 * 원본(미디어) 시각 t → 편집(삭제 누적) 시각.
 * 삭제 구간 내부는 구간 시작에 접힌 값으로 맞춰 단조·역함수 가능하게 함.
 */
export function mediaToEditTime(t: number, cuts: readonly CutRange[]): number {
  if (!cuts.length || !Number.isFinite(t)) return t
  const merged = mergeCutRanges([...cuts])
  let removed = 0
  for (const c of merged) {
    if (c.end <= t + EPS) {
      removed += c.end - c.start
    } else if (c.start + EPS < t) {
      removed += t - c.start
      break
    } else {
      break
    }
  }
  return t - removed
}

/**
 * 편집 시각 → 원본 미디어 시각 (mediaToEditTime 의 단조 역함수: 최소 m 에 대해 mediaToEditTime(m) >= editT).
 */
export function editToMediaTime(editT: number, cuts: readonly CutRange[]): number {
  if (!cuts.length || !Number.isFinite(editT)) return editT
  const merged = mergeCutRanges([...cuts])
  let extra = 0
  let maxMediaEnd = 0
  for (const c of merged) {
    extra += c.end - c.start
    maxMediaEnd = Math.max(maxMediaEnd, c.end)
  }
  /** 상한이 너무 좁으면 이진 탐색이 잘못 수렴 — 미디어 끝·삭제 합을 넉넉히 반영 */
  let hi = Math.max(editT + extra + 1, maxMediaEnd + extra + 10, editT * 2 + extra + 10, maxMediaEnd * 2 + 60)
  let lo = 0
  for (let i = 0; i < 96; i += 1) {
    const mid = (lo + hi) / 2
    if (mediaToEditTime(mid, merged) < editT - EPS) lo = mid
    else hi = mid
  }
  return snapTimelineSec(hi)
}

/**
 * Peaks(편집 축)에서 고른 [startSec, endSec) 구간을 원본 파일 시간의 삭제 구간으로 바꿈.
 * `editToMediaTime`만으로 min/max가 붕괴되는 경우를 줄이기 위해 끝점을 한 번 더 벌린다.
 */
export function peaksEditRangeToMediaCut(
  startSec: number,
  endSec: number,
  cuts: readonly CutRange[]
): { start: number; end: number } | null {
  const s = Math.max(0, Math.min(startSec, endSec))
  const e = Math.max(0, Math.max(startSec, endSec))
  if (!(e > s + 1e-6)) return null
  const merged = mergeCutRanges([...cuts])
  if (merged.length === 0) {
    return { start: snapTimelineSec(s), end: snapTimelineSec(e) }
  }
  let m0 = editToMediaTime(s, merged)
  let m1 = editToMediaTime(e, merged)
  if (m1 < m0) {
    const t = m0
    m0 = m1
    m1 = t
  }
  m0 = snapTimelineSec(m0)
  m1 = snapTimelineSec(m1)
  if (!(m1 > m0 + 1e-6)) return null
  return { start: m0, end: m1 }
}
