import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent, type CSSProperties, type ReactElement } from 'react'
import type { JsonWaveformData } from 'peaks.js'

import type { CutRange, DepsStatus, ExportFormat, GpuRuntimeStatus, TranscribeMode } from '../../shared/ipc'
import type { SubtitleLine, SubtitleWord } from '../../shared/subtitles'
import {
  AUTOSUB_FILE_FORMAT,
  AUTOSUB_VERSION,
  type AutosubProjectFileV1,
  parseAutosubProjectFile
} from '../../shared/autosubProject'
import { removeSilenceWordsFromSubtitleLines } from '../../shared/phase5EditPolicy'
import { SILENCE_PLACEHOLDER_TEXT } from '../../shared/wordContract'
import { parseSubtitleLines } from '../../shared/subtitles'
import { getSubtitleBoxChromeInline } from '../../shared/subtitleBoxChrome'
import { mergeEmptySubtitleWithPrevious, splitSubtitleLine } from './subtitleEditOps'
import { SubtitleVirtualList } from './SubtitleVirtualList'
import { SubtitleDataProvider } from './subtitleDataContext'
import {
  SubtitleWaveformPeaks,
  type PeaksZoomViewRange,
  type SubtitleWaveformPeaksHandle
} from './SubtitleWaveformPeaks'
import type { SubtitleRow } from './components/vrewPeaksEditor/types'
import { subtitleLinesToVrewRows, vrewRowsToSubtitleLines } from './vrewSubtitleAdapter'
import { applyTimeRangeCutToVrewRows } from './waveformCutSync'
import {
  mergeCutRanges,
  mediaToEditTime,
  editToMediaTime,
  peaksEditRangeToMediaCut,
  snapTimelineSec
} from '../../shared/timelineCollapse'
import { replayMediaCutsOnDecodedBuffer, spliceAudioBuffer } from './spliceAudioBuffer'
import { timelineEditLog } from './timelineEditLog'

type OverlayPhase = 'working' | 'success' | 'error'

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'avi'] as const

/** `python_sidecar/main.py` 의 `_PEAKS_MAX_SAMPLES_PER_PIXEL_STALE` 와 맞출 것 */
const PEAKS_JSON_MAX_SAMPLES_PER_PIXEL = 128

/** 구버전 전용: 영상 옆 `{stem}.autosub-peaks.json` — 글로벌 캐시 miss 시 한 번만 읽기 */
function legacyPeaksJsonBesideMedia(absoluteMediaPath: string): string {
  const t = absoluteMediaPath.trim()
  const d = t.lastIndexOf('.')
  const base = d > 0 ? t.slice(0, d) : t
  return `${base}.autosub-peaks.json`
}
const RELEASES_PAGE_URL = 'https://github.com/infohelpful/1.-AutoSubtitle/releases'
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
  const validWords = words.filter(
    (w) =>
      !w.isSilence &&
      w.word !== '??' &&
      w.word !== '-' &&
      w.word.trim() !== SILENCE_PLACEHOLDER_TEXT
  )
  if (validWords.length === 0) return ''
  return validWords.map((w) => w.word).join(' ').trim()
}

type SilenceWorkerRequest = {
  lines: SubtitleLine[]
  waveformData: number[]
  sampleRate: number
}

type SilenceWorkerResponse = {
  lines: SubtitleLine[]
  stats?: {
    avgAmp: number
    threshold: number
    splitWordCount: number
    createdSilenceBlocks: number
    scannedWordCount: number
    longWordCount: number
  }
}

function extractWaveformPayload(
  peaks: JsonWaveformData | null,
  lines: SubtitleLine[]
): { waveformData: number[]; sampleRate: number } | null {
  if (!peaks) return null
  const raw = peaks as unknown as {
    data?: unknown
    channels?: Array<{ data?: unknown }>
  }
  const fromRoot = Array.isArray(raw.data) ? raw.data : null
  const fromChannel = Array.isArray(raw.channels) && Array.isArray(raw.channels[0]?.data) ? raw.channels[0].data : null
  const source = (fromRoot ?? fromChannel) as unknown[] | null
  if (!source || source.length === 0) return null

  const waveformData: number[] = []
  for (const v of source) {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) continue
    waveformData.push(Math.abs(n))
  }
  if (waveformData.length === 0) return null

  const maxSubtitleEndSec = lines.reduce((m, line) => {
    const words = line.words ?? []
    if (words.length > 0) {
      const wordMax = words.reduce((wm, w) => Math.max(wm, w.end), 0)
      return Math.max(m, wordMax)
    }
    return Math.max(m, line.end)
  }, 0)
  if (!(maxSubtitleEndSec > 0)) return null

  const sampleRate = waveformData.length / maxSubtitleEndSec
  if (!Number.isFinite(sampleRate) || sampleRate <= 1) return null
  return { waveformData, sampleRate }
}

function normalizeWorkerLines(lines: SubtitleLine[]): SubtitleLine[] {
  return lines.map((line) => {
    const words: SubtitleWord[] = (line.words ?? [])
      .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
      .map((w) => ({
        start: w.start,
        end: w.end,
        word: w.isSilence ? SILENCE_PLACEHOLDER_TEXT : w.word,
        ...(w.isSilence ? ({ isSilence: true } as const) : {})
      }))
    return {
      ...line,
      words,
      text: textFromWords(words, line.text ?? '')
    }
  })
}

/** 삭제 구간 끝에 정확히 맞추면 디코더가 같은 키프레임에 걸려 멈추는 경우가 있어 살짝 건너뜀 */
const SKIP_CUT_TAIL_SEC = 2e-4

