/**
 * 활성 단어 판정 SSOT — 단어칩·재생 캐럿·내보내기 스케줄이 같은 규칙을 쓴다.
 *
 * - 구간은 반개구간 `start <= t < end`. 다음 단어 시작까지 끝을 늘리지 않는다(gap 은 빈 결과).
 * - 별도의 선행/지연 보정 상수를 두지 않는다. 장치 지연은 정렬 시간에 하드코딩하지 않는다.
 * - 시간 축은 호출자가 맞춘다(보통 원본 media 초). 이 모듈은 축 변환을 하지 않는다.
 */

export type ResolverWord = {
  start: number
  end: number
  isDeleted?: boolean
  isSilence?: boolean
}

export type ResolveActiveWordOptions = {
  /** 기본 true — tombstone 은 발화로 취급하지 않는다 */
  skipDeleted?: boolean
  /** 기본 true — `--` 무음 더미는 발화가 아니므로 활성이 되지 않는다 */
  skipSilence?: boolean
}

export function isTimeInWordSpan(t: number, start: number, end: number): boolean {
  if (!Number.isFinite(t) || !Number.isFinite(start) || !Number.isFinite(end)) return false
  return t >= start && t < end
}

/**
 * `t` 에 활성인 단어의 **입력 배열 인덱스**. 없으면 -1.
 * 단어가 겹치면(겹말) 배열 앞쪽을 우선한다 — 겹침을 억지로 제거하지 않는다.
 */
export function resolveActiveWordIndex(
  words: readonly ResolverWord[],
  t: number,
  options?: ResolveActiveWordOptions
): number {
  if (!Number.isFinite(t) || words.length === 0) return -1
  const skipDeleted = options?.skipDeleted ?? true
  const skipSilence = options?.skipSilence ?? true
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!
    if (skipDeleted && w.isDeleted === true) continue
    if (skipSilence && w.isSilence === true) continue
    if (isTimeInWordSpan(t, w.start, w.end)) return i
  }
  return -1
}
