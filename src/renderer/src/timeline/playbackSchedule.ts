import type { SubtitleLine } from '../../../shared/subtitles'
import {
  intersectMediaIntervalsWithRange,
  playbackIntervalsFromSubtitleLines
} from '../../../shared/playbackIntervals'
import type { TimelineClip } from './mapping'

export type ScheduledMediaSegment = {
  clipId: number
  startMediaSec: number
  endMediaSec: number
}

/**
 * EDL clip 배열에서 [startMediaSec, endMediaSec] 재생 스케줄을 만든다.
 * endMediaSec 이 null 이면 start 이후 모든 재생 가능 구간을 만든다.
 */
export function buildScheduledMediaSegments(
  clips: TimelineClip[],
  startMediaSec: number,
  endMediaSec: number | null
): ScheduledMediaSegment[] {
  if (clips.length === 0) return []
  const start = Math.max(0, startMediaSec)
  const end = endMediaSec == null ? Number.POSITIVE_INFINITY : Math.max(start, endMediaSec)
  const out: ScheduledMediaSegment[] = []
  for (const clip of clips) {
    const segStart = Math.max(start, clip.mediaStart)
    const segEnd = Math.min(end, clip.mediaEnd)
    if (segEnd <= segStart + 1e-4) continue
    out.push({
      clipId: clip.id,
      startMediaSec: segStart,
      endMediaSec: segEnd
    })
  }
  return out
}

/**
 * Phase 2 — 단어 기반 재생 스케줄.
 * `is_deleted` 단어를 제외한 `SubtitleLine[]` 의 단어 구간을 미디어 축 재생 스케줄로 변환한다.
 * `clipId` 는 살아 있는 구간 순서로 1부터 매긴다.
 */
export function buildScheduledMediaSegmentsFromSubtitleWords(
  lines: readonly SubtitleLine[],
  startMediaSec: number,
  endMediaSec: number | null
): ScheduledMediaSegment[] {
  const intervals = playbackIntervalsFromSubtitleLines(lines)
  if (intervals.length === 0) return []
  const start = Math.max(0, startMediaSec)
  const clipped = intersectMediaIntervalsWithRange(intervals, start, endMediaSec)
  const out: ScheduledMediaSegment[] = []
  for (let i = 0; i < clipped.length; i += 1) {
    const iv = clipped[i]!
    out.push({
      clipId: i + 1,
      startMediaSec: iv.start,
      endMediaSec: iv.end
    })
  }
  return out
}
