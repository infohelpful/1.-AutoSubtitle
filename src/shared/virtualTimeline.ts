/**
 * 가상 타임라인(Virtual Timeline): 원본 미디어 시간 기준 블록 + 삭제는 비파괴(isDeleted).
 * cutRanges·편집축 매핑과 병행해 동기화한다.
 *
 * 단계적 비파괴 편집: 0) SSOT·축 규칙 확정 → 1) 순수 파생(브록·visible) → 2) UI 읽기 플래그
 * → 3) 삭제만 is_deleted → 4) Peaks·줄 분할/병합 시 tombstone 유지·리얼라인 스킵
 * → 5) gap-fill 정책(`gapFillWhenBuildingVrew`, tombstone 시 강제 Off) — 표시·경계 일관성.
 * → 6) 내보내기(SRT/VTT/번인)·IPC 큐는 `buildExportCueLines` 로 보이는 자막만 전달.
 * → 7) `.autosub` 저장 시 단어 tombstone(`is_deleted`)을 미디어 구간과 합쳐 `virtualTimeline` 삭제 블록에 반영.
 * → 8) 파생 목록 단일 진입점 `deriveVisibleSubtitleLinesForUi` — READ 플래그 분기 캡슐화.
 */
import type { CutRange } from './ipc'
import type { SubtitleLine, SubtitleWord } from './subtitles'
import { displayTextFromSubtitleWords, visibleSubtitleWords } from './subtitles'
import { SILENCE_PLACEHOLDER_TEXT } from './wordContract'
import { mergeCutRanges, snapTimelineSec } from './timelineCollapse'

const DELETE_RANGE_MIN_SEC = 1e-5

/**
 * 한 줄을 두 단어·두 카드로 나눈 뒤에도 타임스탬프가 예전 **통합 구간**처럼 겹치거나 한쪽이 옆 단어 구간까지 뻗은 경우,
 * 비파괴 삭제 컷이 그 넓은 span 그대로 나가 **한쪽만 지우려다 양쪽 미디어가 함께 잘리는** 문제가 생긴다.
 * (무음 한정이 아니라, 인접 단어와 시간이 겹치는 모든 경우에 동일.)
 * 삭제 미디어 컷은 살아 있는 **직전·직후 단어** 경계 안으로만 자른다.
 */
export function clampTombstoneMediaRangeToAliveNeighbors(
  words: readonly SubtitleWord[],
  wordIndex: number,
  /** 같은 트랜잭션에서 곧 tombstone 이 되는 인덱스 — 이웃 탐색 시 제외 */
  alsoRemovingWordIndices: ReadonlySet<number> | null
): { start: number; end: number } | null {
  const w = words[wordIndex]
  if (!w) return null
  let ms = snapTimelineSec(Math.min(w.start, w.end))
  let me = snapTimelineSec(Math.max(w.start, w.end))
  if (me < ms) {
    const t = ms
    ms = me
    me = t
  }

  const skipNeighbor = (idx: number): boolean => {
    if (alsoRemovingWordIndices?.has(idx)) return true
    const x = words[idx]
    return x?.isDeleted === true
  }

  for (let j = wordIndex - 1; j >= 0; j--) {
    if (skipNeighbor(j)) continue
    const p = words[j]!
    ms = Math.max(ms, snapTimelineSec(Math.max(p.start, p.end)))
    break
  }
  for (let j = wordIndex + 1; j < words.length; j++) {
    if (skipNeighbor(j)) continue
    const n = words[j]!
    me = Math.min(me, snapTimelineSec(Math.min(n.start, n.end)))
    break
  }

  if (!(me > ms + 1e-9)) return null
  return { start: ms, end: me }
}

export type VirtualTimelineBlock = {
  id: string
  /** 원본 미디어 파일 기준 시작(초) */
  mediaStartSec: number
  /** 원본 미디어 파일 기준 끝(초) */
  mediaEndSec: number
  text: string
  isDeleted: boolean
  /** 자막 카드(줄) 단위 — 파생 시 같은 줄로 묶음 */
  lineGroupKey?: string
  isSilence?: boolean
}

export type VirtualWordBlock = VirtualTimelineBlock

