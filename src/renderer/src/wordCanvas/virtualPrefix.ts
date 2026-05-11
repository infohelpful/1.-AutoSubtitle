import type { WordEntity } from './types'

/**
 * virtualPrefixBefore[i] = 글로벌 순서에서 i번째 단어 직전까지의 «가시» 구간 길이 합(가상 타임라인 초).
 * 단어 하나가 tombstone 되면 i 이후 접두사만 다시 채우면 된다 — 전역 배열 전량을 다른 구조로 덮어쓰지 않음.
 */
export function computeVirtualPrefixBefore(
  orderedWordIds: string[],
  words: Record<string, WordEntity | undefined>
): number[] {
  const n = orderedWordIds.length
  const out = new Array<number>(n)
  let acc = 0
  for (let i = 0; i < n; i++) {
    out[i] = acc
    const w = words[orderedWordIds[i]!]
    if (w && !w.is_deleted) acc += Math.max(0, w.o_end - w.o_start)
  }
  return out
}

/** fromIndex 이후만 재계산. 이전 구간의 누적 길이는 동일하므로 acc만 0..fromIndex-1 에서 복구 */
export function recomputeVirtualPrefixFromIndex(
  orderedWordIds: string[],
  words: Record<string, WordEntity | undefined>,
  fromIndex: number,
  previous: number[]
): number[] {
  const n = orderedWordIds.length
  const out = previous.length === n ? previous.slice() : new Array<number>(n)
  let acc = 0
  const start = Math.max(0, Math.min(fromIndex, n))
  for (let i = 0; i < start; i++) {
    const w = words[orderedWordIds[i]!]
    if (w && !w.is_deleted) acc += Math.max(0, w.o_end - w.o_start)
  }
  for (let i = start; i < n; i++) {
    out[i] = acc
    const w = words[orderedWordIds[i]!]
    if (w && !w.is_deleted) acc += Math.max(0, w.o_end - w.o_start)
  }
  return out
}
