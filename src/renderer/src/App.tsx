import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from 'react'

import type { CutRange, DepsStatus, ExportFormat, GpuRuntimeStatus, TranscribeMode } from '../../shared/ipc'
import {
  AUTOSUB_FILE_FORMAT,
  AUTOSUB_VERSION,
  type AutosubProjectFileV1,
  parseAutosubProjectFile
} from '../../shared/autosubProject'
import { parseSubtitleLines, type SubtitleLine } from '../../shared/subtitles'
import { getSubtitleBoxChromeInline } from '../../shared/subtitleBoxChrome'
import { mergeEmptySubtitleWithPrevious, splitSubtitleLine } from './subtitleEditOps'
import { SubtitleVirtualList } from './SubtitleVirtualList'
import { SubtitleDataProvider } from './subtitleDataContext'

type OverlayPhase = 'working' | 'success' | 'error'

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'avi'] as const
const SUBTITLE_STYLE_STORAGE_KEY = 'autosubtitle:preview-subtitle-style'
const RECENT_FONTS_STORAGE_KEY = 'autosubtitle:recent-fonts'
const MAX_RECENT_FONTS = 5
const SUBTITLE_FONT_PRESETS = [
  'Segoe UI',
  'Malgun Gothic',
  'Apple SD Gothic Neo',
  'Noto Sans KR',
  'Arial',
  'Tahoma',
  'Verdana',
  'NanumGothic'
] as const

const EXPORT_OPTIONS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'video', label: '영상으로 내보내기' },
  { value: 'srt', label: '자막 (.srt)' },
  { value: 'vtt', label: '자막 WebVTT (.vtt) · 가운데 정렬' },
  { value: 'ass', label: '자막 ASS (.ass) · 스타일·정렬' },
  { value: 'txt', label: '텍스트 (.txt)' },
  { value: 'mp3', label: '오디오 (.mp3)' },
  { value: 'wav', label: '오디오 (.wav)' }
]

function filePathFromDrop(file: File): string | null {
  try {
    const p = window.api.getPathForFile(file)
    if (typeof p === 'string' && p.length > 0) return p
  } catch {
    /* ignore */
  }
  const legacy = (file as File & { path?: string }).path
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : null
}

function isVideoFilePath(absPath: string): boolean {
  const lower = absPath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  const ext = lower.slice(dot + 1)
  return (VIDEO_EXTENSIONS as readonly string[]).includes(ext)
}

function isAutosubDrop(file: File, absPath: string | null): boolean {
  if (absPath?.toLowerCase().endsWith('.autosub')) return true
  return file.name?.toLowerCase().endsWith('.autosub') ?? false
}

/** 메인에서 ASCII 로그용 코드를 쓰되, 앱 로그에는 한글 안내를 덧붙인다. */
function formatExportFailureMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (m.startsWith('[EXPORT_RENDER_TIMEOUT]')) {
    return `${m} | 자막 렌더 창이 제한 시간 안에 열리지 않았습니다. Vite가 떠 있는지 확인하거나, 프로젝트 루트에서 npm run build 를 한 번 실행한 뒤 다시 시도하세요.`
  }
  if (m.startsWith('[EXPORT_RENDER_LOAD_FAILED]')) {
    return `${m} | 자막 렌더 페이지를 불러오지 못했습니다.`
  }
  return m
}

