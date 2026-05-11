import type { SubtitleLine, SubtitleWord } from './subtitles'

/** 미디어 절대 시간(초) 기준 재생 구간 — 파일 트림 없이 디코더가 재생할 조각 */
export type MediaPlaybackInterval = {
  start: number
  end: number
}

export type PlaybackIntervalsFromWordsOptions = {
  /**
   * 인접·근접 구간을 하나로 합칠 때 허용 간격(초).
   * 0이면 단어 경계마다 구간이 나뉠 수 있음(겹침·경계 접촉은 항상 합침).
   */
  mergeGapSec?: number
  /**
   * true면 gap-fill 무음(`isSilence`) 단어도 구간에 포함.
   * 기본 false — 실제 발화 구간만 재생 스케줄에 넣기 위함.
   */
  includeSilenceSegments?: boolean
}

function isPlaybackEligibleWord(w: SubtitleWord, opts: PlaybackIntervalsFromWordsOptions): boolean {
  if (w.isDeleted === true) return false
  if (!opts.includeSilenceSegments && w.isSilence === true) return false
  if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) return false
  return w.end > w.start
}

/**
 * 모든 자막 줄에서 단어를 모아, 삭제되지 않은 단어만으로 미디어 축 재생 구간을 만든다.
 * - 줄 순서와 무관하게 `start` 오름차순으로 정렬 후 병합한다.
 * - 구간이 겹치면 하나로 합친다.
 */
export function playbackIntervalsFromSubtitleLines(
  lines: readonly SubtitleLine[],
  options?: PlaybackIntervalsFromWordsOptions
): MediaPlaybackInterval[] {
  const mergeGap = Math.max(0, options?.mergeGapSec ?? 0)
  const opts: PlaybackIntervalsFromWordsOptions = {
    mergeGapSec: mergeGap,
    includeSilenceSegments: options?.includeSilenceSegments === true
  }

  const raw: MediaPlaybackInterval[] = []
  for (const line of lines) {
    const words = line.words
    if (!words || words.length === 0) continue
    for (const w of words) {
      if (!isPlaybackEligibleWord(w, opts)) continue
      raw.push({ start: w.start, end: w.end })
    }
  }

  if (raw.length === 0) return []

  raw.sort((a, b) => a.start - b.start)

  const merged: MediaPlaybackInterval[] = []
  let cur = { ...raw[0]! }
  for (let i = 1; i < raw.length; i += 1) {
    const next = raw[i]!
    if (next.start <= cur.end + mergeGap) {
      cur.end = Math.max(cur.end, next.end)
    } else {
      merged.push(cur)
      cur = { ...next }
    }
  }
  merged.push(cur)
  return merged
}

/**
 * 정렬된 미디어 구간 배열을 `[rangeStart, rangeEnd]` 와 교차시킨다.
 * `intervals`는 보통 `playbackIntervalsFromSubtitleLines` 결과(시간순).
 */
export function intersectMediaIntervalsWithRange(
  intervals: readonly MediaPlaybackInterval[],
  rangeStart: number,
  rangeEnd: number | null
): MediaPlaybackInterval[] {
  const lim = rangeEnd == null ? Number.POSITIVE_INFINITY : rangeEnd
  const EPS = 1e-6
  const out: MediaPlaybackInterval[] = []
  for (const iv of intervals) {
    if (iv.end <= rangeStart + EPS) continue
    if (iv.start >= lim - EPS) continue
    const s = Math.max(iv.start, rangeStart)
    const e = Math.min(iv.end, lim)
    if (e > s + EPS) out.push({ start: s, end: e })
  }
  return out
}

/** 재생 구간이 없으면 null — UI 상한(진행 바 등)에 사용 */
/** 재생 가능한 단어 구간이 하나라도 있으면 true (자막 없음·전부 삭제·무음만 → false) */
export function hasPlayableSubtitleWordIntervals(lines: readonly SubtitleLine[]): boolean {
  return playbackIntervalsFromSubtitleLines(lines).length > 0
}

export function lastPlaybackEndSec(intervals: readonly MediaPlaybackInterval[]): number | null {
  if (intervals.length === 0) return null
  let m = intervals[0]!.end
  for (let i = 1; i < intervals.length; i += 1) {
    const e = intervals[i]!.end
    if (e > m) m = e
  }
  return m
}
