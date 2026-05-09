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