function normalizeVideoPath(rawPath: string): string {
  let p = rawPath.normalize('NFC').trim()
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim()
  }
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(p.replace('file://', ''))
    } catch {
      /* ignore malformed URI */
    }
  }
  p = p.replace(/[¥₩]/g, '\\')
  p = p.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
  p = p.replace(/^[/\\]+([A-Za-z]:[\\/])/, '$1')
  p = p.replace(/^([A-Za-z])[\\/](?![\\/])/, '$1:\\')
  return p
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '').trim()
  const norm = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  if (!/^[0-9a-fA-F]{6}$/.test(norm)) return { r: 8, g: 10, b: 16 }
  const n = Number.parseInt(norm, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function readSavedSubtitleStyle(): Partial<{
  subtitleFontFamily: string
  subtitleFontSize: number
  subtitleTextColor: string
  subtitleFontWeight: number
  subtitleBgColor: string
  subtitleBgOpacity: number
  /** 배경 박스 안쪽 여백(30~150, 기본 100) */
  subtitleBgPaddingPct: number
  subtitleStrokeColor: string
  subtitleStrokeWidth: number
  subtitleX: number
  subtitleY: number
}> | null {
  try {
    const raw = window.localStorage.getItem(SUBTITLE_STYLE_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as ReturnType<typeof readSavedSubtitleStyle>
  } catch {
    return null
  }
}

function formatTimecode(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const frac = sec - Math.floor(sec)
  const ms = Math.min(999, Math.round(frac * 1000))
  let t = Math.floor(sec)
  const s = t % 60
  t = Math.floor(t / 60)
  const m = t % 60
  const h = Math.floor(t / 60)
  const pad = (n: number, w: number) => String(n).padStart(w, '0')
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`
}

/** `m:ss` ~ `h:mm:ss` (재생 바 옆 표시용) */
function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** `playheadSec`이 걸리는 자막 줄 인덱스, 없으면 null */
function pickActiveSubtitleIndex(lines: readonly SubtitleLine[], t: number): number | null {
  const i = lines.findIndex((s) => t >= s.start && t < s.end)
  return i >= 0 ? i : null
}

/** `bottom: y%` — 0 에 가까울수록 화면 아래, 값이 클수록 위. 슬라이더 범위와 동일하게 클램프 */
const SUBTITLE_Y_MIN = 0
const SUBTITLE_Y_MAX = 92

function clampSubtitleY(y: number): number {
  if (!Number.isFinite(y)) return 10
  return Math.max(SUBTITLE_Y_MIN, Math.min(SUBTITLE_Y_MAX, Math.round(y)))
}

const SUBTITLE_BG_PADDING_PCT_MIN = 30
const SUBTITLE_BG_PADDING_PCT_MAX = 150

const SUBTITLE_FONT_SIZE_MIN = 14
const SUBTITLE_FONT_SIZE_MAX = 100

function clampSubtitleFontSize(n: number): number {
  if (!Number.isFinite(n)) return 26
  return Math.max(SUBTITLE_FONT_SIZE_MIN, Math.min(SUBTITLE_FONT_SIZE_MAX, Math.round(n)))
}

function clampSubtitleBgPaddingPct(p: number): number {
  if (!Number.isFinite(p)) return 100
  return Math.max(SUBTITLE_BG_PADDING_PCT_MIN, Math.min(SUBTITLE_BG_PADDING_PCT_MAX, Math.round(p)))
}

function textFromWords(words: NonNullable<SubtitleLine['words']> | undefined, fallback: string): string {
  if (!words || words.length === 0) return fallback
  return words.map((w) => w.word).join(' ').trim()
}

function mergeCutRanges(ranges: CutRange[]): CutRange[] {
  if (ranges.length <= 1) return ranges
  const sorted = [...ranges]
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start)
  if (sorted.length <= 1) return sorted
  const out: CutRange[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]
    const last = out[out.length - 1]
    if (cur.start <= last.end + 0.001) {
      last.end = Math.max(last.end, cur.end)
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

function skipCutRangeAt(timeSec: number, ranges: CutRange[]): number {
  for (const r of ranges) {
    if (timeSec >= r.start && timeSec < r.end) return r.end
  }
  return timeSec
}

export default function App(): JSX.Element {
  const savedSubtitleStyle = readSavedSubtitleStyle()
  const readRecentFonts = (): string[] => {
    try {
      const raw = window.localStorage.getItem(RECENT_FONTS_STORAGE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => v.length > 0)
        .slice(0, MAX_RECENT_FONTS)
    } catch {
      return []
    }
  }
  const SPLIT_MIN = 40
  const SPLIT_MAX = 60
  const [previewWidthPct, setPreviewWidthPct] = useState(() => {
    const raw = window.localStorage.getItem('autosubtitle:split-preview-width-pct')
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return 60
    return Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, parsed))
  })
  const [busy, setBusy] = useState(false)
  const [videoPath, setVideoPath] = useState<string | null>(null)
  const [modelReady, setModelReady] = useState(false)
  const [downloadPct, setDownloadPct] = useState(0)

  const [engineOverlayOpen, setEngineOverlayOpen] = useState(false)
  const [overlayPhase, setOverlayPhase] = useState<OverlayPhase>('working')
  const [useGpuRuntimeInstall, setUseGpuRuntimeInstall] = useState(false)
  const [gpuRuntimeStatus, setGpuRuntimeStatus] = useState<GpuRuntimeStatus>({
    installed: false,
    canInstall: false,
    nvidiaPresent: false,
    urlConfigured: false,
    localCandidate: false
  })
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileDragDepthRef = useRef(0)
  const [fileDragOverlay, setFileDragOverlay] = useState(false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const previewStackRef = useRef<HTMLDivElement | null>(null)
  const rafPlayheadRef = useRef<number | null>(null)
  const [playheadSec, setPlayheadSec] = useState(0)
  const [durationSec, setDurationSec] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [cutRanges, setCutRanges] = useState<CutRange[]>([])
  const [subtitleFontFamily, setSubtitleFontFamily] = useState<string>(
    savedSubtitleStyle?.subtitleFontFamily ?? 'Malgun Gothic'
  )
  const [subtitleFontSize, setSubtitleFontSize] = useState<number>(() =>
    clampSubtitleFontSize(savedSubtitleStyle?.subtitleFontSize ?? 26)
  )
  const [subtitleTextColor, setSubtitleTextColor] = useState<string>(savedSubtitleStyle?.subtitleTextColor ?? '#f4f6fb')
  const [subtitleFontWeight, setSubtitleFontWeight] = useState<number>(savedSubtitleStyle?.subtitleFontWeight ?? 700)
  const [subtitleBgColor, setSubtitleBgColor] = useState<string>(savedSubtitleStyle?.subtitleBgColor ?? '#080a10')
  const [subtitleBgOpacity, setSubtitleBgOpacity] = useState<number>(savedSubtitleStyle?.subtitleBgOpacity ?? 62)
  const [subtitleBgPaddingPct, setSubtitleBgPaddingPct] = useState<number>(() =>
    clampSubtitleBgPaddingPct(savedSubtitleStyle?.subtitleBgPaddingPct ?? 100)
  )
  const [subtitleStrokeColor, setSubtitleStrokeColor] = useState<string>(
    savedSubtitleStyle?.subtitleStrokeColor ?? '#000000'
  )
  const [subtitleStrokeWidth, setSubtitleStrokeWidth] = useState<number>(savedSubtitleStyle?.subtitleStrokeWidth ?? 2)
  const [subtitleX, setSubtitleX] = useState<number>(savedSubtitleStyle?.subtitleX ?? 50)
  const [subtitleY, setSubtitleY] = useState<number>(() => clampSubtitleY(savedSubtitleStyle?.subtitleY ?? 10))
  const [availableFonts, setAvailableFonts] = useState<string[]>(() => [...SUBTITLE_FONT_PRESETS])
  const [recentFonts, setRecentFonts] = useState<string[]>(() => readRecentFonts())
  const [videoContentBox, setVideoContentBox] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const [videoNaturalSize, setVideoNaturalSize] = useState({ width: 1920, height: 1080 })

  /** Python `transcribe` 결과 등 — `{ start, end, text }[]` */
  const [subtitles, setSubtitles] = useState<SubtitleLine[]>([])
  const undoStackRef = useRef<SubtitleLine[][]>([])
  const redoStackRef = useRef<SubtitleLine[][]>([])
  /** 마지막으로 저장/연 `.autosub` 경로 — 「저장」 덮어쓰기용 */
  const projectFilePathRef = useRef<string | null>(null)

  const [isExtracting, setIsExtracting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [transcribeMode, setTranscribeMode] = useState<TranscribeMode>('cpu')
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportProgressLabel, setExportProgressLabel] = useState('')
  const [exportEncoderLine, setExportEncoderLine] = useState('')
  /** 진행 창에 인코더 줄 표시 — 영상(번인) 내보내기일 때만 */
  const [showBurnEncoderUi, setShowBurnEncoderUi] = useState(false)
  const videoBurnExportRef = useRef(false)
  const [exportFormat, setExportFormat] = useState<ExportFormat>('video')

  const activeSubtitleIndex = useMemo(
    () => pickActiveSubtitleIndex(subtitles, playheadSec),
    [subtitles, playheadSec]
  )

  const seekToSubtitleStart = useCallback(
    (startSec: number) => {
      const el = videoRef.current
      if (!el || !videoPath) return
      let t = Math.max(0, startSec)
      t = skipCutRangeAt(t, cutRanges)
      if (Number.isFinite(el.duration) && el.duration > 0) {
        t = Math.min(t, Math.max(0, el.duration - 0.001))
      }
      el.currentTime = t
      setPlayheadSec(t)
    },
    [videoPath, cutRanges]
  )

  const seekAndPlayTo = useCallback(
    (startSec: number) => {
      const el = videoRef.current
      if (!el || !videoPath) return
      let t = Math.max(0, startSec)
      t = skipCutRangeAt(t, cutRanges)
      if (Number.isFinite(el.duration) && el.duration > 0) {
        t = Math.min(t, Math.max(0, el.duration - 0.001))
      }
      el.currentTime = t
      setPlayheadSec(t)
      void el.play().catch(() => undefined)
    },
    [videoPath, cutRanges]
  )

  const registerDeletedAudioRange = useCallback((startSec: number, endSec: number) => {
    const s = Math.max(0, Math.min(startSec, endSec))
    const e = Math.max(0, Math.max(startSec, endSec))
    if (!(e > s + 0.001)) return
    setCutRanges((prev) => mergeCutRanges([...prev, { start: s, end: e }]))
  }, [])

  const onSubtitleCardClick = useCallback(
    (e: MouseEvent<HTMLElement>, startSec: number) => {
      if ((e.target as HTMLElement).closest('[data-subtitle-edit]')) return
      seekToSubtitleStart(startSec)
    },
    [seekToSubtitleStart]
  )

  const applySubtitleChange = useCallback(
    (updater: (prev: SubtitleLine[]) => SubtitleLine[], options?: { recordHistory?: boolean }) => {
      const recordHistory = options?.recordHistory ?? true
      setSubtitles((prev) => {
        const next = updater(prev)
        if (!recordHistory) return next
        if (next === prev) return prev
        const changed =
          next.length !== prev.length ||
          next.some(
            (n, i) =>
              n.start !== prev[i]?.start ||
              n.end !== prev[i]?.end ||
              n.text !== prev[i]?.text ||
              (n.words?.length ?? 0) !== (prev[i]?.words?.length ?? 0)
          )
        if (!changed) return prev
        undoStackRef.current.push(prev)
        if (undoStackRef.current.length > 100) undoStackRef.current.shift()
        redoStackRef.current = []
        return next
      })
    },
    []
  )

  const updateSubtitleAt = useCallback((index: number, text: string) => {
    applySubtitleChange((prev) => prev.map((s, j) => (j === index ? { ...s, text } : s)))
  }, [applySubtitleChange])

  const updateSubtitleRangeAt = useCallback((index: number, nextStart: number, nextEnd: number) => {
    const snap = (v: number) => Math.round(Math.max(0, v) * 10) / 10
    applySubtitleChange(
      (prev) =>
      prev.map((s, j) => {
        if (j !== index) return s
        let ns = snap(nextStart)
        let ne = snap(nextEnd)
        if (ne <= ns + 0.1) ne = snap(ns + 0.1)
        return { ...s, start: ns, end: ne }
      }),
      { recordHistory: false }
    )
  }, [applySubtitleChange])

  const splitSubtitleAtTime = useCallback((index: number, splitTimeRaw: number) => {
    const snap = (v: number) => Math.round(Math.max(0, v) * 10) / 10
    applySubtitleChange((prev) => {
      if (index < 0 || index >= prev.length) return prev
      const cur = prev[index]
      const dur = cur.end - cur.start
      if (!(dur > 0.2)) return prev
      let splitTime = snap(splitTimeRaw)
      splitTime = Math.max(cur.start + 0.1, Math.min(cur.end - 0.1, splitTime))
      if (!(splitTime > cur.start && splitTime < cur.end)) return prev

      const words = cur.words ?? []
      const leftWords = words.filter((w) => w.end <= splitTime)
      const rightWords = words.filter((w) => w.start >= splitTime)
      const leftText = leftWords.length > 0 ? leftWords.map((w) => w.word).join(' ') : cur.text
      const rightText = rightWords.length > 0 ? rightWords.map((w) => w.word).join(' ') : ''

      const first: SubtitleLine = { ...cur, end: splitTime, text: leftText, words: leftWords }
      const second: SubtitleLine = { ...cur, start: splitTime, end: cur.end, text: rightText, words: rightWords }
      return [...prev.slice(0, index), first, second, ...prev.slice(index + 1)]
    })
  }, [applySubtitleChange])

  const mergeSubtitleWithNext = useCallback((index: number) => {
    applySubtitleChange((prev) => {
      if (index < 0 || index >= prev.length - 1) return prev
      const cur = prev[index]
      const next = prev[index + 1]
      const mergedWords = [...(cur.words ?? []), ...(next.words ?? [])]
      const merged: SubtitleLine = {
        start: cur.start,
        end: next.end,
        text: textFromWords(mergedWords, `${cur.text} ${next.text}`.trim()),
        words: mergedWords
      }
      return [...prev.slice(0, index), merged, ...prev.slice(index + 2)]
    })
  }, [applySubtitleChange])

  const splitSubtitleAtWord = useCallback(
    (index: number, wordIndex: number) => {
      applySubtitleChange((prev) => {
        if (index < 0 || index >= prev.length) return prev
        const cur = prev[index]
        const words = cur.words ?? []
        if (wordIndex <= 0 || wordIndex >= words.length) return prev

        const leftWords = words.slice(0, wordIndex)
        const rightWords = words.slice(wordIndex)
        if (leftWords.length === 0 || rightWords.length === 0) return prev

        const leftEndRaw = leftWords[leftWords.length - 1].end
        const rightStartRaw = rightWords[0].start
        // 단어 타임스탬프가 겹치거나 역전돼도 분할이 되도록 안전한 경계값 계산
        let splitTime = (leftEndRaw + rightStartRaw) / 2
        if (!Number.isFinite(splitTime)) splitTime = rightStartRaw
        splitTime = Math.max(cur.start + 0.1, Math.min(cur.end - 0.1, splitTime))
        if (!(splitTime > cur.start && splitTime < cur.end)) return prev

        const first: SubtitleLine = {
          ...cur,
          end: splitTime,
          words: leftWords,
          text: textFromWords(leftWords, cur.text)
        }
        const second: SubtitleLine = {
          ...cur,
          start: splitTime,
          end: cur.end,
          words: rightWords,
          text: textFromWords(rightWords, cur.text)
        }
        return [...prev.slice(0, index), first, second, ...prev.slice(index + 1)]
      })
    },
    [applySubtitleChange]
  )

  const backspaceWordAt = useCallback(
    (cardIndex: number, wordIndex: number) => {
      applySubtitleChange((prev) => {
        if (cardIndex < 0 || cardIndex >= prev.length) return prev
        const cur = prev[cardIndex]
        const words = cur.words ?? []
        if (wordIndex < 0 || wordIndex >= words.length) return prev

        // 1) 동일 카드 내: 현재 단어의 왼쪽 단어 삭제
        if (wordIndex > 0) {
          const nextWords = words.filter((_, i) => i !== wordIndex - 1)
          if (nextWords.length === 0) return prev
          const nextStart = nextWords[0].start
          const nextEnd = nextWords[nextWords.length - 1].end
          const updated: SubtitleLine = {
            ...cur,
            start: nextStart,
            end: Math.max(nextStart + 0.1, nextEnd),
            words: nextWords,
            text: textFromWords(nextWords, cur.text)
          }
          return [...prev.slice(0, cardIndex), updated, ...prev.slice(cardIndex + 1)]
        }

        // 2) 카드 첫 단어: 이전 카드로 모두 이동 + 현재 카드 삭제
        if (cardIndex === 0) return prev
        const up = prev[cardIndex - 1]
        const upWords = up.words ?? []
        const movedWords = words
        const mergedWords = [...upWords, ...movedWords]
        if (mergedWords.length === 0) return prev
        const merged: SubtitleLine = {
          ...up,
          start: Math.min(up.start, mergedWords[0].start),
          end: Math.max(mergedWords[mergedWords.length - 1].end, up.end),
          words: mergedWords,
          text: textFromWords(mergedWords, `${up.text} ${cur.text}`.trim())
        }
        return [...prev.slice(0, cardIndex - 1), merged, ...prev.slice(cardIndex + 1)]
      })
    },
    [applySubtitleChange]
  )

  const deleteWordAt = useCallback(
    (cardIndex: number, caretIndex: number) => {
      applySubtitleChange((prev) => {
        if (cardIndex < 0 || cardIndex >= prev.length) return prev
        const cur = prev[cardIndex]
        const words = cur.words ?? []
        if (caretIndex < 0 || caretIndex > words.length) return prev

        // 1) 커서 오른쪽 단어 삭제
        if (caretIndex < words.length && words.length > 1) {
          const nextWords = words.filter((_, i) => i !== caretIndex)
          const nextStart = nextWords[0].start
          const nextEnd = nextWords[nextWords.length - 1].end
          const updated: SubtitleLine = {
            ...cur,
            start: nextStart,
            end: Math.max(nextStart + 0.1, nextEnd),
            words: nextWords,
            text: textFromWords(nextWords, cur.text)
          }
          return [...prev.slice(0, cardIndex), updated, ...prev.slice(cardIndex + 1)]
        }

        // 2) 카드 끝(caretIndex===words.length)에서 Delete: 다음 카드와 병합
        if (caretIndex === words.length && cardIndex < prev.length - 1) {
          const next = prev[cardIndex + 1]
          const mergedWords = [...words, ...(next.words ?? [])]
          const merged: SubtitleLine = {
            ...cur,
            end: next.end,
            words: mergedWords,
            text: textFromWords(mergedWords, `${cur.text} ${next.text}`.trim())
          }
          return [...prev.slice(0, cardIndex), merged, ...prev.slice(cardIndex + 2)]
        }

        // 3) 단어 1개 카드에서 Delete(커서 0): 다음 카드 흡수/카드 제거
        if (words.length === 1 && caretIndex === 0 && cardIndex < prev.length - 1) {
          const next = prev[cardIndex + 1]
          const mergedWords = [...words, ...(next.words ?? [])]
          const mergedNext: SubtitleLine = {
            ...next,
            start: Math.min(cur.start, next.start),
            end: Math.max(next.end, mergedWords[mergedWords.length - 1]?.end ?? next.end),
            words: mergedWords,
            text: textFromWords(mergedWords, `${cur.text} ${next.text}`.trim())
          }
          return [...prev.slice(0, cardIndex), mergedNext, ...prev.slice(cardIndex + 2)]
        }

        // 4) 마지막 카드 단일 단어 삭제
        if (prev.length <= 1) return prev
        return [...prev.slice(0, cardIndex), ...prev.slice(cardIndex + 1)]
      })
    },
    [applySubtitleChange]
  )

  const deleteWordRangeAt = useCallback(
    (cardIndex: number, fromWordIndex: number, toWordIndex: number) => {
      applySubtitleChange((prev) => {
        if (cardIndex < 0 || cardIndex >= prev.length) return prev
        const cur = prev[cardIndex]
        const words = cur.words ?? []
        const start = Math.max(0, Math.min(fromWordIndex, toWordIndex))
        const end = Math.min(words.length, Math.max(fromWordIndex, toWordIndex))
        if (start >= end) return prev

        const nextWords = words.filter((_, i) => i < start || i >= end)
        if (nextWords.length > 0) {
          const nextStart = nextWords[0].start
          const nextEnd = nextWords[nextWords.length - 1].end
          const updated: SubtitleLine = {
            ...cur,
            start: nextStart,
            end: Math.max(nextStart + 0.1, nextEnd),
            words: nextWords,
            text: textFromWords(nextWords, cur.text)
          }
          return [...prev.slice(0, cardIndex), updated, ...prev.slice(cardIndex + 1)]
        }

        if (prev.length <= 1) return prev
        return [...prev.slice(0, cardIndex), ...prev.slice(cardIndex + 1)]
      })
    },
    [applySubtitleChange]
  )

  const splitSubtitleAt = useCallback((index: number, cursorPos: number) => {
    applySubtitleChange((prev) => splitSubtitleLine(prev, index, cursorPos))
  }, [applySubtitleChange])

  const mergeEmptySubtitleAt = useCallback((index: number) => {
    applySubtitleChange((prev) => mergeEmptySubtitleWithPrevious(prev, index) ?? prev)
  }, [applySubtitleChange])

  useEffect(() => {
    if (!videoPath) {
      setPlayheadSec(0)
      setDurationSec(0)
      setIsPlaying(false)
      setSubtitles([])
      setCutRanges([])
    }
  }, [videoPath])

  const syncFromVideo = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    let t = el.currentTime
    const skipped = skipCutRangeAt(t, cutRanges)
    if (skipped !== t) {
      t = skipped
      el.currentTime = t
    }
    setPlayheadSec(t)
    if (Number.isFinite(el.duration) && el.duration > 0) {
      setDurationSec(el.duration)
    }
  }, [cutRanges])

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => undefined)
    else el.pause()
  }, [])

  const pausePlayback = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (!el.paused) el.pause()
  }, [])

  useEffect(() => {
    if (!isPlaying) {
      if (rafPlayheadRef.current !== null) {
        window.cancelAnimationFrame(rafPlayheadRef.current)
        rafPlayheadRef.current = null
      }
      return
    }
    const tick = () => {
      const el = videoRef.current
      if (!el || el.paused) {
        rafPlayheadRef.current = null
        return
      }
      let t = skipCutRangeAt(el.currentTime, cutRanges)
      if (t !== el.currentTime) {
        el.currentTime = t
      }
      // 재생 라인 표시를 0.01초 단위로 안정화
      t = Math.round(t * 100) / 100
      setPlayheadSec(t)
      rafPlayheadRef.current = window.requestAnimationFrame(tick)
    }
    rafPlayheadRef.current = window.requestAnimationFrame(tick)
    return () => {
      if (rafPlayheadRef.current !== null) {
        window.cancelAnimationFrame(rafPlayheadRef.current)
        rafPlayheadRef.current = null
      }
    }
  }, [cutRanges, isPlaying])

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input,textarea,[contenteditable="true"]')) return
      if (target?.closest('.subtitle-card')) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePlay])

  const applySeekValue = useCallback((raw: string) => {
    const el = videoRef.current
    if (!el) return
    const v = Number(raw)
    if (!Number.isFinite(v)) return
    const t = skipCutRangeAt(v, cutRanges)
    el.currentTime = t
    setPlayheadSec(t)
  }, [cutRanges])

  const onSeekChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      applySeekValue(e.target.value)
    },
    [applySeekValue]
  )

  const undoSubtitleChange = useCallback(() => {
    const prev = undoStackRef.current.pop()
    if (!prev) return
    setSubtitles((cur) => {
      redoStackRef.current.push(cur)
      return prev
    })
  }, [])

  const redoSubtitleChange = useCallback(() => {
    const next = redoStackRef.current.pop()
    if (!next) return
    setSubtitles((cur) => {
      undoStackRef.current.push(cur)
      return next
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const z = e.key.toLowerCase() === 'z'
      const y = e.key.toLowerCase() === 'y'
      if (!(e.ctrlKey || e.metaKey) || (!z && !y)) return
      if ((e.target as HTMLElement)?.closest('textarea,input,[contenteditable="true"]')) return
      e.preventDefault()
      if (z && !e.shiftKey) {
        undoSubtitleChange()
      } else {
        redoSubtitleChange()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [redoSubtitleChange, undoSubtitleChange])

  const processDroppedVideoPath = useCallback(
    (rawPath: string) => {
      if (busy || isExtracting) return
      const absPath = normalizeVideoPath(rawPath)
      if (!modelReady) {
        return
      }
      if (!isVideoFilePath(absPath)) {
        return
      }
      setVideoPath(absPath)
      setSubtitles([])
      setCutRanges([])
      undoStackRef.current = []
      redoStackRef.current = []
      setProgress(0)
      setTranscribeMode('cpu')
      setIsExtracting(true)
      window.api.sendVideoDropPath(absPath)
    },
    [busy, isExtracting, modelReady]
  )

  const runTranscribe = useCallback(() => {
    if (!videoPath || !modelReady || isExtracting || busy) return
    if (!isVideoFilePath(videoPath)) {
      return
    }
    setProgress(0)
    setTranscribeMode('cpu')
    setIsExtracting(true)
    window.api.sendVideoDropPath(videoPath)
  }, [busy, isExtracting, modelReady, videoPath])

  useEffect(() => {
    const offExport = window.api.onExportProgress((payload) => {
      setExportProgress((prev) => Math.max(prev, Math.min(100, payload.percent)))
      if (payload.label != null && payload.label !== '') {
        setExportProgressLabel(payload.label)
      }
      if (videoBurnExportRef.current && payload.encoderName != null && payload.encoderName !== '') {
        setExportEncoderLine(`인코더: ${payload.encoderName}`)
      }
    })
    return () => offExport()
  }, [])

  useEffect(() => {
    const offM = window.api.onTranscribeMode((mode) => {
      setTranscribeMode(mode)
    })
    const offD = window.api.onTranscribeDiag(() => {})
    const offP = window.api.onTranscribeProgress((pct) => {
      setProgress((prev) => Math.max(prev, Math.min(100, pct)))
    })
    const offC = window.api.onTranscribeComplete((raw) => {
      setIsExtracting(false)
      setProgress(0)
      setTranscribeMode('cpu')
      const lines = parseSubtitleLines((raw as { subtitles?: unknown })?.subtitles)
      setSubtitles(lines)
      undoStackRef.current = []
      redoStackRef.current = []
    })
    const offE = window.api.onTranscribeError(() => {
      setIsExtracting(false)
      setProgress(0)
      setTranscribeMode('cpu')
    })
    return () => {
      offM()
      offD()
      offP()
      offC()
      offE()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = (await window.api.getDepsStatus()) as DepsStatus
        const g = (await window.api.getGpuRuntimeStatus()) as GpuRuntimeStatus
        if (cancelled) return
        setGpuRuntimeStatus(g)
        setUseGpuRuntimeInstall(g.installed)
        if (s.engineReady) {
          setModelReady(true)
          setDownloadPct(100)
        }
      } catch {
        if (!cancelled) setModelReady(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const selected = subtitleFontFamily.trim()
    if (!selected) return
    setRecentFonts((prev) => {
      const next = [selected, ...prev.filter((f) => f !== selected)].slice(0, MAX_RECENT_FONTS)
      window.localStorage.setItem(RECENT_FONTS_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [subtitleFontFamily])

  useEffect(() => {
    const offProgress = window.api.onModelDownloadProgress((pct) => {
      setDownloadPct((prev) => Math.max(prev, Math.min(100, pct)))
    })
    const offReady = window.api.onModelReady(() => {
      setDownloadPct(100)
    })
    return () => {
      offProgress()
      offReady()
    }
  }, [])

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
    }
  }, [])

  const overlayStepLabel = useMemo(() => {
    if (overlayPhase === 'success') return '준비 완료'
    if (overlayPhase === 'error') return '오류'
    if (downloadPct >= 88 && downloadPct < 99.5) return '최적화 중'
    return '다운로드'
  }, [overlayPhase, downloadPct])

  const closeOverlayAfterError = useCallback(() => {
    setEngineOverlayOpen(false)
    setOverlayPhase('working')
    setDownloadPct(0)
  }, [])

  const startEngineDownload = useCallback(() => {
    setEngineOverlayOpen(true)
    setOverlayPhase('working')
    setDownloadPct(0)
    setBusy(true)

    void (async () => {
      try {
        if (useGpuRuntimeInstall) {
          try {
            await window.api.installGpuRuntime()
          } catch {
            /* CPU 모드로 계속 */
          }
        }
        await window.api.prepareAllEngines()
        setDownloadPct(100)
        setOverlayPhase('success')
        if (successTimerRef.current) clearTimeout(successTimerRef.current)
        successTimerRef.current = setTimeout(() => {
          successTimerRef.current = null
          setModelReady(true)
          setEngineOverlayOpen(false)
          setOverlayPhase('working')
          setBusy(false)
        }, 2000)
      } catch {
        setOverlayPhase('error')
        setBusy(false)
      }
    })()
  }, [useGpuRuntimeInstall])

  const installGpuRuntimeManually = useCallback(() => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        await window.api.installGpuRuntime()
        const g = (await window.api.getGpuRuntimeStatus()) as GpuRuntimeStatus
        setGpuRuntimeStatus(g)
        setUseGpuRuntimeInstall(g.installed)
      } catch {
        /* ignore */
      } finally {
        setBusy(false)
      }
    })()
  }, [busy])

  const exportVideo = useCallback(() => {
    if (!videoPath || subtitles.length === 0 || isExporting) return
    const isVideoBurn = exportFormat === 'video'
    videoBurnExportRef.current = isVideoBurn
    setShowBurnEncoderUi(isVideoBurn)
    setIsExporting(true)
    setExportProgress(0)
    setExportProgressLabel('내보내기 준비 중…')
    setExportEncoderLine('')
    void (async () => {
      try {
        const res = await window.api.exportByFormat({
          inputPath: videoPath,
          format: exportFormat,
          subtitles: subtitles.map((s) => ({ start: s.start, end: s.end, text: s.text })),
          cutRanges,
          subtitleStyle: {
            fontFamily: subtitleFontFamily,
            fontSize: subtitleFontSize,
            textColor: subtitleTextColor,
            fontWeight: subtitleFontWeight,
            bgColor: subtitleBgColor,
            bgOpacity: subtitleBgOpacity,
            bgPaddingPct: subtitleBgPaddingPct,
            strokeColor: subtitleStrokeColor,
            strokeWidth: subtitleStrokeWidth,
            x: subtitleX,
            y: subtitleY,
            videoWidth: videoNaturalSize.width,
            videoHeight: videoNaturalSize.height
          }
        })
        if (res.canceled) {
          setExportProgress(0)
          setExportEncoderLine('')
          setShowBurnEncoderUi(false)
          return
        }
        setExportProgress(100)
        void window.api.showExportResultInFolder(res.outputPath)
      } catch (e) {
        setExportProgress(0)
        console.error(formatExportFailureMessage(e))
      } finally {
        videoBurnExportRef.current = false
        setShowBurnEncoderUi(false)
        setIsExporting(false)
        setExportProgressLabel('')
        setExportEncoderLine('')
      }
    })()
  }, [
    cutRanges,
    exportFormat,
    isExporting,
    subtitleBgColor,
    subtitleBgOpacity,
    subtitleBgPaddingPct,
    subtitleFontFamily,
    subtitleFontSize,
    subtitleFontWeight,
    subtitleStrokeColor,
    subtitleStrokeWidth,
    subtitleTextColor,
    subtitleX,
    subtitleY,
    subtitles,
    videoNaturalSize.height,
    videoNaturalSize.width,
    videoPath
  ])

  const buildAutosubProjectJson = useCallback((): string => {
    const payload: AutosubProjectFileV1 = {
      format: AUTOSUB_FILE_FORMAT,
      version: AUTOSUB_VERSION,
      savedAt: new Date().toISOString(),
      videoPath,
      cutRanges,
      subtitleStyle: {
        fontFamily: subtitleFontFamily,
        fontSize: subtitleFontSize,
        textColor: subtitleTextColor,
        fontWeight: subtitleFontWeight,
        bgColor: subtitleBgColor,
        bgOpacity: subtitleBgOpacity,
        bgPaddingPct: subtitleBgPaddingPct,
        strokeColor: subtitleStrokeColor,
        strokeWidth: subtitleStrokeWidth,
        x: subtitleX,
        y: subtitleY
      },
      subtitles: subtitles.map((line) =>
        line.words && line.words.length > 0
          ? {
              start: line.start,
              end: line.end,
              text: line.text,
              words: line.words.map((w) => ({ ...w }))
            }
          : { start: line.start, end: line.end, text: line.text }
      )
    }
    return JSON.stringify(payload, null, 2)
  }, [
    cutRanges,
    subtitleBgColor,
    subtitleBgOpacity,
    subtitleBgPaddingPct,
    subtitleFontFamily,
    subtitleFontSize,
    subtitleFontWeight,
    subtitleStrokeColor,
    subtitleStrokeWidth,
    subtitleTextColor,
    subtitleX,
    subtitleY,
    subtitles,
    videoPath
  ])

  const saveProjectAs = useCallback(async () => {
    const json = buildAutosubProjectJson()
    const defaultPath = projectFilePathRef.current ?? undefined
    try {
      const r = await window.api.saveProjectFileAs(json, defaultPath)
      if (!r.canceled) projectFilePathRef.current = r.path
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }, [buildAutosubProjectJson])

  const saveProject = useCallback(async () => {
    const json = buildAutosubProjectJson()
    if (!projectFilePathRef.current) {
      await saveProjectAs()
      return
    }
    try {
      const res = await window.api.saveProjectFile(projectFilePathRef.current, json)
      if (!res.ok) window.alert(res.reason)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }, [buildAutosubProjectJson, saveProjectAs])

  const applyAutosubPayload = useCallback((projectPath: string | null, parsed: unknown) => {
    const pr = parseAutosubProjectFile(parsed)
    if (!pr.ok) {
      window.alert(pr.reason)
      return false
    }
    const d = pr.data
    projectFilePathRef.current = projectPath
    setVideoPath(d.videoPath)
    setCutRanges(mergeCutRanges(d.cutRanges))
    setSubtitles(d.subtitles)
    undoStackRef.current = []
    redoStackRef.current = []
    const st = d.subtitleStyle
    setSubtitleFontFamily(st.fontFamily)
    setSubtitleFontSize(clampSubtitleFontSize(st.fontSize))
    setSubtitleTextColor(st.textColor)
    setSubtitleFontWeight(st.fontWeight)
    setSubtitleBgColor(st.bgColor)
    setSubtitleBgOpacity(st.bgOpacity)
    setSubtitleBgPaddingPct(clampSubtitleBgPaddingPct(st.bgPaddingPct))
    setSubtitleStrokeColor(st.strokeColor)
    setSubtitleStrokeWidth(st.strokeWidth)
    setSubtitleX(st.x)
    setSubtitleY(clampSubtitleY(st.y))
    setPlayheadSec(0)
    setIsPlaying(false)
    return true
  }, [])

  const openProjectFile = useCallback(async () => {
    try {
      const r = await window.api.openProjectFile()
      if (r.canceled) return
      let parsed: unknown
      try {
        parsed = JSON.parse(r.content)
      } catch {
        window.alert('파일이 올바른 JSON이 아닙니다.')
        return
      }
      applyAutosubPayload(r.path, parsed)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }, [applyAutosubPayload])

  const loadDroppedAutosubFile = useCallback(
    async (file: File) => {
      if (!modelReady || busy || isExtracting) return
      const absPath = filePathFromDrop(file)
      const pathForRef =
        absPath && absPath.toLowerCase().endsWith('.autosub') ? absPath : null
      try {
        const text = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(String(fr.result ?? ''))
          fr.onerror = () => reject(fr.error ?? new Error('파일을 읽지 못했습니다.'))
          fr.readAsText(file)
        })
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          window.alert('파일이 올바른 JSON이 아닙니다.')
          return
        }
        applyAutosubPayload(pathForRef, parsed)
      } catch (e) {
        window.alert(e instanceof Error ? e.message : String(e))
      }
    },
    [applyAutosubPayload, busy, isExtracting, modelReady]
  )

  useEffect(() => {
    const hasFiles = (e: globalThis.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

    const onEnter = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      fileDragDepthRef.current += 1
      if (fileDragDepthRef.current === 1) setFileDragOverlay(true)
    }
    const onLeave = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1)
      if (fileDragDepthRef.current === 0) setFileDragOverlay(false)
    }
    const onOver = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDrop = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
      fileDragDepthRef.current = 0
      setFileDragOverlay(false)
      const files = e.dataTransfer?.files
      if (!files?.length) return
      const list = Array.from(files)
      for (const f of list) {
        const p = filePathFromDrop(f)
        if (isAutosubDrop(f, p)) {
          void loadDroppedAutosubFile(f)
          return
        }
      }
      let absPath: string | null = null
      for (const f of list) {
        const p = filePathFromDrop(f)
        if (p && isVideoFilePath(p)) {
          absPath = p
          break
        }
      }
      if (!absPath) return
      processDroppedVideoPath(absPath)
    }

    document.addEventListener('dragenter', onEnter, true)
    document.addEventListener('dragleave', onLeave, true)
    document.addEventListener('dragover', onOver, true)
    document.addEventListener('drop', onDrop, true)
    return () => {
      document.removeEventListener('dragenter', onEnter, true)
      document.removeEventListener('dragleave', onLeave, true)
      document.removeEventListener('dragover', onOver, true)
      document.removeEventListener('drop', onDrop, true)
    }
  }, [loadDroppedAutosubFile, processDroppedVideoPath])

  const previewMediaClass = [
    'preview-drop',
    videoPath ? 'preview-drop--filled' : '',
    busy || !modelReady ? 'video-drop--disabled' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const showGpuRuntimeControls = gpuRuntimeStatus.nvidiaPresent && !gpuRuntimeStatus.installed
  const previewSubtitleOverlayStyle = useMemo(() => {
    if (videoContentBox.width <= 0 || videoContentBox.height <= 0) return undefined
    return {
      left: `${videoContentBox.left}px`,
      top: `${videoContentBox.top}px`,
      width: `${videoContentBox.width}px`,
      height: `${videoContentBox.height}px`
    }
  }, [videoContentBox])
  const subtitleMaxWidthPx = useMemo(() => {
    if (videoNaturalSize.width <= 0) return 0
    return Math.floor(videoNaturalSize.width * 0.9)
  }, [videoNaturalSize.width])
  const previewSubtitleInnerStyle = useMemo(() => {
    if (videoContentBox.width <= 0 || videoContentBox.height <= 0) return undefined
    const baseW = Math.max(1, videoNaturalSize.width)
    const baseH = Math.max(1, videoNaturalSize.height)
    return {
      width: `${baseW}px`,
      height: `${baseH}px`,
      transform: `scale(${videoContentBox.width / baseW}, ${videoContentBox.height / baseH})`,
      transformOrigin: 'top left'
    }
  }, [videoContentBox.height, videoContentBox.width, videoNaturalSize.height, videoNaturalSize.width])
  const previewSubtitleTextStyle = useMemo(() => {
    const { r, g, b } = hexToRgb(subtitleBgColor)
    const shadow = Math.max(0, Math.min(6, subtitleStrokeWidth))
    const chrome = getSubtitleBoxChromeInline(subtitleFontSize, subtitleBgPaddingPct)
    return {
      left: `${subtitleX}%`,
      bottom: `${subtitleY}%`,
      transform: 'translateX(-50%)',
      position: 'absolute',
      display: 'inline-block',
      ...chrome,
      textAlign: 'center',
      width: 'max-content',
      maxWidth: subtitleMaxWidthPx > 0 ? `${subtitleMaxWidthPx}px` : '90%',
      background: `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, subtitleBgOpacity / 100))})`,
      fontFamily: subtitleFontFamily,
      fontSize: `${subtitleFontSize}px`,
      fontWeight: subtitleFontWeight,
      color: subtitleTextColor,
      whiteSpace: 'normal',
      wordBreak: 'keep-all',
      overflowWrap: 'normal',
      textShadow: `-${shadow}px 0 ${subtitleStrokeColor}, 0 ${shadow}px ${subtitleStrokeColor}, ${shadow}px 0 ${subtitleStrokeColor}, 0 -${shadow}px ${subtitleStrokeColor}, 0 2px 8px rgba(0,0,0,0.8)`
    }
  }, [
    subtitleBgColor,
    subtitleBgOpacity,
    subtitleBgPaddingPct,
    subtitleFontFamily,
    subtitleFontSize,
    subtitleFontWeight,
    subtitleMaxWidthPx,
    subtitleStrokeColor,
    subtitleStrokeWidth,
    subtitleTextColor,
    subtitleX,
    subtitleY
  ])
  useEffect(() => {
    window.localStorage.setItem('autosubtitle:split-preview-width-pct', String(previewWidthPct))
  }, [previewWidthPct])
  useEffect(() => {
    const payload = {
      subtitleFontFamily,
      subtitleFontSize,
      subtitleTextColor,
      subtitleFontWeight,
      subtitleBgColor,
      subtitleBgOpacity,
      subtitleBgPaddingPct,
      subtitleStrokeColor,
      subtitleStrokeWidth,
      subtitleX,
      subtitleY
    }
    window.localStorage.setItem(SUBTITLE_STYLE_STORAGE_KEY, JSON.stringify(payload))
  }, [
    subtitleBgColor,
    subtitleBgOpacity,
    subtitleBgPaddingPct,
    subtitleFontFamily,
    subtitleFontSize,
    subtitleFontWeight,
    subtitleStrokeColor,
    subtitleStrokeWidth,
    subtitleTextColor,
    subtitleX,
    subtitleY
  ])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const win = window as unknown as {
        queryLocalFonts?: () => Promise<Array<{ family?: string }>>
      }
      if (!win.queryLocalFonts) return
      try {
        const localFonts = await win.queryLocalFonts()
        if (cancelled) return
        const set = new Set<string>(SUBTITLE_FONT_PRESETS)
        for (const f of localFonts) {
          const family = (f.family ?? '').trim()
          if (family) set.add(family)
        }
        const merged = Array.from(set).sort((a, b) => a.localeCompare(b))
        setAvailableFonts(merged)
      } catch {
        /* local font enumeration may be blocked */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const updateVideoContentBox = () => {
      const stack = previewStackRef.current
      const video = videoRef.current
      if (!stack || !video) return
      const cw = stack.clientWidth
      const ch = stack.clientHeight
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (cw <= 0 || ch <= 0) return
      if (vw <= 0 || vh <= 0) {
        setVideoContentBox({ left: 0, top: 0, width: cw, height: ch })
        return
      }
      const scale = Math.min(cw / vw, ch / vh)
      const rw = vw * scale
      const rh = vh * scale
      setVideoContentBox({
        left: (cw - rw) / 2,
        top: (ch - rh) / 2,
        width: rw,
        height: rh
      })
    }
    updateVideoContentBox()
    const ro = new ResizeObserver(updateVideoContentBox)
    if (previewStackRef.current) ro.observe(previewStackRef.current)
    window.addEventListener('resize', updateVideoContentBox)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', updateVideoContentBox)
    }
  }, [previewWidthPct, videoPath])

  const startSplitResize = useCallback((e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const onMove = (ev: globalThis.MouseEvent) => {
      const next = (ev.clientX / window.innerWidth) * 100
      const clamped = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, next))
      setPreviewWidthPct(clamped)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const projectFileUiDisabled = !modelReady || busy || isExtracting

  return (
    <div className="app">
      <div className={`main-workspace ${modelReady ? 'main-workspace--active' : 'main-workspace--inactive'}`}>
        <header className="app-topbar">
          <h1 className="app-title">AutoSubtitle</h1>
          <div className="app-topbar-actions">
            <div className="app-topbar-project-actions">
              <button
                type="button"
                className="app-topbar-gpu-btn preview-project-btn"
                disabled={projectFileUiDisabled}
                onClick={openProjectFile}
                title={
                  !modelReady
                    ? '엔진 준비 후 사용할 수 있습니다.'
                    : '저장된 .autosub 프로젝트 열기 (창에 .autosub 파일을 끌어다 놓을 수도 있습니다)'
                }
              >
                불러오기
              </button>
              <button
                type="button"
                className="app-topbar-gpu-btn preview-project-btn"
                disabled={projectFileUiDisabled}
                onClick={saveProjectAs}
                title="새 파일 이름으로 .autosub 저장"
              >
                다른 이름으로 저장
              </button>
              <button
                type="button"
                className="app-topbar-gpu-btn preview-project-btn"
                disabled={projectFileUiDisabled}
                onClick={saveProject}
                title="한 번이라도 저장했거나 .autosub를 연 상태면 탐색기 없이 같은 파일에 덮어씁니다. 처음 저장할 때만 탐색기가 열립니다. 다른 위치·파일 이름은 「다른 이름으로 저장」을 사용하세요."
              >
                저장
              </button>
            </div>
            {showGpuRuntimeControls ? (
              <button
                type="button"
                className="app-topbar-gpu-btn"
                disabled={busy || !gpuRuntimeStatus.canInstall}
                onClick={installGpuRuntimeManually}
                title={!gpuRuntimeStatus.canInstall ? 'GPU 런타임 소스가 없어 설치할 수 없습니다.' : undefined}
              >
                GPU 런타임 설치
              </button>
            ) : null}
          </div>
        </header>

        <div className="preview-subtitle-controls-bar">
          <div className="preview-subtitle-controls">
            <div className="preview-subtitle-controls-rows">
              <div className="preview-subtitle-controls-line">
                <label className="preview-subtitle-control-row preview-subtitle-control-row--font">
                  <span>폰트</span>
                  <select
                    className="preview-subtitle-font-input"
                    value={subtitleFontFamily}
                    onChange={(e) => setSubtitleFontFamily(e.target.value)}
                  >
                    {recentFonts.length > 0 ? (
                      <optgroup label="최근 사용">
                        {recentFonts.map((f) => (
                          <option key={`recent-${f}`} value={f}>
                            {f}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    <optgroup label="전체 폰트">
                      {availableFonts.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <strong />
                </label>
                <label className="preview-subtitle-control-row">
                  <span>글자 크기</span>
                  <input
                    type="range"
                    min={SUBTITLE_FONT_SIZE_MIN}
                    max={SUBTITLE_FONT_SIZE_MAX}
                    step={1}
                    value={subtitleFontSize}
                    onChange={(e) => setSubtitleFontSize(clampSubtitleFontSize(Number(e.target.value)))}
                  />
                  <strong>{subtitleFontSize}px</strong>
                </label>
                <label className="preview-subtitle-control-row">
                  <span>글자 색상</span>
                  <div className="preview-subtitle-control-main">
                    <input type="color" value={subtitleTextColor} onChange={(e) => setSubtitleTextColor(e.target.value)} />
                    <input
                      type="range"
                      min={400}
                      max={900}
                      step={100}
                      value={subtitleFontWeight}
                      onChange={(e) => setSubtitleFontWeight(Number(e.target.value))}
                    />
                  </div>
                  <strong>{subtitleFontWeight}</strong>
                </label>
                <label className="preview-subtitle-control-row">
                  <span>외곽선</span>
                  <div className="preview-subtitle-control-main">
                    <input
                      type="color"
                      value={subtitleStrokeColor}
                      onChange={(e) => setSubtitleStrokeColor(e.target.value)}
                    />
                    <input
                      type="range"
                      min={0}
                      max={6}
                      step={1}
                      value={subtitleStrokeWidth}
                      onChange={(e) => setSubtitleStrokeWidth(Number(e.target.value))}
                    />
                  </div>
                  <strong>{subtitleStrokeWidth}px</strong>
                </label>
              </div>
              <div className="preview-subtitle-controls-line">
                <label className="preview-subtitle-control-row">
                  <span>배경 색상</span>
                  <div className="preview-subtitle-control-main">
                    <input type="color" value={subtitleBgColor} onChange={(e) => setSubtitleBgColor(e.target.value)} />
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={subtitleBgOpacity}
                      onChange={(e) => setSubtitleBgOpacity(Number(e.target.value))}
                    />
                  </div>
                  <strong>{subtitleBgOpacity}%</strong>
                </label>
                <label className="preview-subtitle-control-row">
                  <span>배경 크기</span>
                  <input
                    type="range"
                    min={SUBTITLE_BG_PADDING_PCT_MIN}
                    max={SUBTITLE_BG_PADDING_PCT_MAX}
                    step={1}
                    value={subtitleBgPaddingPct}
                    onChange={(e) => setSubtitleBgPaddingPct(clampSubtitleBgPaddingPct(Number(e.target.value)))}
                    title="배경 박스 안쪽 여백 — 낮을수록 글자에 붙고, 높을수록 여유가 커집니다."
                  />
                  <strong>{subtitleBgPaddingPct}%</strong>
                </label>
                <label className="preview-subtitle-control-row">
                  <span>좌우 위치</span>
                  <input type="range" min={5} max={95} step={1} value={subtitleX} onChange={(e) => setSubtitleX(Number(e.target.value))} />
                  <strong>{subtitleX}%</strong>
                </label>
                <label className="preview-subtitle-control-row">
                  <span>상하 위치</span>
                  <input
                    type="range"
                    min={SUBTITLE_Y_MIN}
                    max={SUBTITLE_Y_MAX}
                    step={1}
                    value={subtitleY}
                    onChange={(e) => setSubtitleY(clampSubtitleY(Number(e.target.value)))}
                    title="아래(0%) ~ 위(높은 %). 화면 하단에서 자막 박스 하단까지의 거리(%)"
                  />
                  <strong>{subtitleY}%</strong>
                </label>
              </div>
            </div>
            <div className="preview-subtitle-export-actions">
                <select
                  className="preview-export-format"
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
                  title="내보내기 형식"
                  disabled={!videoPath || subtitles.length === 0 || isExporting || isExtracting}
                >
                  {EXPORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="app-topbar-gpu-btn preview-export-btn"
                  disabled={!videoPath || subtitles.length === 0 || isExporting || isExtracting}
                  onClick={exportVideo}
                  title={!videoPath || subtitles.length === 0 ? '영상과 자막이 있어야 내보낼 수 있습니다.' : undefined}
                >
                  {isExporting ? '내보내는 중...' : '내보내기'}
                </button>
            </div>
          </div>
        </div>

        <div className="layout-split">
          <section className="split-preview" aria-label="영상 미리보기" style={{ width: `${previewWidthPct}%` }}>
            {videoPath ? (
              <>
                <div className={previewMediaClass}>
                  <div className="preview-video-stack" ref={previewStackRef}>
                    <video
                      ref={videoRef}
                      key={videoPath}
                      className="preview-video"
                      preload="metadata"
                      playsInline
                      src={window.api.getMediaFileUrl(videoPath)}
                      title={videoPath}
                      onTimeUpdate={syncFromVideo}
                      onLoadedMetadata={() => {
                        syncFromVideo()
                        const stack = previewStackRef.current
                        const video = videoRef.current
                        if (!stack || !video) return
                        const cw = stack.clientWidth
                        const ch = stack.clientHeight
                        const vw = video.videoWidth
                        const vh = video.videoHeight
                        if (cw <= 0 || ch <= 0 || vw <= 0 || vh <= 0) return
                        setVideoNaturalSize({ width: vw, height: vh })
                        const scale = Math.min(cw / vw, ch / vh)
                        const rw = vw * scale
                        const rh = vh * scale
                        setVideoContentBox({
                          left: (cw - rw) / 2,
                          top: (ch - rh) / 2,
                          width: rw,
                          height: rh
                        })
                      }}
                      onDurationChange={syncFromVideo}
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                      onEnded={() => setIsPlaying(false)}
                      onClick={() => togglePlay()}
                      onError={(e) => {
                        console.error(
                          'video 재생 실패:',
                          e.currentTarget.currentSrc || '(empty)',
                          videoPath
                        )
                      }}
                    >
                      video를 재생할 수 없습니다.
                    </video>
                    <div className="preview-subtitle-overlay" aria-live="polite" style={previewSubtitleOverlayStyle}>
                      <div style={previewSubtitleInnerStyle}>
                        <div className="preview-subtitle-stage">
                          {activeSubtitleIndex !== null && subtitles[activeSubtitleIndex] ? (
                            <p key={activeSubtitleIndex} className="preview-subtitle-text" style={previewSubtitleTextStyle}>
                              {subtitles[activeSubtitleIndex].text}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="preview-controls preview-controls--outside" role="group" aria-label="재생 컨트롤">
                  <button
                    type="button"
                    className="preview-play-btn"
                    onClick={togglePlay}
                    aria-label={isPlaying ? '일시정지' : '재생'}
                  >
                    {isPlaying ? (
                      <svg className="preview-play-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden>
                        <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
                        <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
                      </svg>
                    ) : (
                      <svg className="preview-play-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden>
                        <path d="M9 6.5v11L18 12 9 6.5Z" fill="currentColor" />
                      </svg>
                    )}
                  </button>
                  <span className="preview-time preview-time--current">{formatClock(playheadSec)}</span>
                  <input
                    type="range"
                    className="preview-seek"
                    aria-label="재생 위치"
                    min={0}
                    max={Math.max(durationSec, 0.001)}
                    step={0.01}
                    value={durationSec > 0 ? Math.min(playheadSec, durationSec) : 0}
                    onChange={onSeekChange}
                    onInput={(e) => applySeekValue((e.target as HTMLInputElement).value)}
                  />
                  <span className="preview-time preview-time--total">{formatClock(durationSec)}</span>
                </div>
              </>
            ) : (
              <div className={previewMediaClass}>
                <div className="preview-drop-inner">
                  <p className="video-drop-hint">
                    영상 파일을 여기에 끌어다 놓으세요
                    <span className="video-drop-formats"> ({VIDEO_EXTENSIONS.join(', ')})</span>
                  </p>
                </div>
              </div>
            )}
          </section>

          <div
            className="split-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="패널 너비 조절"
            onMouseDown={startSplitResize}
          />

          <aside className="split-subtitles" aria-label="자막 편집" style={{ width: `${100 - previewWidthPct}%` }}>
            <div className="subtitle-panel">
              <header className="subtitle-panel-head">
                <h2 className="subtitle-panel-title">자막</h2>
                <p className="subtitle-panel-sub">
                  <strong>Enter</strong> 자막 분할 · <strong>Shift+Enter</strong> 줄바꿈 · 빈 칸에서{' '}
                  <strong>Backspace</strong> 이전과 병합 · <strong>Tab</strong> / <strong>Shift+Tab</strong> 다른
                  줄로 이동
                </p>
              </header>
              <div className="subtitle-panel-body">
                {subtitles.length === 0 ? (
                  <div className="subtitle-empty-placeholder" aria-live="polite">
                    <p className="subtitle-empty-hint-text">
                      아직 자막이 없습니다. 왼쪽 패널에서 <strong>자막 생성</strong>을 눌러 Faster-Whisper 인식을
                      실행하세요.
                    </p>
                  </div>
                ) : (
                  <SubtitleDataProvider subtitles={subtitles}>
                    <SubtitleVirtualList
                      subtitles={subtitles}
                      activeSubtitleIndex={activeSubtitleIndex}
                      playheadSec={playheadSec}
                      isPlaying={isPlaying}
                      onSubtitleCardClick={onSubtitleCardClick}
                      onCardNavigate={seekToSubtitleStart}
                      onRequestPausePlayback={pausePlayback}
                      onWordBlockClick={seekToSubtitleStart}
                      onWaveformSeekAndPlay={seekAndPlayTo}
                      splitSubtitleAtWord={splitSubtitleAtWord}
                      backspaceWordAt={backspaceWordAt}
                      deleteWordAt={deleteWordAt}
                      deleteWordRangeAt={deleteWordRangeAt}
                      onDeleteAudioRange={registerDeletedAudioRange}
                      onUndo={undoSubtitleChange}
                      onRedo={redoSubtitleChange}
                      updateSubtitleAt={updateSubtitleAt}
                      splitSubtitleAt={splitSubtitleAt}
                      mergeEmptySubtitleAt={mergeEmptySubtitleAt}
                      formatTimecode={formatTimecode}
                      onTogglePlayback={togglePlay}
                    />
                  </SubtitleDataProvider>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>

      {!modelReady && !engineOverlayOpen ? (
        <div className="engine-gate" role="region" aria-label="필수 엔진 준비">
          <div className="engine-gate-card">
            <p className="engine-gate-title">
              프로그램 실행에 필요한 필수 엔진(FFmpeg 및 AI 모델)을 다운로드하시겠습니까?
            </p>
            <p className="engine-gate-desc">
              FFmpeg는 영상·음성 처리에, AI 모델은 음성 인식에 사용됩니다. 한 번만 받으면 이후 실행에서
              재사용됩니다.
            </p>
            {showGpuRuntimeControls ? (
              <>
                <label className="engine-gate-gpu-opt">
                  <input
                    type="checkbox"
                    checked={useGpuRuntimeInstall}
                    disabled={busy}
                    onChange={(e) => setUseGpuRuntimeInstall(e.target.checked)}
                  />
                  <span>GPU 가속 런타임 별도 설치 (선택)</span>
                </label>
                {!gpuRuntimeStatus.canInstall ? (
                  <p className="engine-gate-gpu-hint">GPU 패키지 소스를 찾지 못했습니다. 현재는 CPU 모드로 설치됩니다.</p>
                ) : null}
              </>
            ) : null}
            <button type="button" className="engine-gate-cta" disabled={busy} onClick={startEngineDownload}>
              모델 다운로드 및 최적화 시작
            </button>
          </div>
        </div>
      ) : null}

      {fileDragOverlay ? (
        <div className="file-drag-overlay" aria-hidden>
          <p className="file-drag-overlay-text">영상 또는 .autosub 프로젝트를 놓아주세요</p>
        </div>
      ) : null}

      {isExtracting ? (
        <div className="extract-modal-backdrop" role="presentation">
          <div
            className="extract-modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="extract-modal-title"
          >
            <h2 id="extract-modal-title" className="extract-modal-title">
              {transcribeMode === 'gpu'
                ? 'GPU모드로 자막을 추출하고 있습니다...'
                : 'CPU모드로 자막을 추출하고 있습니다...'}
            </h2>
            <div
              className="extract-progress-track"
              role="progressbar"
              aria-valuenow={Math.round(progress)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="extract-progress-fill" style={{ width: `${Math.min(100, progress)}%` }} />
            </div>
            <p className="extract-modal-pct">{Math.round(progress)}%</p>
          </div>
        </div>
      ) : null}

      {isExporting ? (
        <div className="extract-modal-backdrop" role="presentation">
          <div
            className="extract-modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-modal-title"
          >
            <h2 id="export-modal-title" className="extract-modal-title">
              {exportProgressLabel || '내보내기 중입니다...'}
            </h2>
            <div
              className="extract-progress-track"
              role="progressbar"
              aria-valuenow={Math.round(exportProgress)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="extract-progress-fill" style={{ width: `${Math.min(100, exportProgress)}%` }} />
            </div>
            <p className="extract-modal-pct">{Math.round(exportProgress)}%</p>
            {showBurnEncoderUi && exportEncoderLine ? (
              <p className="extract-modal-encoder">{exportEncoderLine}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {engineOverlayOpen ? (
        <div className="engine-overlay" role="presentation">
          <div
            className="engine-overlay-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="engine-overlay-title"
          >
            <h2 id="engine-overlay-title" className="engine-overlay-heading">
              필수 엔진 설치 (FFmpeg + AI 모델)
            </h2>

            {overlayPhase === 'error' ? (
              <>
                <p className="engine-overlay-error">설정 중 문제가 발생했습니다. 로그를 확인한 뒤 다시 시도해 주세요.</p>
                <button type="button" className="engine-overlay-close" onClick={closeOverlayAfterError}>
                  닫기
                </button>
              </>
            ) : overlayPhase === 'success' ? (
              <>
                <p className="engine-overlay-steps engine-overlay-steps--done">
                  <span className="engine-step done">다운로드</span>
                  <span className="engine-step-arrow">→</span>
                  <span className="engine-step done">최적화</span>
                  <span className="engine-step-arrow">→</span>
                  <span className="engine-step done">준비 완료</span>
                </p>
                <p className="engine-overlay-success">이제 자막 생성이 가능합니다!</p>
              </>
            ) : (
              <>
                <p className="engine-overlay-steps">
                  <span className={`engine-step ${downloadPct > 0 ? 'active' : ''} ${downloadPct >= 88 ? 'done' : ''}`}>
                    다운로드 (FFmpeg + 모델)
                    {downloadPct < 88 ? ` — ${Math.round(downloadPct)}%` : ''}
                  </span>
                  <span className="engine-step-arrow">→</span>
                  <span
                    className={`engine-step ${downloadPct >= 88 && downloadPct < 99.5 ? 'active' : ''} ${downloadPct >= 99.5 ? 'done' : ''}`}
                  >
                    최적화 중
                  </span>
                  <span className="engine-step-arrow">→</span>
                  <span className={`engine-step ${downloadPct >= 99.5 ? 'active done' : ''}`}>준비 완료</span>
                </p>
                {overlayStepLabel === '다운로드' ? (
                  <div className="engine-overlay-bar" role="progressbar" aria-valuenow={Math.round(downloadPct)} aria-valuemin={0} aria-valuemax={100}>
                    <div className="engine-overlay-fill" style={{ width: `${Math.min(100, downloadPct)}%` }} />
                  </div>
                ) : (
                  <div className="engine-overlay-spinner-wrap">
                    <div className="engine-overlay-spinner" />
                    <span className="engine-overlay-spinner-label">{overlayStepLabel}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
