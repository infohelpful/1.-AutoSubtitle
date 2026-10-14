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

/**
 * 하이라이트 유지 시간(초). 단어 사이 틈·마지막 단어 뒤에서 직전 단어 강조를 이만큼 유지한다.
 * 목록 칩 강조·캐럿·번인 내보내기가 같은 값을 쓴다(화면 자막 타이밍과 하이라이트가 달라지지 않게).
 */
export const HIGHLIGHT_HOLD_SEC = 1

/**
 * 줄이 막 나타났는데 첫 단어가 조금 뒤에 시작하는 경우(줄 경계가 단어보다 일찍 시작)에,
 * 첫 단어를 이만큼 먼저 강조한다. 자막이 보이는데 강조가 하나도 없는 시간을 없애기 위함.
 */
export const HIGHLIGHT_LEAD_SEC = 0.6

/** 이보다 짧은 단어 구간은 하이라이트 후보에서 제외한다(30fps 한 프레임 ≈ 33ms 보다 훨씬 짧음). */
const MIN_HIGHLIGHT_WORD_SEC = 0.02

export type ResolveHighlightOptions = ResolveActiveWordOptions & {
  /** 기본 `HIGHLIGHT_HOLD_SEC`. 0 이면 유지하지 않는다. */
  holdSec?: number
  /** 기본 `HIGHLIGHT_LEAD_SEC`. 0 이면 첫 단어를 미리 강조하지 않는다. */
  leadSec?: number
}

/**
 * **화면에 보이는 하이라이트**를 정하는 규칙 — `resolveActiveWordIndex` 와 달리 틈에서 꺼지지 않는다.
 *
 * 1. `t` 가 단어 구간 `[start, end)` 안이면 그 단어. 구간이 겹치면 **가장 늦게 시작한 단어**가 이긴다
 *    (겹침을 만드는 건 보통 늘어난 원본 시간의 단어이고, 새로 시작한 단어가 지금 말하는 단어다).
 * 2. 어느 단어에도 속하지 않으면, `t` 이전에 끝난 단어 중 **가장 늦게 끝난 단어**를 `holdSec` 까지 유지한다.
 * 3. 앞선 단어가 아예 없고(줄의 맨 앞) 다음 단어가 `leadSec` 안에 시작하면 그 단어를 미리 강조한다.
 * 4. 그 밖에는 -1 (진짜 긴 침묵).
 */
export function resolveHighlightWordIndex(
  words: readonly ResolverWord[],
  t: number,
  options?: ResolveHighlightOptions
): number {
  if (!Number.isFinite(t) || words.length === 0) return -1
  const skipDeleted = options?.skipDeleted ?? true
  const skipSilence = options?.skipSilence ?? true
  const holdSec = options?.holdSec ?? HIGHLIGHT_HOLD_SEC
  const leadSec = options?.leadSec ?? HIGHLIGHT_LEAD_SEC
  let exact = -1
  let heldIndex = -1
  let nextIndex = -1
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!
    if (skipDeleted && w.isDeleted === true) continue
    if (skipSilence && w.isSilence === true) continue
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) continue
    // 한 프레임보다 훨씬 짧은 구간은 화면에 보일 수 없고, "유지" 후보가 되면 진짜 단어를 가린다.
    if (w.end - w.start < MIN_HIGHLIGHT_WORD_SEC) continue
    if (t >= w.start && t < w.end) {
      if (exact < 0 || w.start >= words[exact]!.start) exact = i
    } else if (w.end <= t) {
      if (heldIndex < 0) heldIndex = i
      else {
        const h = words[heldIndex]!
        if (w.end > h.end || (w.end === h.end && w.start >= h.start)) heldIndex = i
      }
    } else if (w.start > t) {
      if (nextIndex < 0 || w.start < words[nextIndex]!.start) nextIndex = i
    }
  }
  if (exact >= 0) return exact
  if (heldIndex >= 0) {
    return holdSec > 0 && t - words[heldIndex]!.end <= holdSec ? heldIndex : -1
  }
  if (nextIndex >= 0 && leadSec > 0 && words[nextIndex]!.start - t <= leadSec) return nextIndex
  return -1
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