/** 삭제 블록만 모아 미디어 컷 구간으로 변환 */
export function cutRangesFromDeletedBlocks(blocks: readonly VirtualTimelineBlock[]): CutRange[] {
  const dels = blocks.filter((b) => b.isDeleted && b.mediaEndSec > b.mediaStartSec + 1e-9)
  return mergeCutRanges(dels.map((b) => ({ start: snapTimelineSec(b.mediaStartSec), end: snapTimelineSec(b.mediaEndSec) })))
}

/**
 * Peaks 파형 JSON 스티치용: 타임라인 CutRange + 단어 tombstone(`isDeleted`) + 세션 가상 삭제 블록을
 * 미디어 축에서 한 번에 합친다. 재생·타임라인 매핑은 `mergedCuts` 만 쓰고, 표시용 파형만 이 집합을 쓴다.
 */
export function mergeWaveformPeaksStitchCutRanges(
  mergedCuts: readonly CutRange[],
  lines: readonly SubtitleLine[],
  deletedMediaBlocks: readonly VirtualTimelineBlock[]
): CutRange[] {
  const fromWords = cutRangesFromDeletedBlocks(tombstoneBlocksFromSoftDeletedSubtitleWords(lines, mergedCuts))
  const fromVirtual = cutRangesFromDeletedBlocks(deletedMediaBlocks.filter((b) => b.isDeleted))
  return mergeCutRanges([...mergedCuts, ...fromWords, ...fromVirtual])
}

function rebuildLineMetaAfterWordsChange(line: SubtitleLine, newWords: SubtitleWord[]): SubtitleLine {
  const vis = visibleSubtitleWords(newWords)
  if (vis.length === 0) {
    return {
      ...line,
      words: newWords,
      text: displayTextFromSubtitleWords(newWords)
    }
  }
  return {
    ...line,
    words: newWords,
    start: vis[0]!.start,
    end: Math.max(vis[0]!.start + 0.1, vis[vis.length - 1]!.end),
    text: displayTextFromSubtitleWords(newWords)
  }
}

export type SoftWordDeleteRippleResult = {
  lines: SubtitleLine[]
  /** 미디어 컷 — `mergeDeletedMediaIntoTimeline` 에 순서대로 합침 */
  mediaCutsForVirtual: CutRange[]
}

/**
 * 단어 비파괴 삭제 — EDL 정책: 삭제 단어는 `isDeleted: true` 만 켜고 원본 미디어 `start/end` 는 보존한다.
 * 뒤 단어들의 편집축 위치 변화(시각적 "땡겨오기") 는 `timelineMapping.mediaToProgramSec` 가
 * `mergedWaveformPeaksStitchCuts` (= 하드 컷 + 단어 tombstone) 를 보고 자동으로 계산한다 → O(1) 삭제.
 * `mediaCutsForVirtual` 는 파형 스티치 입력용 미디어 컷 — `mergeDeletedMediaIntoTimeline` 으로 누적한다.
 */
export function subtitleLinesAfterSoftDeleteWordRange(
  lines: readonly SubtitleLine[],
  deletedLineIndex: number,
  fromWordIndex: number,
  toWordIndexExclusive: number,
  _mergedCuts: readonly CutRange[]
): SoftWordDeleteRippleResult | null {
  void _mergedCuts
  if (deletedLineIndex < 0 || deletedLineIndex >= lines.length) return null
  const line = lines[deletedLineIndex]
  const words = line.words ?? []
  if (fromWordIndex < 0 || toWordIndexExclusive > words.length || fromWordIndex >= toWordIndexExclusive) {
    return null
  }

  const deletedIndices: number[] = []
  for (let i = fromWordIndex; i < toWordIndexExclusive; i += 1) deletedIndices.push(i)

  let totalDur = 0
  for (const i of deletedIndices) {
    const w = words[i]
    if (!w || w.isDeleted) return null
    totalDur += Math.max(0, w.end - w.start)
  }
  if (!(totalDur > DELETE_RANGE_MIN_SEC)) return null

  const removing = new Set(deletedIndices)
  const mediaCutPieces: CutRange[] = []
  for (const i of deletedIndices) {
    const w = words[i]!
    const clamped = clampTombstoneMediaRangeToAliveNeighbors(words, i, removing)
    if (clamped && clamped.end > clamped.start + 1e-9) {
      mediaCutPieces.push({ start: clamped.start, end: clamped.end })
      continue
    }
    let ms = snapTimelineSec(Math.min(w.start, w.end))
    let me = snapTimelineSec(Math.max(w.start, w.end))
    if (me < ms) {
      const t = ms
      ms = me
      me = t
    }
    if (me > ms + 1e-9) {
      mediaCutPieces.push({ start: ms, end: me })
    }
  }
  const mediaCutsForVirtual = mergeCutRanges(mediaCutPieces)

  const out: SubtitleLine[] = lines.map((ln, li) => {
    if (li !== deletedLineIndex) return ln
    const ws = ln.words ?? []
    const nw = ws.map((w, wi) =>
      removing.has(wi) ? ({ ...w, isDeleted: true as const }) : w
    )
    return rebuildLineMetaAfterWordsChange(ln, nw)
  })

  return { lines: out, mediaCutsForVirtual }
}

