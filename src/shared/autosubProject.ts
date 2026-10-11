import type { CutRange } from './ipc'
import type { SubtitleLine, SubtitleWord } from './subtitles'
import { parseWordAlignmentMeta } from './wordAlignmentMeta'
import { ensureWordIdentities } from './wordIdentity'
import { parseMediaFingerprint, type MediaFingerprint } from './projectMedia'
import { parseVirtualTimeline, type VirtualTimelineBlock } from './virtualTimeline'

export type { VirtualTimelineBlock }

export const AUTOSUB_FILE_FORMAT = 'autosubtitle-project' as const
export const AUTOSUB_VERSION = 2 as const

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
  wordHighlightEnabled?: boolean
  wordHighlightColor?: string
}

export type AutosubProjectFile = {
  format: typeof AUTOSUB_FILE_FORMAT
  version: typeof AUTOSUB_VERSION
  savedAt: string
  videoPath: string | null
  mediaFingerprint: MediaFingerprint | null
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
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue
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
    y,
    wordHighlightEnabled: raw.wordHighlightEnabled === true,
    wordHighlightColor: typeof raw.wordHighlightColor === 'string' && /^#[a-f0-9]{6}$/i.test(raw.wordHighlightColor)
      ? raw.wordHighlightColor : '#ffff00'
  }
}

/** Project storage must preserve empty/deleted slots and exact text, unlike ASR cleanup. */
function parseProjectSubtitles(raw: unknown, legacy: boolean): SubtitleLine[] | null {
  if (!Array.isArray(raw)) return null
  const lines: SubtitleLine[] = []
  const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  for (const item of raw) {
    if (!isRecord(item) || !time(item.start) || !time(item.end) || item.end < item.start || typeof item.text !== 'string') return null
    const line: SubtitleLine = { start: item.start, end: item.end, text: item.text }
    if (item.isDeleted === true) line.isDeleted = true
    if (item.words !== undefined) {
      if (!Array.isArray(item.words)) return null
      line.words = []
      for (const rawWord of item.words) {
        if (!isRecord(rawWord) || !time(rawWord.start) || !time(rawWord.end) || rawWord.end < rawWord.start || typeof rawWord.word !== 'string') return null
        const word: SubtitleWord = { start: rawWord.start, end: rawWord.end, word: rawWord.word }
        for (const key of ['isSilence', 'isDeleted', 'mergedByEdgeTrim'] as const) {
          if (rawWord[key] === true) word[key] = true
        }
        if (typeof rawWord.splitChain === 'string' && /^[12]+$/.test(rawWord.splitChain)) word.splitChain = rawWord.splitChain
        if (!word.isSilence) {
          Object.assign(word, parseWordAlignmentMeta(rawWord))
          if (legacy && !word.alignmentStatus) {
            word.alignmentStatus = 'estimated'
            word.rawStart ??= word.start
            word.rawEnd ??= word.end
            word.reviewReasons = [...new Set([...(word.reviewReasons ?? []), 'legacy_project'])]
          }
        }
        line.words.push(word)
      }
    }
    lines.push(line)
  }
  return ensureWordIdentities(lines)
}

export function parseAutosubProjectFile(raw: unknown):
  | { ok: true; data: AutosubProjectFile; migrated: boolean }
  | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: '루트가 객체가 아닙니다.' }
  if (raw.format !== AUTOSUB_FILE_FORMAT) return { ok: false, reason: 'format이 autosubtitle-project가 아닙니다.' }
  if (raw.version !== 1 && raw.version !== AUTOSUB_VERSION) return { ok: false, reason: `지원하지 않는 버전: ${String(raw.version)}` }
  const savedAt = typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString()
  const videoPath =
    raw.videoPath === null || raw.videoPath === undefined
      ? null
      : typeof raw.videoPath === 'string'
        ? raw.videoPath
        : null
  const cutRanges = parseCutRanges(raw.cutRanges)
  if (!Array.isArray(raw.cutRanges) || cutRanges.length !== raw.cutRanges.length) return { ok: false, reason: '삭제 구간이 올바르지 않습니다.' }
  const subtitleStyle = parseStyle(raw.subtitleStyle)
  if (!subtitleStyle) return { ok: false, reason: 'subtitleStyle이 올바르지 않습니다.' }
  const subtitles = parseProjectSubtitles(raw.subtitles, raw.version === 1)
  if (!subtitles) return { ok: false, reason: '자막 데이터가 올바르지 않습니다. 원본 파일은 변경하지 않았습니다.' }
  const mediaFingerprint = parseMediaFingerprint(raw.mediaFingerprint)
  if (raw.mediaFingerprint != null && !mediaFingerprint) return { ok: false, reason: '영상 식별 정보가 올바르지 않습니다.' }
  const vtRaw = raw.virtualTimeline
  const virtualTimelineParsed =
    vtRaw !== undefined && vtRaw !== null ? parseVirtualTimeline(vtRaw, true) : undefined
  if (vtRaw != null && (!Array.isArray(vtRaw) || virtualTimelineParsed?.length !== vtRaw.length)) {
    return { ok: false, reason: '저장된 타임라인이 올바르지 않습니다.' }
  }
  const data: AutosubProjectFile = {
    format: AUTOSUB_FILE_FORMAT,
    version: AUTOSUB_VERSION,
    savedAt,
    videoPath,
    mediaFingerprint,
    cutRanges,
    subtitleStyle,
    subtitles
  }
  if (virtualTimelineParsed && virtualTimelineParsed.length > 0) {
    data.virtualTimeline = virtualTimelineParsed
  }
  return { ok: true, data, migrated: raw.version === 1 }
}
