/**
 * 프로그램(편집) 시간축 ↔ 원본 미디어 시간축 ↔ 마스터 오디오 시간축 매핑.
 * App.tsx 의 TimelineClip 로직을 순수 함수로 유지 — 재생 엔진·스냅샷에서 재사용.
 */
import type { CutRange } from '../../../shared/ipc'
import { mergeCutRanges } from '../../../shared/timelineCollapse'

/** 삭제 구간 끝에 정확히 맞추면 디코더가 같은 키프레임에 걸려 멈추는 경우가 있어 살짝 건너뜀 */
export const SKIP_CUT_TAIL_SEC = 2e-4

export type TimelineClip = {
  id: number
  editStart: number
  editEnd: number
  mediaIn: number
  mediaOut: number
  timelineStart: number
  timelineEnd: number
  mediaStart: number
  mediaEnd: number
}

/** 마스터 오디오가 스티치 Blob(편집 축 길이)인지, 원본 파일과 동일(패스스루)인지 */
export type MasterAudioMode = 'stitched' | 'passthrough'

export type TimelineMapping = {
  clips: TimelineClip[]
  mergedCuts: CutRange[]
  mediaEndHintSec: number
  programToMediaSec: (programSec: number) => number
  mediaToProgramSec: (mediaSec: number) => number
  programToMasterAudioSec: (programSec: number) => number
  masterAudioToProgramSec: (masterSec: number) => number
  masterMode: MasterAudioMode
}

export function buildTimelineClips(ranges: CutRange[], mediaEndHintSec: number): TimelineClip[] {
  const merged = mergeCutRanges([...ranges])
  const clips: TimelineClip[] = []
  let timelineCursor = 0
  let mediaCursor = 0
  let nextId = 1
  for (const r of merged) {
    if (r.start > mediaCursor) {
      const dur = r.start - mediaCursor
      const editStart = timelineCursor
      const editEnd = timelineCursor + dur
      const mediaStart = mediaCursor
      const mediaEnd = r.start
      clips.push({
        id: nextId,
        editStart,
        editEnd,
        mediaIn: mediaStart,
        mediaOut: mediaEnd,
        timelineStart: editStart,
        timelineEnd: editEnd,
        mediaStart,
        mediaEnd
      })
      nextId += 1
      timelineCursor += dur
    }
    mediaCursor = Math.max(mediaCursor, r.end)
  }
  const tailEnd = Math.max(mediaCursor, mediaEndHintSec)
  if (tailEnd > mediaCursor) {
    const dur = tailEnd - mediaCursor
    const editStart = timelineCursor
    const editEnd = timelineCursor + dur
    const mediaStart = mediaCursor
    const mediaEnd = tailEnd
    clips.push({
      id: nextId,
      editStart,
      editEnd,
      mediaIn: mediaStart,
      mediaOut: mediaEnd,
      timelineStart: editStart,
      timelineEnd: editEnd,
      mediaStart,
      mediaEnd
    })
  }
  return clips
}

function findClipByProgramSec(programSec: number, clips: TimelineClip[]): TimelineClip | null {
  if (clips.length === 0) return null
  let lo = 0
  let hi = clips.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = clips[mid]!
    if (programSec < c.editStart) {
      hi = mid - 1
      continue
    }
    if (programSec >= c.editEnd) {
      lo = mid + 1
      continue
    }
    return c
  }
  return null
}

function findClipByMediaSec(mediaSec: number, clips: TimelineClip[]): TimelineClip | null {
  if (clips.length === 0) return null
  let lo = 0
  let hi = clips.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = clips[mid]!
    if (mediaSec < c.mediaStart) {
      hi = mid - 1
      continue
    }
    if (mediaSec >= c.mediaEnd) {
      lo = mid + 1
      continue
    }
    return c
  }
  return null
}

/**
 * 미디어 시간이 삭제 구간 안이면 구간 끝 직후로 밀어 낸다 (재생 스킵).
 */
export function skipCutRangeAt(timeSec: number, ranges: CutRange[]): number {
  const merged = mergeCutRanges([...ranges])
  let t = timeSec
  for (let step = 0; step < 64; step += 1) {
    let jumped = false
    for (const r of merged) {
      if (t >= r.start && t < r.end) {
        t = r.end + SKIP_CUT_TAIL_SEC
        jumped = true
        break
      }
    }
    if (!jumped) break
  }
  return t
}

/**
 * 프로그램(편집 타임라인) 초 → 원본 파일 `currentTime` 에 넣을 미디어 초
 */
export function mapProgramToMediaSec(programSec: number, clips: TimelineClip[]): number {
  const t = Math.max(0, programSec)
  if (clips.length === 0) return t
  const c = findClipByProgramSec(t, clips)
  if (c) return c.mediaStart + (t - c.editStart)
  const last = clips[clips.length - 1]!
  return last.mediaOut
}

/**
 * 원본 미디어 초 → 프로그램(편집) 초
 */
export function mapMediaToProgramSec(mediaSec: number, clips: TimelineClip[]): number {
  const t = Math.max(0, mediaSec)
  if (clips.length === 0) return t
  const c = findClipByMediaSec(t, clips)
  if (c) return c.editStart + (t - c.mediaStart)
  const last = clips[clips.length - 1]!
  return last.timelineEnd
}

/** @deprecated 이름 호환 — App.tsx 이전용 */
export const mapEditToMediaWithClips = mapProgramToMediaSec
/** @deprecated 이름 호환 */
export const mapMediaToEditWithClips = mapMediaToProgramSec

/**
 * 컷 + 미디어 길이 힌트로 매핑 세트 생성.
 * - `stitched`: 마스터 오디오 타임라인이 편집 축과 동일(합성 WAV) — program ↔ master identity
 * - `passthrough`: 마스터가 원본과 동일 축 — program ↔ media 와 동일 매핑
 */
export function createTimelineMapping(
  cuts: CutRange[],
  mediaEndHintSec: number,
  options?: { masterMode?: MasterAudioMode }
): TimelineMapping {
  const mergedCuts = mergeCutRanges([...cuts])
  const clips = buildTimelineClips(mergedCuts, mediaEndHintSec)

  const programToMediaSec = (p: number) => mapProgramToMediaSec(p, clips)
  const mediaToProgramSec = (m: number) => mapMediaToProgramSec(m, clips)

  const inferredMode: MasterAudioMode =
    options?.masterMode ?? (mergedCuts.length > 0 ? 'stitched' : 'passthrough')

  const programToMasterAudioSec =
    inferredMode === 'stitched'
      ? (p: number) => Math.max(0, p)
      : (p: number) => programToMediaSec(p)

  const masterAudioToProgramSec =
    inferredMode === 'stitched'
      ? (a: number) => Math.max(0, a)
      : (a: number) => mediaToProgramSec(a)

  return {
    clips,
    mergedCuts,
    mediaEndHintSec,
    programToMediaSec,
    mediaToProgramSec,
    programToMasterAudioSec,
    masterAudioToProgramSec,
    masterMode: inferredMode
  }
}

/** 프로그램 타임라인 상 재생 가능 길이(마지막 클립의 timelineEnd) */
export function programDurationSec(clips: TimelineClip[]): number {
  if (clips.length === 0) return 0
  return clips[clips.length - 1]!.timelineEnd
}