/**
 * 삭제 구간을 가상 타임라인에 반영 — 동일 미디어 구간은 mergeCutRanges 규칙으로 합쳐진다.
 * 기존 비삭제 블록(active 스냅샷)은 유지한다.
 */
export function mergeDeletedMediaIntoTimeline(
  prev: readonly VirtualTimelineBlock[],
  mediaCut: CutRange,
  textHint = ''
): VirtualTimelineBlock[] {
  const s = snapTimelineSec(Math.max(0, Math.min(mediaCut.start, mediaCut.end)))
  const e = snapTimelineSec(Math.max(0, Math.max(mediaCut.start, mediaCut.end)))
  if (!(e > s + 0.001)) return [...prev]

  const active = prev.filter((b) => !b.isDeleted)
  const merged = mergeCutRanges([
    ...cutRangesFromDeletedBlocks(prev.filter((b) => b.isDeleted)),
    { start: s, end: e }
  ])
  const tombstones: VirtualTimelineBlock[] = merged.map((r) => ({
    id: `del:${snapTimelineSec(r.start)}:${snapTimelineSec(r.end)}`,
    mediaStartSec: r.start,
    mediaEndSec: r.end,
    text: textHint,
    isDeleted: true
  }))
  return [...active, ...tombstones]
}

/**
 * 자막 줄·단어 → 미디어 앵커 블록 (줄 id 유지).
 * 비파괴 편집 시 이 블록만 수정하고, 목록은 visibleSubtitleLinesFromBlocks 로 파생.
 */
export function buildWordBlocksFromSubtitleLines(
  lines: readonly SubtitleLine[],
  mergedCuts: readonly CutRange[]
): VirtualWordBlock[] {
  void mergedCuts
  const blocks: VirtualWordBlock[] = []
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!
    const lineKey = `sub-${li}`
    const words = line.words ?? []
    for (let wi = 0; wi < words.length; wi += 1) {
      const w = words[wi]!
      if (w.isDeleted === true) continue
      const ms = snapTimelineSec(Math.min(w.start, w.end))
      const me = snapTimelineSec(Math.max(w.start, w.end))
      if (!(me > ms + 1e-9)) continue
      const entry: VirtualWordBlock = {
        id: `act:${li}:${wi}:${snapTimelineSec(ms)}`,
        mediaStartSec: ms,
        mediaEndSec: me,
        text: w.word,
        isDeleted: false,
        lineGroupKey: lineKey
      }
      if (w.isSilence === true) entry.isSilence = true
      blocks.push(entry)
    }
  }
  return blocks
}

/** 저장용: 줄 메타 제거한 활성 스냅샷 (기존 프로젝트 필드와 호환) */
export function buildActiveBlocksSnapshotFromSubtitles(
  lines: readonly SubtitleLine[],
  mergedCuts: readonly CutRange[]
): VirtualTimelineBlock[] {
  return buildWordBlocksFromSubtitleLines(lines, mergedCuts).map(({ lineGroupKey, ...rest }) => rest)
}

/**
 * 가상 블록 배열 → 자막 줄 (보이는 목록용).
 * `isDeleted === true` 는 제외. 시간은 원본 미디어 축 그대로.
 */
