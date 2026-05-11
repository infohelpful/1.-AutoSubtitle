import type { CutRange } from './ipc'
import type { SubtitleLine } from './subtitles'
import { parseSubtitleLines } from './subtitles'
import { parseVirtualTimeline, type VirtualTimelineBlock } from './virtualTimeline'

export type { VirtualTimelineBlock }

export const AUTOSUB_FILE_FORMAT = 'autosubtitle-project' as const
export const AUTOSUB_VERSION = 1 as const

/** `.autosub` JSON 내부 — 프리뷰 자막 스타일과 동일 의미 */
export type AutosubProjectStyleV1 = {
  fontFamily: string
  fontSize: number
  textColor: string
  fontWeight: number
  bgColor: string
  bgOpacity: number
  bgPaddingPct: number
  strokeColor: string
  strokeWidth: number
  x: number
  y: number
}

export type AutosubProjectFileV1 = {
  format: typeof AUTOSUB_FILE_FORMAT
  version: typeof AUTOSUB_VERSION
  savedAt: string
  videoPath: string | null
  cutRanges: CutRange[]
  subtitleStyle: AutosubProjectStyleV1
  subtitles: SubtitleLine[]
  /** 가상 타임라인 블록(비파괴 삭제 tombstone + 활성 스냅샷) — 없으면 구버전 프로젝트 */
  virtualTimeline?: VirtualTimelineBlock[]
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function parseCutRanges(raw: unknown): CutRange[] {
  if (!Array.isArray(raw)) return []
  const out: CutRange[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const start = Number(item.start)
    const end = Number(item.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    out.push({ start, end })
  }
  return out
}

function parseStyle(raw: unknown): AutosubProjectStyleV1 | null {
  if (!isRecord(raw)) return null
  const fontFamily = typeof raw.fontFamily === 'string' ? raw.fontFamily : ''
  const fontSize = Number(raw.fontSize)
  const textColor = typeof raw.textColor === 'string' ? raw.textColor : '#ffffff'
  const fontWeight = Number(raw.fontWeight)
  const bgColor = typeof raw.bgColor === 'string' ? raw.bgColor : '#000000'
  const bgOpacity = Number(raw.bgOpacity)
  const bgPaddingPct = Number(raw.bgPaddingPct)
  const strokeColor = typeof raw.strokeColor === 'string' ? raw.strokeColor : '#000000'
  const strokeWidth = Number(raw.strokeWidth)
  const x = Number(raw.x)
  const y = Number(raw.y)
  if (!fontFamily.trim()) return null
  if (!Number.isFinite(fontSize) || fontSize < 1) return null
  if (!Number.isFinite(fontWeight)) return null
  if (!Number.isFinite(bgOpacity)) return null
  if (!Number.isFinite(bgPaddingPct)) return null
  if (!Number.isFinite(strokeWidth)) return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return {
    fontFamily,
    fontSize,
    textColor,
    fontWeight,
    bgColor,
    bgOpacity,
    bgPaddingPct,
    strokeColor,
    strokeWidth,
    x,
    y
  }
}

export function parseAutosubProjectFile(raw: unknown):
  | { ok: true; data: AutosubProjectFileV1 }
  | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: '루트가 객체가 아닙니다.' }
  if (raw.format !== AUTOSUB_FILE_FORMAT) return { ok: false, reason: 'format이 autosubtitle-project가 아닙니다.' }
  if (raw.version !== AUTOSUB_VERSION) return { ok: false, reason: `지원하지 않는 버전: ${String(raw.version)}` }
  const savedAt = typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString()
  const videoPath =
    raw.videoPath === null || raw.videoPath === undefined
      ? null
      : typeof raw.videoPath === 'string'
        ? raw.videoPath
        : null
  const cutRanges = parseCutRanges(raw.cutRanges)
  const subtitleStyle = parseStyle(raw.subtitleStyle)
  if (!subtitleStyle) return { ok: false, reason: 'subtitleStyle이 올바르지 않습니다.' }
  const subtitles = parseSubtitleLines(raw.subtitles)
  const vtRaw = raw.virtualTimeline
  const virtualTimelineParsed =
    vtRaw !== undefined && vtRaw !== null ? parseVirtualTimeline(vtRaw) : undefined
  const data: AutosubProjectFileV1 = {
    format: AUTOSUB_FILE_FORMAT,
    version: AUTOSUB_VERSION,
    savedAt,
    videoPath,
    cutRanges,
    subtitleStyle,
    subtitles
  }
  if (virtualTimelineParsed && virtualTimelineParsed.length > 0) {
    data.virtualTimeline = virtualTimelineParsed
  }
  return { ok: true, data }
}