function skipCutRangeAt(timeSec: number, ranges: CutRange[]): number {
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

function subtitleLinesMeaningfullyChanged(next: SubtitleLine[], prev: SubtitleLine[]): boolean {
  if (next.length !== prev.length) return true
  for (let i = 0; i < next.length; i += 1) {
    const n = next[i]
    const p = prev[i]
    if (n.start !== p.start || n.end !== p.end || n.text !== p.text) return true
    const nw = n.words ?? []
    const pw = p.words ?? []
    if (nw.length !== pw.length) return true
    if (nw.length === 0) continue
    for (let j = 0; j < nw.length; j += 1) {
      const a = nw[j]
      const b = pw[j]
      if (a.start !== b.start || a.end !== b.end || a.word !== b.word) return true
      if (Boolean(a.isSilence) !== Boolean(b.isSilence)) return true
    }
  }
  return false
}

export default function App(): ReactElement {
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
  /** 미리보기(영상) 폭 % — 낮을수록 자막·파형 패널이 넓어져 단어 행 가로 스크롤이 줄어듦 */
  const SPLIT_MIN = 35
  const SPLIT_MAX = 65
  const [previewWidthPct, setPreviewWidthPct] = useState(() => {
    const raw = window.localStorage.getItem('autosubtitle:split-preview-width-pct')
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return 50
    return Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, parsed))
  })
  const [busy, setBusy] = useState(false)
  const [videoPath, setVideoPath] = useState<string | null>(null)
  const [modelReady, setModelReady] = useState(false)
  /** 초기 IPC로 FFmpeg·모델 존재 여부를 확인한 뒤에만 엔진 게이트 표시(미확인 시 깜빡임 방지) */
  const [depsResolved, setDepsResolved] = useState(false)
  const [downloadPct, setDownloadPct] = useState(0)

  const [engineOverlayOpen, setEngineOverlayOpen] = useState(false)
  const [overlayPhase, setOverlayPhase] = useState<OverlayPhase>('working')
  const [gpuRuntimeStatus, setGpuRuntimeStatus] = useState<GpuRuntimeStatus>({
    installed: false,
    canInstall: false,
    nvidiaPresent: false,
    urlConfigured: false,
    localCandidate: false,
    dllDir: ''
  })
  const [gpuInstallBanner, setGpuInstallBanner] = useState<string | null>(null)
  type PostEngineDialogState =
    | { kind: 'none' }
    | { kind: 'cpuNotice' }
    | { kind: 'gpuOffer' }
    | { kind: 'gpuInstall'; pct: number; stage: string }
    | { kind: 'gpuFail'; dllDir: string }
  const [postEngineDialog, setPostEngineDialog] = useState<PostEngineDialogState>({ kind: 'none' })
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 엔진 미준비·설치 중(busy)에 드롭한 영상 — 준비되면 곧바로 추출 */
  const pendingAutoTranscribeRef = useRef<string | null>(null)
  const fileDragDepthRef = useRef(0)
  const [fileDragOverlay, setFileDragOverlay] = useState(false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const previewStackRef = useRef<HTMLDivElement | null>(null)
  const rafPlayheadRef = useRef<number | null>(null)
  const [playheadSec, setPlayheadSec] = useState(0)
  const [durationSec, setDurationSec] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [cutRanges, setCutRanges] = useState<CutRange[]>([])
  const cutRangesRef = useRef<CutRange[]>([])
  useEffect(() => {
    cutRangesRef.current = cutRanges
  }, [cutRanges])

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
  const [silenceSplitPending, setSilenceSplitPending] = useState(false)
  const silenceSplitRunKeyRef = useRef<string | null>(null)
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
  /** false면 subtitleLinesToVrewRows 가 단어 간 gap-fill(무음 더미)을 넣지 않음 — 편집 후 타임라인 덮어쓰기 방지 */
  const [gapFillWhenBuildingVrew, setGapFillWhenBuildingVrew] = useState(true)

  const activeSubtitleIndex = useMemo(
    () => pickActiveSubtitleIndex(subtitles, mediaToEditTime(playheadSec, cutRanges)),
    [subtitles, playheadSec, cutRanges]
  )

  const seekToSubtitleStart = useCallback(
    (startSec: number) => {
      const el = videoRef.current
      if (!el || !videoPath) return
      let t = Math.max(0, editToMediaTime(startSec, cutRanges))
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
      let t = Math.max(0, editToMediaTime(startSec, cutRanges))
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
    const s = snapTimelineSec(Math.max(0, Math.min(startSec, endSec)))
    const e = snapTimelineSec(Math.max(0, Math.max(startSec, endSec)))
    if (!(e > s + 0.001)) {
      timelineEditLog('word-delete', 'registerDeletedAudioRange 스킵 — 구간 너무 짧음', { s, e })
      return
    }
    setCutRanges((prev) => {
      const mapped = peaksEditRangeToMediaCut(s, e, prev)
      if (!mapped) {
        timelineEditLog('word-delete', 'registerDeletedAudioRange — peaks→media 맵 실패', {
          s,
          e,
          prevCuts: prev
        })
        return prev
      }
      const next = mergeCutRanges([...prev, mapped])
      timelineEditLog('word-delete', 'registerDeletedAudioRange — cutRanges 반영', {
        inputSec: { start: s, end: e },
        mediaSec: mapped,
        mergedCount: next.length
      })
      return next
    })
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
        const changed = subtitleLinesMeaningfullyChanged(next, prev)
        if (!changed) return prev
        undoStackRef.current.push(prev)
        if (undoStackRef.current.length > 100) undoStackRef.current.shift()
        redoStackRef.current = []
        return next
      })
    },
    []
  )

  const waveformMediaUrl = useMemo(
    () => (videoPath ? window.api.getMediaFileUrl(videoPath) : undefined),
    [videoPath]
  )

  /** Peaks 파형용 — 파일 단 한 번 디코딩(폴백). 사전 피크 JSON이 있으면 사용하지 않음 */
  const [waveformPrefetchedBuffer, setWaveformPrefetchedBuffer] = useState<AudioBuffer | null>(null)
  /** Peaks 사전 피크 JSON 절대 경로 — `userData/WaveformCache` 또는 레거시(영상 옆) */
  const [waveformPeaksJsonPath, setWaveformPeaksJsonPath] = useState<string | null>(null)
  /** 메인 IPC로 읽은 JSON — `waveformData` 직접 주입 시 file:// XHR 없음(더블클릭 체감 지연 감소) */
  const [waveformPeaksJsonData, setWaveformPeaksJsonData] = useState<JsonWaveformData | null>(null)

  const waveformPeaksFileUrl = useMemo(
    () => (waveformPeaksJsonPath ? window.api.getMediaFileUrl(waveformPeaksJsonPath) : null),
    [waveformPeaksJsonPath]
  )

  useEffect(() => {
    if (!videoPath) {
      setWaveformPrefetchedBuffer(null)
      setWaveformPeaksJsonPath(null)
      setWaveformPeaksJsonData(null)
      silenceSplitRunKeyRef.current = null
      setSilenceSplitPending(false)
      return
    }
    setWaveformPrefetchedBuffer(null)
    setWaveformPeaksJsonPath(null)
    setWaveformPeaksJsonData(null)
    let cancelled = false
    void (async () => {
      const cacheRes = await window.api.getWaveformPeaksCachePath(videoPath)
      const cachePath = cacheRes.ok ? cacheRes.cachePath : null
      const legacyPath = legacyPeaksJsonBesideMedia(videoPath)
      let peaksJsonLoaded = false

      const readPeaksJsonUsable = async (
        absPath: string
      ): Promise<{ ok: true; json: JsonWaveformData } | { ok: false; coarse: boolean }> => {
        try {
          const disk = await window.api.readLocalPeaksJsonFile(absPath)
          if (!disk.ok) return { ok: false, coarse: false }
          const j = disk.json as JsonWaveformData
          const spp = typeof j.samples_per_pixel === 'number' ? j.samples_per_pixel : Number.NaN
          const tooCoarse = Number.isFinite(spp) && spp > PEAKS_JSON_MAX_SAMPLES_PER_PIXEL
          if (tooCoarse) return { ok: false, coarse: true }
          return { ok: true, json: j }
        } catch {
          return { ok: false, coarse: false }
        }
      }

      if (cachePath) {
        const disk = await readPeaksJsonUsable(cachePath)
        if (cancelled) return
        if (disk.ok) {
          setWaveformPeaksJsonPath(cachePath)
          setWaveformPeaksJsonData(disk.json)
          peaksJsonLoaded = true
          void window.api
            .logWaveformDebug(
              'waveform',
              'WaveformCache 로드 — 피크 JSON + CUT용 오디오 버퍼 디코딩 진행',
              cachePath
            )
            .catch(() => {})
        } else if (disk.coarse) {
          void window.api
            .logWaveformDebug(
              'waveform',
              'WaveformCache 가 거친 해상도 — audiowaveform 재생성 시도',
              cachePath
            )
            .catch(() => {})
        }
      }

      if (!peaksJsonLoaded && legacyPath !== cachePath) {
        const leg = await readPeaksJsonUsable(legacyPath)
        if (cancelled) return
        if (leg.ok) {
          setWaveformPeaksJsonPath(legacyPath)
          setWaveformPeaksJsonData(leg.json)
          peaksJsonLoaded = true
          void window.api
            .logWaveformDebug(
              'waveform',
              '레거시(영상 옆) .autosub-peaks.json 로드 — 피크 JSON + CUT용 버퍼 디코딩 진행',
              legacyPath
            )
            .catch(() => {})
        } else if (leg.coarse) {
          void window.api
            .logWaveformDebug(
              'waveform',
              '레거시 peaks 가 거친 해상도 — audiowaveform 재생성 시도',
              legacyPath
            )
            .catch(() => {})
        }
      }

      if (!peaksJsonLoaded) {
        try {
          let ffmpegPath: string | undefined
          try {
            const caps = await window.api.getFfmpegCapabilities()
            if (caps.ffmpegPath) ffmpegPath = caps.ffmpegPath
          } catch {
            /* FFmpeg 미준비 시 Python env 의 AUTOSUBTITLE_FFMPEG_PATH 로 처리 */
          }
          const raw = await window.api.sidecarCall('waveform_peaks', {
            path: videoPath,
            ...(ffmpegPath ? { ffmpeg_path: ffmpegPath } : {})
          })
          if (cancelled) return
          const r = raw as { ok?: boolean; path?: string | null; reason?: string }
          if (r?.ok && r.path) {
            setWaveformPeaksJsonPath(r.path)
            try {
              const jr = await window.api.readLocalPeaksJsonFile(r.path)
              if (cancelled) return
              if (jr.ok) {
                setWaveformPeaksJsonData(jr.json as JsonWaveformData)
                peaksJsonLoaded = true
              } else setWaveformPeaksJsonData(null)
            } catch {
              if (!cancelled) setWaveformPeaksJsonData(null)
            }
            void window.api
              .logWaveformDebug('waveform', 'waveform_peaks 생성·로드 완료 — 이후 CUT용 버퍼 디코딩', r.path)
              .catch(() => {})
          } else {
            void window.api
              .logWaveformDebug(
                'waveform',
                'waveform_peaks 미사용 (audiowaveform 없음 등)',
                r?.reason ?? 'ok:false'
              )
              .catch(() => {})
          }
        } catch (e) {
          void window.api
            .logWaveformDebug(
              'waveform',
              'waveform_peaks RPC 예외 — 전체 오디오 디코딩 폴백',
              e instanceof Error ? e.message : String(e)
            )
            .catch(() => {})
        }
      }
      if (cancelled) return
      if (typeof window.api.readLocalMediaFileBuffer !== 'function') {
        setWaveformPrefetchedBuffer(null)
        return
      }
      try {
        const res = await window.api.readLocalMediaFileBuffer(videoPath)
        if (cancelled) return
        if (!res.ok) {
          setWaveformPrefetchedBuffer(null)
          return
        }
        const ac = new AudioContext()
        try {
          const buf = await ac.decodeAudioData(res.arrayBuffer.slice(0))
          if (cancelled) return
          setWaveformPrefetchedBuffer(buf)
        } finally {
          void ac.close()
        }
      } catch {
        if (!cancelled) setWaveformPrefetchedBuffer(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [videoPath])

  useEffect(() => {
    if (!silenceSplitPending) return
    if (!videoPath || subtitles.length === 0) return
    const payload = extractWaveformPayload(waveformPeaksJsonData, subtitles)
    if (!payload) return

    const runKey = `${videoPath}|${subtitles.length}|${payload.waveformData.length}`
    if (silenceSplitRunKeyRef.current === runKey) {
      setSilenceSplitPending(false)
      return
    }

    let cancelled = false
    const worker = new Worker(new URL('./silenceWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<SilenceWorkerResponse>) => {
      if (cancelled) return
      const next = normalizeWorkerLines(event.data.lines ?? [])
      setSubtitles(next)
      setGapFillWhenBuildingVrew(false)
      setSilenceSplitPending(false)
      silenceSplitRunKeyRef.current = runKey
      const stats = event.data.stats
      if (stats) {
        void window.api
          .logWaveformDebug('silence-worker', '초기 무음 분리 완료', {
            ...stats,
            sampleRate: payload.sampleRate,
            waveformPoints: payload.waveformData.length
          })
          .catch(() => {})
      }
      worker.terminate()
    }
    worker.onerror = () => {
      if (cancelled) return
      setSilenceSplitPending(false)
      worker.terminate()
    }
    const req: SilenceWorkerRequest = {
      lines: subtitles,
      waveformData: payload.waveformData,
      sampleRate: payload.sampleRate
    }
    worker.postMessage(req)

    return () => {
      cancelled = true
      worker.terminate()
    }
  }, [silenceSplitPending, videoPath, subtitles, waveformPeaksJsonData])

  /**
   * 피크 JSON이 먼저 오고 디코딩이 늦을 때: CUT 후 `cutRanges`만 있고 버퍼는 풀 길이인 채로 들어오면
   * 파형을 닫았다 열 때 전체 피크가 부활한다 — 한 번에 스플라이스 재적용.
   */
  useEffect(() => {
    const buf = waveformPrefetchedBuffer
    if (!buf || cutRanges.length === 0) return
    const merged = mergeCutRanges(cutRanges)
    let removed = 0
    for (const c of merged) removed += c.end - c.start
    const durFull = durationSec > 0.25 ? durationSec : buf.duration
    const expectedShort = Math.max(0, durFull - removed)
    if (expectedShort < 0.2) return
    if (buf.duration > expectedShort + 0.12) {
      setWaveformPrefetchedBuffer((cur) => {
        if (!cur) return cur
        return replayMediaCutsOnDecodedBuffer(cur, cutRanges)
      })
    }
  }, [waveformPrefetchedBuffer, cutRanges, durationSec])

  const onVrewRowsChange = useCallback(
    (nextRows: SubtitleRow[]) => {
      setGapFillWhenBuildingVrew(false)
      applySubtitleChange(() => vrewRowsToSubtitleLines(nextRows), { recordHistory: true })
    },
    [applySubtitleChange]
  )

  const removeAllSilenceWords = useCallback(() => {
    applySubtitleChange((prev) => {
      const hadSilence = prev.some((l) => (l.words ?? []).some((w) => w.isSilence))
      if (hadSilence) queueMicrotask(() => setGapFillWhenBuildingVrew(false))
      return removeSilenceWordsFromSubtitleLines(prev)
    })
  }, [applySubtitleChange])

  const waveformPeaksRef = useRef<SubtitleWaveformPeaksHandle>(null)
  /** 행 layout 이펙트가 Peaks ref(useImperativeHandle)보다 먼저 돌 수 있어 맵은 여기서 동기 갱신 */
  const waveMountByLineRef = useRef<Map<number, HTMLDivElement>>(new Map())
  const [waveformLineIndex, setWaveformLineIndex] = useState<number | null>(null)
  const [waveformWordId, setWaveformWordId] = useState<number | null>(null)
  const [peaksZoomViewRange, setPeaksZoomViewRange] = useState<PeaksZoomViewRange | null>(null)

  /** 파형 CUT 확정 — 재생 스킵 + 전역 타임라인 자막 단어 반영 */
  const applyTimeRangeCut = useCallback(
    (startSec: number, endSec: number) => {
      const s = snapTimelineSec(Math.max(0, Math.min(startSec, endSec)))
      const e = snapTimelineSec(Math.max(0, Math.max(startSec, endSec)))
      if (!(e > s + 0.001)) {
        timelineEditLog('waveform-cut', 'applyTimeRangeCut 스킵 — 구간 너무 짧음', { startSec, endSec })
        return
      }
      setCutRanges((prev) => {
        const mapped = peaksEditRangeToMediaCut(s, e, prev)
        if (!mapped) {
          timelineEditLog('waveform-cut', 'applyTimeRangeCut — peaks→media 맵 실패(cutRanges 미변경)', {
            peaksEditSec: { start: s, end: e },
            prevCuts: prev
          })
          return prev
        }
        const next = mergeCutRanges([...prev, mapped])
        timelineEditLog('waveform-cut', 'applyTimeRangeCut — cutRanges 갱신', {
          peaksEditSec: { start: s, end: e },
          mediaCutSec: mapped,
          mergedCutCount: next.length,
          mergedCutsHead: next.slice(0, 5)
        })
        return next
      })
      setGapFillWhenBuildingVrew(false)
      setWaveformPrefetchedBuffer((prev) => (prev ? spliceAudioBuffer(prev, s, e) : prev))
      applySubtitleChange((prev) => {
        const rows = subtitleLinesToVrewRows(prev, { gapFill: false })
        const nextRows = applyTimeRangeCutToVrewRows(rows, s, e)
        return vrewRowsToSubtitleLines(nextRows)
      })
    },
    [applySubtitleChange]
  )

  /**
   * 파형(Peaks)은 gap-fill 무음 더미 단어마다 세그먼트가 생기는데, 자막 카드 칩은 원본 단어만 있어 개수·경계가 어긋남.
   * 한 줄이라도 파형 편집이 열려 있으면 gap-fill 을 끄고 vrew 단어 배열을 자막과 1:1로 맞춘다.
   */
  const vrewRows = useMemo(
    () =>
      subtitleLinesToVrewRows(subtitles, {
        gapFill: gapFillWhenBuildingVrew && waveformLineIndex === null
      }),
    [subtitles, gapFillWhenBuildingVrew, waveformLineIndex]
  )

  /** Peaks 줌·단어 칹 %배치와 동일 소스 — 헤더 줄 시각만 쓰면 단어 타임코드와 어긋날 수 있음 */
  const waveformLineZoomBounds = useMemo(() => {
    if (waveformLineIndex == null) return null
    const row = vrewRows[waveformLineIndex]
    if (row?.words?.length) {
      const ws = row.words
      return {
        start: Math.min(...ws.map((w) => w.start)),
        end: Math.max(...ws.map((w) => w.end))
      }
    }
    const line = subtitles[waveformLineIndex]
    return line ? { start: line.start, end: line.end } : null
  }, [waveformLineIndex, vrewRows, subtitles])

  const registerWaveMount = useCallback((lineIndex: number, el: HTMLDivElement | null) => {
    if (el) waveMountByLineRef.current.set(lineIndex, el)
    else waveMountByLineRef.current.delete(lineIndex)
    const dirty = waveformPeaksRef.current?.onWaveMountDirty
    if (dirty) {
      dirty()
    } else {
      queueMicrotask(() => waveformPeaksRef.current?.onWaveMountDirty?.())
    }
  }, [])

  const onWaveformWordDoubleClick = useCallback(
    (lineIndex: number, wordIndex: number) => {
      const line = subtitles[lineIndex]
      const sw = line?.words?.[wordIndex]
      const row = vrewRows[lineIndex]
      if (!sw || !row?.words?.length) return

      /** gap-fill 무음(??)이 끼면 vrew.words 인덱스 ≠ 자막 words 인덱스 — 시간으로 매칭 */
      const matchTime = (a: number, b: number) => Math.abs(a - b) < 0.05
      let w = row.words.find(
        (vw) =>
          !vw.isSilence &&
          matchTime(vw.start, sw.start) &&
          matchTime(vw.end, sw.end)
      )
      if (!w && sw.isSilence) {
        w = row.words.find(
          (vw) => vw.isSilence && matchTime(vw.start, sw.start) && matchTime(vw.end, sw.end)
        )
      }
      if (!w) {
        const nonSilent = row.words.filter((vw) => !vw.isSilence)
        if (nonSilent.length > 0) {
          w = nonSilent.reduce((best, vw) =>
            Math.abs(vw.start - sw.start) < Math.abs(best.start - sw.start) ? vw : best
          )
        }
      }
      if (!w) return
      setWaveformLineIndex(lineIndex)
      setWaveformWordId(w.id)
    },
    [subtitles, vrewRows]
  )

  /** 파형 마운트를 단어 아래로 옮긴 뒤 body 포털·연결선 좌표 동기화 */
  const onWaveformMountLayout = useCallback(() => {
    queueMicrotask(() => waveformPeaksRef.current?.onWaveMountDirty?.())
  }, [])

  useEffect(() => {
    if (subtitles.length === 0) {
      setWaveformLineIndex(null)
      setWaveformWordId(null)
    }
  }, [subtitles.length])

  useEffect(() => {
    if (waveformLineIndex === null) setPeaksZoomViewRange(null)
  }, [waveformLineIndex])

  /** 파형 편집 중 — 다른 단어·영상·빈 곳 클릭 시 닫기(활성 단어 칩·파형 UI는 유지) */
  useEffect(() => {
    if (waveformLineIndex === null && waveformWordId === null) return
    const onPointerDown = (e: PointerEvent): void => {
      const el = e.target as HTMLElement | null
      if (!el) return
      if (el.closest('.subtitle-waveform-flow-root')) return
      if (el.closest('[data-waveform-active-word-chip="1"]')) return
      if (el.closest('[data-waveform-mount-for-open-line="1"]')) return
      /** body 포털된 CUT 삭제 버튼 — 클릭 시 파형 닫히면 CUT 확정 전에 줄이 닫혀 삭제가 스킵됨 */
      if (el.closest('[data-waveform-app-portal="1"]')) return
      setWaveformLineIndex(null)
      setWaveformWordId(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [waveformLineIndex, waveformWordId])

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
      setGapFillWhenBuildingVrew(false)
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
      setGapFillWhenBuildingVrew(false)
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
      setGapFillWhenBuildingVrew(false)
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

  /** CUT 직후 `timeupdate`가 없을 수 있어 재생 헤드가 삭제 구간 안에 남음 → 재생이 멈춘 것처럼 보임 */
  useEffect(() => {
    const el = videoRef.current
    if (!el || !videoPath) return
    if (mergeCutRanges([...cutRanges]).length === 0) return
    const fromTime = el.currentTime
    const skipped = skipCutRangeAt(fromTime, cutRanges)
    let t = skipped
    if (Number.isFinite(el.duration) && el.duration > 0) {
      t = Math.min(skipped, Math.max(0, el.duration - 0.001))
    }
    if (t !== fromTime) {
      el.currentTime = t
      setPlayheadSec(t)
      timelineEditLog('playback', 'cutRanges 반영 — currentTime 을 삭제 구간 밖으로 이동', {
        from: fromTime,
        to: t
      })
    }
  }, [cutRanges, videoPath])

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) {
      const from = el.currentTime
      let t = skipCutRangeAt(from, cutRangesRef.current)
      if (Number.isFinite(el.duration) && el.duration > 0) {
        t = Math.min(t, Math.max(0, el.duration - 0.001))
      }
      if (t !== from) {
        el.currentTime = t
        timelineEditLog('playback', 'togglePlay 직전 — 삭제 구간 밖으로 시크', { from, to: t })
      }
      void el.play().catch((e) => {
        timelineEditLog('playback', 'togglePlay play() 거절', {
          message: e instanceof Error ? e.message : String(e)
        })
      })
    } else {
      el.pause()
    }
  }, [])

  /**
   * 재생 중 삭제 구간으로 들어가며 seek 하면 일부 브라우저가 일시정지를 띄우고,
   * `onPause` → isPlaying=false 로 RAF 가 끊겨 복귀 seek 이 안 됨 — pause 직후 구간 밖이면 즉시 재생.
   */
  const handleVideoPause = useCallback(() => {
    const el = videoRef.current
    if (!el) {
      setIsPlaying(false)
      return
    }
    const dur = el.duration
    const cur = el.currentTime
    if (Number.isFinite(dur) && dur > 0 && cur >= dur - 0.03) {
      setIsPlaying(false)
      return
    }
    if (mergeCutRanges([...cutRangesRef.current]).length === 0) {
      setIsPlaying(false)
      return
    }
    const next = skipCutRangeAt(cur, cutRangesRef.current)
    let t = next
    if (Number.isFinite(dur) && dur > 0) {
      t = Math.min(next, Math.max(0, dur - 0.001))
    }
    if (next !== cur) {
      el.currentTime = t
      timelineEditLog('playback', 'pause 이벤트 — 삭제 구간 회피 시크 후 재생', { cur, to: t })
      void el.play().catch((e) => {
        timelineEditLog('playback', 'pause-회피 play() 거절', {
          message: e instanceof Error ? e.message : String(e)
        })
      })
      return
    }
    setIsPlaying(false)
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
      if (el.seeking) {
        rafPlayheadRef.current = window.requestAnimationFrame(tick)
        return
      }
      const from = el.currentTime
      let t = skipCutRangeAt(from, cutRanges)
      if (t !== from) {
        el.currentTime = t
        timelineEditLog('playback', 'RAF — 재생 중 삭제 구간 스킵 시크', { from, to: t })
        rafPlayheadRef.current = window.requestAnimationFrame(tick)
        return
      }
      // 재생 라인 표시를 0.01초 단위로 안정화
      t = Math.round(el.currentTime * 100) / 100
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
      if (isExtracting) return
      const absPath = normalizeVideoPath(rawPath)
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
      if (modelReady && !busy) {
        pendingAutoTranscribeRef.current = null
        setIsExtracting(true)
        window.api.sendVideoDropPath(absPath)
      } else {
        pendingAutoTranscribeRef.current = absPath
      }
    },
    [busy, isExtracting, modelReady]
  )

  useEffect(() => {
    if (!modelReady || busy || isExtracting) return
    const p = pendingAutoTranscribeRef.current
    if (!p || !isVideoFilePath(p)) return
    pendingAutoTranscribeRef.current = null
    setIsExtracting(true)
    window.api.sendVideoDropPath(p)
  }, [modelReady, busy, isExtracting])

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
      setSilenceSplitPending(true)
      silenceSplitRunKeyRef.current = null
      const wp = (raw as { waveform_peaks?: { ok?: boolean; path?: string | null } }).waveform_peaks
      if (wp?.ok && wp.path) {
        setWaveformPeaksJsonPath(wp.path)
        void window.api.readLocalPeaksJsonFile(wp.path).then((jr) => {
          if (jr.ok) setWaveformPeaksJsonData(jr.json as JsonWaveformData)
          else setWaveformPeaksJsonData(null)
        })
      }
      setGapFillWhenBuildingVrew(true)
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
        if (s.engineReady) {
          setModelReady(true)
          setDownloadPct(100)
        }
      } catch {
        if (!cancelled) setModelReady(false)
      } finally {
        if (!cancelled) setDepsResolved(true)
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
          void (async () => {
            try {
              const g = (await window.api.getGpuRuntimeStatus()) as GpuRuntimeStatus
              setGpuRuntimeStatus(g)
              if (!g.nvidiaPresent) {
                setPostEngineDialog({ kind: 'cpuNotice' })
              } else if (!g.installed) {
                setPostEngineDialog({ kind: 'gpuOffer' })
              }
            } catch {
              /* ignore */
            }
          })()
        }, 2000)
      } catch {
        setOverlayPhase('error')
        setBusy(false)
      }
    })()
  }, [])

  const installGpuRuntimeManually = useCallback(() => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        await window.api.installGpuRuntime()
        const g = (await window.api.getGpuRuntimeStatus()) as GpuRuntimeStatus
        setGpuRuntimeStatus(g)
        if (g.installed) setGpuInstallBanner(null)
        else {
          setGpuInstallBanner(`GPU 런타임이 설치되지 않았습니다. DLL 위치: ${g.dllDir}`)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const g = (await window.api.getGpuRuntimeStatus().catch(() => null)) as GpuRuntimeStatus | null
        setGpuInstallBanner(`GPU 설치 실패: ${msg}${g?.dllDir ? ` (대상 폴더: ${g.dllDir})` : ''}`)
      } finally {
        setBusy(false)
      }
    })()
  }, [busy])

  const runPostEngineGpuInstall = useCallback(async () => {
    const g0 = (await window.api.getGpuRuntimeStatus()) as GpuRuntimeStatus
    if (!g0.canInstall) {
      setPostEngineDialog({ kind: 'gpuFail', dllDir: g0.dllDir })
      return
    }
    setPostEngineDialog({ kind: 'gpuInstall', pct: 0, stage: '시작…' })
    const off = window.api.onGpuInstallProgress((p) => {
      setPostEngineDialog({ kind: 'gpuInstall', pct: p.pct, stage: p.stage })
    })
    try {
      await window.api.installGpuRuntime()
      const g = (await window.api.getGpuRuntimeStatus()) as GpuRuntimeStatus
      setGpuRuntimeStatus(g)
      if (g.installed) {
        setPostEngineDialog({ kind: 'none' })
        setGpuInstallBanner(null)
      } else {
        setPostEngineDialog({ kind: 'gpuFail', dllDir: g.dllDir })
      }
    } catch {
      const g = (await window.api.getGpuRuntimeStatus().catch(() => null)) as GpuRuntimeStatus | null
      setPostEngineDialog({ kind: 'gpuFail', dllDir: g?.dllDir ?? g0.dllDir })
    } finally {
      off()
    }
  }, [])

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
    pendingAutoTranscribeRef.current = null
    setVideoPath(d.videoPath)
    setCutRanges(mergeCutRanges(d.cutRanges))
    setSubtitles(d.subtitles)
    setSilenceSplitPending(true)
    silenceSplitRunKeyRef.current = null
    setGapFillWhenBuildingVrew(true)
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
  const previewSubtitleTextStyle = useMemo<CSSProperties>(() => {
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
      overflowWrap: 'normal' as const,
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
      {gpuInstallBanner ? (
        <div className="app-gpu-install-banner" role="alert">
          <p className="app-gpu-install-banner-text">{gpuInstallBanner}</p>
          <button type="button" className="app-gpu-install-banner-dismiss" onClick={() => setGpuInstallBanner(null)}>
            닫기
          </button>
        </div>
      ) : null}
      <div
        className={`main-workspace ${
          modelReady || !depsResolved ? 'main-workspace--active' : 'main-workspace--inactive'
        }`}
      >
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
                      onPause={handleVideoPause}
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
                <div className="subtitle-panel-head-top">
                  <h2 className="subtitle-panel-title">자막</h2>
                  {subtitles.length > 0 ? (
                    <div className="subtitle-panel-actions" role="group" aria-label="자막 일괄 편집">
                      <button
                        type="button"
                        className="app-topbar-gpu-btn preview-project-btn subtitle-panel-action-btn"
                        onClick={removeAllSilenceWords}
                        title="isSilence 로 표시된 단어를 모두 제거합니다. 이후 파형 변환 시 단어 사이 무음 더미를 자동 삽입하지 않습니다."
                      >
                        무음 일괄 삭제
                      </button>
                      <button
                        type="button"
                        className="app-topbar-gpu-btn preview-project-btn subtitle-panel-action-btn"
                        disabled={gapFillWhenBuildingVrew}
                        onClick={() => setGapFillWhenBuildingVrew(true)}
                        title="파형 편집용 줄을 만들 때 단어 사이 간격을 다시 메웁니다(무음 더미 포함)."
                      >
                        간격 다시 채우기
                      </button>
                    </div>
                  ) : null}
                </div>
                <p className="subtitle-panel-sub">
                  <strong>단어 더블클릭</strong> 해당 줄 단어 아래 파동 편집 · <strong>Enter</strong> 줄바꿈 ·{' '}
                  <strong>Ctrl+Enter</strong> 자막 분할 · 빈 칸에서 <strong>Backspace</strong> 이전과 병합 ·{' '}
                  <strong>Tab</strong> / <strong>Shift+Tab</strong> 다른 줄로 이동
                </p>
              </header>
              <div className="subtitle-panel-body">
                {subtitles.length === 0 ? (
                  <div className="subtitle-empty-placeholder" aria-live="polite">
                    <p className="subtitle-empty-hint-text">
                      아직 자막이 없습니다. 영상을 창에 끌어다 놓으면 엔진이 준비된 뒤 Faster-Whisper 인식이
                      자동으로 시작됩니다.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="subtitle-list-stack">
                      <SubtitleDataProvider subtitles={subtitles}>
                        <SubtitleVirtualList
                          subtitles={subtitles}
                          activeSubtitleIndex={activeSubtitleIndex}
                          playheadSec={playheadSec}
                          isPlaying={isPlaying}
                          mediaFileUrl={videoPath ? window.api.getMediaFileUrl(videoPath) : null}
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
                          waveformEnabled={Boolean(modelReady)}
                          registerWaveMount={registerWaveMount}
                          waveformExpandedLineIndex={waveformLineIndex}
                          waveformActiveWordId={waveformWordId}
                          onWaveformWordDoubleClick={onWaveformWordDoubleClick}
                          vrewRows={vrewRows}
                          onWaveformMountLayout={onWaveformMountLayout}
                          mediaDurationSec={durationSec > 0 ? durationSec : undefined}
                          peaksZoomViewRange={peaksZoomViewRange}
                        />
                      </SubtitleDataProvider>
                    </div>
                    {modelReady && subtitles.length > 0 ? (
                      <SubtitleWaveformPeaks
                        ref={waveformPeaksRef}
                        rows={vrewRows}
                        onRowsChange={onVrewRowsChange}
                        audioUrl={waveformMediaUrl}
                        localMediaPath={videoPath}
                        prefetchedAudioBuffer={waveformPrefetchedBuffer}
                        precomputedWaveformJson={waveformPeaksJsonData}
                        precomputedPeaksJsonFileUrl={waveformPeaksJsonData ? null : waveformPeaksFileUrl}
                        waveMountByLineRef={waveMountByLineRef}
                        activeLineIndex={waveformLineIndex}
                        activeWordId={waveformWordId}
                        waveformCardBounds={waveformLineZoomBounds}
                        onZoomViewRange={setPeaksZoomViewRange}
                        onTimeRangeCut={applyTimeRangeCut}
                      />
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>

      {depsResolved && !modelReady && !engineOverlayOpen ? (
        <div className="engine-gate" role="region" aria-label="필수 엔진 준비">
          <div className="engine-gate-card">
            <p className="engine-gate-title">
              프로그램 실행에 필요한 필수 엔진(FFmpeg 및 AI 모델)을 다운로드하시겠습니까?
            </p>
            <p className="engine-gate-desc">
              FFmpeg는 영상·음성 처리에, AI 모델은 음성 인식에 사용됩니다. 한 번만 받으면 이후 실행에서
              재사용됩니다. GPU 런타임(CUDA DLL)은 다운로드·최적화가 끝난 뒤, PC 환경에 맞는 안내가
              이어집니다.
            </p>
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

      {postEngineDialog.kind === 'cpuNotice' ? (
        <div className="post-engine-backdrop" role="presentation">
          <div
            className="post-engine-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="post-engine-cpu-title"
          >
            <h2 id="post-engine-cpu-title" className="post-engine-title">
              CPU 모드 안내
            </h2>
            <p className="post-engine-body">
              이 PC에서 <strong>NVIDIA 그래픽 카드가 감지되지 않았습니다</strong>. 자막 추출과 내보내기는{' '}
              <strong>CPU</strong>로 동작하며, GPU를 사용할 때보다 <strong>처리 시간이 더 길어질 수 있습니다</strong>.
            </p>
            <button type="button" className="post-engine-primary" onClick={() => setPostEngineDialog({ kind: 'none' })}>
              확인
            </button>
          </div>
        </div>
      ) : null}

      {postEngineDialog.kind === 'gpuOffer' ? (
        <div className="post-engine-backdrop" role="presentation">
          <div className="post-engine-card" role="alertdialog" aria-modal="true" aria-labelledby="post-engine-gpu-title">
            <h2 id="post-engine-gpu-title" className="post-engine-title">
              GPU 런타임 설치
            </h2>
            <p className="post-engine-body">
              <strong>NVIDIA GPU</strong>가 감지되었습니다. GPU로 음성 인식을 사용하려면{' '}
              <strong>GPU 런타임(CUDA DLL)</strong>을 설치해야 합니다. 지금 설치하시겠습니까?
            </p>
            <div className="post-engine-actions">
              <button type="button" className="post-engine-secondary" onClick={() => setPostEngineDialog({ kind: 'none' })}>
                나중에
              </button>
              <button type="button" className="post-engine-primary" onClick={() => void runPostEngineGpuInstall()}>
                예
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {postEngineDialog.kind === 'gpuInstall' ? (
        <div className="post-engine-backdrop" role="presentation">
          <div
            className="post-engine-card post-engine-card--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="post-engine-gpu-install-title"
            aria-busy="true"
          >
            <h2 id="post-engine-gpu-install-title" className="post-engine-title">
              GPU 런타임 설치 중
            </h2>
            <p className="post-engine-stage">{postEngineDialog.stage}</p>
            <div
              className="extract-progress-track"
              role="progressbar"
              aria-valuenow={Math.round(postEngineDialog.pct)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="extract-progress-fill" style={{ width: `${Math.min(100, postEngineDialog.pct)}%` }} />
            </div>
            <p className="extract-modal-pct">{Math.round(postEngineDialog.pct)}%</p>
          </div>
        </div>
      ) : null}

      {postEngineDialog.kind === 'gpuFail' ? (
        <div className="post-engine-backdrop" role="presentation">
          <div
            className="post-engine-card post-engine-card--wide"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="post-engine-gpu-fail-title"
          >
            <h2 id="post-engine-gpu-fail-title" className="post-engine-title">
              GPU 런타임 설치 실패
            </h2>
            <p className="post-engine-body">
              자동 설치에 실패했습니다. 아래 순서로 직접 설치해 주세요.
            </p>
            <ol className="post-engine-steps">
              <li>
                하단의 <strong>GitHub 릴리스 페이지 열기</strong>를 눌러 해당 페이지로 이동합니다.
              </li>
              <li>
                페이지에서 <strong>Assets</strong> 목록의{' '}
                <code className="post-engine-code">runtime_dlls.zip</code> 파일을 다운로드합니다.
              </li>
              <li>
                받은 ZIP 압축을 해제한 뒤, 나온 <strong>모든 파일</strong>을 선택해 복사합니다.
              </li>
              <li>
                아래 폴더를 연 다음, 복사한 파일들을 그대로 <strong>붙여넣기</strong>합니다. (같은 이름이 있으면
                덮어써도 됩니다.)
              </li>
            </ol>
            <p className="post-engine-path-label">복사 대상 폴더</p>
            <p className="post-engine-path">{postEngineDialog.dllDir}</p>
            <div className="post-engine-actions post-engine-actions--wrap">
              <button
                type="button"
                className="post-engine-secondary"
                onClick={() =>
                  void window.api.openExternal(RELEASES_PAGE_URL).then((r) => {
                    if (!r.ok) console.warn('openExternal', r)
                  })
                }
              >
                GitHub 릴리스 페이지 열기
              </button>
              <button type="button" className="post-engine-primary" onClick={() => setPostEngineDialog({ kind: 'none' })}>
                닫기
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