export function visibleSubtitleLinesFromBlocks(
  blocks: readonly VirtualWordBlock[],
  mergedCuts: readonly CutRange[]
): SubtitleLine[] {
  void mergedCuts
  const active = blocks.filter((b) => !b.isDeleted && b.mediaEndSec > b.mediaStartSec + 1e-9)
  const byLine = new Map<string, VirtualWordBlock[]>()
  const ungrouped: VirtualWordBlock[] = []
  for (const b of active) {
    const key = b.lineGroupKey
    if (key === undefined || key === '') {
      ungrouped.push(b)
    } else {
      const arr = byLine.get(key) ?? []
      arr.push(b)
      byLine.set(key, arr)
    }
  }

  const lines: SubtitleLine[] = []

  const toSubtitleWord = (w: VirtualWordBlock): SubtitleWord => {
    const sw: SubtitleWord = {
      start: snapTimelineSec(w.mediaStartSec),
      end: snapTimelineSec(w.mediaEndSec),
      word: w.text
    }
    if (w.isSilence === true || w.text === SILENCE_PLACEHOLDER_TEXT || w.text === '??') sw.isSilence = true
    return sw
  }

  const sortedKeys = [...byLine.keys()].sort((a, b) => {
    const ma = /^sub-(\d+)$/.exec(a)
    const mb = /^sub-(\d+)$/.exec(b)
    if (ma && mb) return Number(ma[1]) - Number(mb[1])
    return a.localeCompare(b)
  })
  for (const key of sortedKeys) {
    const words = (byLine.get(key) ?? []).slice().sort((a, b) => a.mediaStartSec - b.mediaStartSec)
    if (words.length === 0) continue
    const subtitleWords = words.map(toSubtitleWord)
    const start = Math.min(...subtitleWords.map((s) => s.start))
    const end = Math.max(...subtitleWords.map((s) => s.end))
    const text = words.map((w) => w.text).join(' ').trim()
    lines.push({ start, end, text, words: subtitleWords })
  }

  if (ungrouped.length > 0) {
    const sorted = ungrouped.slice().sort((a, b) => a.mediaStartSec - b.mediaStartSec)
    const subtitleWords = sorted.map(toSubtitleWord)
    const start = Math.min(...subtitleWords.map((s) => s.start))
    const end = Math.max(...subtitleWords.map((s) => s.end))
    const text = sorted.map((w) => w.text).join(' ').trim()
    lines.push({ start, end, text, words: subtitleWords })
  }

  return lines
}

/**
 * UI 목록·파형용 파생 자막 줄 (`READ_SUBTITLES_FROM_VIRTUAL_TIMELINE` 가 true 일 때).
 * 활성 단어 블록 + 세션 미디어 삭제 블록을 합쳐 `visibleSubtitleLinesFromBlocks` 로 미디어 축 줄 목록을 만든다.
 * 삭제 미디어 블록은 조립 시 건너뛰지만, 호출부와 저장 스키마와 인자 형태를 맞추기 위해 함께 넘긴다.
 */
export function deriveVisibleSubtitleLinesForUi(
  lines: readonly SubtitleLine[],
  mergedCuts: readonly CutRange[],
  deletedMediaBlocks: readonly VirtualTimelineBlock[]
): SubtitleLine[] {
  const active = buildWordBlocksFromSubtitleLines(lines, mergedCuts)
  return visibleSubtitleLinesFromBlocks([...active, ...deletedMediaBlocks], mergedCuts)
}

/**
 * 자막 단어의 비파괴 삭제(`isDeleted`) 구간을 미디어 시간 tombstone 블록으로 변환.
 * `buildAutosubProjectJson` 에서 기존 미디어 삭제 블록과 합치기 위한 후보.
 */
