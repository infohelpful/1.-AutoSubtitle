import type { CutRange } from '../../shared/ipc'
import type { SubtitleLine } from '../../shared/subtitles'
import { applyProgramTimeRangeTombstoneCutToSubtitleLines } from '../../shared/subtitleTombstoneCut'
import { editToMediaTime, mediaToEditTime, mergeCutRanges, peaksEditRangeToMediaCut, snapTimelineSec } from '../../shared/timelineCollapse'

export type TimelineMapperSnapshot = {
  version: number
  cutRanges: CutRange[]
  cutCount: number
  mapEditToMediaSec: (editSec: number) => number
  mapMediaToEditSec: (mediaSec: number) => number
}

export type TimelineSeekResult = {
  requestedStartEditSec: number
  requestedEndEditSec: number | null
  resolvedStartMediaSec: number
  resolvedEndMediaSec: number | null
}

export type CutTransactionResult = {
  nextCutRanges: CutRange[]
  nextSubtitles: SubtitleLine[]
  mediaCut: CutRange | null
  editCut: { start: number; end: number }
}

export function createTimelineMapperSnapshot(version: number, cutRanges: CutRange[]): TimelineMapperSnapshot {
  const merged = mergeCutRanges([...cutRanges])
  return {
    version,
    cutRanges: merged,
    cutCount: merged.length,
    mapEditToMediaSec: (editSec: number) => Math.max(0, editToMediaTime(editSec, merged)),
    mapMediaToEditSec: (mediaSec: number) => Math.max(0, mediaToEditTime(mediaSec, merged))
  }
}

export function skipCutRangeAt(mediaSec: number, cutRanges: CutRange[]): number {
  const SKIP_CUT_HEAD_EPS_SEC = 1e-3
  for (const c of cutRanges) {
    if (mediaSec >= c.start - SKIP_CUT_HEAD_EPS_SEC && mediaSec < c.end) {
      return c.end + 0.0002
    }
  }
  return mediaSec
}

export function resolveEditSeek(
  snapshot: TimelineMapperSnapshot,
  requestedStartEditSec: number,
  requestedEndEditSec: number | null,
  mediaDurationSec?: number
): TimelineSeekResult {
  const startEdit = snapTimelineSec(requestedStartEditSec)
  let startMedia = skipCutRangeAt(snapshot.mapEditToMediaSec(startEdit), snapshot.cutRanges)
  if (mediaDurationSec && Number.isFinite(mediaDurationSec) && mediaDurationSec > 0) {
    startMedia = Math.min(startMedia, Math.max(0, mediaDurationSec - 0.001))
  }
  if (requestedEndEditSec == null) {
    return {
      requestedStartEditSec: startEdit,
      requestedEndEditSec: null,
      resolvedStartMediaSec: startMedia,
      resolvedEndMediaSec: null
    }
  }
  const endEdit = snapTimelineSec(requestedEndEditSec)
  let endMedia = skipCutRangeAt(snapshot.mapEditToMediaSec(endEdit), snapshot.cutRanges)
  if (mediaDurationSec && Number.isFinite(mediaDurationSec) && mediaDurationSec > 0) {
    endMedia = Math.min(endMedia, Math.max(0, mediaDurationSec - 0.001))
  }
  if (!(endMedia > startMedia + 1e-4)) endMedia = startMedia + 0.05
  return {
    requestedStartEditSec: startEdit,
    requestedEndEditSec: endEdit,
    resolvedStartMediaSec: startMedia,
    resolvedEndMediaSec: endMedia
  }
}

/**
 * 레거시 헬퍼 — 단어 tombstone 단일 모델에서는 자막만 갱신하고 CutRange 는 건드리지 않는다.
 */
export function buildCutTransaction(
  snapshot: TimelineMapperSnapshot,
  subtitles: SubtitleLine[],
  startEditSec: number,
  endEditSec: number
): CutTransactionResult | null {
  const s = snapTimelineSec(Math.max(0, Math.min(startEditSec, endEditSec)))
  const e = snapTimelineSec(Math.max(0, Math.max(startEditSec, endEditSec)))
  if (!(e > s + 0.001)) return null
  const mediaCut = peaksEditRangeToMediaCut(s, e, snapshot.cutRanges)
  const nextSubtitles = applyProgramTimeRangeTombstoneCutToSubtitleLines(subtitles, s, e)
  return {
    nextCutRanges: snapshot.cutRanges,
    nextSubtitles,
    mediaCut,
    editCut: { start: s, end: e }
  }
}
