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

/** Never anticipate speech to fill a visually empty row. Cue visibility is separate. */
export const HIGHLIGHT_LEAD_SEC = 0

/** 이보다 짧은 단어 구간은 하이라이트 후보에서 제외한다(30fps 한 프레임 ≈ 33ms 보다 훨씬 짧음). */
const MIN_HIGHLIGHT_WORD_SEC = 0.02

export type ResolveHighlightOptions = ResolveActiveWordOptions & {
  /** 기본 `HIGHLIGHT_HOLD_SEC`. 0 이면 유지하지 않는다. */
  holdSec?: number
  /** 기본 `HIGHLIGHT_LEAD_SEC`. 0 이면 첫 단어를 미리 강조하지 않는다. */
  leadSec?: number
}

/** Highlight the most recently started word, then hold it briefly through a gap.
 * An older overlapping ASR span must never regain the highlight after a later word.
 * Seeking backwards is stateless: the same source time always resolves identically.
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
  let latest = -1
  let nextIndex = -1
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!
    if (skipDeleted && w.isDeleted === true) continue
    if (skipSilence && w.isSilence === true) continue
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) continue
    if (w.end - w.start < MIN_HIGHLIGHT_WORD_SEC) continue
    if (w.start <= t) {
      if (latest < 0 || w.start >= words[latest]!.start) latest = i
    } else if (nextIndex < 0 || w.start < words[nextIndex]!.start) {
      nextIndex = i
    }
  }
  if (latest >= 0) {
    const word = words[latest]!
    return t < word.end || (holdSec > 0 && t - word.end < holdSec) ? latest : -1
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