export function tombstoneBlocksFromSoftDeletedSubtitleWords(
  lines: readonly SubtitleLine[],
  mergedCuts: readonly CutRange[]
): VirtualTimelineBlock[] {
  void mergedCuts
  const blocks: VirtualTimelineBlock[] = []
  for (let li = 0; li < lines.length; li += 1) {
    const words = lines[li]?.words ?? []
    for (let wi = 0; wi < words.length; wi += 1) {
      const w = words[wi]!
      if (w.isDeleted !== true) continue
      /**
       * **트림 드래그 흡수로 인한 tombstone 은 스킵.**
       *  - 텍스트는 인접 단어에 이미 옮겨졌고, 미디어 오디오는 그대로 유지되므로 stitched 파형에
       *    cut 으로 들어가면 안 된다. 이 cut 이 깔리면 commit 직후 파형이 좌측으로 “접혀” 보여
       *    사용자가 “점프” 로 체감한다.
       *  - 일반 단어 삭제(`isDeleted=true` 이면서 `mergedByEdgeTrim` 미설정) 는 그대로 cut 처리.
       */
      if (w.mergedByEdgeTrim === true) continue
      const clamped = clampTombstoneMediaRangeToAliveNeighbors(words, wi, null)
      let ms: number
      let me: number
      if (clamped) {
        ms = clamped.start
        me = clamped.end
      } else {
        ms = snapTimelineSec(Math.min(w.start, w.end))
        me = snapTimelineSec(Math.max(w.start, w.end))
      }
      if (!(me > ms + 1e-9)) continue
      blocks.push({
        id: `softdel:${li}:${wi}:${snapTimelineSec(ms)}:${snapTimelineSec(me)}`,
        mediaStartSec: ms,
        mediaEndSec: me,
        text: w.word,
        isDeleted: true,
        lineGroupKey: `sub-${li}`
      })
    }
  }
  return blocks
}

/**
 * 세션의 삭제 tombstone + 단어 단위 soft-delete 구간을 미디어 축에서 합친 뒤 최소 블록 집합으로 만든다.
 */
export function mergedDeletedBlocksForProjectSave(
  existingDeleted: readonly VirtualTimelineBlock[],
  lines: readonly SubtitleLine[],
  mergedCuts: readonly CutRange[]
): VirtualTimelineBlock[] {
  const soft = tombstoneBlocksFromSoftDeletedSubtitleWords(lines, mergedCuts)
  const combined = [...existingDeleted, ...soft].filter((b) => b.isDeleted)
  if (combined.length === 0) return []
  const ranges = cutRangesFromDeletedBlocks(combined)
  return virtualTombstonesFromCutRanges(ranges)
}

/** 컷만 있을 때 삭제 블록으로 복원 (구 프로젝트 마이그레이션) */
export function virtualTombstonesFromCutRanges(cuts: readonly CutRange[]): VirtualTimelineBlock[] {
  const merged = mergeCutRanges([...cuts])
  return merged.map((r) => ({
    id: `del:${snapTimelineSec(r.start)}:${snapTimelineSec(r.end)}`,
    mediaStartSec: r.start,
    mediaEndSec: r.end,
    text: '',
    isDeleted: true
  }))
}

/** 비삭제 블록 길이 합 ≒ 편집 타임라인에서 재생 가능한 누적(미디어 상 구간 길이 합) */
export function sumActiveBlockMediaDurationSec(blocks: readonly VirtualTimelineBlock[]): number {
  let s = 0
  for (const b of blocks) {
    if (!b.isDeleted && b.mediaEndSec > b.mediaStartSec + 1e-9) {
      s += b.mediaEndSec - b.mediaStartSec
    }
  }
  return s
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** 프로젝트 JSON·외부 스키마(start_time/end_time 등) 호환 */
export function parseVirtualTimeline(raw: unknown): VirtualTimelineBlock[] {
  if (!Array.isArray(raw)) return []
  const out: VirtualTimelineBlock[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const idRaw = item.id ?? item.block_id
    const id = typeof idRaw === 'string' && idRaw.trim() ? idRaw.trim() : `block_${out.length}`
    const start = Number(item.mediaStartSec ?? item.start_time ?? item.startTime ?? item.start)
    const end = Number(item.mediaEndSec ?? item.end_time ?? item.endTime ?? item.end)
    const text = typeof item.text === 'string' ? item.text : ''
    const isDeleted =
      item.isDeleted === true || item.is_deleted === true || item.deleted === true
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start + 1e-9)) continue
    const lineGroupKey =
      typeof item.lineGroupKey === 'string' && item.lineGroupKey.trim()
        ? item.lineGroupKey.trim()
        : typeof item.line_group_key === 'string' && item.line_group_key.trim()
          ? item.line_group_key.trim()
          : undefined
    const isSilence = item.isSilence === true || item.is_silence === true
    const block: VirtualTimelineBlock = {
      id,
      mediaStartSec: snapTimelineSec(start),
      mediaEndSec: snapTimelineSec(end),
      text,
      isDeleted
    }
    if (lineGroupKey !== undefined) block.lineGroupKey = lineGroupKey
    if (isSilence) block.isSilence = true
    out.push(block)
  }
  return out
}
