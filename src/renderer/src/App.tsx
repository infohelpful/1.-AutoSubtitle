import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
  type CSSProperties,
  type ReactElement
} from 'react'
import type { JsonWaveformData } from 'peaks.js'

import type { CutRange, DepsStatus, ExportFormat, GpuRuntimeStatus, TranscribeMode } from '../../shared/ipc'
import { parseSubtitleLines, type SubtitleLine, type SubtitleWord } from '../../shared/subtitles'
import {
  AUTOSUB_FILE_FORMAT,
  AUTOSUB_VERSION,
  type AutosubProjectFileV1,
  parseAutosubProjectFile
} from '../../shared/autosubProject'
import type { SentenceTokenTimeline } from '../../shared/sentenceTokenTimeline'
import {
  sentenceTokenTimelineToSubtitleLines,
  subtitleLinesToSentenceTokenTimeline
} from '../../shared/sentenceTokenTimelineAdapter'
import {
  buildActiveBlocksSnapshotFromSubtitles,
  deriveVisibleSubtitleLinesForUi,
  mergeDeletedMediaIntoTimeline,
  mergeWaveformPeaksStitchCutRanges,
  mergedDeletedBlocksForProjectSave,
  subtitleLinesAfterSoftDeleteWordRange,
  type VirtualTimelineBlock,
  virtualTombstonesFromCutRanges
} from '../../shared/virtualTimeline'
import {
  removeSilenceWordsFromSubtitleLines,
  shouldFillGapsWhenBuildingVrewRows
} from '../../shared/phase5EditPolicy'
import { SILENCE_PLACEHOLDER_TEXT } from '../../shared/wordContract'
import { buildExportCueLines } from '../../shared/exportCuePipeline'
import {
  hasPlayableSubtitleWordIntervals,
  lastPlaybackEndSec,
  playbackIntervalsFromSubtitleLines
} from '../../shared/playbackIntervals'
import { applyProgramTimeRangeTombstoneCutToSubtitleLines } from '../../shared/subtitleTombstoneCut'
import { getSubtitleBoxChromeInline } from '../../shared/subtitleBoxChrome'
import { splitWordTextAtMediaCut } from '../../shared/subtitleWordTextSplit'
import { mergeEmptySubtitleWithPrevious, splitSubtitleLine } from './subtitleEditOps'
import { SubtitleVirtualList } from './SubtitleVirtualList'
import { SubtitleDataProvider } from './subtitleDataContext'
import {
  SubtitleWaveformPeaks,
  type PeaksZoomViewRange,
  type SubtitleWaveformPeaksHandle
} from './SubtitleWaveformPeaks'
import type { SubtitleRow } from './components/vrewPeaksEditor/types'
import { makeRowWordBlockId } from './components/vrewPeaksEditor/blockIds'
import {
  mergeVrewRowsIntoSubtitleLines,
  subtitleLinesToVrewRows,
  vrewRowsToSubtitleLines
} from './vrewSubtitleAdapter'
import {
  mergeCutRanges,
  peaksEditRangeToMediaCut,
  snapTimelineSec
} from '../../shared/timelineCollapse'
import { timelineEditLog } from './timelineEditLog'
import { wfLog } from './components/vrewPeaksEditor/waveformDebugLog'
import {
  cutRemovedIntervalsExpandOnly,
  cutRangesSignature,
  exactTimelineDurationSecFromWaveformJson,
  stitchWaveformJsonByCuts,
  stitchWaveformJsonExpandCutsIncremental,
  stitchedEditAxisDurationSecFromCuts
} from './timeline/stitchWaveformJson'
import { StitchedPeaksJsonLruCache } from './timeline/stitchedPeaksJsonCache'
import { cutRangeShallowEqual, useStableArrayReference } from './useStableArrayReference'
import {
  createTimelineMapping,
  jumpVideoPastClipTailIfNeeded,
  programDurationSec,
  skipCutRangeAt,
  type TimelineMapping
} from './timeline/mapping'
import { createPlaybackCommandRouter } from './timeline/playbackCommandRouter'
import {
  buildScheduledMediaSegments,
  buildScheduledMediaSegmentsFromSubtitleWords,
  type ScheduledMediaSegment
} from './timeline/playbackSchedule'
import { USE_WORD_BASED_PLAYBACK_SCHEDULE } from './timeline/playbackPolicy'
import { WebAudioMasterPlayback } from './timeline/webAudioMasterPlayback'
import { useVideoSeekUi } from './sync/useVideoSeekUi'
import {
  WordCanvasPanel,
  buildEditorSnapshotFromSentenceTokenTimeline,
  useEditorStore
} from './wordCanvas'

type OverlayPhase = 'working' | 'success' | 'error'

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'avi'] as const

/** `python_sidecar/main.py` 의 `_PEAKS_MAX_SAMPLES_PER_PIXEL_STALE` 와 맞출 것 */
const PEAKS_JSON_MAX_SAMPLES_PER_PIXEL = 128

const PLAYHEAD_STEP_SEC = 0.01

/**
 * Phase 2 / 8 — 자막 **목록 표시**만 가상 타임라인 파생으로 바꿀 때 사용.
 * `true`면 `deriveVisibleSubtitleLinesForUi` 결과를 쓰지만, `SubtitleVirtualList` 인덱스는 여전히 파생 `subtitles` 줄
 * 순서와 맞춰야 하므로 기본은 false (파생 전환 시 리스트 컴포넌트 매핑 추가 필요).
 * 앱 SSOT는 `SentenceTokenTimeline`; `subtitles`는 `sentenceTokenTimelineToSubtitleLines` 파생값.
 */
const READ_SUBTITLES_FROM_VIRTUAL_TIMELINE = false

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
      !w.isDeleted &&
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

function estimateSpeechOnsetFromWaveformJson(
  json: JsonWaveformData | null,
  mediaDurationSec: number
): number | null {
  if (!json || !(mediaDurationSec > 0)) return null
  const data = json.data ?? []
  if (data.length < 4) return null
  let pps = 0
  if (json.sample_rate && json.samples_per_pixel) {
    pps = json.sample_rate / json.samples_per_pixel
  } else if (json.length && json.length > 0) {
    pps = json.length / mediaDurationSec
  }
  if (!(pps > 1)) return null
  const pixels = Math.floor(data.length / 2)
  let maxAmp = 0
  const amps: number[] = new Array(pixels)
  for (let i = 0; i < pixels; i += 1) {
    const lo = Math.abs(data[i * 2] ?? 0)
    const hi = Math.abs(data[i * 2 + 1] ?? 0)
    const a = Math.max(lo, hi)
    amps[i] = a
    if (a > maxAmp) maxAmp = a
  }
  if (!(maxAmp > 0)) return null
  const threshold = maxAmp * 0.12
  for (let i = 0; i < pixels; i += 1) {
    if (amps[i] > threshold) return i / pps
  }
  return null
}

function stitchAudioBufferByCuts(
  src: AudioBuffer,
  cuts: CutRange[],
  targetSampleRate: number
): { buffer: AudioBuffer; totalSamples: number } {
  const merged = mergeCutRanges([...cuts])
  const channelCount = src.numberOfChannels
  const sampleRate = src.sampleRate
  const keepRanges: Array<{ startSec: number; endSec: number }> = []
  let cursor = 0
  const mediaDuration = src.length / sampleRate
  for (const c of merged) {
    const s = Math.max(0, Math.min(mediaDuration, c.start))
    const e = Math.max(0, Math.min(mediaDuration, c.end))
    if (s > cursor) keepRanges.push({ startSec: cursor, endSec: s })
    cursor = Math.max(cursor, e)
  }
  if (cursor < mediaDuration) keepRanges.push({ startSec: cursor, endSec: mediaDuration })

  let accumulatedError = 0
  const sampleRanges = keepRanges.map((r) => {
    const exactStart = r.startSec * sampleRate
    const exactEnd = r.endSec * sampleRate
    const exactDuration = exactEnd - exactStart

    const s = Math.max(0, Math.round(exactStart))
    const targetDuration = exactDuration + accumulatedError
    const durationSamples = Math.round(targetDuration)
    accumulatedError = targetDuration - durationSamples

    const eUnclamped = s + durationSamples
    const e = Math.min(eUnclamped, src.length)
    return { start: s, end: e }
  })
  const totalSamples = sampleRanges.reduce((acc, r) => acc + (r.end - r.start), 0)
  const out = new AudioBuffer({
    numberOfChannels: channelCount,
    length: Math.max(1, totalSamples),
    sampleRate: targetSampleRate
  })
  for (let ch = 0; ch < channelCount; ch += 1) {
    const srcData = src.getChannelData(ch)
    const outData = out.getChannelData(ch)
    let write = 0
    for (const r of sampleRanges) {
      outData.set(srcData.subarray(r.start, r.end), write)
      write += r.end - r.start
    }
  }
  return { buffer: out, totalSamples: Math.max(1, totalSamples) }
}

/** 편집 타임라인(컷 반영) 좌표 → 원본 미디어 타임라인 초 — 파형·미디어 요소와 1:1 매칭용 */
function getMediaTimeFromEditTime(editSec: number, cutRanges: CutRange[]): number {
  let mediaSec = editSec
  const sortedCuts = mergeCutRanges([...cutRanges]).sort((a, b) => a.start - b.start)
  for (const cut of sortedCuts) {
    if (mediaSec >= cut.start) mediaSec += cut.end - cut.start
  }
  return mediaSec
}

/** 원본 미디어 초 → 편집 타임라인 좌표 (역함수) — 파형(Media)→자막 상태 저장 시 사용 */
function getEditTimeFromMediaTime(mediaSec: number, cutRanges: CutRange[]): number {
  let editSec = mediaSec
  const sortedCuts = mergeCutRanges([...cutRanges]).sort((a, b) => a.start - b.start)
  for (const cut of sortedCuts) {
    if (editSec > cut.end) {
      editSec -= cut.end - cut.start
    } else if (editSec > cut.start) {
      editSec -= editSec - cut.start
    }
  }
  return editSec
}

function seekVideoElementTo(videoEl: HTMLVideoElement, targetVideoSec: number): Promise<void> {
  return new Promise((resolve) => {
    const target = Math.max(0, Number(targetVideoSec))
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(tid)
      videoEl.removeEventListener('seeked', onSeeked)
      resolve()
    }
    const tid = window.setTimeout(done, 420)
    const onSeeked = (): void => {
      done()
    }
    videoEl.addEventListener('seeked', onSeeked, { once: true })
    videoEl.currentTime = target
    queueMicrotask(() => {
      if (Math.abs(videoEl.currentTime - target) < 0.002) done()
    })
  })
}

/**
 * `HTMLAudioElement.currentTime` 재할당은 값이 거의 같아도 seeking 이벤트를 유발해 재생을 끊을 수 있다.
 * (일시정지 시 `syncPausedMasterToEdit` 같은 경로에서 흔함)
 */
const MASTER_AUDIO_ASSIGN_EPS_SEC = 0.002

function assignMasterAudioTimelineSecIfNeeded(audio: HTMLAudioElement, timelineSec: number): boolean {
  const t = Math.max(0, Number(timelineSec))
  if (!Number.isFinite(t)) return false
  if (Math.abs(audio.currentTime - t) <= MASTER_AUDIO_ASSIGN_EPS_SEC) return false
  audio.currentTime = t
  return true
}

/**
 * 시간 동기화용 안전한 동시 재생.
 * Basis 정의:
 * - EditTimeSec: `subtitles`/단어 카드/타임라인 편집 좌표계(컷 반영 후 압축된 시간)
 * - MediaTimeSec: 원본(컷 스킵) 미디어 좌표계(오디오/비디오 currentTime의 기준)
 *
 * 재생 시점에는 오디오와 비디오 모두 HAVE_FUTURE_DATA 이상일 때만 동시에 play()를 호출한다.
 */
function playMasterVideoSynced(
  masterAudio: HTMLAudioElement,
  videoEl: HTMLVideoElement,
  opts?: {
    onAudioPlayRejected?: (reason?: unknown) => void
    targetVideoSec?: number
    targetAudioSec?: number
    /** stitched 마스터: HTML 오디오 currentTime 이 편집 축 — 비디오 미디어 시각으로 바꿀 때 사용 */
    videoMediaSecFromMasterClockSec?: (masterClockSec: number) => number
  }
): void {
  const A_V_PLAY_EVENT_GAP_MS = 220
  const AUDIO_PLAYING_GATE_MS = 120
  const SEEK_EVENT_FALLBACK_MS = 320
  const playBoth = (): void => {
    const startedAt = performance.now()
    let audioPlayingAt: number | null = null
    let videoPlayingAt: number | null = null
    const onAudioPlaying = (): void => {
      audioPlayingAt = performance.now()
    }
    const onVideoPlaying = (): void => {
      videoPlayingAt = performance.now()
    }
    masterAudio.addEventListener('playing', onAudioPlaying, { once: true })
    videoEl.addEventListener('playing', onVideoPlaying, { once: true })
    window.setTimeout(() => {
      const oneSideMissing = audioPlayingAt == null || videoPlayingAt == null
      if (!oneSideMissing) return
      /**
       * 통합 정책: 앱 기본 RAF (`video-master-html`)는 비디오를 마스터로 본다.
       * 다만 `playing` 이벤트가 한쪽만 도착해 재생 시점이 어긋난 비상 분기에서는,
       * 슬레이브 격인 오디오가 도착하지 못한 채 비디오만 흐르는 상태를 피하려 비디오를 잠깐 멈춘 뒤
       * 한 번에 양쪽을 동일 좌표로 정렬한다(다시 시작은 두 쪽 모두 준비됐을 때).
       */
      if (videoPlayingAt != null && audioPlayingAt == null && !videoEl.paused) {
        videoEl.pause()
      }
      const mapV = opts?.videoMediaSecFromMasterClockSec
      const targetVideoFromAudio = mapV
        ? mapV(masterAudio.currentTime)
        : masterAudio.currentTime
      if (Math.abs(videoEl.currentTime - targetVideoFromAudio) > 1e-3) {
        videoEl.currentTime = targetVideoFromAudio
      }
      if (masterAudio.paused) void masterAudio.play().catch(() => undefined)
      if (videoEl.paused) void videoEl.play().catch(() => undefined)
      timelineEditLog('playback', 'playMasterVideoSynced 재동기화(play/playing gap, 비디오→오디오시계)', {
        elapsedMs: performance.now() - startedAt,
        audioPlayingAt,
        videoPlayingAt,
        audioMasterSec: masterAudio.currentTime,
        videoMediaSec: videoEl.currentTime
      })
    }, A_V_PLAY_EVENT_GAP_MS)
    void (async () => {
      try {
        await masterAudio.play()
      } catch (e: unknown) {
        opts?.onAudioPlayRejected?.(e)
        return
      }
      await new Promise<void>((resolve) => {
        if (!masterAudio.paused) {
          resolve()
          return
        }
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          masterAudio.removeEventListener('playing', onPlaying)
          resolve()
        }
        const onPlaying = (): void => finish()
        masterAudio.addEventListener('playing', onPlaying, { once: true })
        window.setTimeout(finish, AUDIO_PLAYING_GATE_MS)
      })
      void videoEl.play().catch(() => undefined)
    })()
  }
  const targetState = HTMLMediaElement.HAVE_FUTURE_DATA
  const targetVideoSec = opts?.targetVideoSec
  const targetAudioSec = opts?.targetAudioSec
  const shouldSeekVideo = Number.isFinite(targetVideoSec)
  const shouldSeekAudio = Number.isFinite(targetAudioSec)

  let videoSeekDone = !shouldSeekVideo
  let audioSeekDone = !shouldSeekAudio
  const haveBothReady = (): boolean => masterAudio.readyState >= targetState && videoEl.readyState >= targetState

  let done = false
  const cleanupFns: Array<() => void> = []
  const cleanup = (): void => {
    for (const fn of cleanupFns) fn()
    cleanupFns.length = 0
  }
  const once = <K extends keyof HTMLMediaElementEventMap>(
    el: HTMLMediaElement,
    evt: K,
    fn: () => void
  ): void => {
    const wrapped = () => fn()
    el.addEventListener(evt, wrapped, { once: true })
    cleanupFns.push(() => el.removeEventListener(evt, wrapped))
  }

  const playSync = (): void => {
    if (done) return
    if (!videoSeekDone || !audioSeekDone) return
    if (!haveBothReady()) return
    done = true
    cleanup()
    playBoth()
  }

  const withSeekFallback = (markDone: () => void): void => {
    let doneLocal = false
    const finish = (): void => {
      if (doneLocal) return
      doneLocal = true
      markDone()
    }
    cleanupFns.push(() => {
      doneLocal = true
    })
    window.setTimeout(finish, SEEK_EVENT_FALLBACK_MS)
  }

  const seekWithNudge = (
    el: HTMLMediaElement,
    targetSec: number,
    done: () => void
  ): void => {
    const target = Math.max(0, Number(targetSec))
    const cur = el.currentTime
    const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null
    const nearSame = Math.abs(cur - target) < 1e-4
    const nudgeForward = dur != null ? Math.min(target + 0.001, Math.max(0, dur - 0.001)) : target + 0.001
    const nudgeBackward = Math.max(0, target - 0.001)
    const nudge =
      nearSame && Math.abs(nudgeForward - target) > 1e-6
        ? nudgeForward
        : nearSame && Math.abs(nudgeBackward - target) > 1e-6
          ? nudgeBackward
          : null
    withSeekFallback(done)
    if (nudge != null) {
      el.currentTime = nudge
      once(el, 'seeked', () => {
        el.currentTime = target
        once(el, 'seeked', done)
      })
      return
    }
    el.currentTime = target
    once(el, 'seeked', done)
  }

  const isMasterAudioBroken = (): boolean =>
    masterAudio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE || masterAudio.readyState === 0

  const runSeekAndPlay = (): void => {
    if (shouldSeekVideo && Number.isFinite(targetVideoSec)) {
      seekWithNudge(videoEl, Number(targetVideoSec), () => {
        videoSeekDone = true
        playSync()
      })
    }
    if (shouldSeekAudio && Number.isFinite(targetAudioSec)) {
      seekWithNudge(masterAudio, Number(targetAudioSec), () => {
        audioSeekDone = true
        playSync()
      })
    }
    if (videoEl.readyState < targetState) once(videoEl, 'canplay', playSync)
    if (masterAudio.readyState < targetState) once(masterAudio, 'canplay', playSync)
    queueMicrotask(playSync)
    window.setTimeout(playSync, 250)
  }

  if (isMasterAudioBroken() && masterAudio.src) {
    timelineEditLog('playback', 'playMasterVideoSynced masterAudio 복구(load)', {
      readyState: masterAudio.readyState,
      networkState: masterAudio.networkState
    })
    let recovered = false
    const continueAfterRecover = (): void => {
      if (recovered) return
      recovered = true
      runSeekAndPlay()
    }
    once(masterAudio, 'canplay', continueAfterRecover)
    once(masterAudio, 'loadeddata', continueAfterRecover)
    masterAudio.load()
    window.setTimeout(continueAfterRecover, 280)
    return
  }
  runSeekAndPlay()
}

function encodeWavFromAudioBuffer(buf: AudioBuffer): Blob {
  const numChannels = buf.numberOfChannels
  const sampleRate = buf.sampleRate
  const bitsPerSample = 16
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = buf.length * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < buf.length; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const sample = Math.max(-1, Math.min(1, buf.getChannelData(ch)[i] ?? 0))
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      view.setInt16(offset, int16, true)
      offset += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * 디코딩 버퍼에서 Peaks용 피크 JSON을 만든다.
 * Peaks.js 는 zoom scale 이 JSON 의 samples_per_pixel 보다 작으면 클램프하므로,
 * 네이티브 spp 가 크면(예: 512) 짧은 자막 줄도 한 화면에 못 담는다.
 * 일반 길이 미디어는 spp 를 낮추고, 초장시에는 픽셀 상한을 넘기지 않게 spp 를 올린다.
 */
function buildWaveformJsonFromAudioBuffer(buf: AudioBuffer, samplesPerPixelHint = 128): JsonWaveformData {
  const src = buf.getChannelData(0)
  /** 피크 픽셀 수 상한 — 500k 근처면 spp 가 다시 커져 Peaks 최소 줌(~zw*spp/sr)이 과도하게 넓어짐 */
  const targetMaxPixels = 980_000
  /** zw≈1900·48kHz·spp=48 ⇒ 최소 가시 구간 ~1.9s — spp=96 이면 ~3.8s 로 칩 타임라인과 어긋남 */
  const maxNativeSppForEditing = 48
  const minSpp = 32
  const adaptiveSpp = Math.ceil(src.length / targetMaxPixels)
  let spp = Math.max(minSpp, Math.floor(samplesPerPixelHint), adaptiveSpp)
  spp = Math.min(maxNativeSppForEditing, spp)
  let pixels = Math.max(1, Math.ceil(src.length / spp))
  if (pixels > targetMaxPixels) {
    spp = Math.max(minSpp, Math.ceil(src.length / targetMaxPixels))
    pixels = Math.max(1, Math.ceil(src.length / spp))
  }
  const data: number[] = new Array(pixels * 2)
  for (let p = 0; p < pixels; p += 1) {
    const start = p * spp
    const end = Math.min(src.length, start + spp)
    let min = 1
    let max = -1
    for (let i = start; i < end; i += 1) {
      const v = src[i] ?? 0
      if (v < min) min = v
      if (v > max) max = v
    }
    // Peaks.js v4 JSON 파형은 8-bit(min/max per pixel) 포맷으로 전달해야 안정적으로 초기화된다.
    data[p * 2] = Math.max(-128, Math.min(127, Math.round(min * 127)))
    data[p * 2 + 1] = Math.max(-128, Math.min(127, Math.round(max * 127)))
  }
  return {
    sample_rate: buf.sampleRate,
    samples_per_pixel: spp,
    bits: 8,
    length: pixels,
    data
  } as JsonWaveformData
}

function realignSubtitleWordBoundariesByWaveform(
  lines: SubtitleLine[],
  waveform: JsonWaveformData,
  durationSec: number
): { lines: SubtitleLine[]; changedWords: number } {
  const data = waveform.data ?? []
  if (data.length < 4 || !(durationSec > 0)) return { lines, changedWords: 0 }
  let pps = 0
  if (waveform.sample_rate && waveform.samples_per_pixel) {
    pps = waveform.sample_rate / waveform.samples_per_pixel
  } else if (waveform.length && waveform.length > 0) {
    pps = waveform.length / durationSec
  }
  if (!(pps > 1)) return { lines, changedWords: 0 }
  const pixels = Math.floor(data.length / 2)
  const amps = new Array<number>(pixels)
  for (let i = 0; i < pixels; i += 1) {
    amps[i] = Math.max(Math.abs(data[i * 2] ?? 0), Math.abs(data[i * 2 + 1] ?? 0))
  }
  const snapToValley = (timeSec: number): number => {
    const center = Math.max(0, Math.min(pixels - 1, Math.round(timeSec * pps)))
    const radius = Math.max(1, Math.round(0.08 * pps))
    let best = center
    let bestAmp = amps[center] ?? Number.POSITIVE_INFINITY
    const lo = Math.max(0, center - radius)
    const hi = Math.min(pixels - 1, center + radius)
    for (let i = lo; i <= hi; i += 1) {
      const a = amps[i] ?? Number.POSITIVE_INFINITY
      if (a < bestAmp) {
        bestAmp = a
        best = i
      }
    }
    return best / pps
  }

  let changedWords = 0
  const maxShiftSec = 0.12
  const next = lines.map((line) => {
    const words = line.words ?? []
    if (words.length === 0) return line
    let prevEnd = Math.max(0, line.start ?? 0)
    const nextWords = words.map((w) => {
      if (w.isDeleted) return w
      const s0 = Math.max(0, w.start)
      const e0 = Math.max(s0 + 0.02, w.end)
      const s1 = snapToValley(s0)
      const e1 = snapToValley(e0)
      const snappedStart = Math.abs(s1 - s0) <= maxShiftSec ? s1 : s0
      const snappedEnd = Math.abs(e1 - e0) <= maxShiftSec ? e1 : e0
      const start = Math.max(prevEnd + 0.004, snappedStart)
      const end = Math.max(start + 0.04, snappedEnd)
      prevEnd = end
      if (Math.abs(start - s0) > 1e-4 || Math.abs(end - e0) > 1e-4) changedWords += 1
      return { ...w, start, end }
    })
    const visibleNext = nextWords.filter((w) => !w.isDeleted)
    return {
      ...line,
      start: visibleNext[0]?.start ?? line.start,
      end: visibleNext[visibleNext.length - 1]?.end ?? line.end,
      words: nextWords
    }
  })
  return { lines: next, changedWords }
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
      if (Boolean(a.isDeleted) !== Boolean(b.isDeleted)) return true
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
  const previewEndMediaSecRef = useRef<number | null>(null)
  const oneShotRangeRef = useRef<{ start: number; end: number } | null>(null)
  const oneShotSessionSeqRef = useRef(0)
  const oneShotSessionRef = useRef<{ id: number; start: number; end: number; state: 'playing' | 'done' } | null>(null)
  /** 원샷 분석용 RAF 스냅샷 로그 간격(ms) — 너무 촘촘하면 로그만 비대해짐 */
  const PLAYBACK_TRACE_INTERVAL_MS = 100
  const playbackTraceLastMsRef = useRef(0)
  const finalizePlaybackStopRef = useRef<
    | ((
        reason: string,
        options?: { editSec?: number; mediaSec?: number; markUserPause?: boolean; soft?: boolean }
      ) => void)
    | null
  >(null)
  /**
   * `clearOneShotSession` 의 최신 클로저 핸들. `useEffect` 1회 등록 콜백(예: WebAudio onScheduleEnded)
   * 안에서 latest 클로저로 안전하게 호출하기 위함이다.
   */
  const clearOneShotSessionRef = useRef<((reason: string) => void) | null>(null)
  const masterAudioRef = useRef<HTMLAudioElement | null>(null)
  const webAudioMasterPlaybackRef = useRef<WebAudioMasterPlayback | null>(null)
  const deleteOpSeqRef = useRef(0)
  const lastDeleteOpIdRef = useRef<number | null>(null)
  const deleteProbeTimersRef = useRef<number[]>([])
  const pendingTogglePlayTimerRef = useRef<number | null>(null)
  const pendingSeekAndPlayTimerRef = useRef<number | null>(null)
  const pendingPlayEditRangeTimerRef = useRef<number | null>(null)
  const pendingSeekAfterGuardRef = useRef<{
    startSec: number
    basis: 'edit' | 'media'
    source: 'user-trusted' | 'user' | 'auto-focus' | 'navigate'
  } | null>(null)
  const pendingSeekAndPlayAfterGuardRef = useRef<{ startSec: number; basis: 'edit' | 'media' } | null>(null)
  const pendingPlayRangeAfterGuardRef = useRef<{ startSec: number; endSec: number } | null>(null)
  const pendingPlayIntentRef = useRef(false)
  const [pendingGuardQueueVersion, setPendingGuardQueueVersion] = useState(0)
  const [waveformAutoSeekBlockToken, setWaveformAutoSeekBlockToken] = useState(0)
  const deleteGuardUntilRef = useRef(0)
  const waveformFocusBlockUntilRef = useRef(0)
  const lastSeekIssuedRef = useRef<{ mediaSec: number; at: number; kind: 'seek' | 'seekAndPlay' | 'playRange' } | null>(null)
  const lastWaveformPlayRangeIntentRef = useRef<{
    at: number
    startSec: number
    endSec: number
    wordId: string | null
    wordText: string | null
  } | null>(null)
  const lastAutoResumeAtRef = useRef(0)
  /** media waiting/stalled — 버퍼링·디코드 지연 판정용 */
  const lastMediaBufferingAtRef = useRef(0)
  const playbackStartupVerifyTimerRef = useRef<number | null>(null)
  const playbackStartupProbeRef = useRef<{ startedAt: number; waStart: number | null } | null>(null)
  const audioPlayingSeenRef = useRef(false)
  const waLastMediaSecRef = useRef<number | null>(null)
  const lastPlayRangeIssuedRef = useRef<{ start: number; end: number; at: number } | null>(null)
  const activePlaybackScheduleRef = useRef<{
    kind: 'oneshot' | 'continuous'
    index: number
    segments: ScheduledMediaSegment[]
  } | null>(null)
  const playbackEnginePhaseRef = useRef<'idle' | 'playing'>('idle')
  const playbackCommandRouterRef = useRef(createPlaybackCommandRouter())
  const playbackSessionIdRef = useRef(0)
  const lastHumanInteractionAtRef = useRef(0)
  const userPauseRequestedRef = useRef(false)
  const oneShotSoftStopUntilRef = useRef(0)
  /**
   * 컷 시그니처가 바뀔 때마다 증가. 마스터 오디오 Blob이 이 세대에 맞게 준비되기 전까지 재생 매퍼는 대기.
   * (구 timelineRevision — 단, 오디오 미준비 상태에서 숫자만 앞서던 문제 제거)
   */
  const [playbackPendingRevision, setPlaybackPendingRevision] = useState(0)
  const playbackPendingRevisionRef = useRef(0)
  /** 마스터 오디오가 현재 컷 세대에 맞게 빌드 완료된 버전. pending 과 같을 때만 재생 허용. */
  const [playbackCommittedRevision, setPlaybackCommittedRevision] = useState(0)
  /** 동일 시크가 짧은 간격에 반복 로그될 때 timeline.log 노이즈 방지(더블클릭 등) */
  const seekToSubtitleStartLogDedupeRef = useRef<{ startSec: number; at: number } | null>(null)
  /** 단일 진실: 편집(프로그램) 타임라인 초 — 미디어 초는 항상 매핑으로 파생 */
  const playheadEditSecRef = useRef(0)
  const activeSubtitleIndexRef = useRef<number | null>(null)
  const isPlayingRef = useRef(false)
  const tickRef = useRef<() => void>(() => {})
  const previewCurrentTimeRef = useRef<HTMLSpanElement | null>(null)
  const previewSeekInputRef = useRef<HTMLInputElement | null>(null)
  const previewSubtitleTextRef = useRef<HTMLParagraphElement | null>(null)
  const subtitleListRootRef = useRef<HTMLDivElement | null>(null)
  /** 활성 자막 카드만 단어 칩 하이라이트 — 카드/단어 경계에서만 class 갱신 */
  const wordHighlightPrevCardRef = useRef<number | null>(null)
  const wordHighlightActiveChipElRef = useRef<HTMLElement | null>(null)
  const activeSubtitleCardIdxRef = useRef<number | null>(null)
  const waveformPeaksRef = useRef<SubtitleWaveformPeaksHandle>(null)
  const [durationSec, setDurationSec] = useState(0)
  /** Peaks 플레이어가 보고한 길이 — 미디어 메타 로드 후 다시 비교 */
  const peaksReportedDurationRef = useRef<number | null>(null)
  /** 파형 JSON·init 시 이론 타임라인 길이 — 비디오 컨테이너 duration 과 다를 수 있음 */
  const waveformTimelineExactRef = useRef<number | null>(null)
  /** Peaks 콜백으로 보정된 파형 기준 길이 — JSON만으로 길이 못 구할 때 보조 */
  const [waveformMediaSpanSec, setWaveformMediaSpanSec] = useState<number | null>(null)
  /** IPC 로드 peaks JSON — 편집축 길이는 여기서 바로 계산(timelineMediaEndHint 보다 위에 둠) */
  const [waveformPeaksJsonPath, setWaveformPeaksJsonPath] = useState<string | null>(null)
  const [waveformPeaksJsonData, setWaveformPeaksJsonData] = useState<JsonWaveformData | null>(null)
  /** 원본 피크 JSON 비동기 로드 중 — 완료 전에는 컨테이너 duration 으로 상한을 두지 않음 */
  const [waveformPeaksJsonLoading, setWaveformPeaksJsonLoading] = useState(false)
  /**
   * Stitched Peaks JSON LRU 캐시 — `(srcKey, cutSig) → JsonWaveformData`.
   *
   * - **Exact hit**: 같은 시그니처가 캐시에 있으면 **이전 reference 그대로** 반환 → `stitchedWaveformJsonComputed`
   *   소비처(`timelineMediaEndHint` / 자식 metrics / hydrate · 디버그 로그 effect 등) cascade 가 통째로 스킵된다.
   *   Undo/Redo 처럼 직전 시그니처로 되돌아갈 때 사실상 0ms.
   * - **Miss + expansion-only**: MRU 항목의 컷이 새 컷의 부분집합이면 `stitchWaveformJsonExpandCutsIncremental`
   *   로 splice (이전 단일 슬롯 캐시 경로 유지).
   * - **Full fallback**: 위 두 경로가 안 되면 `stitchWaveformJsonByCuts` 로 전체 계산 후 캐시 등록.
   *
   * 메모리: 출력 픽셀 데이터 ~6MB/entry. 기본 maxBytes 64MB · maxEntries 8.
   */
  const stitchedPeaksJsonCacheRef = useRef<StitchedPeaksJsonLruCache>(
    new StitchedPeaksJsonLruCache({ maxEntries: 8, maxBytes: 64 * 1024 * 1024 })
  )
  const [timelineAxisMismatch, setTimelineAxisMismatch] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  const applyTimelineMismatchFromReport = useCallback(() => {
    const TIMELINE_MATCH_EPS = 0.65
    const p = peaksReportedDurationRef.current
    const m = durationSec
    const jsonExact = waveformTimelineExactRef.current

    if (!(p != null && p > 0)) {
      setTimelineAxisMismatch(null)
      return
    }

    if (jsonExact != null && jsonExact > 0) {
      const peaksVsJson = Math.abs(p - jsonExact)
      if (peaksVsJson <= TIMELINE_MATCH_EPS) {
        if (m > 0 && Math.abs(p - m) > 0.35) {
          timelineEditLog(
            'playback-diag',
            'peaks aligned to waveform JSON; video container duration differs (common for mp4 — no banner)',
            {
              peaksDurationSec: p,
              mediaDurationSec: m,
              exactTimelineDurationSec: jsonExact,
              deltaPeaksMinusMedia: p - m
            }
          )
        }
        setTimelineAxisMismatch(null)
        return
      }
      timelineEditLog('playback-diag', 'axis mismatch: Peaks player vs waveform timeline length', {
        peaksDurationSec: p,
        exactTimelineDurationSec: jsonExact,
        deltaSec: peaksVsJson
      })
      setTimelineAxisMismatch(
        `파형 플레이어(${p.toFixed(2)}s)와 파형 데이터 기준 길이(${jsonExact.toFixed(2)}s)가 어긋납니다. 파형을 다시 생성해 보세요.`
      )
      return
    }

    if (!(m > 0)) {
      setTimelineAxisMismatch(null)
      return
    }
    const d = Math.abs(p - m)
    if (d > 0.35) {
      timelineEditLog('playback-diag', 'axis mismatch: peaks duration vs media duration (no JSON baseline)', {
        peaksDurationSec: p,
        mediaDurationSec: m,
        deltaSec: d
      })
      setTimelineAxisMismatch(
        `파형 길이(${p.toFixed(2)}s)와 미디어(${m.toFixed(2)}s)가 약 ${d.toFixed(1)}s 어긋납니다. 재생·단어 위치가 맞지 않을 수 있습니다.`
      )
    } else {
      setTimelineAxisMismatch(null)
    }
  }, [durationSec])

  useEffect(() => {
    applyTimelineMismatchFromReport()
  }, [applyTimelineMismatchFromReport])

  const onPeaksDurationComparedToMedia = useCallback(
    (info: {
      peaksDurationSec: number
      mediaDurationSec: number | undefined
      deltaSec: number | null
      exactTimelineDurationSec?: number | null
    }) => {
      peaksReportedDurationRef.current = info.peaksDurationSec
      if (info.exactTimelineDurationSec != null && info.exactTimelineDurationSec > 0) {
        waveformTimelineExactRef.current = info.exactTimelineDurationSec
        setWaveformMediaSpanSec(info.exactTimelineDurationSec)
      }
      applyTimelineMismatchFromReport()
    },
    [applyTimelineMismatchFromReport]
  )

  const freezeUiPlayheadRaf = useCallback(() => {
    if (rafPlayheadRef.current !== null) {
      window.cancelAnimationFrame(rafPlayheadRef.current)
      rafPlayheadRef.current = null
    }
  }, [])
  const resumeUiPlayheadRafIfPossible = useCallback(() => {
    queueMicrotask(() => {
      const fn = tickRef.current
      if (!fn || rafPlayheadRef.current !== null) return
      rafPlayheadRef.current = window.requestAnimationFrame(fn)
    })
  }, [])

  const [isBuffering, setIsBuffering] = useState(false)
  const [cutRanges, setCutRanges] = useState<CutRange[]>([])
  /** 가상 타임라인: 삭제 tombstone(isDeleted)만 상태로 유지 — 저장 시 활성 스냅샷과 합쳐 JSON 기록 */
  const [virtualTimelineDeleted, setVirtualTimelineDeleted] = useState<VirtualTimelineBlock[]>([])
  const cutRangesRef = useRef<CutRange[]>([])
  useEffect(() => {
    cutRangesRef.current = cutRanges
  }, [cutRanges])
  /** RAF·seek — 원본 미디어 시각이 하드 컷 + 단어 tombstone 구간에 들어가면 건너뜀 (렌더마다 동기화) */
  const mergedPlaybackSkipRangesRef = useRef<CutRange[]>([])
  const cutSigRef = useRef<string>('')
  /** stitched 결과 동일 시 로그 출력 생략 */
  const stitchedWaveformOutputSigRef = useRef<string | null>(null)
  /** 마스터 오디오 URL/모드/리비전 묶음 동일 시 중복 setState 생략 */
  const masterAudioLayoutKeyRef = useRef<string>('')
  useEffect(() => {
    const markHumanInteraction = (): void => {
      lastHumanInteractionAtRef.current = performance.now()
    }
    window.addEventListener('pointerdown', markHumanInteraction, true)
    window.addEventListener('keydown', markHumanInteraction, true)
    return () => {
      window.removeEventListener('pointerdown', markHumanInteraction, true)
      window.removeEventListener('keydown', markHumanInteraction, true)
    }
  }, [])
  useEffect(() => {
    const engine = new WebAudioMasterPlayback()
    webAudioMasterPlaybackRef.current = engine
    /**
     * **WebAudio 자연 종료 콜백 — oneShotSession 정리의 단일 결정점.**
     * 짧은 슬라이스(예: 97ms 단어) 재생 시, startup verify 타이머(180ms) 가 발화하기 전에
     * BufferSource 가 자연 종료되어 `isPlaying()` 만으로는 RAF/verify 어느 쪽도 종료를 못 잡고
     * `oneShotSessionRef` 가 `state:"playing"` 인 채 영구 잔존하여 이후 클릭이 전부
     * `dispatchPlayRangeIntentFromWaveform → queued` 로 막히는 경합이 있었다. 엔진이 직접 통지하는
     * 이 콜백이 정리의 단일 결정점이고, `reason==='stopped'` (외부 stopPlayback) 의 경우엔
     * 이미 다른 경로에서 정리되므로 여기서는 `'natural'` 만 처리.
     */
    engine.setOnScheduleEnded((scheduleId, reason) => {
      if (reason !== 'natural') return
      const lingering = oneShotSessionRef.current
      if (!lingering || lingering.state !== 'playing') return
      const endMedia = previewEndMediaSecRef.current ?? lingering.end
      oneShotSessionRef.current = { ...lingering, state: 'done' }
      try {
        playbackCommandRouterRef.current.finishRange(playbackSessionIdRef.current)
      } catch {
        /* ignore router-finalize errors so cleanup always runs */
      }
      playbackSessionIdRef.current = 0
      try {
        /**
         * `soft:false` 로 가드를 완전히 풀면 자연 종료 직후 idle drift guard 가 즉시 비디오를
         * pause/seek 해 다른 effect 와 경합 → "Maximum update depth exceeded" 가 뜨는 회귀가
         * 있었다. `finalizePlaybackStop` 본체에서 가드 길이를 짧게(120ms) 유지하므로 다시 soft:true 로.
         */
        finalizePlaybackStopRef.current?.('webaudio natural end', { mediaSec: endMedia, soft: true })
      } catch {
        /* ignore */
      }
      try {
        clearOneShotSessionRef.current?.('webaudio natural end')
      } catch {
        /* ignore */
      }
      wfLog('peaks', 'startSyncedPlayback [diag-6] WebAudio 자연 종료 콜백 — one-shot 정리', {
        scheduleId,
        sessionId: lingering.id,
        sessionEndMediaSec: lingering.end
      })
    })
    return () => {
      engine.setOnScheduleEnded(null)
      engine.dispose()
      if (webAudioMasterPlaybackRef.current === engine) {
        webAudioMasterPlaybackRef.current = null
      }
    }
  }, [])

  const logDeletePlaybackSnapshot = useCallback(
    (phase: string, details?: Record<string, unknown>) => {
      const v = videoRef.current
      const a = masterAudioRef.current
      timelineEditLog('word-delete', phase, {
        deleteOpId: lastDeleteOpIdRef.current,
        isPlayingState: isPlaying,
        playheadEditSec: playheadEditSecRef.current,
        cutCount: cutRangesRef.current.length,
        video: v
          ? {
              currentTime: v.currentTime,
              paused: v.paused,
              seeking: v.seeking,
              readyState: v.readyState,
              networkState: v.networkState,
              duration: Number.isFinite(v.duration) ? v.duration : null
            }
          : null,
        masterAudio: a
          ? {
              currentTime: a.currentTime,
              paused: a.paused,
              readyState: a.readyState,
              networkState: a.networkState,
              duration: Number.isFinite(a.duration) ? a.duration : null
            }
          : null,
        ...details
      })
    },
    [isPlaying]
  )

  const isDeleteGuardActive = useCallback((): boolean => performance.now() < deleteGuardUntilRef.current, [])

  const armDeleteGuard = useCallback(
    (reason: string, ms = 280) => {
      const now = performance.now()
      const requestedUntil = now + ms
      const curUntil = deleteGuardUntilRef.current
      // 연속 삭제 시 guard가 누적되어 커서가 수 초간 먹통이 되는 현상을 막기 위해
      // 활성 guard에는 최대 +320ms만 추가 연장한다.
      const cappedExtendUntil = curUntil > now ? Math.min(requestedUntil, curUntil + 120) : requestedUntil
      deleteGuardUntilRef.current = Math.max(curUntil, cappedExtendUntil)
      /** 삭제 직후 파형 포커스만 막음 — +350ms 는 체감 지연이 커서 +120ms 로 축소 (가드 본체는 `deleteGuardUntil` 로 유지) */
      waveformFocusBlockUntilRef.current = Math.max(waveformFocusBlockUntilRef.current, deleteGuardUntilRef.current + 120)
      // 삭제 트랜잭션마다 파형 auto-focus seek 차단 토큰을 갱신한다.
      setWaveformAutoSeekBlockToken((v) => v + 1)
      timelineEditLog('word-delete', 'delete guard armed', {
        deleteOpId: lastDeleteOpIdRef.current,
        reason,
        ms,
        untilMs: deleteGuardUntilRef.current
      })
    },
    []
  )

  const bumpPendingQueue = useCallback(() => {
    setPendingGuardQueueVersion((v) => v + 1)
  }, [])

  const queuePlaybackIntent = useCallback(
    (
      intent:
        | {
            kind: 'seek'
            startSec: number
            basis: 'edit' | 'media'
            source?: 'user-trusted' | 'user' | 'auto-focus' | 'navigate'
          }
        | { kind: 'seekAndPlay'; startSec: number; basis: 'edit' | 'media' }
        | { kind: 'playRange'; startSec: number; endSec: number }
        | { kind: 'play' }
    ): void => {
      if (intent.kind === 'seek') {
        pendingSeekAfterGuardRef.current = {
          startSec: intent.startSec,
          basis: intent.basis,
          source: intent.source ?? 'user-trusted'
        }
      } else if (intent.kind === 'seekAndPlay') {
        pendingSeekAndPlayAfterGuardRef.current = { startSec: intent.startSec, basis: intent.basis }
        pendingPlayIntentRef.current = true
      } else if (intent.kind === 'playRange') {
        pendingPlayRangeAfterGuardRef.current = { startSec: intent.startSec, endSec: intent.endSec }
        pendingPlayIntentRef.current = true
      } else {
        pendingPlayIntentRef.current = true
      }
      bumpPendingQueue()
    },
    [bumpPendingQueue]
  )

  const clearPlaybackStartupVerifyTimer = useCallback(() => {
    if (playbackStartupVerifyTimerRef.current != null) {
      window.clearTimeout(playbackStartupVerifyTimerRef.current)
      playbackStartupVerifyTimerRef.current = null
    }
  }, [])
  const isEdlSessionActive = useCallback((): boolean => {
    return playbackSessionIdRef.current !== 0 || activePlaybackScheduleRef.current != null || oneShotSessionRef.current != null
  }, [])

  const markPlaybackActiveIfAudioClockReady = useCallback(
    (source: 'audio' | 'video') => {
      if (!isEdlSessionActive()) return
      const audio = masterAudioRef.current
      const engine = webAudioMasterPlaybackRef.current
      const waPlaying = engine?.isPlaying() === true
      const waNow = engine?.getCurrentMediaSec() ?? null
      const probe = playbackStartupProbeRef.current
      const waProgress =
        waNow != null
          ? probe != null && probe.waStart != null
            ? waNow >= probe.waStart + 0.025
            : waPlaying && (waLastMediaSecRef.current == null || waNow >= waLastMediaSecRef.current + 0.004)
          : false
      const audioPlayingSeen = audioPlayingSeenRef.current
      const canCommit = audioPlayingSeen || waProgress
      if (waNow != null && Number.isFinite(waNow)) {
        waLastMediaSecRef.current = waNow
      }
      if (!canCommit) {
        timelineEditLog('playback', `playing gate held(${source})`, {
          enginePlaybackDesired: isEdlSessionActive(),
          phase: playbackEnginePhaseRef.current,
          waPlaying,
          waNow,
          waProbeStart: probe?.waStart ?? null,
          waProgress,
          audioPlayingSeen,
          audioPaused: audio?.paused ?? null,
          audioReadyState: audio?.readyState ?? null
        })
        return
      }
      playbackEnginePhaseRef.current = 'playing'
      playbackStartupProbeRef.current = null
      waLastMediaSecRef.current = null
      clearPlaybackStartupVerifyTimer()
      setIsBuffering(false)
      setIsPlaying(true)
      resumeUiPlayheadRafIfPossible()
    },
    [clearPlaybackStartupVerifyTimer, isEdlSessionActive, resumeUiPlayheadRafIfPossible]
  )

  const isWaveformFocusSuppressed = useCallback((): boolean => {
    return (
      performance.now() < waveformFocusBlockUntilRef.current ||
      isDeleteGuardActive() ||
      isBuffering ||
      (playbackSessionIdRef.current !== 0 || activePlaybackScheduleRef.current != null || oneShotSessionRef.current != null) ||
      playbackEnginePhaseRef.current !== 'idle'
    )
  }, [isDeleteGuardActive, isBuffering])

  const beginPlaybackSession = useCallback((sessionId: number) => {
    playbackSessionIdRef.current = sessionId
  }, [])

  const clearPlaybackSession = useCallback(() => {
    playbackCommandRouterRef.current.cancelSession(playbackSessionIdRef.current)
    playbackSessionIdRef.current = 0
  }, [])

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

  /** SSOT: 문장·토큰 타임라인 — UI·내보내기·Peaks는 파생 `subtitles`(SubtitleLine[]) */
  const [sentenceTokenTimeline, setSentenceTokenTimeline] = useState<SentenceTokenTimeline>([])
  const subtitles = useMemo(
    () => sentenceTokenTimelineToSubtitleLines(sentenceTokenTimeline),
    [sentenceTokenTimeline]
  )
  const subtitlesRef = useRef(subtitles)
  subtitlesRef.current = subtitles
  const [silenceSplitPending, setSilenceSplitPending] = useState(false)
  const silenceSplitRunKeyRef = useRef<string | null>(null)
  const autoWordRealignRunKeyRef = useRef<string | null>(null)
  /**
   * Undo/Redo 항목은 **세 state 한 묶음** 으로 저장한다.
   * - `subtitles`: 단어 tombstone(isDeleted) 토글·split·merge 등 자막 그래프 자체의 스냅샷
   * - `virtualTimelineDeleted`: 가상 타임라인 삭제 구간(파형 stitch 입력)
   * - `cutRanges`: 하드 타임라인 컷 (오디오 파동에서의 time-range 자르기)
   *
   * 이전엔 `subtitles` 만 push 해서 Ctrl+Z 후에도 `virtualTimelineDeleted` 가 그대로 남아
   * 파형 stitched cuts 가 유지 → 사용자 입장에서 "복구 안됨" 처럼 보였다.
   */
  type SubtitleHistoryEntry = {
    subtitles: SubtitleLine[]
    virtualTimelineDeleted: VirtualTimelineBlock[]
    cutRanges: CutRange[]
  }
  const undoStackRef = useRef<SubtitleHistoryEntry[]>([])
  const redoStackRef = useRef<SubtitleHistoryEntry[]>([])
  /** virtualTimelineDeleted 의 최신 값 ref — applySubtitleChange/undo/redo 가 동기 캡처 */
  const virtualTimelineDeletedRef = useRef<VirtualTimelineBlock[]>([])
  useEffect(() => {
    virtualTimelineDeletedRef.current = virtualTimelineDeleted
  }, [virtualTimelineDeleted])
  /** 마지막으로 저장/연 `.autosub` 경로 — 「저장」 덮어쓰기용 */
  const projectFilePathRef = useRef<string | null>(null)

  const [isExtracting, setIsExtracting] = useState(false)
  /** IPC 100% 이후 — 리스트·가상행 레이아웃이 끝날 때까지 오버레이 유지할 때 true */
  const [extractAwaitListPaint, setExtractAwaitListPaint] = useState(false)
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
  const [gapFillWhenBuildingVrew, setGapFillWhenBuildingVrew] = useState(false)
  const [masterAudioSrcUrl, setMasterAudioSrcUrl] = useState<string | undefined>(undefined)
  const masterAudioBlobUrlRef = useRef<string | null>(null)
  const mergedCutRanges = useMemo(() => mergeCutRanges([...cutRanges]), [cutRanges])

  /**
   * Phase 2 / 8 — READ 플래그 시 목록·파형 영역에서 파생 줄 수만 참조.
   * `SubtitleVirtualList` 인덱스는 여전히 `subtitles` SSOT 기준(플래그 true일 때 매핑 추가 전까지).
   */
  const subtitlesForListRaw = useMemo(() => {
    if (!READ_SUBTITLES_FROM_VIRTUAL_TIMELINE) return subtitles
    return deriveVisibleSubtitleLinesForUi(subtitles, mergedCutRanges, virtualTimelineDeleted)
  }, [subtitles, mergedCutRanges, virtualTimelineDeleted])
  /** element-wise 동일하면 이전 array reference 유지 → 자식 `SubtitleVirtualList` 의 prop 안정 */
  const subtitlesForList = useStableArrayReference(subtitlesForListRaw) as SubtitleLine[]

  const peaksStitchCutSig = useMemo(() => cutRangesSignature(mergedCutRanges), [mergedCutRanges])

  /** 표시용 Peaks JSON 스티치만 — 하드 컷 + 단어 tombstone + 가상 삭제 블록 (재생 매핑은 mergedCutRanges 유지) */
  const mergedWaveformPeaksStitchCutsRaw = useMemo(
    () => mergeWaveformPeaksStitchCutRanges(mergedCutRanges, subtitles, virtualTimelineDeleted),
    [mergedCutRanges, subtitles, virtualTimelineDeleted]
  )
  /**
   * `mergeWaveformPeaksStitchCutRanges` 는 매번 새 `CutRange[]` 를 반환한다(`mergeCutRanges` 내부 sort/병합).
   * 의미상 동일(시작·끝 모두 동일) 하면 이전 reference 를 유지해야 downstream useMemo 들 (`stitchedWaveformJsonComputed`,
   * `timelineMediaEndHint`, `timelineMapping`, `playbackTimelineMapping`) 의 deps 가 stable 해진다.
   */
  const mergedWaveformPeaksStitchCuts = useStableArrayReference(
    mergedWaveformPeaksStitchCutsRaw,
    cutRangeShallowEqual
  ) as CutRange[]
  const waveformPeaksStitchCutSig = useMemo(
    () => cutRangesSignature(mergedWaveformPeaksStitchCuts),
    [mergedWaveformPeaksStitchCuts]
  )
  /** 렌더마다 동기화해 RAF·이벤트 콜백이 최신 tombstone 까지 반영된 스킵 리스트를 즉시 본다 */
  mergedPlaybackSkipRangesRef.current = mergedWaveformPeaksStitchCuts

  /**
   * Peaks JSON 스티치(740k+ 픽셀 버퍼) 입력만 deferred — tombstone/가상삭제가 `subtitles` 에 즉시 반영되면
   * `mergeWaveformPeaksStitchCutRanges` → `stitchWaveformJsonByCuts` → 캔버스/Peaks 초기화가 **첫 commit** 에 묶여
   * waveform.log 의 ~800ms longtask 가 난다(스티치 자체 로그는 수 ms).
   *
   * `useDeferredValue` 로 1~2프레임 늦추면: 단어 카드·타임라인·재생(`mergedWaveformPeaksStitchCuts` 즉시) 은 그대로,
   * 파형 비트맵만 짧게 따라온다. 이전에 시도했던 *stitched 출력* 자체를 defer 하는 것과 달리,
   * 매핑은 즉시 컷 리스트를 쓰고 **픽셀 데이터 생성** 만 한 박자 늦다.
   */
  const subtitlesDeferredForPeaksJsonStitch = useDeferredValue(subtitles)
  const virtualTimelineDeletedDeferredForPeaksJsonStitch = useDeferredValue(virtualTimelineDeleted)
  const mergedWaveformPeaksStitchCutsForPeaksJsonOnlyRaw = useMemo(
    () =>
      mergeWaveformPeaksStitchCutRanges(
        mergedCutRanges,
        subtitlesDeferredForPeaksJsonStitch,
        virtualTimelineDeletedDeferredForPeaksJsonStitch
      ),
    [
      mergedCutRanges,
      subtitlesDeferredForPeaksJsonStitch,
      virtualTimelineDeletedDeferredForPeaksJsonStitch
    ]
  )
  /** 동일 — `stitchedWaveformJsonComputed` deps stable 화. cut 시그니처 동일하면 LRU exact hit 와 함께 0ms. */
  const mergedWaveformPeaksStitchCutsForPeaksJsonOnly = useStableArrayReference(
    mergedWaveformPeaksStitchCutsForPeaksJsonOnlyRaw,
    cutRangeShallowEqual
  ) as CutRange[]

  /** 원본 피크 JSON 미디어 길이 — 스티치 상한·타임라인 힌트와 순환 참조 없음 */
  const rawWaveformTimelineDurationSec = useMemo((): number => {
    const durHint = durationSec > 0 ? durationSec : undefined
    if (waveformPeaksJsonData) {
      const fromJson = exactTimelineDurationSecFromWaveformJson(waveformPeaksJsonData, durHint)
      if (fromJson != null && fromJson > 0) return fromJson
    }
    if (waveformMediaSpanSec != null && waveformMediaSpanSec > 0) return waveformMediaSpanSec
    if (durationSec > 0) return durationSec
    return 0
  }, [durationSec, waveformMediaSpanSec, waveformPeaksJsonData])

  /**
   * 단어 tombstone/가상 삭제 구간을 피크 배열에서 실제로 잘라 낸 편집축 Peaks JSON — 동기 계산.
   * 디바운스/setState 폴백 없이 항상 `stitchedWaveformJsonComputed ?? waveformPeaksJsonData` 두 가지 중 하나만 그린다.
   *
   * **컷이 하나라도 있으면 스티치** — 하드 타임라인 컷(`mergedCutRanges`) 없이 단어 tombstone(`isDeleted`) 만
   * 발생한 경우에도 `mergedWaveformPeaksStitchCuts` 에는 들어가므로 동일하게 스티치를 돌려 파형 UI 에 삭제 구간을
   * 즉시 반영한다. (이전에는 `mergedCutRanges.length === 0` 이면 무조건 null 로 폴백 → 단어 삭제 시 파형이
   * 줄어들지 않던 버그가 있었음.)
   *
   * 비용 — 스티치 자체는 동기 픽셀 복사이지만 컷 시그니처가 바뀔 때만 재계산되며, Peaks `precomputedWaveformSig`
   * 도 길이/데이터 길이 기반이라 같은 시그니처 결과면 `destroy/init` 루프는 발생하지 않는다.
   *
   * 입력 컷은 `mergedWaveformPeaksStitchCutsForPeaksJsonOnly`(deferred subtitles) — 삭제 직후 첫 paint 에
   * 거대 버퍼 생성이 메인 스레드를 막지 않도록 한다.
   */
  const stitchedWaveformJsonComputed = useMemo((): JsonWaveformData | null => {
    const cache = stitchedPeaksJsonCacheRef.current
    if (!videoPath || !waveformPeaksJsonData) {
      cache.clear()
      return null
    }
    const wf = waveformPeaksJsonData
    const newCuts = mergedWaveformPeaksStitchCutsForPeaksJsonOnly
    const stitchDur = rawWaveformTimelineDurationSec
    if (!(stitchDur > 0)) return null
    if (newCuts.length === 0) return null

    const srcKey = `${videoPath}|${wf.length ?? 0}|${stitchDur.toFixed(4)}`
    const newSig = cutRangesSignature(newCuts)

    /**
     * 1) **Exact hit** — 같은 시그니처가 캐시에 있으면 이전 reference 그대로 반환.
     *    Undo/Redo 가 직전 상태로 돌아갈 때 사실상 0ms 이고, 다운스트림 cascade 도 reference 동일성으로 스킵.
     */
    const exact = cache.get(srcKey, newSig)
    if (exact) {
      wfLog('perf', 'stitched peaks JSON 캐시 hit (LRU)', {
        cutCount: newCuts.length,
        outPixels: exact.out.length ?? 0,
        cacheEntries: cache.size()
      })
      return exact.out
    }

    /**
     * 2) **Miss + expansion-only** — MRU 항목의 컷이 새 컷의 부분집합이면 splice 만으로 확장.
     *    1473 word 환경에서 단일 단어 삭제의 일반 경로.
     */
    const mru = cache.peekMru(srcKey, newSig)
    if (mru && cutRemovedIntervalsExpandOnly(mru.mergedCuts, newCuts)) {
      const tInc = performance.now()
      const inc = stitchWaveformJsonExpandCutsIncremental(mru.out, mru.mergedCuts, wf, newCuts, stitchDur)
      if (inc) {
        const entry = cache.set(srcKey, newSig, { mergedCuts: mergeCutRanges([...newCuts]), out: inc })
        wfLog('perf', 'stitchWaveformJsonExpandCutsIncremental', {
          ms: Math.round(performance.now() - tInc),
          cutCount: newCuts.length,
          outPixels: inc.length ?? 0,
          cacheEntries: cache.size(),
          cacheBytes: cache.bytes()
        })
        return entry.out
      }
    }

    /**
     * 3) **Full fallback** — 전체 계산. 결과는 LRU 에 등록되어 다음 Undo/Redo 때 0ms hit.
     */
    try {
      const t0 = performance.now()
      const out = stitchWaveformJsonByCuts(wf, newCuts, stitchDur)
      wfLog('perf', 'stitchWaveformJsonByCuts 동기 계산', {
        ms: Math.round(performance.now() - t0),
        cutCount: newCuts.length,
        srcPixels: wf.length ?? 0,
        outPixels: out?.length ?? 0,
        stitchDurSec: Math.round(stitchDur * 100) / 100
      })
      if (out) {
        const entry = cache.set(srcKey, newSig, { mergedCuts: mergeCutRanges([...newCuts]), out })
        return entry.out
      }
      return null
    } catch (e) {
      wfLog('perf', 'stitchWaveformJsonByCuts 예외', {
        message: e instanceof Error ? e.message : String(e)
      })
      return null
    }
  }, [
    videoPath,
    waveformPeaksJsonData,
    mergedWaveformPeaksStitchCutsForPeaksJsonOnly,
    rawWaveformTimelineDurationSec
  ])

  /**
   * 과거 시도: stitched **출력** 전체를 `useDeferredValue` 하면 인라인 단어 레일과 픽셀 축이 어긋져 싱크가 깨졌다.
   * 현재: 매핑·재생은 즉시 컷(`mergedWaveformPeaksStitchCuts`), Peaks JSON 생성 입력만 deferred.
   */

  /**
   * 컷·tombstone 스티치 시그니처 변경 → pending revision 만 증가.
   * committed 는 master audio effect (videoPath/baseUrl/sig/rev 묶음) 가 단일 소유 —
   * 두 setter 를 같은 commit 안에서 함께 set 하면 `playbackSnapshot` useMemo 가 한 commit 안에 두 번 새 객체를 만들어
   * 소비처 useCallback 들이 매번 새 ref 가 되고 nested-update / idle 폭주의 출발점이 된다.
   * (하드 컷이 없을 때 mapperReady 고착은 `isPlaybackMapperReady` 가 직접 해소한다.)
   */
  useEffect(() => {
    const sig = waveformPeaksStitchCutSig
    if (sig === cutSigRef.current) return
    cutSigRef.current = sig
    playbackPendingRevisionRef.current += 1
    setPlaybackPendingRevision(playbackPendingRevisionRef.current)
  }, [waveformPeaksStitchCutSig])

  /**
   * 편집축 미디어 끝 — 스티치 파형 → 원본 파형 → Peaks 보조 → 컨테이너 메타.
   * 정책: “끝은 실오디오(파형) 기준”. Peaks JSON 로딩 중에는 컨테이너 `durationSec` 와
   * 이전 세션 잔존 `waveformMediaSpanSec` 를 무시하고 자막 끝만 임시 상한으로 쓴다.
   */
  const timelineMediaEndHint = useMemo(() => {
    const subtitleEnd = subtitles.reduce((m, line) => Math.max(m, line.end ?? 0), 0)
    const durHint = durationSec > 0 ? durationSec : undefined
    /**
     * 편집축 길이는 **즉시** `mergedWaveformPeaksStitchCuts` 로 계산한다.
     * `stitchedWaveformJsonComputed` 는 deferred 입력이라 삭제 직후 한두 프레임 옛 길이를 유지하면
     * `createTimelineMapping` 의 클립·`mapMediaToEditSec` 과 실제 오디오·단어 하이라이트가 어긋난다.
     */
    if (
      waveformPeaksJsonData &&
      mergedWaveformPeaksStitchCuts.length > 0 &&
      rawWaveformTimelineDurationSec > 0
    ) {
      const fromImmediateCuts = stitchedEditAxisDurationSecFromCuts(
        waveformPeaksJsonData,
        mergedWaveformPeaksStitchCuts,
        rawWaveformTimelineDurationSec,
        durHint
      )
      if (fromImmediateCuts != null && fromImmediateCuts > 0) return fromImmediateCuts
    }
    if (stitchedWaveformJsonComputed) {
      const fromStitched = exactTimelineDurationSecFromWaveformJson(stitchedWaveformJsonComputed, durHint)
      if (fromStitched != null && fromStitched > 0) return fromStitched
    }
    if (waveformPeaksJsonData) {
      const fromJson = exactTimelineDurationSecFromWaveformJson(waveformPeaksJsonData, durHint)
      if (fromJson != null && fromJson > 0) return fromJson
    }
    if (waveformPeaksJsonLoading) return Math.max(subtitleEnd, 0)
    if (waveformMediaSpanSec != null && waveformMediaSpanSec > 0) return waveformMediaSpanSec
    if (!(durationSec > 0)) return Math.max(subtitleEnd, 0)
    return durationSec
  }, [
    durationSec,
    subtitles,
    waveformMediaSpanSec,
    waveformPeaksJsonData,
    waveformPeaksJsonLoading,
    mergedWaveformPeaksStitchCuts,
    rawWaveformTimelineDurationSec,
    stitchedWaveformJsonComputed
  ])

  /** 하드 컷 + 단어 tombstone 미디어 구간 — 편집↔미디어 클립·재생 EDL·스킵 공통 입력 */
  const timelineMapping = useMemo((): TimelineMapping => {
    return createTimelineMapping(mergedWaveformPeaksStitchCuts, timelineMediaEndHint)
  }, [mergedWaveformPeaksStitchCuts, timelineMediaEndHint])
  /**
   * 재생 매핑 — 클립은 하드 컷 + tombstone 모두 빼고, masterMode 는 **실제 하드 컷**이 있을 때만 stitched.
   * tombstone 만 있으면 passthrough + 클립 갭으로 미디어 구간을 빼면 RAF·skipCutRangeAt 가 동일 리스트로 jump.
   */
  const playbackTimelineMapping = useMemo((): TimelineMapping => {
    const stitchedPlayback = mergedCutRanges.length > 0
    return createTimelineMapping(mergedWaveformPeaksStitchCuts, timelineMediaEndHint, {
      masterMode: stitchedPlayback ? 'stitched' : 'passthrough'
    })
  }, [mergedCutRanges.length, mergedWaveformPeaksStitchCuts, timelineMediaEndHint])
  const playbackTimelineMappingRef = useRef(playbackTimelineMapping)
  playbackTimelineMappingRef.current = playbackTimelineMapping
  /** Web Audio·스티치 빌드 시 동일하게 쓸 원본 미디어 URL(blob 아님) */
  const waveformMediaUrl = useMemo(
    () => (videoPath ? window.api.getMediaFileUrl(videoPath) : undefined),
    [videoPath]
  )
  const playbackSnapshot = useMemo(
    () => ({
      pendingRevision: playbackPendingRevision,
      committedRevision: playbackCommittedRevision,
      mapperReady: playbackCommittedRevision >= playbackPendingRevision,
      masterMode: playbackTimelineMapping.masterMode
    }),
    [playbackPendingRevision, playbackCommittedRevision, playbackTimelineMapping.masterMode]
  )
  const isPlaybackMapperReady = useCallback((): boolean => {
    /**
     * 하드 타임라인 컷(`mergedCutRanges`)이 없을 때는 단어 tombstone 만으로
     * `mergedWaveformPeaksStitchCuts` 가 생긴다. 이때 UI용 `timelineMapping` 은 stitched,
     * `playbackTimelineMapping` 은 의도적으로 passthrough — `committed >= pending` 동기화는
     * 마스터 오디오 URL 이 바뀌지 않아 master audio effect 가 layoutKey 같음으로 early-return 하면 영원히 안 따라잡는다.
     * 이 조합에서는 `mapperReady` / `masterMode` 검사를 모두 건너뛰고 즉시 ready 로 본다.
     * (그러지 않으면 `isPlaybackTransactionLocked` → `playRange` 가 큐에만 쌓이고 재생이 멈춘다.)
     */
    if (mergedCutRanges.length === 0) return true
    if (!playbackSnapshot.mapperReady) return false
    return timelineMapping.masterMode === playbackSnapshot.masterMode
  }, [
    playbackSnapshot.mapperReady,
    playbackSnapshot.masterMode,
    timelineMapping.masterMode,
    mergedCutRanges.length
  ])
  useEffect(() => {
    playbackCommandRouterRef.current.setMappingRevision(
      playbackSnapshot.pendingRevision,
      playbackSnapshot.committedRevision
    )
  }, [playbackSnapshot.pendingRevision, playbackSnapshot.committedRevision])
  const firstWordStartSec = useMemo(() => {
    let first = Number.POSITIVE_INFINITY
    for (const line of subtitles) {
      const ws = line.words ?? []
      if (ws.length > 0) {
        for (const w of ws) first = Math.min(first, w.start)
      } else {
        first = Math.min(first, line.start ?? Number.POSITIVE_INFINITY)
      }
    }
    return Number.isFinite(first) ? Math.max(0, first) : null
  }, [subtitles])
  const autoGlobalSyncOffsetSec = 0
  const mapEditToMediaSec = useCallback(
    (sec: number): number => Math.max(0, timelineMapping.programToMediaSec(sec)),
    [timelineMapping]
  )

  const mapMediaToEditSec = useCallback(
    (sec: number): number => Math.max(0, timelineMapping.mediaToProgramSec(sec)),
    [timelineMapping]
  )

  const applySubtitleChangeRef = useRef<typeof applySubtitleChange | null>(null)
  const wordEdgeSubtitleBridge = useMemo(
    () =>
      gapFillWhenBuildingVrew
        ? undefined
        : {
            getSubtitleLines: () => subtitlesRef.current,
            onSubtitleLinesCommit: (lines: SubtitleLine[]) => {
              setGapFillWhenBuildingVrew(false)
              const fn = applySubtitleChangeRef.current
              if (fn) fn(() => lines)
              else setSentenceTokenTimeline(subtitleLinesToSentenceTokenTimeline(lines))
            },
            onSubtitleLinesPreview: (lines: SubtitleLine[]) => {
              const fn = applySubtitleChangeRef.current
              if (fn) fn(() => lines, { recordHistory: false })
            },
            onSubtitleLinesRevert: (snapshot: SubtitleLine[]) => {
              const fn = applySubtitleChangeRef.current
              if (fn) fn(() => snapshot, { recordHistory: false })
            },
            editSecToMediaSec: mapEditToMediaSec,
            mediaSecToEditSec: mapMediaToEditSec
          },
    [gapFillWhenBuildingVrew, mapEditToMediaSec, mapMediaToEditSec]
  )

  /**
   * 편집축 스티치 파형을 쓰지 않을 때(Peaks = 원본 미디어 축) 플레이헤드만 program→media 로 맞춤.
   * 스티치 파형(편집 축)일 때는 좌표가 이미 program 축이므로 undefined.
   *
   * NOTE: `mapEditToMediaSec` 보다 **뒤에 선언**해야 TDZ(Cannot access ... before initialization) 미발생.
   */
  const waveformPlayheadProgramToPeaksSec = useMemo(
    () => (stitchedWaveformJsonComputed == null ? mapEditToMediaSec : undefined),
    [stitchedWaveformJsonComputed, mapEditToMediaSec]
  )

  /** 파형·클립 매핑 기준 편집 축 상한(초) — 컨테이너 duration 보다 짧을 수 있음 */
  const programTimelineEndEditSec = useMemo((): number => {
    const pd = programDurationSec(timelineMapping.clips)
    if (pd > 0) return pd
    if (timelineMediaEndHint > 0) return Math.max(0, mapMediaToEditSec(timelineMediaEndHint))
    return 0
  }, [timelineMapping, timelineMediaEndHint, mapMediaToEditSec])

  /** 살아 있는 단어 구간의 미디어 축 끝 — 재생·UI 상한 클램프용 */
  const visibleWordsMediaEndSec = useMemo(
    () => lastPlaybackEndSec(playbackIntervalsFromSubtitleLines(subtitles)),
    [subtitles]
  )

  /** 진행 바·플레이헤드 상한 — 매핑된 편집 길이와 마지막 유효 단어 끝 중 짧은 쪽 */
  const uiTimelineEndEditSec = useMemo((): number => {
    const prog = programTimelineEndEditSec
    const lastMedia = visibleWordsMediaEndSec
    if (lastMedia == null || !Number.isFinite(lastMedia)) return prog
    const mappedEnd = mapMediaToEditSec(lastMedia)
    if (!(mappedEnd > 0)) return prog
    if (prog > 0) return Math.min(prog, mappedEnd)
    return mappedEnd
  }, [programTimelineEndEditSec, mapMediaToEditSec, visibleWordsMediaEndSec])

  const clampProgramEditSec = useCallback(
    (editSec: number): number => {
      const x = Math.max(0, Number.isFinite(editSec) ? editSec : 0)
      const end = uiTimelineEndEditSec
      if (end > 0) return Math.min(x, end)
      return x
    },
    [uiTimelineEndEditSec]
  )

  const uiTimelineEndEditSecRef = useRef(0)
  useEffect(() => {
    uiTimelineEndEditSecRef.current = uiTimelineEndEditSec
  }, [uiTimelineEndEditSec])

  /**
   * 파형·자막 목록에 넘기는 총 길이 — 편집 프로그램 길이 우선, 그다음 파형 끝 힌트, 그다음 컨테이너 duration.
   * UI 가 컨테이너 938s 와 파형 928s 를 동시에 노출해 어색해지는 걸 막기 위한 단일 진입점.
   */
  const waveformUiDurationSec = useMemo((): number | undefined => {
    if (programTimelineEndEditSec > 0) return programTimelineEndEditSec
    if (timelineMediaEndHint > 0) return timelineMediaEndHint
    if (waveformPeaksJsonLoading) return undefined
    if (durationSec > 0) return durationSec
    return undefined
  }, [programTimelineEndEditSec, timelineMediaEndHint, waveformPeaksJsonLoading, durationSec])

  /** 파형·진단용 미디어 길이 상한 — 파일 끝과 마지막 유효 단어 끝 중 짧은 쪽 */
  const waveformMediaDurationCapSec = useMemo((): number | undefined => {
    const vm = visibleWordsMediaEndSec
    if (vm == null) return undefined
    if (durationSec > 0) return Math.min(durationSec, vm)
    return vm
  }, [visibleWordsMediaEndSec, durationSec])

  /** 편집 타임라인 초를 ref·미리보기·자막 DOM·파형 재생선에 반영하는 단일 진입점 */
  const commitEditSecToUi = useCallback(
    (editSecRaw: number) => {
      const editSec = clampProgramEditSec(editSecRaw)
      playheadEditSecRef.current = editSec
      /**
       * **`subtitles` 는 deps 에서 빼고 ref 로 읽는다.**
       * `subtitles` 가 `sentenceTokenTimeline` 파생 useMemo 라, 단어 분할/삭제 1회마다 새 array.
       * 이 콜백 deps 에 들어가 있으면 매 삭제마다 콜백·이를 의존하는 모든 useEffect 가 재시작되어
       * 재생 중 단어 하이라이트가 한 박자 늦게 따라옴(150~300ms 체감). ref 로 읽으면 콜백이 안정해
       * 매 RAF tick 이 동일 클로저를 호출 → 하이라이트가 즉시 갱신된다.
       */
      const subsNow = subtitlesRef.current
      const ai = pickActiveSubtitleIndex(subsNow, editSec)
      activeSubtitleIndexRef.current = ai

      const timeEl = previewCurrentTimeRef.current
      if (timeEl) timeEl.textContent = formatClock(editSec)

      const seekEl = previewSeekInputRef.current
      if (seekEl) {
        const d = uiTimelineEndEditSec > 0 ? uiTimelineEndEditSec : 0.001
        seekEl.max = String(Math.max(d, 0.001))
        const v = uiTimelineEndEditSec > 0 ? Math.min(editSec, uiTimelineEndEditSec) : editSec
        seekEl.value = String(v)
        seekEl.setAttribute('aria-valuenow', String(Math.round(v * 100) / 100))
      }

      const previewTextEl = previewSubtitleTextRef.current
      if (previewTextEl) {
        previewTextEl.textContent = ai !== null && subsNow[ai] ? subsNow[ai].text : ''
      }

      const t = editSec
      const playing = isPlayingRef.current

      const prevCardLine = wordHighlightPrevCardRef.current
      if (prevCardLine !== null && prevCardLine !== ai) {
        const prevCardEl = document.getElementById(`subtitle-card-${prevCardLine}`)
        prevCardEl?.querySelectorAll<HTMLElement>('.subtitle-word-chip').forEach((el) => {
          el.classList.remove('subtitle-word-chip--active')
        })
        wordHighlightActiveChipElRef.current = null
      }
      wordHighlightPrevCardRef.current = ai

      const prevActiveCard = activeSubtitleCardIdxRef.current
      if (prevActiveCard !== null && prevActiveCard !== ai) {
        document.getElementById(`subtitle-card-${prevActiveCard}`)?.classList.remove('subtitle-card--active')
      }
      activeSubtitleCardIdxRef.current = ai
      if (ai !== null) {
        document.getElementById(`subtitle-card-${ai}`)?.classList.add('subtitle-card--active')
      }

      if (!playing) {
        wordHighlightActiveChipElRef.current?.classList.remove('subtitle-word-chip--active')
        wordHighlightActiveChipElRef.current = null
      } else if (ai !== null) {
        const cardEl = document.getElementById(`subtitle-card-${ai}`)
        let nextChip: HTMLElement | null = null
        if (cardEl) {
          cardEl.querySelectorAll<HTMLElement>('.subtitle-word-chip').forEach((el) => {
            const s = parseFloat(el.dataset.wordStart ?? 'NaN')
            const e = parseFloat(el.dataset.wordEnd ?? 'NaN')
            if (!Number.isFinite(s) || !Number.isFinite(e)) return
            if (t >= s && t < e) nextChip = el
          })
        }
        const prevChip = wordHighlightActiveChipElRef.current
        if (prevChip !== nextChip) {
          prevChip?.classList.remove('subtitle-word-chip--active')
          if (nextChip) {
            const chipEl = nextChip as HTMLElement
            chipEl.classList.add('subtitle-word-chip--active')
          }
          wordHighlightActiveChipElRef.current = nextChip as HTMLElement | null
        }
      } else {
        wordHighlightActiveChipElRef.current?.classList.remove('subtitle-word-chip--active')
        wordHighlightActiveChipElRef.current = null
      }

      waveformPeaksRef.current?.syncPlayheadFromEditSec(editSec)
    },
    [clampProgramEditSec, uiTimelineEndEditSec]
  )

  useLayoutEffect(() => {
    commitEditSecToUi(playheadEditSecRef.current)
  }, [subtitles, durationSec, timelineMediaEndHint, mapMediaToEditSec, commitEditSecToUi])

  useEffect(() => {
    if (!videoPath) return
    timelineEditLog('sync', 'auto global offset calibrated', {
      cutCount: mergedCutRanges.length,
      durationSec,
      firstWordStartSec,
      autoGlobalSyncOffsetSec,
      timelineMasterMode: timelineMapping.masterMode,
      playbackMasterMode: playbackTimelineMapping.masterMode
    })
    timelineEditLog('playback-diag', 'axis snapshot (check 4)', {
      cutSig: peaksStitchCutSig,
      cutCount: mergedCutRanges.length,
      durationSec,
      playbackPendingRevision,
      playbackCommittedRevision,
      mapperPlaybackReady: playbackCommittedRevision >= playbackPendingRevision,
      timelineMasterMode: timelineMapping.masterMode,
      playbackMasterMode: playbackTimelineMapping.masterMode,
      check4_stitchedUi_vs_passthroughPlayback:
        timelineMapping.masterMode === 'stitched' && playbackTimelineMapping.masterMode === 'passthrough',
      check4_note:
        timelineMapping.masterMode === 'stitched' && playbackTimelineMapping.masterMode === 'passthrough'
          ? '편집 타임라인·피크는 stitched, 마스터 오디오 패스스루 — 귀 들리는 축과 그리기 축이 다를 수 있음'
          : null
    })
  }, [
    videoPath,
    mergedCutRanges.length,
    durationSec,
    firstWordStartSec,
    autoGlobalSyncOffsetSec,
    timelineMapping.masterMode,
    playbackTimelineMapping.masterMode,
    peaksStitchCutSig,
    playbackPendingRevision,
    playbackCommittedRevision
  ])

  const toMediaSeekSec = useCallback(
    (editSec: number, el: HTMLVideoElement | null): number => {
      let e = clampProgramEditSec(editSec)
      let t = mapEditToMediaSec(e)
      t = skipCutRangeAt(t, mergedWaveformPeaksStitchCuts)
      const endEdit = uiTimelineEndEditSec
      if (endEdit > 0) {
        t = Math.min(t, mapEditToMediaSec(endEdit))
      }
      if (el && Number.isFinite(el.duration) && el.duration > 0) {
        t = Math.min(t, Math.max(0, el.duration - 0.001))
      }
      return t
    },
    [mergedWaveformPeaksStitchCuts, mapEditToMediaSec, clampProgramEditSec, uiTimelineEndEditSec]
  )

  const mediaToMasterAudioSec = useCallback(
    (mediaSec: number): number => {
      if (playbackSnapshot.masterMode === 'passthrough') return Math.max(0, mediaSec)
      return Math.max(0, playbackTimelineMapping.mediaToProgramSec(mediaSec))
    },
    [playbackSnapshot.masterMode, playbackTimelineMapping]
  )

  const masterAudioToMediaSec = useCallback(
    (masterSec: number): number => {
      if (playbackSnapshot.masterMode === 'passthrough') return Math.max(0, masterSec)
      return Math.max(0, playbackTimelineMapping.programToMediaSec(masterSec))
    },
    [playbackSnapshot.masterMode, playbackTimelineMapping]
  )

  /** `playing` 직후 RAF 루프만 재개 — 플레이헤드 커밋은 RAF tick 단일 경로 */
  const snapUiAfterMediaPlaying = useCallback(() => {
    queueMicrotask(() => {
      resumeUiPlayheadRafIfPossible()
    })
  }, [resumeUiPlayheadRafIfPossible])

  /** 정지 시 HTML 마스터 오디오 시계를 편집 축 위치에 맞춘다 — 미디어 초 인자 금지 */
  const syncPausedMasterToEdit = useCallback(
    (editSecRaw: number): void => {
      const editSec = clampProgramEditSec(editSecRaw)
      webAudioMasterPlaybackRef.current?.stopPlayback()
      const audio = masterAudioRef.current
      if (!audio) return
      const masterT = playbackTimelineMappingRef.current.programToMasterAudioSec(editSec)
      assignMasterAudioTimelineSecIfNeeded(audio, Math.max(0, masterT))
      if (!audio.paused) {
        timelineEditLog('playback', 'pause-call audio.pause (syncPausedMasterToEdit)', {
          editSec: editSec,
          masterAudioAssignSec: masterT,
          audioCurrentTime: audio.currentTime
        })
        audio.pause()
      }
    },
    [clampProgramEditSec]
  )

  const startSyncedPlayback = useCallback(
    (
      source: string,
      targetEditSec: number,
      options?: {
        onAudioPlayRejected?: (reason?: unknown) => void
        onMapperBlocked?: () => void
      }
    ): boolean => {
      /**
       * 하드 컷이 없을 때(`mergedCutRanges.length === 0`)는 tombstone·가상 삭제만으로 `timelineMapping` 은
       * stitched, `playbackTimelineMapping` 은 의도적으로 passthrough 가 된다. 두 가드 전부를 건너뛰고
       * 즉시 재생을 허용 — 그러지 않으면 단어 자르기·삭제 직후 모든 단어 재생 클릭이 `onMapperBlocked`
       * → 큐 → mapper revision 영원히 안 따라잡힘 사이클에 영구히 막힌다. (`isPlaybackMapperReady` 와 동일 정책.)
       */
      if (mergedCutRanges.length === 0) {
        wfLog('peaks', 'startSyncedPlayback mapper 가드 우회 [diag-5] tombstone-only', {
          targetEditSec,
          timelineMasterMode: timelineMapping.masterMode,
          playbackMasterMode: playbackSnapshot.masterMode,
          mapperReady: playbackSnapshot.mapperReady
        })
      } else {
        if (!playbackSnapshot.mapperReady) {
          options?.onMapperBlocked?.()
          timelineEditLog('playback', `${source} 차단(mapper rebuild)`, {
            targetEditSec,
            playbackPendingRevision: playbackSnapshot.pendingRevision,
            playbackCommittedRevision: playbackSnapshot.committedRevision
          })
          wfLog('peaks', 'startSyncedPlayback 차단 [diag-5] mapper rebuild', {
            targetEditSec,
            playbackPendingRevision: playbackSnapshot.pendingRevision,
            playbackCommittedRevision: playbackSnapshot.committedRevision
          })
          return false
        }
        if (timelineMapping.masterMode !== playbackSnapshot.masterMode) {
          options?.onMapperBlocked?.()
          timelineEditLog('playback', `${source} 차단(mode mismatch)`, {
            targetEditSec,
            timelineMasterMode: timelineMapping.masterMode,
            playbackMasterMode: playbackSnapshot.masterMode,
            playbackPendingRevision: playbackSnapshot.pendingRevision,
            playbackCommittedRevision: playbackSnapshot.committedRevision
          })
          wfLog('peaks', 'startSyncedPlayback 차단 [diag-5] mode mismatch', {
            targetEditSec,
            timelineMasterMode: timelineMapping.masterMode,
            playbackMasterMode: playbackSnapshot.masterMode
          })
          return false
        }
      }
      const el = videoRef.current
      const masterAudio = masterAudioRef.current
      if (!el || !masterAudio) {
        wfLog('peaks', 'startSyncedPlayback 차단 [diag-6] refs 없음', {
          targetEditSec,
          hasVideoEl: el != null,
          hasMasterAudio: masterAudio != null
        })
        return false
      }
      const editStart = clampProgramEditSec(targetEditSec)
      const targetMediaSec = mapEditToMediaSec(editStart)
      commitEditSecToUi(editStart)
      userPauseRequestedRef.current = false
      setIsBuffering(false)
      audioPlayingSeenRef.current = false
      playbackStartupProbeRef.current = null
      waLastMediaSecRef.current = null
      const targetAudioSec = playbackTimelineMapping.programToMasterAudioSec(editStart)
      wfLog('peaks', 'startSyncedPlayback 진행 [diag-6]', {
        source,
        targetEditSec: editStart,
        targetMediaSec,
        targetAudioSec,
        videoCurrentTime: Number.isFinite(el.currentTime) ? el.currentTime : null,
        masterAudioCurrentTime: Number.isFinite(masterAudio.currentTime) ? masterAudio.currentTime : null,
        masterAudioPaused: masterAudio.paused,
        masterAudioReadyState: masterAudio.readyState,
        masterAudioSrc: masterAudio.src || null,
        hasWaveformMediaUrl: waveformMediaUrl != null,
        hasWebAudioEngine: webAudioMasterPlaybackRef.current != null,
        scheduleKind: activePlaybackScheduleRef.current?.kind ?? null,
        scheduleSegCount: activePlaybackScheduleRef.current?.segments.length ?? 0
      })
      timelineEditLog('playback', `${source} startSyncedPlayback(web-audio)`, {
        targetEditSec: editStart,
        targetMediaSec,
        targetAudioSec,
        playbackPendingRevision: playbackSnapshot.pendingRevision,
        playbackCommittedRevision: playbackSnapshot.committedRevision,
        playbackMasterMode: playbackSnapshot.masterMode
      })

      masterAudio.pause()
      assignMasterAudioTimelineSecIfNeeded(masterAudio, Math.max(0, targetAudioSec))

      const scheduleInfo = activePlaybackScheduleRef.current
      const decodeUrl = waveformMediaUrl ?? null
      const mapMasterClockToVideo =
        playbackSnapshot.masterMode === 'stitched'
          ? (t: number) => Math.max(0, playbackTimelineMapping.programToMediaSec(t))
          : undefined
      clearPlaybackStartupVerifyTimer()

      void (async () => {
        const engine = webAudioMasterPlaybackRef.current
        try {
          if (!engine || !decodeUrl) {
            wfLog('peaks', 'startSyncedPlayback [diag-6] HTML 폴백 — engine/decodeUrl 없음', {
              hasEngine: engine != null,
              hasDecodeUrl: decodeUrl != null
            })
            playMasterVideoSynced(masterAudio, el, {
              targetVideoSec: targetMediaSec,
              targetAudioSec,
              onAudioPlayRejected: options?.onAudioPlayRejected,
              videoMediaSecFromMasterClockSec: mapMasterClockToVideo
            })
            return
          }
          if (!scheduleInfo || scheduleInfo.segments.length <= 0) {
            timelineEditLog('playback', `${source} WebAudio: EDL schedule 없음 — HTML 폴백`)
            wfLog('peaks', 'startSyncedPlayback [diag-6] HTML 폴백 — EDL schedule 없음', {
              hasScheduleInfo: scheduleInfo != null,
              segCount: scheduleInfo?.segments.length ?? 0
            })
            playMasterVideoSynced(masterAudio, el, {
              targetVideoSec: targetMediaSec,
              targetAudioSec,
              onAudioPlayRejected: options?.onAudioPlayRejected,
              videoMediaSecFromMasterClockSec: mapMasterClockToVideo
            })
            return
          }
          if (!engine.isLoadedForUrl(decodeUrl)) {
            wfLog('peaks', 'startSyncedPlayback [diag-6] WebAudio loadFromUrl 시작', {
              decodeUrl
            })
            await engine.loadFromUrl(decodeUrl)
            wfLog('peaks', 'startSyncedPlayback [diag-6] WebAudio loadFromUrl 완료')
          }
          engine.stopPlayback()
          await seekVideoElementTo(el, targetMediaSec)
          wfLog('peaks', 'startSyncedPlayback [diag-6] WebAudio scheduleFromEdl 호출', {
            targetMediaSec,
            segCount: scheduleInfo.segments.length,
            scheduleKind: scheduleInfo.kind
          })
          const endClamp =
            scheduleInfo.kind === 'oneshot'
              ? (previewEndMediaSecRef.current ?? scheduleInfo.segments[scheduleInfo.segments.length - 1]!.endMediaSec)
              : null
          await engine.scheduleFromEdl(scheduleInfo.segments, targetMediaSec, endClamp)
          if (!engine.isPlaying()) {
            timelineEditLog('playback', `${source} WebAudio 스케줄 결과 활성 소스 없음 — HTML 폴백`, {
              targetMediaSec,
              segmentCount: scheduleInfo.segments.length,
              scheduleKind: scheduleInfo.kind
            })
            wfLog('peaks', 'startSyncedPlayback [diag-6] WebAudio 비활성 — HTML 폴백', {
              targetMediaSec,
              segCount: scheduleInfo.segments.length
            })
            playMasterVideoSynced(masterAudio, el, {
              targetVideoSec: targetMediaSec,
              targetAudioSec,
              onAudioPlayRejected: options?.onAudioPlayRejected,
              videoMediaSecFromMasterClockSec: mapMasterClockToVideo
            })
            return
          }
          wfLog('peaks', 'startSyncedPlayback [diag-6] WebAudio 재생 중', {
            targetMediaSec
          })
          const waProbeStart = engine.getCurrentMediaSec()
          playbackStartupProbeRef.current = { startedAt: performance.now(), waStart: waProbeStart }
          playbackStartupVerifyTimerRef.current = window.setTimeout(() => {
            playbackStartupVerifyTimerRef.current = null
            const curEngine = webAudioMasterPlaybackRef.current
            const curAudio = masterAudioRef.current
            const curVideo = videoRef.current
            if (!curAudio || !curVideo) return
            const waNow = curEngine?.getCurrentMediaSec()
            const waPlaying = curEngine?.isPlaying() === true
            const waProgress =
              waNow != null && waProbeStart != null
                ? waNow >= waProbeStart + 0.025
                : waNow != null && waPlaying
            const htmlAudioPlaying =
              !curAudio.paused && curAudio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
            if ((waPlaying && waProgress) || htmlAudioPlaying) {
              markPlaybackActiveIfAudioClockReady('video')
              return
            }
            timelineEditLog('playback', `${source} startup verify failed — fallback to HTML`, {
              targetMediaSec,
              targetAudioSec,
              waProbeStart,
              waNow,
              waPlaying,
              waProgress,
              htmlAudioPaused: curAudio.paused,
              htmlAudioReadyState: curAudio.readyState
            })
            curEngine?.stopPlayback()
            playbackStartupProbeRef.current = null
            waLastMediaSecRef.current = null
            playMasterVideoSynced(curAudio, curVideo, {
              targetVideoSec: targetMediaSec,
              targetAudioSec,
              onAudioPlayRejected: options?.onAudioPlayRejected,
              videoMediaSecFromMasterClockSec: mapMasterClockToVideo
            })
          }, 180)
          void el.play().catch(() => undefined)
        } catch (err: unknown) {
          timelineEditLog('playback', `${source} WebAudio 스케줄 실패 — HTML 폴백`, {
            message: err instanceof Error ? err.message : String(err)
          })
          wfLog('peaks', 'startSyncedPlayback [diag-6] WebAudio 예외 — HTML 폴백', {
            message: err instanceof Error ? err.message : String(err)
          })
          playMasterVideoSynced(masterAudio, el, {
            targetVideoSec: targetMediaSec,
            targetAudioSec,
            onAudioPlayRejected: options?.onAudioPlayRejected,
            videoMediaSecFromMasterClockSec: mapMasterClockToVideo
          })
        }
      })()
      return true
    },
    [
      clearPlaybackStartupVerifyTimer,
      clampProgramEditSec,
      commitEditSecToUi,
      mapEditToMediaSec,
      markPlaybackActiveIfAudioClockReady,
      playbackSnapshot.pendingRevision,
      playbackSnapshot.committedRevision,
      playbackSnapshot.mapperReady,
      playbackSnapshot.masterMode,
      playbackTimelineMapping,
      timelineMapping.masterMode,
      waveformMediaUrl,
      mergedCutRanges.length
    ]
  )

  const isOneShotSessionLocked = useCallback((): boolean => {
    return oneShotSessionRef.current != null
  }, [])

  const isPlaybackTransactionLocked = useCallback((): boolean => {
    return isDeleteGuardActive() || !isPlaybackMapperReady()
  }, [isDeleteGuardActive, isPlaybackMapperReady])

  const beginOneShotSession = useCallback((startMediaSec: number, endMediaSec: number): void => {
    oneShotSessionSeqRef.current += 1
    oneShotSessionRef.current = {
      id: oneShotSessionSeqRef.current,
      start: startMediaSec,
      end: endMediaSec,
      state: 'playing'
    }
    previewEndMediaSecRef.current = endMediaSec
    oneShotRangeRef.current = { start: startMediaSec, end: endMediaSec }
    playbackTraceLastMsRef.current = 0
    const r4 = (x: number) => Math.round(x * 10000) / 10000
    const startEditSec = mapMediaToEditSec(startMediaSec)
    const endEditSec = mapMediaToEditSec(endMediaSec)
    timelineEditLog('playback-trace', 'one-shot armed', {
      sessionId: oneShotSessionSeqRef.current,
      masterMode: cutRangesRef.current.length > 0 ? 'stitched' : 'passthrough',
      startMediaSec: r4(startMediaSec),
      endMediaSec: r4(endMediaSec),
      mediaSpanSec: r4(endMediaSec - startMediaSec),
      startEditSec: r4(startEditSec),
      endEditSec: r4(endEditSec),
      editSpanSec: r4(endEditSec - startEditSec)
    })
  }, [mapMediaToEditSec])

  const clearOneShotSession = useCallback((reason: string): void => {
    if (oneShotSessionRef.current) {
      timelineEditLog('playback', `one-shot session cleared(${reason})`, {
        session: oneShotSessionRef.current
      })
    }
    oneShotSessionRef.current = null
    previewEndMediaSecRef.current = null
    oneShotRangeRef.current = null
  }, [])

  const armPlaybackSchedule = useCallback(
    (startMediaSec: number, endMediaSec: number | null, kind: 'oneshot' | 'continuous'): ScheduledMediaSegment[] => {
      const segments = USE_WORD_BASED_PLAYBACK_SCHEDULE
        ? buildScheduledMediaSegmentsFromSubtitleWords(subtitles, startMediaSec, endMediaSec)
        : buildScheduledMediaSegments(timelineMapping.clips, startMediaSec, endMediaSec)
      activePlaybackScheduleRef.current = segments.length > 0 ? { kind, index: 0, segments } : null
      timelineEditLog('playback', 'EDL schedule armed', {
        kind,
        scheduleSource: USE_WORD_BASED_PLAYBACK_SCHEDULE ? 'word-intervals' : 'edl-clips',
        startMediaSec,
        endMediaSec,
        segmentCount: segments.length,
        first: segments[0] ?? null,
        last: segments.length > 0 ? segments[segments.length - 1] : null
      })
      return segments
    },
    [timelineMapping, subtitles]
  )

  const clearPlaybackSchedule = useCallback((reason: string): void => {
    if (!activePlaybackScheduleRef.current) return
    timelineEditLog('playback', `EDL schedule cleared(${reason})`, {
      kind: activePlaybackScheduleRef.current.kind,
      index: activePlaybackScheduleRef.current.index,
      segmentCount: activePlaybackScheduleRef.current.segments.length
    })
    activePlaybackScheduleRef.current = null
  }, [])

  type SeekIntentSource = 'user-trusted' | 'user' | 'auto-focus' | 'navigate'

  const deferPauseWhileMapperStale = useCallback((source: string): boolean => {
      if (!isEdlSessionActive() || previewEndMediaSecRef.current != null) return false
    if (isPlaybackMapperReady()) return false
    bumpPendingQueue()
    timelineEditLog('playback', `${source} pauseFinalize deferred(wait mapper)`, {
      playbackPendingRevision: playbackSnapshot.pendingRevision,
      playbackCommittedRevision: playbackSnapshot.committedRevision
    })
    return true
  }, [
    isPlaybackMapperReady,
    bumpPendingQueue,
    playbackSnapshot.pendingRevision,
    playbackSnapshot.committedRevision,
    isEdlSessionActive
  ])

  const seekToSubtitleStart = useCallback(
    (
      startSec: number,
      inputTimeBasis: 'edit' | 'media' = 'edit',
      source: SeekIntentSource = 'user-trusted'
    ) => {
      if (
        source === 'user-trusted' &&
        performance.now() < oneShotSoftStopUntilRef.current
      ) {
        timelineEditLog('playback', 'seekToSubtitleStart 차단(one-shot soft-stop guard)', {
          requestedStartEditSec: startSec,
          inputTimeBasis,
          softStopUntilMs: oneShotSoftStopUntilRef.current
        })
        return
      }
      const trustedByHardware =
        source === 'user-trusted' && performance.now() - lastHumanInteractionAtRef.current < 500
      const actualSource: SeekIntentSource =
        source === 'user-trusted' ? (trustedByHardware ? 'user-trusted' : 'auto-focus') : source
      if (source === 'user-trusted' && actualSource !== source) {
        timelineEditLog('playback', 'seekToSubtitleStart trusted 강등(no hardware intent)', {
          requestedStartEditSec: startSec,
          inputTimeBasis,
          source,
          actualSource
        })
      }
      if (actualSource === 'auto-focus') {
        if (isEdlSessionActive() || playbackEnginePhaseRef.current !== 'idle') {
          timelineEditLog('playback', 'seekToSubtitleStart hard drop(auto-focus during active/recovering)', {
            requestedStartEditSec: startSec,
            inputTimeBasis,
            phase: playbackEnginePhaseRef.current,
            enginePlaybackDesired: isEdlSessionActive()
          })
          return
        }
      }
      const isTrustedUserSource = actualSource === 'user-trusted'
      /** 카드/목록 탐색(navigate)도 삭제 가드·매퍼 지연 중 버리면 편집 위치와 미디어 헤드가 어긋난다 */
      const isQueuedAllowed = isTrustedUserSource || actualSource === 'navigate'
      const isUntrustedSource = !isTrustedUserSource
      if (isDeleteGuardActive()) {
        const queued = isQueuedAllowed
        if (isQueuedAllowed) {
          queuePlaybackIntent({ kind: 'seek', startSec, basis: inputTimeBasis, source: actualSource })
        }
        timelineEditLog('playback', 'seekToSubtitleStart 차단(delete guard)', {
          deleteOpId: lastDeleteOpIdRef.current,
          requestedStartEditSec: startSec,
          inputTimeBasis,
          source: actualSource,
          queued
        })
        return
      }
      if (!isPlaybackMapperReady()) {
        const queued = isQueuedAllowed
        if (isQueuedAllowed) {
          queuePlaybackIntent({ kind: 'seek', startSec, basis: inputTimeBasis, source: actualSource })
        }
        timelineEditLog('playback', 'seekToSubtitleStart 차단(mapper rebuild)', {
          requestedStartEditSec: startSec,
          inputTimeBasis,
          source: actualSource,
          queued,
          playbackPendingRevision: playbackSnapshot.pendingRevision,
          playbackCommittedRevision: playbackSnapshot.committedRevision
        })
        return
      }
      if (isOneShotSessionLocked()) {
        timelineEditLog('playback', 'seekToSubtitleStart 차단(one-shot hard lock)', {
          requestedStartEditSec: startSec,
          inputTimeBasis,
          source: actualSource,
          activeOneShot: oneShotRangeRef.current,
          phase: playbackEnginePhaseRef.current
        })
        return
      }
      if (isTrustedUserSource && isEdlSessionActive()) {
        timelineEditLog('playback', 'seekToSubtitleStart 재생중 클릭 — 탐색 전용으로 정지 후 이동', {
          requestedStartEditSec: startSec,
          inputTimeBasis,
          source: actualSource,
          phase: playbackEnginePhaseRef.current
        })
        const v = videoRef.current
        const a = masterAudioRef.current
        const waPos = webAudioMasterPlaybackRef.current?.getCurrentMediaSec()
        const cur = a ? waPos ?? masterAudioToMediaSec(a.currentTime) : (v?.currentTime ?? 0)
        playbackEnginePhaseRef.current = 'idle'
        userPauseRequestedRef.current = true
        clearPlaybackSession()
        clearPlaybackSchedule('seekToSubtitleStart navigate while playing')
        syncPausedMasterToEdit(mapMediaToEditSec(cur))
        setIsPlaying(false)
        setIsBuffering(false)
      }
      if (isUntrustedSource && isEdlSessionActive()) {
        timelineEditLog('playback', 'seekToSubtitleStart 차단(untrusted while playing)', {
          requestedStartEditSec: startSec,
          inputTimeBasis,
          source: actualSource,
          phase: playbackEnginePhaseRef.current
        })
        return
      }
      if (previewEndMediaSecRef.current != null && isEdlSessionActive()) {
        timelineEditLog('playback', 'seekToSubtitleStart 차단(one-shot session lock)', {
          requestedStartEditSec: startSec,
          inputTimeBasis,
          source: actualSource,
          previewEndMediaSec: previewEndMediaSecRef.current,
          phase: playbackEnginePhaseRef.current
        })
        return
      }
      const el = videoRef.current
      if (!el || !videoPath) return
      const editTarget =
        inputTimeBasis === 'media'
          ? clampProgramEditSec(mapMediaToEditSec(skipCutRangeAt(startSec, mergedWaveformPeaksStitchCuts)))
          : clampProgramEditSec(startSec)
      const t = toMediaSeekSec(editTarget, el)
      const now = performance.now()
      const prevSeek = lastSeekIssuedRef.current
      if (prevSeek && Math.abs(prevSeek.mediaSec - t) < 0.002 && now - prevSeek.at < 420) {
        timelineEditLog('playback', 'seekToSubtitleStart 하드 디듑', {
          requestedStartEditSec: startSec,
          inputTimeBasis,
          resolvedStartMediaSec: t,
          prevKind: prevSeek.kind,
          elapsedMs: now - prevSeek.at
        })
        return
      }
      lastSeekIssuedRef.current = { mediaSec: t, at: now, kind: 'seek' }
      const activeOneShot = oneShotRangeRef.current
      if (
        activeOneShot &&
        isPlaying &&
        t >= activeOneShot.start - 0.03 &&
        t <= activeOneShot.end + 0.03
      ) {
        timelineEditLog('playback', 'seekToSubtitleStart 스킵(one-shot range guard)', {
          requestedStartEditSec: startSec,
          inputTimeBasis,
          resolvedStartMediaSec: t,
          activeOneShot
        })
        return
      }
      clearOneShotSession('seekToSubtitleStart')
      playbackEnginePhaseRef.current = 'idle'
      clearPlaybackSession()
      const prev = seekToSubtitleStartLogDedupeRef.current
      const dupLog =
        prev != null &&
        Math.abs(prev.startSec - startSec) < 1e-7 &&
        now - prev.at < 85
      if (!dupLog) {
        timelineEditLog('playback', 'seekToSubtitleStart mapping', {
          requestedStartEditSec: startSec,
          requestedEndEditSec: null,
          inputTimeBasis,
          source: actualSource,
          resolvedStartMediaSec: t,
          resolvedEndMediaSec: null,
          cutCount: mergedWaveformPeaksStitchCuts.length
        })
        seekToSubtitleStartLogDedupeRef.current = { startSec, at: now }
      }
      el.currentTime = t
      commitEditSecToUi(editTarget)
      syncPausedMasterToEdit(editTarget)
    },
    [
      videoPath,
      mergedWaveformPeaksStitchCuts,
      toMediaSeekSec,
      syncPausedMasterToEdit,
      isDeleteGuardActive,
      isPlaying,
      queuePlaybackIntent,
      isPlaybackMapperReady,
      playbackSnapshot.pendingRevision,
      playbackSnapshot.committedRevision,
      playbackSnapshot.mapperReady,
      playbackSnapshot.masterMode,
      clearPlaybackSession,
      isOneShotSessionLocked,
      clearOneShotSession,
      lastHumanInteractionAtRef,
      commitEditSecToUi,
      clampProgramEditSec,
      mapMediaToEditSec
    ]
  )

  const dispatchSeekIntent = useCallback(
    (startSec: number, basis: 'edit' | 'media', source: SeekIntentSource): void => {
      const trustedByHardware =
        source === 'user-trusted' && performance.now() - lastHumanInteractionAtRef.current < 500
      const normalizedSource: SeekIntentSource =
        source === 'user-trusted' ? (trustedByHardware ? 'user-trusted' : 'auto-focus') : source
      if (source === 'user-trusted' && normalizedSource !== source) {
        timelineEditLog('playback', 'dispatchSeekIntent trusted 강등(no hardware intent)', {
          requestedStartEditSec: startSec,
          inputTimeBasis: basis,
          source,
          normalizedSource
        })
      }
      if (isPlaybackTransactionLocked()) {
        const queued =
          normalizedSource === 'user-trusted' || normalizedSource === 'navigate'
        if (queued) {
          queuePlaybackIntent({ kind: 'seek', startSec, basis, source: normalizedSource })
        }
        timelineEditLog('playback', 'dispatchSeekIntent 차단(transaction lock)', {
          requestedStartEditSec: startSec,
          inputTimeBasis: basis,
          source: normalizedSource,
          queued,
          deleteGuard: isDeleteGuardActive(),
          mapperReady: isPlaybackMapperReady()
        })
        return
      }
      seekToSubtitleStart(startSec, basis, normalizedSource)
    },
    [
      isPlaybackTransactionLocked,
      queuePlaybackIntent,
      seekToSubtitleStart,
      isDeleteGuardActive,
      isPlaybackMapperReady,
      lastHumanInteractionAtRef
    ]
  )

  const seekToSubtitleStartFromAutoFocus = useCallback(
    (startSec: number) => {
      dispatchSeekIntent(startSec, 'edit', 'auto-focus')
    },
    [dispatchSeekIntent]
  )

  const seekToSubtitleStartFromNavigate = useCallback(
    (startSec: number) => {
      dispatchSeekIntent(startSec, 'edit', 'navigate')
    },
    [dispatchSeekIntent]
  )

  const seekToSubtitleStartFromUserInput = useCallback(
    (startSec: number) => {
      dispatchSeekIntent(startSec, 'edit', 'navigate')
    },
    [dispatchSeekIntent]
  )

  const seekAndPlayTo = useCallback(
    (startSec: number, inputTimeBasis: 'edit' | 'media' = 'edit') => {
      const el = videoRef.current
      const masterAudio = masterAudioRef.current
      if (!el || !masterAudio || !videoPath) return
      if (isOneShotSessionLocked()) {
        timelineEditLog('playback', 'seekAndPlayTo 차단(one-shot hard lock)', {
          requestedStartEditSec: startSec,
          inputTimeBasis,
          activeOneShot: oneShotRangeRef.current,
          phase: playbackEnginePhaseRef.current
        })
        return
      }
      const run = (): void => {
        if (!hasPlayableSubtitleWordIntervals(subtitles)) {
          timelineEditLog('playback', 'seekAndPlayTo 차단(재생 가능 단어 없음)', {
            requestedStartEditSec: startSec,
            inputTimeBasis,
            subtitleLineCount: subtitles.length
          })
          return
        }
        const allow = playbackCommandRouterRef.current.beginSeekLike('seekAndPlay')
        if (!allow.allowed) {
          queuePlaybackIntent({ kind: 'seekAndPlay', startSec, basis: inputTimeBasis })
          timelineEditLog('playback', 'seekAndPlayTo 차단(router)', {
            reason: allow.reason,
            requestedStartEditSec: startSec,
            inputTimeBasis,
            queued: true
          })
          return
        }
        beginPlaybackSession(allow.sessionId)
        clearOneShotSession('seekAndPlayTo')
        const editStart =
          inputTimeBasis === 'media'
            ? clampProgramEditSec(mapMediaToEditSec(skipCutRangeAt(startSec, mergedWaveformPeaksStitchCuts)))
            : clampProgramEditSec(startSec)
        const tRaw = toMediaSeekSec(editStart, el)
        const schedule = armPlaybackSchedule(tRaw, null, 'continuous')
        if (schedule.length <= 0) return
        const t = schedule[0]!.startMediaSec
        const now = performance.now()
        const prevSeek = lastSeekIssuedRef.current
        if (prevSeek && Math.abs(prevSeek.mediaSec - t) < 0.002 && now - prevSeek.at < 420) {
          timelineEditLog('playback', 'seekAndPlayTo 하드 디듑', {
            requestedStartEditSec: startSec,
            inputTimeBasis,
            resolvedStartMediaSec: t,
            prevKind: prevSeek.kind,
            elapsedMs: now - prevSeek.at
          })
          return
        }
        lastSeekIssuedRef.current = { mediaSec: t, at: now, kind: 'seekAndPlay' }
        timelineEditLog('playback', 'seekAndPlayTo mapping', {
          requestedStartEditSec: startSec,
          requestedEndEditSec: null,
          inputTimeBasis,
          resolvedStartMediaSec: t,
          resolvedEndMediaSec: null,
          cutCount: mergedWaveformPeaksStitchCuts.length
        })
        playbackEnginePhaseRef.current = 'playing'
        setIsBuffering(true)
        const editResolved = editStart
        commitEditSecToUi(editResolved)
        startSyncedPlayback('seekAndPlayTo', editResolved, {
          onMapperBlocked: () => {
            queuePlaybackIntent({ kind: 'seekAndPlay', startSec, basis: inputTimeBasis })
          }
        })
      }
      if (isDeleteGuardActive()) {
        queuePlaybackIntent({ kind: 'seekAndPlay', startSec, basis: inputTimeBasis })
        timelineEditLog('playback', 'seekAndPlayTo 차단(delete guard)', {
          deleteOpId: lastDeleteOpIdRef.current,
          requestedStartEditSec: startSec,
          inputTimeBasis,
          queued: true
        })
        return
      }
      run()
    },
    [
      videoPath,
      mergedWaveformPeaksStitchCuts,
      toMediaSeekSec,
      mapMediaToEditSec,
      clampProgramEditSec,
      isDeleteGuardActive,
      queuePlaybackIntent,
      playbackSnapshot.pendingRevision,
      playbackSnapshot.committedRevision,
      playbackSnapshot.mapperReady,
      playbackSnapshot.masterMode,
      startSyncedPlayback,
      beginPlaybackSession,
      isOneShotSessionLocked,
      clearOneShotSession,
      commitEditSecToUi,
      subtitles
    ]
  )

  const seekAndPlayFromSubtitleList = useCallback(
    (editStartSec: number) => {
      seekAndPlayTo(editStartSec, 'edit')
    },
    [seekAndPlayTo]
  )

  const playEditRange = useCallback(
    (startSec: number, endSec: number) => {
      const el = videoRef.current
      const masterAudio = masterAudioRef.current
      if (!el || !masterAudio || !videoPath) return
      const run = (): void => {
        // 현재 진입점은 파형 단어 재생(onPlayEditRange)과 큐 복귀뿐이며, 값은 모두 편집 축(단어 start/end)이다.
        const startInput = Math.max(0, Math.min(startSec, endSec))
        const endInput = Math.max(0, Math.max(startSec, endSec))
        if (!(endInput > startInput + 1e-4)) return

        if (!hasPlayableSubtitleWordIntervals(subtitles)) {
          timelineEditLog('playback', 'playEditRange 차단(재생 가능 단어 없음)', {
            requestedStartEditSec: startSec,
            requestedEndEditSec: endSec,
            subtitleLineCount: subtitles.length
          })
          wfLog('peaks', 'playEditRange 차단 [diag-5] 재생 가능 단어 없음', {
            startSec,
            endSec
          })
          return
        }

        /** 파형·단어 모델의 start/end는 항상 편집(프로그램) 축 — 컷이 있으면 미디어 초와 값이 크게 달라진다. */
        const inputTimeBasis: 'edit' = 'edit'
        const editClampedS = clampProgramEditSec(startInput)
        const editClampedE = clampProgramEditSec(endInput)
        const mapOnlyMediaS = mapEditToMediaSec(editClampedS)
        const mapOnlyMediaE = mapEditToMediaSec(editClampedE)
        const afterSkipMediaS = skipCutRangeAt(mapOnlyMediaS, mergedWaveformPeaksStitchCuts)
        const afterSkipMediaE = skipCutRangeAt(mapOnlyMediaE, mergedWaveformPeaksStitchCuts)
        let mediaStart = toMediaSeekSec(startInput, el)
        let mediaEnd = toMediaSeekSec(endInput, el)

        const r4 = (x: number) => Math.round(x * 10000) / 10000
        timelineEditLog('playback-trace', 'playEditRange edit→media layers', {
          requestedEditSec: { start: r4(startInput), end: r4(endInput) },
          editClamped: { start: r4(editClampedS), end: r4(editClampedE) },
          mapEditToMediaOnly: { start: r4(mapOnlyMediaS), end: r4(mapOnlyMediaE) },
          afterSkipCutRange: { start: r4(afterSkipMediaS), end: r4(afterSkipMediaE) },
          afterToMediaSeekSec: { start: r4(mediaStart), end: r4(mediaEnd) },
          skipCutAdjusted: {
            start: Math.abs(afterSkipMediaS - mapOnlyMediaS) > 1e-6,
            end: Math.abs(afterSkipMediaE - mapOnlyMediaE) > 1e-6
          },
          deltaSeekMinusSkip: {
            start: r4(mediaStart - afterSkipMediaS),
            end: r4(mediaEnd - afterSkipMediaE)
          },
          cutCount: mergedWaveformPeaksStitchCuts.length,
          programTimelineEndEditSec: r4(programTimelineEndEditSec),
          videoDurationSec: Number.isFinite(el.duration) ? r4(el.duration) : null
        })

        if (!(mediaEnd > mediaStart + 1e-4)) {
          mediaEnd = mediaStart + 0.05
        }
        if (Number.isFinite(el.duration) && el.duration > 0) {
          mediaEnd = Math.min(mediaEnd, Math.max(0, el.duration - 0.001))
        }
        const now = performance.now()
        const prevSeek = lastSeekIssuedRef.current
        /**
         * 시크만 한 직후(Space로 단어 구간 재생)에는 미디어 초가 동일해도 재생해야 한다.
         * seekAndPlay·연속 playRange 만 디듑한다.
         */
        if (
          prevSeek &&
          prevSeek.kind !== 'seek' &&
          Math.abs(prevSeek.mediaSec - mediaStart) < 0.002 &&
          now - prevSeek.at < 420
        ) {
          timelineEditLog('playback', 'playEditRange 하드 디듑', {
            requestedStartEditSec: startInput,
            requestedEndEditSec: endInput,
            inputTimeBasis,
            resolvedStartMediaSec: mediaStart,
            resolvedEndMediaSec: mediaEnd,
            prevKind: prevSeek.kind,
            elapsedMs: now - prevSeek.at
          })
          wfLog('peaks', 'playEditRange 차단 [diag-5] 하드 디듑', {
            startSec: startInput,
            endSec: endInput,
            prevKind: prevSeek.kind,
            elapsedMs: Math.round(now - prevSeek.at)
          })
          return
        }
        const prevRange = lastPlayRangeIssuedRef.current
        if (
          prevRange &&
          Math.abs(prevRange.start - mediaStart) < 0.003 &&
          Math.abs(prevRange.end - mediaEnd) < 0.003 &&
          now - prevRange.at < 280
        ) {
          timelineEditLog('playback', 'playEditRange 구간 디듑', {
            requestedStartEditSec: startInput,
            requestedEndEditSec: endInput,
            resolvedStartMediaSec: mediaStart,
            resolvedEndMediaSec: mediaEnd,
            elapsedMs: now - prevRange.at
          })
          wfLog('peaks', 'playEditRange 차단 [diag-5] 구간 디듑', {
            startSec: startInput,
            endSec: endInput,
            elapsedMs: Math.round(now - prevRange.at)
          })
          return
        }
        const activeSession = oneShotSessionRef.current
        if (
          activeSession &&
          Math.abs(activeSession.start - mediaStart) < 0.003 &&
          Math.abs(activeSession.end - mediaEnd) < 0.003
        ) {
          timelineEditLog('playback', 'playEditRange 세션 디듑(active one-shot)', {
            requestedStartEditSec: startInput,
            requestedEndEditSec: endInput,
            resolvedStartMediaSec: mediaStart,
            resolvedEndMediaSec: mediaEnd,
            oneShotSession: activeSession
          })
          wfLog('peaks', 'playEditRange 차단 [diag-5] 세션 디듑(active one-shot)', {
            startSec: startInput,
            endSec: endInput,
            oneShotSession: activeSession
          })
          return
        }
        const allow = playbackCommandRouterRef.current.beginPlayRange(mediaStart, mediaEnd)
        if (!allow.allowed) {
          timelineEditLog('playback', 'playEditRange 차단(router)', {
            reason: allow.reason,
            requestedStartEditSec: startInput,
            requestedEndEditSec: endInput,
            resolvedStartMediaSec: mediaStart,
            resolvedEndMediaSec: mediaEnd
          })
          wfLog('peaks', 'playEditRange 차단 [diag-5] router', {
            reason: allow.reason,
            startSec: startInput,
            endSec: endInput
          })
          return
        }
        beginPlaybackSession(allow.sessionId)
        lastPlayRangeIssuedRef.current = { start: mediaStart, end: mediaEnd, at: now }
        lastSeekIssuedRef.current = { mediaSec: mediaStart, at: now, kind: 'playRange' }
        const schedule = armPlaybackSchedule(mediaStart, mediaEnd, 'oneshot')
        if (schedule.length <= 0) {
          timelineEditLog('playback', 'playEditRange 스킵(EDL 세그먼트 없음)', {
            requestedStartEditSec: startInput,
            requestedEndEditSec: endInput,
            resolvedStartMediaSec: mediaStart,
            resolvedEndMediaSec: mediaEnd,
            cutCount: mergedWaveformPeaksStitchCuts.length
          })
          wfLog('peaks', 'playEditRange 차단 [diag-5] EDL 세그먼트 없음', {
            startSec: startInput,
            endSec: endInput,
            cutCount: mergedWaveformPeaksStitchCuts.length
          })
          return
        }
        const preClipStartMediaSec = mediaStart
        const preClipEndMediaSec = mediaEnd
        mediaStart = schedule[0]!.startMediaSec
        mediaEnd = schedule[schedule.length - 1]!.endMediaSec
        timelineEditLog('playback-trace', 'playEditRange EDL clip window', {
          segmentCount: schedule.length,
          segments: schedule.map((s) => ({
            clipId: s.clipId,
            startMediaSec: r4(s.startMediaSec),
            endMediaSec: r4(s.endMediaSec),
            startEditSec: r4(mapMediaToEditSec(s.startMediaSec)),
            endEditSec: r4(mapMediaToEditSec(s.endMediaSec))
          })),
          preClipStartMediaSec: r4(preClipStartMediaSec),
          preClipEndMediaSec: r4(preClipEndMediaSec),
          oneShotStartMediaSec: r4(mediaStart),
          oneShotEndMediaSec: r4(mediaEnd),
          clipStartShift: r4(mediaStart - preClipStartMediaSec),
          clipEndShift: r4(mediaEnd - preClipEndMediaSec)
        })
        beginOneShotSession(mediaStart, mediaEnd)
        timelineEditLog('playback', 'playEditRange mapping', {
          requestedStartEditSec: startInput,
          requestedEndEditSec: endInput,
          inputTimeBasis,
          resolvedStartMediaSec: mediaStart,
          resolvedEndMediaSec: mediaEnd,
          cutCount: mergedWaveformPeaksStitchCuts.length,
          mediaStartFromEditFormula:
            mergedCutRanges.length > 0 ? getMediaTimeFromEditTime(startInput, mergedCutRanges) : null,
          inverseEditFromResolvedMediaStart:
            mergedCutRanges.length > 0 ? getEditTimeFromMediaTime(mediaStart, mergedCutRanges) : null
        })
        const clickIntent = lastWaveformPlayRangeIntentRef.current
        if (clickIntent && performance.now() - clickIntent.at < 2000) {
          timelineEditLog('playback-diag', 'waveform click→playRange resolved compare', {
            clickStartEditSec: clickIntent.startSec,
            clickEndEditSec: clickIntent.endSec,
            clickWordId: clickIntent.wordId,
            clickWordText: clickIntent.wordText,
            resolvedStartMediaSec: mediaStart,
            resolvedEndMediaSec: mediaEnd,
            resolvedStartEditSec: mapMediaToEditSec(mediaStart),
            resolvedEndEditSec: mapMediaToEditSec(mediaEnd)
          })
        }
        timelineEditLog('playback-diag', 'playEditRange edit↔media (check 4 playback)', {
          requestedEdit: { start: startInput, end: endInput },
          resolvedMedia: { start: mediaStart, end: mediaEnd },
          playbackMasterMode: playbackTimelineMapping.masterMode,
          timelineMasterMode: timelineMapping.masterMode,
          cutSig: waveformPeaksStitchCutSig
        })
        playbackEnginePhaseRef.current = 'playing'
        setIsBuffering(true)
        const editPlay = mapMediaToEditSec(mediaStart)
        commitEditSecToUi(editPlay)
        wfLog('peaks', 'playEditRange → startSyncedPlayback [diag-5]', {
          startSec: startInput,
          endSec: endInput,
          mediaStart,
          mediaEnd,
          editPlay,
          masterMode: playbackTimelineMapping.masterMode
        })
        startSyncedPlayback('playEditRange', editPlay, {
          onMapperBlocked: () => {
            wfLog('peaks', 'playEditRange onMapperBlocked [diag-5]', { startSec, endSec })
            queuePlaybackIntent({ kind: 'playRange', startSec, endSec })
          },
          onAudioPlayRejected: () => {
            wfLog('peaks', 'playEditRange onAudioPlayRejected [diag-5]', { startSec, endSec })
            clearOneShotSession('playEditRange rejected')
            clearPlaybackSession()
          }
        })
      }
      if (isDeleteGuardActive()) {
        queuePlaybackIntent({ kind: 'playRange', startSec, endSec })
        timelineEditLog('playback', 'playEditRange 차단(delete guard)', {
          deleteOpId: lastDeleteOpIdRef.current,
          requestedStartEditSec: startSec,
          requestedEndEditSec: endSec,
          queued: true
        })
        wfLog('peaks', 'playEditRange 차단 [diag-5] delete guard', {
          startSec,
          endSec,
          deleteOpId: lastDeleteOpIdRef.current
        })
        return
      }
      run()
    },
    [
      videoPath,
      mergedWaveformPeaksStitchCuts,
      toMediaSeekSec,
      isDeleteGuardActive,
      queuePlaybackIntent,
      playbackSnapshot.pendingRevision,
      playbackSnapshot.committedRevision,
      playbackSnapshot.mapperReady,
      playbackSnapshot.masterMode,
      startSyncedPlayback,
      beginPlaybackSession,
      clearPlaybackSession,
      beginOneShotSession,
      clearOneShotSession,
      commitEditSecToUi,
      mapMediaToEditSec,
      timelineMapping.masterMode,
      playbackTimelineMapping.masterMode,
      waveformPeaksStitchCutSig,
      programTimelineEndEditSec,
      mapEditToMediaSec,
      clampProgramEditSec,
      armPlaybackSchedule,
      subtitles
    ]
  )

  /** 예전: 단어 삭제 시 CutRange 등록 — Phase 4 이후 tombstone 단일 모델이라 no-op (IPC 시그니처 유지) */
  const registerDeletedAudioRange = useCallback((_startSec: number, _endSec: number) => {}, [])

  const onSubtitleCardClick = useCallback(
    (e: MouseEvent<HTMLElement>, startSec: number) => {
      if ((e.target as HTMLElement).closest('[data-subtitle-edit]')) return
      dispatchSeekIntent(startSec, 'edit', 'navigate')
    },
    [dispatchSeekIntent]
  )

  const applySubtitleChange = useCallback(
    (updater: (prev: SubtitleLine[]) => SubtitleLine[], options?: { recordHistory?: boolean }) => {
      const recordHistory = options?.recordHistory ?? true
      setSentenceTokenTimeline((prevTl) => {
        const prev = sentenceTokenTimelineToSubtitleLines(prevTl)
        const next = updater(prev)
        const nextTl = subtitleLinesToSentenceTokenTimeline(next)
        if (!recordHistory) return nextTl
        if (next === prev) return prevTl
        const changed = subtitleLinesMeaningfullyChanged(next, prev)
        if (!changed) return prevTl
        /**
         * `virtualTimelineDeleted`/`cutRanges` 도 함께 캡처해야 Ctrl+Z 가 stitched cut 까지 되돌릴 수 있다.
         * 단어 삭제는 `setVirtualTimelineDeleted` 를 `setTimeout(0)` 으로 분리하지만, 이 push 시점의 ref 는
         * **before-this-op** 의 값이므로 entry 정합성은 유지된다.
         */
        undoStackRef.current.push({
          subtitles: prev,
          virtualTimelineDeleted: virtualTimelineDeletedRef.current,
          cutRanges: cutRangesRef.current
        })
        if (undoStackRef.current.length > 100) undoStackRef.current.shift()
        redoStackRef.current = []
        return nextTl
      })
    },
    []
  )
  /** WordEdgeDrag bridge 가 TDZ 회피용으로 참조하는 ref — applySubtitleChange 선언 이후 동기화 */
  useEffect(() => {
    applySubtitleChangeRef.current = applySubtitleChange
  }, [applySubtitleChange])

  useEffect(() => {
    const revokePrev = () => {
      if (masterAudioBlobUrlRef.current) {
        URL.revokeObjectURL(masterAudioBlobUrlRef.current)
        masterAudioBlobUrlRef.current = null
      }
    }
    if (!videoPath || !waveformMediaUrl) {
      revokePrev()
      masterAudioLayoutKeyRef.current = ''
      stitchedWaveformOutputSigRef.current = null
      setMasterAudioSrcUrl(undefined)
      playbackPendingRevisionRef.current = 0
      setPlaybackPendingRevision(0)
      setPlaybackCommittedRevision(0)
      return
    }

    const baseUrl = waveformMediaUrl
    const rev = playbackPendingRevisionRef.current
    /** tombstone 변경(컷 없음)도 commit 으로 잡기 위해 stitch sig 포함 — committed 단일 소유자 */
    const layoutKey = `${videoPath}|${baseUrl}|${peaksStitchCutSig}|${waveformPeaksStitchCutSig}|${rev}`
    if (masterAudioLayoutKeyRef.current === layoutKey) {
      return
    }
    masterAudioLayoutKeyRef.current = layoutKey

    const hasCuts = mergedCutRanges.length > 0
    revokePrev()
    setMasterAudioSrcUrl(baseUrl)
    setPlaybackCommittedRevision(rev)
    void window.api
      .logWaveformDebug(
        'audio-master',
        hasCuts
          ? '마스터 오디오 메모리 컷 매핑 모드(stitched-axis, no blob rebuild)'
          : '마스터 오디오 passthrough (컷 없음)',
        { cutCount: mergedCutRanges.length }
      )
      .catch(() => {})

    return () => {
      // no-op
    }
  }, [videoPath, waveformMediaUrl, mergedCutRanges, peaksStitchCutSig, waveformPeaksStitchCutSig])

  /** Web Audio EDL 디코드는 항상 원본 미디어 — stitched Blob 과 축 분리 */
  useEffect(() => {
    const url = waveformMediaUrl
    if (!url || !videoPath) return
    const eng = webAudioMasterPlaybackRef.current
    if (!eng) return
    void eng.loadFromUrl(url).catch((err: unknown) => {
      timelineEditLog('playback', 'WebAudio master 디코드 실패', {
        url,
        message: err instanceof Error ? err.message : String(err)
      })
    })
  }, [waveformMediaUrl, videoPath])

  const waveformPeaksFileUrl = useMemo(
    () => (waveformPeaksJsonPath ? window.api.getMediaFileUrl(waveformPeaksJsonPath) : null),
    [waveformPeaksJsonPath]
  )

  useEffect(() => {
    if (!videoPath) {
      setWaveformPeaksJsonPath(null)
      setWaveformPeaksJsonData(null)
      setWaveformPeaksJsonLoading(false)
      silenceSplitRunKeyRef.current = null
      setSilenceSplitPending(false)
      return
    }
    setWaveformPeaksJsonPath(null)
    setWaveformPeaksJsonData(null)
    /** 새 영상 — 이전 세션의 파형 기준 길이가 잠시 남으면 끝 판정이 옛 값으로 잡힘 */
    peaksReportedDurationRef.current = null
    waveformTimelineExactRef.current = null
    setWaveformMediaSpanSec(null)
    setWaveformPeaksJsonLoading(true)
    let cancelled = false
    void (async () => {
      try {
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
      } finally {
        if (!cancelled) setWaveformPeaksJsonLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [videoPath])

  /**
   * 정규화 wordCanvas 스토어 — 타임라인 SSOT + 원본 미디어 축 peaks JSON 만 사용
   * (스티치 편집축 JSON 과 시간축이 안 맞아 혼용 금지).
   *
   * 빠른 경로 (구조 동일):
   *  1) `tryPatchTombstonesFromTimeline` — 시간·텍스트 동일 + `is_deleted` 만 토글 → 가상 접두만 갱신.
   *  2) `patchFromTimelineIfStructureMatches` — 리플 삭제처럼 토큰 시간이 바뀐 경우에도 `audioChunks` 는 재사용.
   * 느린 경로 (구조 변경: 분할/병합/문장 삭제): 전체 hydrate 1회.
   *
   * 효과: 단어 1개 삭제 시 매번 모든 문장에 대해 `slicePeaksJsonToRmsChunk` 가 도는 O(N) 경로 차단.
   */
  useEffect(() => {
    if (sentenceTokenTimeline.length === 0) {
      return
    }
    const store = useEditorStore.getState()
    const tStart = performance.now()
    const tokenCount = sentenceTokenTimeline.reduce(
      (acc, s) => acc + (s.tokens?.length ?? 0),
      0
    )
    if (store.tryPatchTombstonesFromTimeline(sentenceTokenTimeline)) {
      wfLog('perf', 'editor store hydrate — fast tombstone patch', {
        ms: Math.round(performance.now() - tStart),
        sentenceCount: sentenceTokenTimeline.length,
        tokenCount
      })
      return
    }
    if (store.patchFromTimelineIfStructureMatches(sentenceTokenTimeline)) {
      wfLog('perf', 'editor store hydrate — structure-match patch', {
        ms: Math.round(performance.now() - tStart),
        sentenceCount: sentenceTokenTimeline.length,
        tokenCount
      })
      return
    }
    const snap = buildEditorSnapshotFromSentenceTokenTimeline(
      sentenceTokenTimeline,
      waveformPeaksJsonData ?? null,
      rawWaveformTimelineDurationSec > 0 ? rawWaveformTimelineDurationSec : undefined
    )
    const tBuilt = performance.now()
    store.hydrate(snap)
    wfLog('perf', 'editor store hydrate — full snapshot (slow path)', {
      buildMs: Math.round(tBuilt - tStart),
      hydrateMs: Math.round(performance.now() - tBuilt),
      totalMs: Math.round(performance.now() - tStart),
      sentenceCount: sentenceTokenTimeline.length,
      tokenCount,
      hasPeaksJson: !!waveformPeaksJsonData,
      peakPixels: waveformPeaksJsonData?.length ?? 0
    })
  }, [sentenceTokenTimeline, waveformPeaksJsonData, rawWaveformTimelineDurationSec])

  /** 디바운스 없이 동기 useMemo 로 만든 stitched 결과의 로그/진단만 별도 effect 에서 처리 */
  useEffect(() => {
    const wf = waveformPeaksJsonData
    if (!wf) {
      stitchedWaveformOutputSigRef.current = null
      return
    }
    const stitched = stitchedWaveformJsonComputed
    const inputSig = `${waveformPeaksStitchCutSig}|${rawWaveformTimelineDurationSec.toFixed(6)}|${wf.length ?? 0}|${(wf.data ?? []).length}`
    const outSig = stitched
      ? `${inputSig}|${stitched.length}|${(stitched.data ?? []).length}|${stitched.sample_rate ?? 0}|${stitched.samples_per_pixel ?? 0}`
      : `${inputSig}|null`
    if (outSig === stitchedWaveformOutputSigRef.current) return
    stitchedWaveformOutputSigRef.current = outSig
    const origPx = wf.length
    const stPx = stitched?.length ?? null
    void window.api
      .logWaveformDebug('waveform', 'peaks JSON stitched (edit-axis, sync)', {
        cutSig: waveformPeaksStitchCutSig,
        cutCount: mergedWaveformPeaksStitchCuts.length,
        stitchedPixels: stitched?.length ?? 0
      })
      .catch(() => {})
    timelineEditLog('waveform-diag', 'stitchWaveformJsonByCuts (check 3 parent, sync)', {
      durationSecUsed: rawWaveformTimelineDurationSec,
      cutSig: waveformPeaksStitchCutSig,
      cutCount: mergedWaveformPeaksStitchCuts.length,
      originalPeakPixels: origPx,
      stitchedPeakPixels: stPx,
      pixelDeltaVsOriginal: origPx != null && stPx != null ? stPx - origPx : null,
      check3_floorVsCeilNote:
        '자식(SubtitleWaveformPeaks) 인라인 stitched 픽셀이 stitchWaveformJsonByCuts 결과와 ±1 차이 나면 시간축 미세 불일치 의심'
    })
  }, [
    waveformPeaksJsonData,
    stitchedWaveformJsonComputed,
    waveformPeaksStitchCutSig,
    mergedWaveformPeaksStitchCuts.length,
    rawWaveformTimelineDurationSec
  ])

  useEffect(() => {
    const AUTO_SILENCE_RESPLIT = false
    if (!silenceSplitPending) return
    if (!videoPath || subtitles.length === 0) return
    if (!AUTO_SILENCE_RESPLIT) {
      // 싱크 안정화 우선: 자동 무음 재분할은 단어 경계를 다시 계산해 타임코드가 이동할 수 있다.
      setSilenceSplitPending(false)
      setGapFillWhenBuildingVrew(false)
      return
    }

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
      /** 1,473 word 통째 재commit 도 transition 으로 격하 — silence-split 직후 UI freeze 차단 */
      startTransition(() => {
        setSentenceTokenTimeline(subtitleLinesToSentenceTokenTimeline(next))
      })
      setGapFillWhenBuildingVrew(false)
      setSilenceSplitPending(false)
      silenceSplitRunKeyRef.current = runKey
      void event.data.stats
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

  const onVrewRowsChange = useCallback((nextRows: SubtitleRow[]) => {
    setGapFillWhenBuildingVrew(false)
    applySubtitleChange(
      (prev) =>
        mergeVrewRowsIntoSubtitleLines(prev, nextRows, {
          // Peaks 가 돌려준 프로그램(편집) 축 시간 → 자막은 항상 미디어(원본) 축으로 저장
          mapProgramWordToMedia: (s, e) => ({ start: mapEditToMediaSec(s), end: mapEditToMediaSec(e) })
        }),
      { recordHistory: true }
    )
  }, [applySubtitleChange, mapEditToMediaSec])

  const removeAllSilenceWords = useCallback(() => {
    applySubtitleChange((prev) => {
      const hadSilence = prev.some((l) => (l.words ?? []).some((w) => w.isSilence))
      if (hadSilence) queueMicrotask(() => setGapFillWhenBuildingVrew(false))
      return removeSilenceWordsFromSubtitleLines(prev)
    })
  }, [applySubtitleChange])

  /** 행 layout 이펙트가 Peaks ref(useImperativeHandle)보다 먼저 돌 수 있어 맵은 여기서 동기 갱신 */
  const waveMountByLineRef = useRef<Map<number, HTMLDivElement>>(new Map())
  const [waveformLineIndex, setWaveformLineIndex] = useState<number | null>(null)
  const [waveformWordId, setWaveformWordId] = useState<string | null>(null)
  const [peaksZoomViewRange, setPeaksZoomViewRange] = useState<PeaksZoomViewRange | null>(null)
  /**
   * 자르기 성공 직후 한 번 — `vrewRows` 가 새 `subtitles` 로 커밋된 뒤
   *  `focusWaveformWord(line, wordIndexInVrew)` 로 **분할된 왼쪽 조각**(가시 인덱스 동일)을 선택한다.
   *  같은 틱에 `setWaveformWordId` 만 호출하면 id/행 배열 타이밍이 어긋져 파형 뷰가 튀는 문제가 있다.
   */
  const postSplitWaveformFocusRef = useRef<{ lineIndex: number; wordIndexInVrew: number } | null>(null)
  const [postSplitWaveformFocusCommit, setPostSplitWaveformFocusCommit] = useState(0)

  useEffect(() => {
    if (!videoPath || subtitles.length === 0) return
    if (mergedCutRanges.length > 0) return
    /** tombstone/가상 삭제만 스티치된 파형은 미디어 축 단어와 길이 불일치 — 리얼라인 금지 */
    if (mergedWaveformPeaksStitchCuts.length > 0) return
    /** 파형 편집 중 자동 경계 스냅은 Peaks 세그먼트·단어 칩과 충돌(1:1 깨짐) — 접힌 뒤에만 적용 */
    if (waveformLineIndex !== null) return
    // 스티치(편집 축) 파형이 없을 때(컷 0개) 는 원본 미디어 축 피크로 폴백 — 단어 시간은 이미 미디어 축이라 동일 축.
    const wf = stitchedWaveformJsonComputed ?? waveformPeaksJsonData
    if (!wf || !(timelineMediaEndHint > 0)) return
    /** 비디오·피크 버퍼만 키에 넣음 — 지문 FP 를 넣으면 줄 분할·단어 편집 후 해시가 바뀌어 접은 직후 대량 스냅(수백 단어)이 한 번 더 돈다 */
    const wfSig = `${wf.length ?? 0}:${(wf.data ?? []).length}`
    const runKey = `${videoPath}|${wfSig}`
    if (autoWordRealignRunKeyRef.current === runKey) return
    const { lines: next, changedWords } = realignSubtitleWordBoundariesByWaveform(
      subtitles,
      wf,
      timelineMediaEndHint
    )
    autoWordRealignRunKeyRef.current = runKey
    if (changedWords <= 0) return
    setGapFillWhenBuildingVrew(false)
    applySubtitleChange(() => next, { recordHistory: false })
    timelineEditLog('sync', 'auto word boundary realign', {
      changedWords,
      subtitleCount: subtitles.length,
      timelineMediaEndHint
    })
  }, [
    videoPath,
    subtitles,
    mergedCutRanges.length,
    mergedWaveformPeaksStitchCuts.length,
    stitchedWaveformJsonComputed,
    waveformPeaksJsonData,
    timelineMediaEndHint,
    applySubtitleChange,
    waveformLineIndex
  ])

  /** 파형 CUT 확정 — 편집축 구간을 단어 tombstone(`isDeleted`)으로만 반영 (CutRange·타임라인 스플라이스 없음) */
  const applyTimeRangeCut = useCallback(
    (startSec: number, endSec: number) => {
      const s = snapTimelineSec(Math.max(0, Math.min(startSec, endSec)))
      const e = snapTimelineSec(Math.max(0, Math.max(startSec, endSec)))
      if (!(e > s + 0.001)) {
        timelineEditLog('waveform-cut', 'applyTimeRangeCut 스킵 — 구간 너무 짧음', { startSec, endSec })
        return
      }
      setGapFillWhenBuildingVrew(false)
      applySubtitleChange((prev) => applyProgramTimeRangeTombstoneCutToSubtitleLines(prev, s, e))
    },
    [applySubtitleChange]
  )

  /**
   * 파형 패널의 자르기 라인 위치(편집축 초)에서 활성 단어를 두 개로 분할한다.
   * - `wordIndexInVrew` = vrew 화면 표시 인덱스(=가시 단어들 중 N번째, gap-fill 비활성 가정).
   * - 미디어 축으로 변환한 분할 시각이 단어 [start, end] 안에 들어 있어야 분할이 적용된다.
   * - 분할 결과: 왼쪽 단어는 `end = splitMediaSec`, 오른쪽 단어는 `start = splitMediaSec` 으로
   *   동일 텍스트·플래그를 유지한 채 두 개로 갈라진다.
   * - `applySubtitleChange` 의 기본 동작(recordHistory: true)을 사용하므로 Ctrl+Z 로 그대로 되돌릴 수 있다.
   */
  const splitWordAtEditSecFromWaveform = useCallback(
    (lineIndex: number, wordIndexInVrew: number, splitEditSec: number) => {
      /** [진단 3] 자르기 진입 — 인자/매핑 결과를 그대로 기록 */
      const splitMediaSec = Number.isFinite(splitEditSec) ? mapEditToMediaSec(splitEditSec) : NaN
      wfLog('peaks', 'splitWordAtEditSecFromWaveform 진입 [diag-3]', {
        lineIndex,
        wordIndexInVrew,
        splitEditSec,
        splitMediaSec
      })
      if (!Number.isFinite(splitEditSec)) {
        wfLog('peaks', 'splitWordAtEditSecFromWaveform reject [diag-3] splitEditSec 비정상', {
          splitEditSec
        })
        return
      }
      postSplitWaveformFocusRef.current = null
      setGapFillWhenBuildingVrew(false)
      /**
       * 분할 직후 좌측 조각의 새 id 를 같은 React batch 에서 `setWaveformWordId` 로 박는다.
       *  - 이렇게 하지 않으면 subtitles 만 먼저 갱신되고 activeWordId 는 한 프레임 뒤에 따라잡혀,
       *    그 사이 자식 `SubtitleWaveformCanvas` 가 `wi === -1` 상태로 한 번 렌더 → 파형이 “휙” 튀는 현상이 발생.
       *  - reducer 에서 id 를 계산해 외부 변수에 담아두고, applySubtitleChange 호출 직후 setState 로 적용.
       */
      let newLeftWordId: string | null = null
      applySubtitleChange((prev) => {
        if (lineIndex < 0 || lineIndex >= prev.length) {
          wfLog('peaks', 'splitWord reject [diag-3] lineIndex 범위 벗어남', {
            lineIndex,
            totalLines: prev.length
          })
          return prev
        }
        const line = prev[lineIndex]
        const words = line.words ?? []
        if (words.length === 0 || wordIndexInVrew < 0) {
          wfLog('peaks', 'splitWord reject [diag-3] words 비었거나 vrew idx 음수', {
            wordsLen: words.length,
            wordIndexInVrew
          })
          return prev
        }

        let visibleSeen = -1
        let storageIdx = -1
        for (let i = 0; i < words.length; i++) {
          if (!words[i].isDeleted) {
            visibleSeen += 1
            if (visibleSeen === wordIndexInVrew) {
              storageIdx = i
              break
            }
          }
        }
        if (storageIdx < 0) {
          wfLog('peaks', 'splitWord reject [diag-3] storageIdx 미발견', {
            lineIndex,
            wordIndexInVrew,
            visibleSeen,
            wordsLen: words.length
          })
          return prev
        }

        const w = words[storageIdx]
        const a = Math.min(w.start, w.end)
        const b = Math.max(w.start, w.end)
        const minSpan = 0.01
        if (!(b > a + minSpan * 2)) {
          wfLog('peaks', 'splitWord reject [diag-3] 단어 길이 < 2*minSpan', {
            lineIndex,
            storageIdx,
            word: w.word,
            a,
            b,
            span: b - a,
            minSpan
          })
          return prev
        }
        const t = Math.max(a + minSpan, Math.min(b - minSpan, splitMediaSec))
        if (!(t > a + 1e-6 && t < b - 1e-6)) {
          wfLog('peaks', 'splitWord reject [diag-3] t 가 단어 내부 아님', {
            lineIndex,
            storageIdx,
            word: w.word,
            a,
            b,
            splitMediaSec,
            t,
            tFromA: t - a,
            tToB: b - t
          })
          return prev
        }
        wfLog('peaks', 'splitWord 실행 [diag-3]', {
          lineIndex,
          storageIdx,
          word: w.word,
          a,
          b,
          splitMediaSec,
          t
        })

        /**
         * 시각 t 비율에 맞춰 글자도 두 조각으로 — 사용자가 “이 시점 이후 글자” 와 “이전 글자” 를
         * 각각 가지는 두 단어가 되도록 한다 (한 글자뿐이면 같은 글자를 양쪽에 유지).
         */
        const { left: leftText, right: rightText } = splitWordTextAtMediaCut(w.word, a, b, t)
        const leftFinal = leftText.length > 0 ? leftText : w.word
        const rightFinal = rightText.length > 0 ? rightText : w.word
        /**
         * 분할 체인 — 좌측은 `${parent}1`, 우측은 `${parent}2` 가 누적된다.
         * 어댑터(`vrewSubtitleAdapter`)가 이 chain 을 `block_{g}_{slot}_{chain}` 형태 ID 로 변환해,
         * 자르기 후에도 활성 단어 ID 가 의미 있게 새로워져 트림/뷰가 정상 갱신되도록 한다.
         */
        const parentChain = w.splitChain ?? ''
        const leftChain = `${parentChain}1`
        const rightChain = `${parentChain}2`
        const left: SubtitleWord = {
          ...w,
          start: a,
          end: t,
          word: leftFinal,
          splitChain: leftChain
        }
        const right: SubtitleWord = {
          ...w,
          start: t,
          end: b,
          word: rightFinal,
          splitChain: rightChain
        }
        /** 분할 직후 포커스: 가시 인덱스는 그대로 — 왼쪽 조각이 여전히 `wordIndexInVrew` 자리에 있다. */
        postSplitWaveformFocusRef.current = { lineIndex, wordIndexInVrew }
        /**
         * 좌측 조각이 어댑터에서 받게 될 안정 ID 를 reducer 안에서 미리 계산한다.
         *  포맷은 `vrewSubtitleAdapter` 의 `gapFill:false` 경로와 동일해야 한다.
         *    baseId = block_{lineIndex+1}_{storageIdx+1}, suffix = '_${leftChain}'
         */
        newLeftWordId = `${makeRowWordBlockId(lineIndex + 1, storageIdx + 1)}_${leftChain}`
        const nextWords = [
          ...words.slice(0, storageIdx),
          left,
          right,
          ...words.slice(storageIdx + 1)
        ]
        const updated: SubtitleLine = {
          ...line,
          words: nextWords,
          /** 글자 분할로 라인 text 도 재계산 — sentenceTokenTimeline 동기화 시 일관성 유지. */
          text: nextWords
            .filter((x) => x.isDeleted !== true)
            .map((x) => x.word)
            .join(' ')
            .trim()
        }
        return [...prev.slice(0, lineIndex), updated, ...prev.slice(lineIndex + 1)]
      })
      /**
       * 분할 성공 시 — subtitles 업데이트와 같은 batch 에서 활성 단어 ID 를 좌측 새 ID 로 강제.
       *  이렇게 해야 자식 캔버스가 처음부터 새 vrewRows 와 일치하는 activeWordId 로 렌더되어
       *  `wi === -1` 폴백을 거치지 않고 viewWin 도 튀지 않는다.
       */
      if (newLeftWordId != null) {
        wfLog('peaks', 'splitWord 분할 직후 좌측 포커스 강제 [diag-3]', {
          lineIndex,
          wordIndexInVrew,
          newLeftWordId
        })
        setWaveformLineIndex(lineIndex)
        setWaveformWordId(newLeftWordId)
        postSplitWaveformFocusRef.current = null
      } else if (postSplitWaveformFocusRef.current != null) {
        // 폴백(드물게 reducer 가 다른 경로로 진입한 경우): 기존 effect 기반 포커스로
        setPostSplitWaveformFocusCommit((c) => c + 1)
      }
    },
    [applySubtitleChange, mapEditToMediaSec]
  )

  /** 비파괴 삭제가 있으면 Peaks gap-fill 가상 무음 세그먼트를 넣지 않음 — 단어 수 불일치·병합 깨짐 방지 */
  const subtitlesContainDeletedWords = useMemo(
    () => subtitles.some((l) => (l.words ?? []).some((w) => w.isDeleted)),
    [subtitles]
  )

  /**
   * 파형(Peaks)은 gap-fill 무음 더미 단어마다 세그먼트가 생기는데, 자막 카드 칩은 원본 단어만 있어 개수·경계가 어긋남.
   * tombstone 이 있거나 사용자가 끈 경우 gap-fill 을 끄고 vrew 단어 배열을 자막과 1:1로 맞춘다.
   */
  /**
   * **`mapWordMediaToProgram` 을 useCallback 으로 안정화 — vrewRowCache(Incremental) 의 cache key 가 매번 변하면 효과 0.**
   * 매 vrewRows useMemo 호출에서 새 화살표 함수를 넘기면 `vrewRowCache` 가 모든 line 에서 miss 되어
   * 1473 word 전체가 재빌드. mapMediaToEditSec 가 변할 때만 새 reference 가 되도록 useCallback.
   */
  const mapWordMediaToProgramForVrew = useCallback(
    (ms: number, me: number) => ({
      start: mapMediaToEditSec(ms),
      end: mapMediaToEditSec(me)
    }),
    [mapMediaToEditSec]
  )

  const vrewRowsRaw = useMemo(
    () => {
      const t0 = performance.now()
      const out = subtitleLinesToVrewRows(subtitles, {
        gapFill: shouldFillGapsWhenBuildingVrewRows(
          gapFillWhenBuildingVrew,
          subtitlesContainDeletedWords
        ),
        mapWordMediaToProgram: mapWordMediaToProgramForVrew
      })
      const ms = performance.now() - t0
      if (ms > 5) {
        const wordCount = subtitles.reduce(
          (acc, l) => acc + (l.words?.length ?? 0),
          0
        )
        wfLog('perf', 'vrewRows 빌드', {
          ms: Math.round(ms),
          lineCount: subtitles.length,
          wordCount,
          gapFill: shouldFillGapsWhenBuildingVrewRows(
            gapFillWhenBuildingVrew,
            subtitlesContainDeletedWords
          )
        })
      }
      return out
    },
    [subtitles, gapFillWhenBuildingVrew, subtitlesContainDeletedWords, mapWordMediaToProgramForVrew]
  )
  /**
   * `subtitleLinesToVrewRows` 내부는 WeakMap 으로 `SubtitleRow` 를 캐시하므로 element reference 는 안정.
   * 하지만 `lines.map(...)` 이 항상 새 array 를 만들어 `SubtitleVirtualList` 가 받는 prop reference 가 매 렌더 변한다.
   * element-wise 동일하면 prev array 그대로 유지 → `SubtitleVirtualList` `rowProps` useMemo 와 자식 row reconcile 모두 skip.
   */
  const vrewRows = useStableArrayReference(vrewRowsRaw) as SubtitleRow[]

  /**
   * SubtitleVirtualList 로 들어가는 1,473 word x 303 line 의 prop 을 background priority 로 격하 — 추출 직후 첫 commit 의 main thread 점유 시간을 줄여
   * 컨트롤이 즉시 반응하게 한다. 다른 소비처(재생 동기화, peaks 계산 등) 는 즉시값 그대로.
   */
  const deferredSubtitlesForUi = useDeferredValue(subtitles)
  const deferredVrewRowsForUi = useDeferredValue(vrewRows)

  /**
   * `SubtitleDataProvider` 가 **즉시** `subtitles` 를 들고 있으므로(`SubtitleVirtualRow` 가 wordRail 을 그리는 소스),
   * 같은 컴포넌트로 흘러가는 `vrewRows` 도 즉시여야 한다. 둘이 한 commit 안에서 박자가 어긋나면 칩의 `chipWordId`
   * (deferred)와 `wordRail` 의 단어 시간(즉시)이 매칭되지 않아 더블클릭이 wrong storage index 를 잡고
   * `focusWaveformWord` 가 early-return — 파형이 안 열리고 hover caret 표시도 다른 단어로 이동한다.
   *
   * deferred 는 추출 직후 1,473단어 첫 commit 페인트 비용을 낮추는 용도였는데, tombstone/split 가 매우 빈번한
   * 본 워크플로우에선 deferred 가 더 큰 비일관 비용을 만든다 → 항상 즉시값을 사용한다.
   */
  void deferredSubtitlesForUi
  void deferredVrewRowsForUi
  const subtitlesForSubtitleVirtualList = subtitles
  const vrewRowsForSubtitleVirtualList = vrewRows

  /**
   * 자막 추출 완료 후에도 오버레이를 유지하고, deferred 리스트 prop 이 실제 값과 동기화된 뒤
   * (paint 한 단계 이후) 닫는다 → 진행률 100% 직후 곧바로 정렬된 카드가 보이게 함.
   */
  useEffect(() => {
    if (!isExtracting || !extractAwaitListPaint) return
    if (subtitles.length === 0) return
    if (deferredSubtitlesForUi !== subtitles) return
    if (deferredVrewRowsForUi !== vrewRows) return
    let cancelled = false
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return
        queueMicrotask(() => {
          if (cancelled) return
          setIsExtracting(false)
          setProgress(0)
          setExtractAwaitListPaint(false)
        })
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [
    isExtracting,
    extractAwaitListPaint,
    subtitles,
    deferredSubtitlesForUi,
    vrewRows,
    deferredVrewRowsForUi
  ])

  /** deferred 동기화가 막히는 비정상 시 오버레이 무한 대기 방지 */
  useEffect(() => {
    if (!isExtracting || !extractAwaitListPaint) return
    const t = window.setTimeout(() => {
      wfLog('perf', 'extract overlay reveal fallback (15s timeout)', {
        ts: new Date().toISOString()
      })
      setIsExtracting(false)
      setProgress(0)
      setExtractAwaitListPaint(false)
    }, 15000)
    return () => window.clearTimeout(t)
  }, [isExtracting, extractAwaitListPaint])

  /** Peaks 줌 — 편집 타임라인 경계(splice 파형·세그먼트와 동일 축) */
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
    const line =
      READ_SUBTITLES_FROM_VIRTUAL_TIMELINE ? subtitlesForList[waveformLineIndex] : subtitles[waveformLineIndex]
    return line ? { start: line.start, end: line.end } : null
  }, [waveformLineIndex, vrewRows, subtitles, subtitlesForList])

  const registerWaveMount = useCallback((lineIndex: number, el: HTMLDivElement | null) => {
    if (el) waveMountByLineRef.current.set(lineIndex, el)
    else waveMountByLineRef.current.delete(lineIndex)
    const dirty = waveformPeaksRef.current?.onWaveMountDirty
    if (dirty) {
      dirty()
    } else {
      queueMicrotask(() => waveformPeaksRef.current?.onWaveMountDirty?.())
    }
    queueMicrotask(() => commitEditSecToUi(playheadEditSecRef.current))
  }, [commitEditSecToUi])

  const focusWaveformWord = useCallback(
    (lineIndex: number, wordIndex: number, source: 'double-click' | 'expanded-click') => {
      if (isWaveformFocusSuppressed()) {
        timelineEditLog('playback', `waveform ${source} 시크 억제(transaction/focus guard)`, {
          lineIndex,
          wordIndex
        })
        return
      }
      const row = vrewRows[lineIndex]
      const w = row?.words?.[wordIndex]
      if (!w) return
      if (source === 'expanded-click' && waveformLineIndex === lineIndex && waveformWordId === w.id) {
        setWaveformLineIndex(null)
        setWaveformWordId(null)
        return
      }
      /** 같은 카드에서 이미 파형이 열려 있으면 접지 않고 활성 단어만 이동 */
      if (waveformLineIndex === lineIndex) {
        setWaveformWordId(w.id)
        return
      }
      setWaveformLineIndex(lineIndex)
      setWaveformWordId(w.id)
    },
    [vrewRows, waveformLineIndex, waveformWordId, isWaveformFocusSuppressed]
  )

  useEffect(() => {
    const p = postSplitWaveformFocusRef.current
    if (p == null) return
    postSplitWaveformFocusRef.current = null
    focusWaveformWord(p.lineIndex, p.wordIndexInVrew, 'double-click')
  }, [subtitles, postSplitWaveformFocusCommit, focusWaveformWord])

  const onWaveformWordDoubleClick = useCallback(
    (lineIndex: number, wordIndex: number) => {
      focusWaveformWord(lineIndex, wordIndex, 'double-click')
    },
    [focusWaveformWord]
  )

  /** 파형이 펼쳐진 줄에서 단어 칩 단일 클릭 — 활성 칩이면 접기, 다른 칩이면 파형 유지·포커스만 이동 */
  const onWaveformExpandedLineWordClick = useCallback(
    (lineIndex: number, wordIndex: number) => {
      focusWaveformWord(lineIndex, wordIndex, 'expanded-click')
    },
    [focusWaveformWord]
  )

  /** 파형 마운트를 단어 아래로 옮긴 뒤 body 포털·연결선 좌표 동기화 */
  const onWaveformMountLayout = useCallback(() => {
    queueMicrotask(() => {
      waveformPeaksRef.current?.onWaveMountDirty?.()
      commitEditSecToUi(playheadEditSecRef.current)
    })
  }, [commitEditSecToUi])

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
      /** 펼친 줄의 단어 칩 — 클릭은 칩 onClick(접기·단어 이동)에서 처리, 여기서는 외부 클릭만 닫기 */
      if (el.closest('[data-waveform-expanded-row-chip="1"]')) return
      if (el.closest('[data-waveform-mount-for-open-line="1"]')) return
      if (el.closest('[data-waveform-no-dismiss="1"]')) return
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

        // 1) 동일 카드 내: 현재 단어의 왼쪽 단어 삭제 — 비파괴(isDeleted)
        if (wordIndex > 0) {
          const nextWords = words.map((w, i) =>
            i === wordIndex - 1 ? ({ ...w, isDeleted: true } as SubtitleWord) : w
          )
          const visibleNext = nextWords.filter((w) => !w.isDeleted)
          if (visibleNext.length === 0) {
            // 마지막 카드(prev.length === 1)도 비워지면 그대로 제거 — 자막 배열은 []까지 내려갈 수 있음
            return [...prev.slice(0, cardIndex), ...prev.slice(cardIndex + 1)]
          }
          const nextStart = visibleNext[0].start
          const nextEnd = visibleNext[visibleNext.length - 1].end
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
      const deleteOpId = ++deleteOpSeqRef.current
      lastDeleteOpIdRef.current = deleteOpId
      armDeleteGuard('deleteWordAt')
      logDeletePlaybackSnapshot('deleteWordAt 시작', { deleteOpId, cardIndex, caretIndex })
      setGapFillWhenBuildingVrew(false)
      let pendingMediaCuts: CutRange[] = []
      let pendingHint = ''
      applySubtitleChange((prev) => {
        if (cardIndex < 0 || cardIndex >= prev.length) return prev
        const cur = prev[cardIndex]
        const words = cur.words ?? []
        if (caretIndex < 0 || caretIndex > words.length) return prev

        // 1) 커서 오른쪽 단어 삭제 — 비파괴(isDeleted) + 편집축 리플 → 뒤 단어/줄을 파형과 맞춤
        if (caretIndex < words.length) {
          const result = subtitleLinesAfterSoftDeleteWordRange(
            prev,
            cardIndex,
            caretIndex,
            caretIndex + 1,
            mergedCutRanges
          )
          if (!result) return prev
          const { lines: next, mediaCutsForVirtual } = result
          const updatedCard = next[cardIndex]
          const visible = (updatedCard?.words ?? []).filter((w) => !w.isDeleted)
          if (visible.length === 0) {
            // 단어 1개 카드도 동일 경로 — 마지막 카드(next.length === 1)까지 제거 허용
            pendingMediaCuts = mediaCutsForVirtual
            pendingHint = words[caretIndex]?.word ?? ''
            return [...next.slice(0, cardIndex), ...next.slice(cardIndex + 1)]
          }
          pendingMediaCuts = mediaCutsForVirtual
          pendingHint = words[caretIndex]?.word ?? ''
          return next
        }

        // 2) 카드 끝(caretIndex===words.length)에서 Delete: 다음 카드와 병합 (리플 없음)
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

        // 3) 그 외 — 카드 통째 제거(예: 단일 단어·커서 끝, 다음 카드 없음). 마지막 카드도 허용.
        return [...prev.slice(0, cardIndex), ...prev.slice(cardIndex + 1)]
      })
      if (pendingMediaCuts.length > 0) {
        const cuts = pendingMediaCuts
        const hint = pendingHint
        /**
         * 가상 타임라인 갱신은 **같은 핸들러 안에서** 호출 → React 18 자동 batching 으로 `setSentenceTokenTimeline`
         * 과 한 commit 에 묶인다. 이전엔 `setTimeout(0)` 로 분리했지만, 그 사이에 발생한 Ctrl+Z 가
         * `virtualTimelineDeletedRef.current` 의 옛 값을 읽고 → 그 후 setTimeout 이 늦게 fire 해서
         * 가상 삭제가 다시 복원되지 않는 race 가 있었다.
         *
         * 파형 픽셀 데이터(`stitchedWaveformJsonComputed`) 는 이미 `useDeferredValue` 로 한 단계 늦춰지므로
         * 같은 commit 에 묶여도 740k 픽셀 재페인트가 첫 페인트를 막지 않는다.
         */
        setVirtualTimelineDeleted((vp) => {
          let acc = vp
          for (const r of cuts) acc = mergeDeletedMediaIntoTimeline(acc, r, hint)
          return acc
        })
      }
      deleteProbeTimersRef.current.forEach((id) => window.clearTimeout(id))
      deleteProbeTimersRef.current = [500, 2000, 5000, 10000, 20000, 30000].map((delayMs) =>
        window.setTimeout(() => {
          logDeletePlaybackSnapshot('deleteWordAt 지연 스냅샷', { deleteOpId, delayMs })
        }, delayMs)
      )
      queueMicrotask(() => {
        logDeletePlaybackSnapshot('deleteWordAt 직후', { deleteOpId, cardIndex, caretIndex })
      })
    },
    [applySubtitleChange, logDeletePlaybackSnapshot, armDeleteGuard, mergedCutRanges]
  )

  const deleteWordRangeAt = useCallback(
    (cardIndex: number, fromWordIndex: number, toWordIndex: number) => {
      const deleteOpId = ++deleteOpSeqRef.current
      lastDeleteOpIdRef.current = deleteOpId
      armDeleteGuard('deleteWordRangeAt')
      logDeletePlaybackSnapshot('deleteWordRangeAt 시작', { deleteOpId, cardIndex, fromWordIndex, toWordIndex })
      setGapFillWhenBuildingVrew(false)
      let pendingMediaCuts: CutRange[] = []
      let pendingHint = ''
      applySubtitleChange((prev) => {
        if (cardIndex < 0 || cardIndex >= prev.length) return prev
        const cur = prev[cardIndex]
        const words = cur.words ?? []
        const start = Math.max(0, Math.min(fromWordIndex, toWordIndex))
        const end = Math.min(words.length, Math.max(fromWordIndex, toWordIndex))
        if (start >= end) return prev

        const result = subtitleLinesAfterSoftDeleteWordRange(
          prev,
          cardIndex,
          start,
          end,
          mergedCutRanges
        )
        if (!result) return prev
        const { lines: next, mediaCutsForVirtual } = result
        const updatedCard = next[cardIndex]
        const visible = (updatedCard?.words ?? []).filter((w) => !w.isDeleted)
        if (visible.length > 0) {
          pendingMediaCuts = mediaCutsForVirtual
          pendingHint = (cur.words?.[start]?.word ?? '').trim()
          return next
        }

        // 단어가 전부 없어진 카드는 마지막 카드(next.length === 1)도 제거 — 자막 배열은 []까지 내려갈 수 있음
        pendingMediaCuts = mediaCutsForVirtual
        pendingHint = (cur.words?.[start]?.word ?? '').trim()
        return [...next.slice(0, cardIndex), ...next.slice(cardIndex + 1)]
      })
      if (pendingMediaCuts.length > 0) {
        const cuts = pendingMediaCuts
        const hint = pendingHint
        /** 동일 — undo 정합성을 위해 같은 핸들러에 묶고, stitched 픽셀 redraw 는 useDeferredValue 가 처리 */
        setVirtualTimelineDeleted((vp) => {
          let acc = vp
          for (const r of cuts) acc = mergeDeletedMediaIntoTimeline(acc, r, hint)
          return acc
        })
      }
      deleteProbeTimersRef.current.forEach((id) => window.clearTimeout(id))
      deleteProbeTimersRef.current = [500, 2000, 5000, 10000, 20000, 30000].map((delayMs) =>
        window.setTimeout(() => {
          logDeletePlaybackSnapshot('deleteWordRangeAt 지연 스냅샷', { deleteOpId, delayMs })
        }, delayMs)
      )
      queueMicrotask(() => {
        logDeletePlaybackSnapshot('deleteWordRangeAt 직후', { deleteOpId, cardIndex, fromWordIndex, toWordIndex })
      })
    },
    [applySubtitleChange, logDeletePlaybackSnapshot, armDeleteGuard, mergedCutRanges]
  )

  const splitSubtitleAt = useCallback((index: number, cursorPos: number) => {
    applySubtitleChange((prev) => splitSubtitleLine(prev, index, cursorPos))
  }, [applySubtitleChange])

  const mergeEmptySubtitleAt = useCallback((index: number) => {
    applySubtitleChange((prev) => mergeEmptySubtitleWithPrevious(prev, index) ?? prev)
  }, [applySubtitleChange])

  /**
   * videoPath 가 null 일 때 idle 리셋 — `setX([])` 가 매번 새 array 참조라 React eager bail-out 실패,
   * 그게 1.2kHz 렌더 폭주의 진짜 원인이었음. functional setter 로 prev 가 이미 빈 array 면 prev 자체를 반환해 bail 보장.
   * → chain 끊김: sentenceTokenTimeline ref 안정 → subtitles useMemo ref 안정 → commitEditSecToUi ref 안정 → 본 effect 재발화 0.
   */
  useEffect(() => {
    if (!videoPath) {
      playbackEnginePhaseRef.current = 'idle'
      peaksReportedDurationRef.current = null
      waveformTimelineExactRef.current = null
      setWaveformMediaSpanSec(null)
      setTimelineAxisMismatch(null)
      cutSigRef.current = ''
      playbackPendingRevisionRef.current = 0
      setPlaybackPendingRevision(0)
      setPlaybackCommittedRevision(0)
      commitEditSecToUi(0)
      setDurationSec(0)
      setIsPlaying(false)
      setSentenceTokenTimeline((prev) => (prev.length === 0 ? prev : []))
      setCutRanges((prev) => (prev.length === 0 ? prev : []))
      setVirtualTimelineDeleted((prev) => (prev.length === 0 ? prev : []))
    }
  }, [videoPath, commitEditSecToUi])

  const syncFromVideo = useCallback(() => {
    if (isDeleteGuardActive()) {
      const masterAudio = masterAudioRef.current
      if (masterAudio) {
        const pm = playbackTimelineMappingRef.current
        const e = clampProgramEditSec(pm.masterAudioToProgramSec(masterAudio.currentTime))
        commitEditSecToUi(e)
      }
      return
    }
    const el = videoRef.current
    const masterAudio = masterAudioRef.current
    if (!el || !masterAudio) return

    const bumpDurFromVideo = (): void => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        setDurationSec(el.duration)
      }
    }

    /**
     * 재생 중(`isPlaying`)에는 RAF `tick`만 playhead를 커밋한다.
     * `timeupdate`가 같은 값을 반복 커밋하면 RAF 양자화·렌더가 겹쳐 재생선이 끊겨 보인다.
     */
    if (isPlayingRef.current) {
      bumpDurFromVideo()
      return
    }

    const waEngine = webAudioMasterPlaybackRef.current
    /** playing gate 등으로 아직 `isPlaying`이 false인 짧은 구간 — RAF 미가동 시 UI만 보정 */
    if (waEngine?.isPlaying()) {
      bumpDurFromVideo()
      const wm = waEngine.getCurrentMediaSec()
      if (wm != null && Number.isFinite(wm)) {
        commitEditSecToUi(mapMediaToEditSec(wm))
      } else {
        commitEditSecToUi(playheadEditSecRef.current)
      }
      return
    }

    /**
     * HTML `<audio>` 마스터 클럭 → 편집 축 단일 경로 (stitched / passthrough 구분 없음).
     * 비디오·디코더 위치는 RAF·시크에서만 다룬다.
     */
    const pm = playbackTimelineMappingRef.current
    const raw = pm.masterAudioToProgramSec(masterAudio.currentTime)
    const stepped = Math.round(raw / PLAYHEAD_STEP_SEC) * PLAYHEAD_STEP_SEC
    commitEditSecToUi(clampProgramEditSec(stepped))
    bumpDurFromVideo()
  }, [isDeleteGuardActive, commitEditSecToUi, clampProgramEditSec, mapMediaToEditSec])

  /** CUT/tombstone 직후 `timeupdate`가 없을 수 있어 재생 헤드가 삭제 구간 안에 남음 → 재생이 멈춘 것처럼 보임 */
  useEffect(() => {
    const el = videoRef.current
    if (!el || !videoPath) return
    if (isPlayingRef.current || isEdlSessionActive()) return
    if (playbackTimelineMappingRef.current.masterMode === 'stitched') return
    if (isDeleteGuardActive()) {
      timelineEditLog('playback', 'cutRanges 즉시 보정 지연(delete guard)', {
        deleteOpId: lastDeleteOpIdRef.current
      })
      return
    }
    if (mergedWaveformPeaksStitchCuts.length === 0) return
    const fromTime = el.currentTime
    const skipped = skipCutRangeAt(fromTime, mergedWaveformPeaksStitchCuts)
    let t = skipped
    if (Number.isFinite(el.duration) && el.duration > 0) {
      t = Math.min(skipped, Math.max(0, el.duration - 0.001))
    }
    if (t !== fromTime) {
      el.currentTime = t
      commitEditSecToUi(mapMediaToEditSec(t))
      const ma = masterAudioRef.current
      const wa = webAudioMasterPlaybackRef.current
      if (ma && !wa?.isPlaying() && !ma.paused && !ma.seeking) {
        assignMasterAudioTimelineSecIfNeeded(ma, mediaToMasterAudioSec(t))
      }
      timelineEditLog('playback', 'cutRanges/tombstone 반영 — currentTime 을 삭제 구간 밖으로 이동', {
        from: fromTime,
        to: t
      })
    }
  }, [
    mergedWaveformPeaksStitchCuts,
    videoPath,
    isDeleteGuardActive,
    commitEditSecToUi,
    mapMediaToEditSec,
    mediaToMasterAudioSec
  ])

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    const masterAudio = masterAudioRef.current
    if (!el || !masterAudio) return
    const waOut = Boolean(webAudioMasterPlaybackRef.current?.isPlaying())
    const htmlOut = !masterAudio.paused
    const outputPlaying = waOut || htmlOut
    if (isOneShotSessionLocked() && !outputPlaying) {
      timelineEditLog('playback', 'togglePlay 차단(one-shot hard lock)', {
        activeOneShot: oneShotRangeRef.current,
        phase: playbackEnginePhaseRef.current
      })
      return
    }
    const startPlaybackNow = (): void => {
      const from = el.currentTime
      const stitchedMode = playbackTimelineMappingRef.current.masterMode === 'stitched'
      let t = stitchedMode ? from : skipCutRangeAt(from, mergedPlaybackSkipRangesRef.current)
      if (Number.isFinite(el.duration) && el.duration > 0) {
        t = Math.min(t, Math.max(0, el.duration - 0.001))
      }
      if (t !== from) {
        assignMasterAudioTimelineSecIfNeeded(masterAudio, mediaToMasterAudioSec(t))
        el.currentTime = t
        timelineEditLog('playback', 'togglePlay 직전 — 삭제 구간 밖으로 시크', { from, to: t })
      }
      const schedule = armPlaybackSchedule(t, null, 'continuous')
      if (schedule.length <= 0) return
      t = schedule[0]!.startMediaSec
      startSyncedPlayback('togglePlay', mapMediaToEditSec(t), {
        onMapperBlocked: () => {
          queuePlaybackIntent({ kind: 'play' })
        },
        onAudioPlayRejected: (e) => {
          timelineEditLog('playback', 'togglePlay play() 거절', {
            message: e instanceof Error ? e.message : String(e)
          })
        }
      })
    }
    if (isDeleteGuardActive()) {
      const wantsPlay = !outputPlaying
      timelineEditLog('playback', 'togglePlay 차단(delete guard)', {
        deleteOpId: lastDeleteOpIdRef.current,
        wantsPlay,
        queued: wantsPlay
      })
      if (wantsPlay) {
        queuePlaybackIntent({ kind: 'play' })
      }
      return
    }
    if (!isOneShotSessionLocked()) clearOneShotSession('togglePlay')
    if (!outputPlaying) {
      if (!hasPlayableSubtitleWordIntervals(subtitles)) {
        timelineEditLog('playback', 'togglePlay 차단(재생 가능 단어 없음)', {
          subtitleLineCount: subtitles.length
        })
        return
      }
      userPauseRequestedRef.current = false
      const allow = playbackCommandRouterRef.current.beginSeekLike('togglePlay')
      if (!allow.allowed) {
        timelineEditLog('playback', 'togglePlay 차단(router)', { reason: allow.reason })
        queuePlaybackIntent({ kind: 'play' })
        return
      }
      beginPlaybackSession(allow.sessionId)
      playbackEnginePhaseRef.current = 'playing'
      setIsBuffering(true)
      startPlaybackNow()
    } else {
      userPauseRequestedRef.current = true
      playbackEnginePhaseRef.current = 'idle'
      clearPlaybackSession()
      clearPlaybackSchedule('togglePlay pause')
      const waPos = webAudioMasterPlaybackRef.current?.getCurrentMediaSec()
      const editPause =
        waPos != null
          ? mapMediaToEditSec(waPos)
          : mapMediaToEditSec(masterAudioToMediaSec(masterAudio.currentTime))
      syncPausedMasterToEdit(editPause)
      timelineEditLog('playback', 'pause-call video.pause (togglePlay pause branch)', {
        videoCurrentTime: el.currentTime,
        audioCurrentTime: masterAudio.currentTime
      })
      el.pause()
    }
  }, [
    syncPausedMasterToEdit,
    mapMediaToEditSec,
    masterAudioToMediaSec,
    mediaToMasterAudioSec,
    isDeleteGuardActive,
    playbackSnapshot.pendingRevision,
    playbackSnapshot.committedRevision,
    playbackSnapshot.mapperReady,
    playbackSnapshot.masterMode,
    queuePlaybackIntent,
    startSyncedPlayback,
    beginPlaybackSession,
    clearPlaybackSession,
    isOneShotSessionLocked,
    clearOneShotSession,
    subtitles
  ])

  const dispatchPlaybackIntent = useCallback(
    (
      intent:
        | { kind: 'seek'; startSec: number; basis: 'edit' | 'media'; source: SeekIntentSource }
        | { kind: 'seekAndPlay'; startSec: number; basis: 'edit' | 'media' }
        | { kind: 'playRange'; startSec: number; endSec: number }
        | { kind: 'togglePlay' }
    ): void => {
      const oneShot = oneShotSessionRef.current
      if (oneShot) {
        if (intent.kind === 'seek' || intent.kind === 'seekAndPlay') {
          timelineEditLog('playback', 'dispatchPlaybackIntent 차단(one-shot mode)', {
            kind: intent.kind,
            source: intent.kind === 'seek' ? intent.source : undefined,
            oneShotSession: oneShot
          })
          return
        }
      }
      if (intent.kind === 'seek') {
        dispatchSeekIntent(intent.startSec, intent.basis, intent.source)
        return
      }
      if (isPlaybackTransactionLocked()) {
        if (intent.kind === 'seekAndPlay') {
          queuePlaybackIntent({ kind: 'seekAndPlay', startSec: intent.startSec, basis: intent.basis })
        } else if (intent.kind === 'playRange') {
          queuePlaybackIntent({ kind: 'playRange', startSec: intent.startSec, endSec: intent.endSec })
        } else {
          queuePlaybackIntent({ kind: 'play' })
        }
        timelineEditLog('playback', 'dispatchPlaybackIntent 차단(transaction lock)', {
          kind: intent.kind,
          deleteGuard: isDeleteGuardActive(),
          mapperReady: isPlaybackMapperReady()
        })
        return
      }
      if (intent.kind === 'seekAndPlay') {
        seekAndPlayTo(intent.startSec, intent.basis)
      } else if (intent.kind === 'playRange') {
        playEditRange(intent.startSec, intent.endSec)
      } else {
        togglePlay()
      }
    },
    [
      dispatchSeekIntent,
      isPlaybackTransactionLocked,
      queuePlaybackIntent,
      isDeleteGuardActive,
      isPlaybackMapperReady,
      seekAndPlayTo,
      playEditRange,
      togglePlay
    ]
  )

  const dispatchSeekAndPlayIntent = useCallback(
    (startSec: number, basis: 'edit' | 'media' = 'edit') => {
      dispatchPlaybackIntent({ kind: 'seekAndPlay', startSec, basis })
    },
    [dispatchPlaybackIntent]
  )

  const dispatchPlayRangeIntent = useCallback(
    (startSec: number, endSec: number) => {
      dispatchPlaybackIntent({ kind: 'playRange', startSec, endSec })
    },
    [dispatchPlaybackIntent]
  )

  const dispatchPlayRangeIntentFromWaveform = useCallback(
    (
      startSec: number,
      endSec: number,
      meta?: { wordId?: string | null; wordText?: string | null; lineIndex?: number | null }
    ) => {
      lastWaveformPlayRangeIntentRef.current = {
        at: performance.now(),
        startSec,
        endSec,
        wordId: meta?.wordId ?? null,
        wordText: meta?.wordText ?? null
      }
      timelineEditLog('playback-diag', 'waveform click→playRange intent', {
        startSec,
        endSec,
        wordId: meta?.wordId ?? null,
        wordText: meta?.wordText ?? null,
        lineIndex: meta?.lineIndex ?? null
      })
      /** [진단 4] waveform.log 에도 동일 정보를 흘려, edge-drag commit 직후 흐름을 한 파일에서 추적. */
      const guards = {
        isBuffering,
        isEdlSessionActive: isEdlSessionActive(),
        phase: playbackEnginePhaseRef.current
      }
      wfLog('peaks', 'dispatchPlayRangeIntentFromWaveform 진입 [diag-4]', {
        startSec,
        endSec,
        wordId: meta?.wordId ?? null,
        wordText: meta?.wordText ?? null,
        lineIndex: meta?.lineIndex ?? null,
        ...guards,
        oneShotSession: oneShotSessionRef.current
      })
      /**
       * 모든 가드가 idle 인데 oneShotSession 만 남아있으면 stale — 이전 세션이 정상 종료되지 않아
       * `playEditRange` 의 세션 디듑 가드에 영원히 걸려 같은 단어 재생이 차단된다. 명시적으로 정리.
       */
      if (
        !isBuffering &&
        !isEdlSessionActive() &&
        playbackEnginePhaseRef.current === 'idle' &&
        oneShotSessionRef.current != null
      ) {
        wfLog('peaks', 'dispatchPlayRangeIntentFromWaveform stale one-shot 정리 [diag-4]', {
          oneShotSession: oneShotSessionRef.current
        })
        clearOneShotSession('dispatch idle stale clear')
      }
      if (isBuffering || isEdlSessionActive() || playbackEnginePhaseRef.current !== 'idle') {
        queuePlaybackIntent({ kind: 'playRange', startSec, endSec })
        timelineEditLog('playback', 'waveform playRange queued(non-idle or buffering)', {
          startSec,
          endSec,
          isBuffering,
          enginePlaybackDesired: isEdlSessionActive(),
          phase: playbackEnginePhaseRef.current
        })
        wfLog('peaks', 'dispatchPlayRangeIntentFromWaveform → queued [diag-4]', {
          startSec,
          endSec,
          ...guards
        })
        return
      }
      wfLog('peaks', 'dispatchPlayRangeIntentFromWaveform → dispatch [diag-4]', {
        startSec,
        endSec,
        ...guards
      })
      dispatchPlayRangeIntent(startSec, endSec)
    },
    [dispatchPlayRangeIntent, isBuffering, isEdlSessionActive, queuePlaybackIntent, clearOneShotSession]
  )

  const dispatchTogglePlayIntent = useCallback(() => {
    dispatchPlaybackIntent({ kind: 'togglePlay' })
  }, [dispatchPlaybackIntent])

  useEffect(() => {
    return () => {
      if (pendingTogglePlayTimerRef.current !== null) {
        window.clearTimeout(pendingTogglePlayTimerRef.current)
        pendingTogglePlayTimerRef.current = null
      }
      if (pendingSeekAndPlayTimerRef.current !== null) {
        window.clearTimeout(pendingSeekAndPlayTimerRef.current)
        pendingSeekAndPlayTimerRef.current = null
      }
      if (pendingPlayEditRangeTimerRef.current !== null) {
        window.clearTimeout(pendingPlayEditRangeTimerRef.current)
        pendingPlayEditRangeTimerRef.current = null
      }
    }
  }, [])

  // 삭제 가드 중 들어온 사용자 의도(시크/재생)를 버리지 않고 가드 해제 즉시 재실행
  useEffect(() => {
    const id = window.setInterval(() => {
      if (isDeleteGuardActive()) return
      if (!isPlaybackMapperReady()) return
      if (isBuffering || isEdlSessionActive() || playbackEnginePhaseRef.current !== 'idle') return
      if (
        pendingSeekAfterGuardRef.current == null &&
        pendingSeekAndPlayAfterGuardRef.current == null &&
        pendingPlayRangeAfterGuardRef.current == null &&
        !pendingPlayIntentRef.current
      ) {
        return
      }
      const pendingRange = pendingPlayRangeAfterGuardRef.current
      const pendingSeekPlay = pendingSeekAndPlayAfterGuardRef.current
      const pendingSeek = pendingSeekAfterGuardRef.current
      pendingPlayRangeAfterGuardRef.current = null
      pendingSeekAndPlayAfterGuardRef.current = null
      pendingSeekAfterGuardRef.current = null
      if (isOneShotSessionLocked()) {
        timelineEditLog('playback', 'pending intent flush 차단(one-shot hard lock)', {
          hasRange: Boolean(pendingRange),
          hasSeekAndPlay: Boolean(pendingSeekPlay),
          hasSeek: Boolean(pendingSeek),
          hasPlay: pendingPlayIntentRef.current,
          activeOneShot: oneShotRangeRef.current
        })
        pendingPlayIntentRef.current = false
        return
      }
      if (pendingRange) {
        dispatchPlaybackIntent({ kind: 'playRange', startSec: pendingRange.startSec, endSec: pendingRange.endSec })
      } else if (pendingSeekPlay) {
        dispatchPlaybackIntent({ kind: 'seekAndPlay', startSec: pendingSeekPlay.startSec, basis: pendingSeekPlay.basis })
      } else if (pendingSeek) {
        dispatchPlaybackIntent({
          kind: 'seek',
          startSec: pendingSeek.startSec,
          basis: pendingSeek.basis,
          source: pendingSeek.source
        })
      }
      if (pendingPlayIntentRef.current) {
        pendingPlayIntentRef.current = false
        const a = masterAudioRef.current
        if (a?.paused) dispatchPlaybackIntent({ kind: 'togglePlay' })
      }
    }, 35)
    return () => window.clearInterval(id)
  }, [isDeleteGuardActive, isPlaybackMapperReady, dispatchPlaybackIntent, pendingGuardQueueVersion, isOneShotSessionLocked, isBuffering, isEdlSessionActive])

  useEffect(() => {
    // 재생 의도가 꺼졌는데 비디오가 계속 흘러 커서/하이라이트/삭제 동작을 깨뜨리는 드리프트 차단
    const id = window.setInterval(() => {
      if (performance.now() < oneShotSoftStopUntilRef.current) return
      if (isEdlSessionActive() || isPlayingRef.current) return
      const v = videoRef.current
      const a = masterAudioRef.current
      if (!v || !a) return
      if (!v.paused) {
        timelineEditLog('playback', 'idle drift guard: pause video', {
          videoCurrentTime: v.currentTime,
          audioCurrentTime: a.currentTime
        })
        v.pause()
      }
      const edit = playheadEditSecRef.current
      const targetMediaSec = Math.max(0, mapEditToMediaSec(edit))
      if (!v.seeking && Math.abs(v.currentTime - targetMediaSec) > 0.06) {
        v.currentTime = targetMediaSec
      }
      const targetMasterT = playbackTimelineMappingRef.current.programToMasterAudioSec(edit)
      if (!a.seeking && Math.abs(a.currentTime - targetMasterT) > 0.06) {
        assignMasterAudioTimelineSecIfNeeded(a, targetMasterT)
      }
    }, 120)
    return () => window.clearInterval(id)
  }, [isEdlSessionActive, mapEditToMediaSec])

  /**
   * 재생 중 삭제 구간으로 들어가며 seek 하면 일부 브라우저가 일시정지를 띄우고,
   * `onPause` → isPlaying=false 로 RAF 가 끊겨 복귀 seek 이 안 됨 — pause 직후 구간 밖이면 즉시 재생.
   */
  const handleVideoPause = useCallback(() => {
    freezeUiPlayheadRaf()
    timelineEditLog('playback', 'pause-event video.onPause entry(handleVideoPause)', {
      enginePlaybackDesired: isEdlSessionActive(),
      userPauseRequested: userPauseRequestedRef.current,
      phase: playbackEnginePhaseRef.current,
      isBuffering
    })
    if (isDeleteGuardActive()) {
      timelineEditLog('playback', 'handleVideoPause 자동복구 차단(delete guard)', {
        deleteOpId: lastDeleteOpIdRef.current
      })
      playbackEnginePhaseRef.current = 'idle'
      clearPlaybackSession()
      const masterAudio = masterAudioRef.current
      const el = videoRef.current
      const waPGuard = webAudioMasterPlaybackRef.current?.getCurrentMediaSec()
      const cur = masterAudio
        ? waPGuard ?? masterAudioToMediaSec(masterAudio.currentTime)
        : (el?.currentTime ?? 0)
      syncPausedMasterToEdit(mapMediaToEditSec(cur))
      setIsPlaying(false)
      return
    }
    const masterAudio = masterAudioRef.current
    const el = videoRef.current
    if (deferPauseWhileMapperStale('handleVideoPause')) return
    const waPFinal = webAudioMasterPlaybackRef.current?.getCurrentMediaSec()
    const cur = masterAudio
      ? waPFinal ?? masterAudioToMediaSec(masterAudio.currentTime)
      : (el?.currentTime ?? 0)
    // 자동 재생 복구는 waiting/play/pause 루프를 만든다. 일단 확실히 정지 상태로 고정한다.
    if (masterAudio && !masterAudio.paused) {
      timelineEditLog('playback', 'pause-call audio.pause (handleVideoPause finalize)', {
        audioCurrentTime: masterAudio.currentTime,
        videoCurrentTime: el?.currentTime ?? null
      })
      masterAudio.pause()
    }
    clearPlaybackSession()
    syncPausedMasterToEdit(mapMediaToEditSec(cur))
    setIsPlaying(false)
    setIsBuffering(false)
    userPauseRequestedRef.current = false
  }, [
    syncPausedMasterToEdit,
    mapMediaToEditSec,
    masterAudioToMediaSec,
    isDeleteGuardActive,
    deferPauseWhileMapperStale,
    clearPlaybackSession,
    isBuffering,
    freezeUiPlayheadRaf
  ])

  const finalizePlaybackStop = useCallback(
    (
      reason: string,
      options?: {
        /** 편집 타임라인 초 — 단일 진실(우선) */
        editSec?: number
        /** WA·레거시 호환: 원본 미디어 초 → 내부에서 편집 초로 변환 */
        mediaSec?: number
        markUserPause?: boolean
        soft?: boolean
      }
    ): void => {
      const el = videoRef.current
      const masterAudio = masterAudioRef.current
      if (!el || !masterAudio) return

      const traceSnapPreviewEnd = previewEndMediaSecRef.current
      const traceSnapOneShot = oneShotSessionRef.current
      const traceSnapAudioSec = masterAudio.currentTime
      const traceSnapWaMediaSec = waLastMediaSecRef.current

      if (options?.markUserPause) {
        userPauseRequestedRef.current = true
      }
      playbackEnginePhaseRef.current = 'idle'
      clearPlaybackSession()
      clearPlaybackSchedule(reason)
      clearPlaybackStartupVerifyTimer()
      playbackStartupProbeRef.current = null
      audioPlayingSeenRef.current = false
      waLastMediaSecRef.current = null

      let editResolved: number
      if (typeof options?.editSec === 'number' && Number.isFinite(options.editSec)) {
        editResolved = clampProgramEditSec(options.editSec)
      } else if (typeof options?.mediaSec === 'number' && Number.isFinite(options.mediaSec)) {
        editResolved = clampProgramEditSec(mapMediaToEditSec(Math.max(0, options.mediaSec)))
      } else {
        const waPosFinalize = webAudioMasterPlaybackRef.current?.getCurrentMediaSec()
        if (waPosFinalize != null && Number.isFinite(waPosFinalize)) {
          editResolved = clampProgramEditSec(mapMediaToEditSec(waPosFinalize))
        } else {
          editResolved = clampProgramEditSec(
            playbackTimelineMappingRef.current.masterAudioToProgramSec(masterAudio.currentTime)
          )
        }
      }

      const targetMediaSec = mapEditToMediaSec(editResolved)
      let videoT = Math.max(0, targetMediaSec)
      if (Number.isFinite(el.duration) && el.duration > 0) {
        videoT = Math.min(videoT, Math.max(0, el.duration - 0.001))
      }
      el.currentTime = videoT
      commitEditSecToUi(editResolved)
      syncPausedMasterToEdit(editResolved)
      const softStop = options?.soft === true
      if (!el.paused) {
        timelineEditLog('playback', `pause-call video.pause (${reason})`, {
          videoCurrentTime: el.currentTime,
          audioCurrentTime: masterAudio.currentTime,
          soft: softStop
        })
        el.pause()
      }
      if (softStop) {
        /**
         * **소프트 가드 길이 단축 — 450ms → 120ms.**
         * 길게 두면 `seekToSubtitleStart` user-trusted 시크와 `idle drift guard` 모두
         * 자연 종료 직후 한참 동안 막혀 "재생이 조금 느린" 체감을 만든다. idle drift 가
         * 즉시 강제 seek 하면 video seeking → 다른 effect 재진입으로 무한 업데이트 가드가
         * 뜨는 경합이 있어 짧게라도 유지하는 게 안전하다.
         */
        oneShotSoftStopUntilRef.current = performance.now() + 120
        timelineEditLog('playback', `soft-stop guard armed(${reason})`, {
          untilMs: oneShotSoftStopUntilRef.current,
          targetEditSec: editResolved,
          targetMediaSec: videoT
        })
      }
      if (reason.includes('one-shot') || options?.soft) {
        const r4 = (x: number) => Math.round(x * 10000) / 10000
        const expectedEditAtPreviewEnd =
          traceSnapPreviewEnd != null ? mapMediaToEditSec(traceSnapPreviewEnd) : null
        timelineEditLog('playback-trace', 'finalizePlaybackStop', {
          reason,
          soft: softStop,
          sessionId: traceSnapOneShot?.id ?? null,
          optionsMediaSec: options?.mediaSec != null ? r4(options.mediaSec) : null,
          optionsEditSec: options?.editSec != null ? r4(options.editSec) : null,
          resolvedEditSec: r4(editResolved),
          videoSeekSec: r4(videoT),
          previewEndMediaSec: traceSnapPreviewEnd != null ? r4(traceSnapPreviewEnd) : null,
          expectedEditAtPreviewEnd:
            expectedEditAtPreviewEnd != null ? r4(expectedEditAtPreviewEnd) : null,
          editDeltaVsPreviewEndEdit:
            expectedEditAtPreviewEnd != null
              ? r4(editResolved - expectedEditAtPreviewEnd)
              : null,
          masterAudioSecBeforePause: r4(traceSnapAudioSec),
          waLastMediaSec: traceSnapWaMediaSec != null ? r4(traceSnapWaMediaSec) : null
        })
      }
      setIsPlaying(false)
      setIsBuffering(false)
      userPauseRequestedRef.current = false
    },
    [
      syncPausedMasterToEdit,
      clampProgramEditSec,
      mapEditToMediaSec,
      mapMediaToEditSec,
      clearPlaybackSession,
      clearPlaybackSchedule,
      clearPlaybackStartupVerifyTimer,
      commitEditSecToUi
    ]
  )

  useEffect(() => {
    finalizePlaybackStopRef.current = finalizePlaybackStop
    return () => {
      finalizePlaybackStopRef.current = null
    }
  }, [finalizePlaybackStop])

  useEffect(() => {
    clearOneShotSessionRef.current = clearOneShotSession
    return () => {
      clearOneShotSessionRef.current = null
    }
  }, [clearOneShotSession])

  useEffect(() => {
    const v = videoRef.current
    const a = masterAudioRef.current
    if (!v || !a) return

    const logMedia = (scope: 'video' | 'audio', event: string): void => {
      if (event === 'waiting' || event === 'stalled') {
        lastMediaBufferingAtRef.current = performance.now()
      }
      const target = scope === 'video' ? v : a
      const audioMasterSec = a.currentTime
      const audioAsMediaSec = masterAudioToMediaSec(audioMasterSec)
      timelineEditLog('playback', `media-${scope}:${event}`, {
        deleteOpId: lastDeleteOpIdRef.current,
        currentTime: target.currentTime,
        videoMediaSec: v.currentTime,
        audioMasterSec,
        audioAsMediaSec,
        paused: target.paused,
        readyState: target.readyState,
        networkState: target.networkState,
        seeking: 'seeking' in target ? (target as HTMLMediaElement).seeking : null,
        ended: target.ended,
        playheadEditSec: playheadEditSecRef.current,
        isPlayingState: isPlaying
      })
    }

    const videoEvents: Array<keyof HTMLMediaElementEventMap> = [
      'play',
      'playing',
      'pause',
      'waiting',
      'stalled',
      'seeking',
      'seeked',
      'canplay',
      'canplaythrough',
      'error'
    ]
    const audioEvents: Array<keyof HTMLMediaElementEventMap> = [
      'play',
      'playing',
      'pause',
      'waiting',
      'stalled',
      'seeking',
      'seeked',
      'canplay',
      'canplaythrough',
      'error'
    ]

    const videoHandlers = videoEvents.map((evt) => {
      const fn = () => logMedia('video', evt)
      v.addEventListener(evt, fn)
      return { evt, fn }
    })
    const audioHandlers = audioEvents.map((evt) => {
      const fn = () => logMedia('audio', evt)
      a.addEventListener(evt, fn)
      return { evt, fn }
    })

    return () => {
      videoHandlers.forEach(({ evt, fn }) => v.removeEventListener(evt, fn))
      audioHandlers.forEach(({ evt, fn }) => a.removeEventListener(evt, fn))
    }
  }, [videoPath, isPlaying, masterAudioToMediaSec])

  useEffect(() => {
    return () => {
      deleteProbeTimersRef.current.forEach((id) => window.clearTimeout(id))
      deleteProbeTimersRef.current = []
    }
  }, [])

  const pausePlayback = useCallback((reason = 'unspecified') => {
    const hasMedia = Boolean(videoRef.current && masterAudioRef.current)
    if (!hasMedia) return
    timelineEditLog('playback', `pausePlayback request(${reason})`, {
      enginePlaybackDesired: isEdlSessionActive(),
      userPauseRequested: userPauseRequestedRef.current,
      phase: playbackEnginePhaseRef.current,
      isBuffering
    })
    clearOneShotSession('pausePlayback')
    finalizePlaybackStop('pausePlayback', { markUserPause: true })
  }, [clearOneShotSession, finalizePlaybackStop, isBuffering])

  useEffect(() => {
    if (!isPlaying) {
      if (rafPlayheadRef.current !== null) {
        window.cancelAnimationFrame(rafPlayheadRef.current)
        rafPlayheadRef.current = null
      }
      return
    }
    const RAF_AV_SYNC_HARD_SEC = 0.15
    const r4 = (x: number) => Math.round(x * 10000) / 10000
    const tick = () => {
      tickRef.current = tick
      const el = videoRef.current
      const masterAudio = masterAudioRef.current
      if (!el || !masterAudio) {
        rafPlayheadRef.current = null
        return
      }

      /**
       * Task 1 — `videoSeekUi` 잠금: video.seeking 동안 디코딩 지연이 끝날 때까지
       * 재생 헤드 커밋·강제 시크를 건너뛴다(낙관적 UI 는 슬라이더가 직접 갱신).
       */
      if (videoSeekUiLockedRef.current) {
        rafPlayheadRef.current = window.requestAnimationFrame(tick)
        return
      }

      const maybePlaybackTrace = (
        branch: string,
        tMediaUi: number,
        tEditUi: number,
        extra?: Record<string, unknown>
      ): void => {
        const oneShot = oneShotSessionRef.current
        if (!oneShot) return
        const nowMs = performance.now()
        if (nowMs - playbackTraceLastMsRef.current < PLAYBACK_TRACE_INTERVAL_MS) return
        playbackTraceLastMsRef.current = nowMs
        const previewEnd = previewEndMediaSecRef.current
        const audioSec = masterAudio.currentTime
        const audioAsMediaSec = masterAudioToMediaSec(audioSec)
        timelineEditLog('playback-trace', `RAF tick [${branch}]`, {
          sessionId: oneShot.id,
          tMediaUi: r4(tMediaUi),
          tEditUi: r4(tEditUi),
          videoMediaSec: r4(el.currentTime),
          masterAudioSec: r4(audioSec),
          audioAsMediaSec: r4(audioAsMediaSec),
          previewEndMediaSec: previewEnd != null ? r4(previewEnd) : null,
          remainingMediaSec: previewEnd != null ? r4(previewEnd - tMediaUi) : null,
          ...(extra ?? {})
        })
      }

      const waEngine = webAudioMasterPlaybackRef.current
      if (waEngine?.isPlaying()) {
        const cuts = mergedPlaybackSkipRangesRef.current
        const wm = waEngine.getCurrentMediaSec()
        const previewEndWa = previewEndMediaSecRef.current
        if (wm != null && previewEndWa != null && wm >= previewEndWa - 0.01) {
          const oneShot = oneShotSessionRef.current
          if (oneShot) {
            oneShotSessionRef.current = { ...oneShot, state: 'done' }
          }
          playbackCommandRouterRef.current.finishRange(playbackSessionIdRef.current)
          playbackSessionIdRef.current = 0
          finalizePlaybackStop('raf one-shot end', { mediaSec: previewEndWa, soft: true })
          clearOneShotSession('raf reached end')
          return
        }

        if (wm != null) {
          let tWa = Math.round(wm / PLAYHEAD_STEP_SEC) * PLAYHEAD_STEP_SEC
          const capEdit = uiTimelineEndEditSecRef.current
          const capM =
            capEdit > 0 ? playbackTimelineMappingRef.current.programToMediaSec(capEdit) : 0
          if (capM > 0) tWa = Math.min(tWa, capM)
          const tvRaw = el.currentTime
          if (skipCutRangeAt(tvRaw, cuts) !== tvRaw && !el.seeking) {
            el.currentTime = tWa
            timelineEditLog('playback', 'RAF wa master — video escaped deleted span', {
              tvRaw,
              snapTo: tWa
            })
          }
          const vd = tWa - el.currentTime
          const absDeltaWa = Math.abs(vd)
          if (absDeltaWa > RAF_AV_SYNC_HARD_SEC && !el.seeking) {
            timelineEditLog('playback', 'Master Sync (RAF)', { delta: vd, wa: true })
            el.currentTime = tWa
          }
          const editWa = mapMediaToEditSec(tWa)
          commitEditSecToUi(editWa)
          maybePlaybackTrace('wa-master', tWa, editWa, { wm: wm != null ? r4(wm) : null })
        } else {
          const tvRaw = el.currentTime
          const tvOut = skipCutRangeAt(tvRaw, cuts)
          if (tvOut !== tvRaw && !el.seeking) {
            el.currentTime = tvOut
            timelineEditLog('playback', 'RAF wm null — video skip-cut only', { from: tvRaw, to: tvOut })
          }
          const pm = playbackTimelineMappingRef.current
          const rawNull = pm.masterAudioToProgramSec(masterAudio.currentTime)
          const editWaNull = Math.round(rawNull / PLAYHEAD_STEP_SEC) * PLAYHEAD_STEP_SEC
          commitEditSecToUi(editWaNull)
          const probeM = masterAudioToMediaSec(masterAudio.currentTime)
          maybePlaybackTrace('wa-master-wm-null', probeM, editWaNull)
        }
        rafPlayheadRef.current = window.requestAnimationFrame(tick)
        return
      }

      if (masterAudio.paused) {
        /**
         * **WebAudio 자연 종료 후 oneShotSession 정리.**
         * `WebAudioMasterPlayback.scheduleFromEdl` 의 BufferSource 가 onended 로 종료되면
         * `playingFlag=false` 가 되지만 외부에 통지가 없다. 그러면 RAF 의 첫 `waEngine.isPlaying()`
         * 블록을 건너뛰고 이 분기로 떨어지는데, 이때 정리가 없으면 `oneShotSessionRef` 가
         * `state:"playing"` 인 채 남아 이후 모든 단어 클릭이 "세션 디듑(active one-shot)" 으로
         * 큐잉되어 재생/포커스 둘 다 막힌다. RAF 종료 직전에 한 번 마무리한다.
         */
        const lingering = oneShotSessionRef.current
        if (lingering && lingering.state === 'playing') {
          oneShotSessionRef.current = { ...lingering, state: 'done' }
          playbackCommandRouterRef.current.finishRange(playbackSessionIdRef.current)
          playbackSessionIdRef.current = 0
          finalizePlaybackStop('raf one-shot natural end', {
            mediaSec: previewEndMediaSecRef.current ?? lingering.end,
            soft: true
          })
          clearOneShotSession('raf natural-end (engine stopped, master paused)')
          wfLog('peaks', 'startSyncedPlayback [diag-6] one-shot 자연 종료 정리', {
            sessionId: lingering.id,
            sessionEndMediaSec: lingering.end
          })
        }
        rafPlayheadRef.current = null
        return
      }
      if (masterAudio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        if (!el.paused && !el.seeking) {
          el.pause()
          timelineEditLog('playback', 'RAF html freeze video — master audio buffering', {
            readyState: masterAudio.readyState
          })
        }
        const pmBuf = playbackTimelineMappingRef.current
        const rawBuf = pmBuf.masterAudioToProgramSec(masterAudio.currentTime)
        const editBuf = Math.round(rawBuf / PLAYHEAD_STEP_SEC) * PLAYHEAD_STEP_SEC
        const probeBuf = masterAudioToMediaSec(masterAudio.currentTime)
        commitEditSecToUi(editBuf)
        maybePlaybackTrace('html-buffering', probeBuf, editBuf, {
          readyState: masterAudio.readyState
        })
        rafPlayheadRef.current = window.requestAnimationFrame(tick)
        return
      }
      /**
       * HTML `<audio>` 마스터 클럭 → 편집 플레이헤드 (stitched / passthrough 동일).
       * 비디오·세그먼트 점프는 디코더용으로만 유지한다.
       */
      const cutsHtml = mergedPlaybackSkipRangesRef.current
      let tMedia = el.currentTime
      const skippedMedia = skipCutRangeAt(tMedia, cutsHtml)
      if (skippedMedia !== tMedia) {
        if (!el.seeking) el.currentTime = skippedMedia
        const editSkip = mapMediaToEditSec(skippedMedia)
        if (!masterAudio.seeking) {
          assignMasterAudioTimelineSecIfNeeded(
            masterAudio,
            playbackTimelineMappingRef.current.programToMasterAudioSec(editSkip)
          )
        }
        timelineEditLog('playback', 'RAF html — 비디오 기준 삭제 구간 스킵', {
          videoMediaWas: tMedia,
          to: skippedMedia
        })
        const skippedR = Math.round(skippedMedia / PLAYHEAD_STEP_SEC) * PLAYHEAD_STEP_SEC
        const pmSk = playbackTimelineMappingRef.current
        const rawSk = pmSk.masterAudioToProgramSec(masterAudio.currentTime)
        const editSk = Math.round(rawSk / PLAYHEAD_STEP_SEC) * PLAYHEAD_STEP_SEC
        commitEditSecToUi(editSk)
        maybePlaybackTrace('html-master-skip-cut', masterAudioToMediaSec(masterAudio.currentTime), editSk, {
          videoMediaWas: r4(tMedia)
        })
        rafPlayheadRef.current = window.requestAnimationFrame(tick)
        return
      }
      tMedia = el.currentTime

      /** 클립 꼬리 → 다음 클립 mediaStart 로 Jump-Cut (가상 시간 단절 보정) */
      {
        const clipsForJump = playbackTimelineMappingRef.current.clips
        const jr = jumpVideoPastClipTailIfNeeded(tMedia, clipsForJump)
        if (jr.jumped && !el.seeking) {
          el.currentTime = jr.toMediaSec
          const editJump = mapMediaToEditSec(jr.toMediaSec)
          if (!masterAudio.seeking) {
            assignMasterAudioTimelineSecIfNeeded(
              masterAudio,
              playbackTimelineMappingRef.current.programToMasterAudioSec(editJump)
            )
          }
          timelineEditLog('playback', 'RAF html — 비디오 클립 Jump-Cut', {
            fromMediaSec: jr.fromMediaSec,
            toMediaSec: jr.toMediaSec,
            fromClipId: jr.fromClipId,
            toClipId: jr.toClipId
          })
          const pmJ = playbackTimelineMappingRef.current
          const rawJ = pmJ.masterAudioToProgramSec(masterAudio.currentTime)
          const editHead = Math.round(rawJ / PLAYHEAD_STEP_SEC) * PLAYHEAD_STEP_SEC
          commitEditSecToUi(editHead)
          maybePlaybackTrace('html-master-jump-cut', masterAudioToMediaSec(masterAudio.currentTime), editHead)
          rafPlayheadRef.current = window.requestAnimationFrame(tick)
          return
        }
      }

      const activeSchedule = activePlaybackScheduleRef.current
      if (activeSchedule && activeSchedule.segments.length > 0) {
        const seg = activeSchedule.segments[activeSchedule.index]
        if (seg) {
          if (tMedia < seg.startMediaSec - 0.012) {
            if (!el.seeking) el.currentTime = seg.startMediaSec
            const editSegStart = mapMediaToEditSec(seg.startMediaSec)
            if (!masterAudio.seeking) {
              assignMasterAudioTimelineSecIfNeeded(
                masterAudio,
                playbackTimelineMappingRef.current.programToMasterAudioSec(editSegStart)
              )
            }
            timelineEditLog('playback', 'RAF schedule align to segment start (video master)', {
              fromVideoMediaSec: tMedia,
              to: seg.startMediaSec,
              clipId: seg.clipId,
              index: activeSchedule.index
            })
            rafPlayheadRef.current = window.requestAnimationFrame(tick)
            return
          }
          if (tMedia >= seg.endMediaSec - 0.006) {
            const nextSeg = activeSchedule.segments[activeSchedule.index + 1]
            if (nextSeg) {
              playbackEnginePhaseRef.current = 'playing'
              lastMediaBufferingAtRef.current = performance.now()
              timelineEditLog('playback', 'segment advance shield armed (video master)', {
                fromVideoMediaSec: tMedia,
                to: nextSeg.startMediaSec,
                fromClipId: seg.clipId,
                toClipId: nextSeg.clipId,
                index: activeSchedule.index + 1
              })
              activeSchedule.index += 1
              if (!el.seeking) el.currentTime = nextSeg.startMediaSec
              const editSegNext = mapMediaToEditSec(nextSeg.startMediaSec)
              if (!masterAudio.seeking) {
                assignMasterAudioTimelineSecIfNeeded(
                  masterAudio,
                  playbackTimelineMappingRef.current.programToMasterAudioSec(editSegNext)
                )
              }
              timelineEditLog('playback', 'RAF schedule segment advance (video master)', {
                fromVideoMediaSec: tMedia,
                to: nextSeg.startMediaSec,
                fromClipId: seg.clipId,
                toClipId: nextSeg.clipId,
                index: activeSchedule.index
              })
              rafPlayheadRef.current = window.requestAnimationFrame(tick)
              return
            }
            if (activeSchedule.kind === 'continuous') {
              clearPlaybackSchedule('raf schedule finished')
            }
          }
        }
      }
      const pmTick = playbackTimelineMappingRef.current
      const capEditHtml = uiTimelineEndEditSecRef.current
      let rawProg = pmTick.masterAudioToProgramSec(masterAudio.currentTime)
      if (capEditHtml > 0) rawProg = Math.min(rawProg, capEditHtml)
      const editT = Math.round(rawProg / PLAYHEAD_STEP_SEC) * PLAYHEAD_STEP_SEC

      let probeMedia = masterAudioToMediaSec(masterAudio.currentTime)
      const capMedia =
        capEditHtml > 0 ? pmTick.programToMediaSec(capEditHtml) : 0
      if (capMedia > 0) probeMedia = Math.min(probeMedia, capMedia)

      const previewEnd = previewEndMediaSecRef.current
      if (previewEnd != null && probeMedia >= previewEnd - 0.01) {
        const oneShot = oneShotSessionRef.current
        if (oneShot) {
          oneShotSessionRef.current = { ...oneShot, state: 'done' }
        }
        playbackCommandRouterRef.current.finishRange(playbackSessionIdRef.current)
        playbackSessionIdRef.current = 0
        finalizePlaybackStop('raf one-shot end', { mediaSec: previewEnd, soft: true })
        clearOneShotSession('raf reached end')
        return
      }

      const targetMediaFromAudio = pmTick.programToMediaSec(editT)
      const vd = targetMediaFromAudio - el.currentTime
      if (
        Math.abs(vd) > RAF_AV_SYNC_HARD_SEC &&
        !el.seeking &&
        !masterAudio.seeking &&
        masterAudio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        timelineEditLog('playback', 'Master Sync (RAF, video slave to audio clock)', {
          delta: vd,
          wa: false
        })
        el.currentTime = targetMediaFromAudio
      }

      commitEditSecToUi(editT)
      maybePlaybackTrace('html-master-audio', probeMedia, editT)
      rafPlayheadRef.current = window.requestAnimationFrame(tick)
    }
    rafPlayheadRef.current = window.requestAnimationFrame(tick)
    return () => {
      if (rafPlayheadRef.current !== null) {
        window.cancelAnimationFrame(rafPlayheadRef.current)
        rafPlayheadRef.current = null
      }
    }
  }, [
    isPlaying,
    masterAudioToMediaSec,
    mapMediaToEditSec,
    clearOneShotSession,
    clearPlaybackSchedule,
    finalizePlaybackStop,
    commitEditSecToUi
  ])

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input,textarea,[contenteditable="true"]')) return
      if (target?.closest('.subtitle-card')) return
      e.preventDefault()
      dispatchTogglePlayIntent()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dispatchTogglePlayIntent])

  /**
   * Task 1 — 프리뷰 슬라이더 스크럽: seeking 동안 RAF 커밋 잠금 + 낙관적 UI 갱신.
   * `mapVirtualMsToRealSec` 는 편집 ms → 원본 미디어 초.
   */
  const {
    isSeekingLocked: videoSeekUiLocked,
    optimisticVirtualMsRef,
    scrubToVirtualMs,
    seekRealSecImmediate
  } = useVideoSeekUi({
    videoRef,
    attachToken: videoPath,
    throttleMs: 32,
    mapVirtualMsToRealSec: (virtualMs) => {
      const editSec = Math.max(0, virtualMs) / 1000
      const el = videoRef.current
      if (!el) return null
      return toMediaSeekSec(clampProgramEditSec(editSec), el)
    },
    onOptimisticVirtualMs: (vMs) => {
      if (vMs == null) return
      commitEditSecToUi(Math.max(0, vMs / 1000))
    }
  })
  const videoSeekUiLockedRef = useRef(videoSeekUiLocked)
  videoSeekUiLockedRef.current = videoSeekUiLocked

  const applySeekValue = useCallback((raw: string) => {
    const el = videoRef.current
    const masterAudio = masterAudioRef.current
    if (!el || !masterAudio) return
    const editV = Number(raw)
    if (!Number.isFinite(editV)) return
    const editClamped = clampProgramEditSec(editV)
    const mediaT = toMediaSeekSec(editClamped, el)
    userPauseRequestedRef.current = true
    playbackEnginePhaseRef.current = 'idle'
    clearPlaybackSession()
    clearPlaybackSchedule('applySeekValue')
    optimisticVirtualMsRef.current = null
    seekRealSecImmediate(mediaT)
    commitEditSecToUi(editClamped)
    syncPausedMasterToEdit(editClamped)
  }, [
    clampProgramEditSec,
    toMediaSeekSec,
    syncPausedMasterToEdit,
    clearPlaybackSession,
    clearPlaybackSchedule,
    commitEditSecToUi,
    optimisticVirtualMsRef,
    seekRealSecImmediate
  ])

  const onSeekChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      applySeekValue(e.target.value)
    },
    [applySeekValue]
  )

  /** 드래그 중(input) — scrubToVirtualMs (낙관적 UI + 비디오 currentTime 스로틀) */
  const onSeekSliderInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const editV = Number(e.target.value)
      if (!Number.isFinite(editV)) return
      const editClamped = clampProgramEditSec(editV)
      scrubToVirtualMs(Math.round(editClamped * 1000))
    },
    [clampProgramEditSec, scrubToVirtualMs]
  )

  const undoSubtitleChange = useCallback(() => {
    const prev = undoStackRef.current.pop()
    if (!prev) return
    setSentenceTokenTimeline((curTl) => {
      const curSubs = sentenceTokenTimelineToSubtitleLines(curTl)
      redoStackRef.current.push({
        subtitles: curSubs,
        virtualTimelineDeleted: virtualTimelineDeletedRef.current,
        cutRanges: cutRangesRef.current
      })
      return subtitleLinesToSentenceTokenTimeline(prev.subtitles)
    })
    setVirtualTimelineDeleted(prev.virtualTimelineDeleted)
    setCutRanges(prev.cutRanges)
  }, [])

  const redoSubtitleChange = useCallback(() => {
    const next = redoStackRef.current.pop()
    if (!next) return
    setSentenceTokenTimeline((curTl) => {
      const curSubs = sentenceTokenTimelineToSubtitleLines(curTl)
      undoStackRef.current.push({
        subtitles: curSubs,
        virtualTimelineDeleted: virtualTimelineDeletedRef.current,
        cutRanges: cutRangesRef.current
      })
      return subtitleLinesToSentenceTokenTimeline(next.subtitles)
    })
    setVirtualTimelineDeleted(next.virtualTimelineDeleted)
    setCutRanges(next.cutRanges)
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
      setExtractAwaitListPaint(false)
      setSentenceTokenTimeline([])
      setCutRanges([])
      setVirtualTimelineDeleted([])
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
    setExtractAwaitListPaint(false)
    setIsExtracting(true)
    window.api.sendVideoDropPath(p)
  }, [modelReady, busy, isExtracting])

  /**
   * 단어 추출 직후 카드가 잠시 붙어 보이는 현상 진단용 —
   * 메인 스레드 50ms 초과 작업을 자동으로 `waveform.log`(scope: perf) 에 기록.
   * PerformanceObserver(longtask) 는 크롬/Electron 에서 표준 지원 — 비용은 거의 0.
   */
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return
    let installed = false
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const dur = Math.round(entry.duration)
          if (dur < 50) continue
          wfLog('perf', 'longtask', {
            ms: dur,
            startTimeMs: Math.round(entry.startTime),
            name: entry.name,
            entryType: entry.entryType,
            ts: new Date().toISOString()
          })
        }
      })
      obs.observe({ entryTypes: ['longtask'] })
      installed = true
      return () => {
        try {
          obs.disconnect()
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* longtask 미지원 환경 — 무시 */
    }
    if (!installed) return
    return
  }, [])

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
      setTranscribeMode('cpu')
      const rawLines = parseSubtitleLines((raw as { subtitles?: unknown })?.subtitles)
      /**
       * `end > start` 가 깨진 단어는 카드 레이아웃·캐럿 측정에서 NaN/음수 폭을 만들어
       * `useLayoutEffect` ↔ `ResizeObserver` 가 매 렌더 다른 값을 set 하는 형태의
       * Maximum update depth 루프의 잠재 트리거가 된다. 추출 직후 한 번만 정리한다.
       */
      let droppedWords = 0
      const lines = rawLines.map((l) => {
        if (!l.words || l.words.length === 0) return l
        const cleaned = l.words.filter((w) => {
          const ok =
            Number.isFinite(w.start) &&
            Number.isFinite(w.end) &&
            w.end > w.start
          if (!ok) droppedWords += 1
          return ok
        })
        return cleaned.length === l.words.length ? l : { ...l, words: cleaned }
      })
      const wordCount = lines.reduce((acc, l) => acc + (l.words?.length ?? 0), 0)
      if (lines.length === 0 || wordCount === 0) {
        setExtractAwaitListPaint(false)
        setIsExtracting(false)
        setProgress(0)
        wfLog('perf', '단어 추출 완료 — 빈 결과', {
          lineCount: lines.length,
          wordCount,
          ts: new Date().toISOString()
        })
        return
      }
      const t0 = performance.now()
      wfLog('perf', '단어 추출 완료 — setSentenceTokenTimeline 시작', {
        lineCount: lines.length,
        wordCount,
        droppedInvalidWords: droppedWords,
        ts: new Date().toISOString()
      })
      /**
       * 1,473 word × 303 line 의 첫 commit 은 main thread longtask 를 유발.
       * `startTransition` + `useDeferredValue`(리스트 prop) 와 함께, 오버레이는
       * `extractAwaitListPaint` + effect 가 deferred 가 따라잡힌 뒤에만 닫는다 (100% 직후 곧바로 정렬된 화면).
       */
      setProgress(100)
      setExtractAwaitListPaint(true)
      startTransition(() => {
        setSentenceTokenTimeline(subtitleLinesToSentenceTokenTimeline(lines))
      })
      wfLog('perf', '단어 추출 완료 — setSentenceTokenTimeline 호출 끝', {
        callMs: Math.round(performance.now() - t0),
        lineCount: lines.length,
        wordCount
      })
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
      setGapFillWhenBuildingVrew(false)
      undoStackRef.current = []
      redoStackRef.current = []
    })
    const offE = window.api.onTranscribeError(() => {
      setExtractAwaitListPaint(false)
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
          subtitles: buildExportCueLines(subtitles),
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
    const mergedCuts = mergeCutRanges([...cutRanges])
    const activeSnap = buildActiveBlocksSnapshotFromSubtitles(subtitles, mergedCuts)
    const mergedDeleted = mergedDeletedBlocksForProjectSave(virtualTimelineDeleted, subtitles, mergedCuts)
    const virtualTimeline = [...activeSnap, ...mergedDeleted]
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
    if (virtualTimeline.length > 0) {
      payload.virtualTimeline = virtualTimeline
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
    videoPath,
    virtualTimelineDeleted
  ])

  const saveProjectAs = useCallback(async () => {
    const json = buildAutosubProjectJson()
    const defaultPath = projectFilePathRef.current ?? undefined
    try {
      const r = await window.api.saveProjectFileAs(json, defaultPath)
      if (!r.canceled) {
        projectFilePathRef.current = r.path
        const mergedCuts = mergeCutRanges([...cutRanges])
        setVirtualTimelineDeleted(mergedDeletedBlocksForProjectSave(virtualTimelineDeleted, subtitles, mergedCuts))
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }, [buildAutosubProjectJson, cutRanges, subtitles, virtualTimelineDeleted])

  const saveProject = useCallback(async () => {
    const json = buildAutosubProjectJson()
    if (!projectFilePathRef.current) {
      await saveProjectAs()
      return
    }
    try {
      const res = await window.api.saveProjectFile(projectFilePathRef.current, json)
      if (!res.ok) window.alert(res.reason)
      else {
        const mergedCuts = mergeCutRanges([...cutRanges])
        setVirtualTimelineDeleted(mergedDeletedBlocksForProjectSave(virtualTimelineDeleted, subtitles, mergedCuts))
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }, [buildAutosubProjectJson, saveProjectAs, cutRanges, subtitles, virtualTimelineDeleted])

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
    let tombstones = (d.virtualTimeline ?? []).filter((b) => b.isDeleted)
    if (tombstones.length === 0 && mergeCutRanges(d.cutRanges).length > 0) {
      tombstones = virtualTombstonesFromCutRanges(d.cutRanges)
    }
    setVirtualTimelineDeleted(tombstones)
    setSentenceTokenTimeline(subtitleLinesToSentenceTokenTimeline(d.subtitles))
    setSilenceSplitPending(true)
    silenceSplitRunKeyRef.current = null
    setGapFillWhenBuildingVrew(false)
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
    commitEditSecToUi(0)
    setIsPlaying(false)
    return true
  }, [commitEditSecToUi])

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

        <div className="preview-subtitle-controls-bar" data-waveform-no-dismiss="1">
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
          <section
            className="split-preview"
            aria-label="영상 미리보기"
            style={{ width: `${previewWidthPct}%` }}
            data-waveform-no-dismiss="1"
          >
            {videoPath ? (
              <>
                <div className={previewMediaClass}>
                  <div className="preview-video-stack" ref={previewStackRef}>
                    <audio
                      ref={masterAudioRef}
                      preload="metadata"
                      src={masterAudioSrcUrl ?? window.api.getMediaFileUrl(videoPath)}
                      className="hidden"
                      muted
                      onTimeUpdate={syncFromVideo}
                      onLoadedMetadata={syncFromVideo}
                      onDurationChange={syncFromVideo}
                      onPlay={() => {}}
                      onPlaying={() => {
                        audioPlayingSeenRef.current = true
                        snapUiAfterMediaPlaying()
                      }}
                      onWaiting={() => {
                        freezeUiPlayheadRaf()
                        lastMediaBufferingAtRef.current = performance.now()
                        setIsBuffering(true)
                      }}
                      onStalled={() => {
                        freezeUiPlayheadRaf()
                      }}
                      onPause={() => {
                        freezeUiPlayheadRaf()
                        timelineEditLog('playback', 'pause-event audio.onPause entry', {
                          enginePlaybackDesired: isEdlSessionActive(),
                          userPauseRequested: userPauseRequestedRef.current,
                          phase: playbackEnginePhaseRef.current,
                          isBuffering
                        })
                        if (deferPauseWhileMapperStale('media-audio:pause')) return
                        const curRaw = masterAudioRef.current?.currentTime ?? 0
                        const cur = masterAudioToMediaSec(curRaw)
                        syncPausedMasterToEdit(mapMediaToEditSec(cur))
                        setIsPlaying(false)
                        setIsBuffering(false)
                        userPauseRequestedRef.current = false
                      }}
                      onEnded={() => {
                        playbackEnginePhaseRef.current = 'idle'
                        clearPlaybackSession()
                        clearPlaybackSchedule('audio ended')
                        const endSec = masterAudioToMediaSec(masterAudioRef.current?.duration ?? durationSec)
                        syncPausedMasterToEdit(mapMediaToEditSec(endSec))
                        setIsPlaying(false)
                        setIsBuffering(false)
                        userPauseRequestedRef.current = false
                      }}
                    />
                    <video
                      ref={videoRef}
                      key={videoPath}
                      className="preview-video"
                      preload="metadata"
                      playsInline
                      muted
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
                      onPlay={() => {}}
                      onPlaying={() => {
                        snapUiAfterMediaPlaying()
                      }}
                      onWaiting={() => {
                        freezeUiPlayheadRaf()
                        lastMediaBufferingAtRef.current = performance.now()
                        setIsBuffering(true)
                      }}
                      onStalled={() => {
                        freezeUiPlayheadRaf()
                      }}
                      onPause={handleVideoPause}
                      onEnded={() => {
                        playbackEnginePhaseRef.current = 'idle'
                        clearPlaybackSession()
                        clearPlaybackSchedule('video ended')
                        setIsPlaying(false)
                        setIsBuffering(false)
                        userPauseRequestedRef.current = false
                      }}
                      onClick={dispatchTogglePlayIntent}
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
                          <p
                            ref={previewSubtitleTextRef}
                            className="preview-subtitle-text"
                            style={previewSubtitleTextStyle}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="preview-controls preview-controls--outside" role="group" aria-label="재생 컨트롤">
                  <button
                    type="button"
                    className="preview-play-btn"
                    onClick={dispatchTogglePlayIntent}
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
                  <span ref={previewCurrentTimeRef} className="preview-time preview-time--current" />
                  <input
                    ref={previewSeekInputRef}
                    type="range"
                    className="preview-seek"
                    aria-label="재생 위치"
                    min={0}
                    max={Math.max(timelineMediaEndHint > 0 ? mapMediaToEditSec(timelineMediaEndHint) : 0, 0.001)}
                    step={0.01}
                    defaultValue={0}
                    disabled={waveformPeaksJsonLoading}
                    onChange={onSeekChange}
                    onInput={onSeekSliderInput}
                  />
                  <span className="preview-time preview-time--total">
                    {waveformPeaksJsonLoading
                      ? '로딩 중…'
                      : formatClock(timelineMediaEndHint > 0 ? mapMediaToEditSec(timelineMediaEndHint) : 0)}
                  </span>
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
            data-waveform-no-dismiss="1"
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
                        title={
                          subtitlesContainDeletedWords
                            ? '삭제된 단어(tombstone)가 있어 파형에는 무음 더미를 넣지 않습니다. 간격 메우기 플래그만 켭니다.'
                            : '파형 편집용 줄을 만들 때 단어 사이 간격을 다시 메웁니다(무음 더미 포함).'
                        }
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
                {timelineAxisMismatch ? (
                  <p
                    className="subtitle-panel-sub"
                    role="alert"
                    style={{
                      marginTop: 8,
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: 'rgba(180, 60, 60, 0.22)',
                      color: '#fbeaea',
                      border: '1px solid rgba(255, 160, 160, 0.35)'
                    }}
                  >
                    {timelineAxisMismatch}
                  </p>
                ) : null}
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
                    <div ref={subtitleListRootRef} className="subtitle-list-stack">
                      <SubtitleDataProvider subtitles={subtitles}>
                        <SubtitleVirtualList
                          subtitles={subtitlesForSubtitleVirtualList}
                          activeSubtitleIndexRef={activeSubtitleIndexRef}
                          playheadSecRef={playheadEditSecRef}
                          isPlaying={isPlaying}
                          mediaFileUrl={videoPath ? window.api.getMediaFileUrl(videoPath) : null}
                          onSubtitleCardClick={onSubtitleCardClick}
                          onCardNavigate={seekToSubtitleStartFromNavigate}
                          onRequestPausePlayback={pausePlayback}
                          onWordBlockClick={seekToSubtitleStartFromUserInput}
                          onWaveformSeekAndPlay={seekAndPlayFromSubtitleList}
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
                          onTogglePlayback={dispatchTogglePlayIntent}
                          waveformEnabled={Boolean(modelReady)}
                          registerWaveMount={registerWaveMount}
                          waveformExpandedLineIndex={waveformLineIndex}
                          waveformActiveWordId={waveformWordId}
                          onWaveformWordDoubleClick={onWaveformWordDoubleClick}
                          onWaveformExpandedLineWordClick={onWaveformExpandedLineWordClick}
                          vrewRows={vrewRowsForSubtitleVirtualList}
                          onWaveformMountLayout={onWaveformMountLayout}
                          mediaDurationSec={waveformMediaDurationCapSec ?? waveformUiDurationSec}
                          peaksZoomViewRange={peaksZoomViewRange}
                          waveformPeaksJson={waveformPeaksJsonData}
                          waveformMediaDurationHintSec={durationSec > 0 ? durationSec : undefined}
                        />
                      </SubtitleDataProvider>
                    </div>
                    {modelReady &&
                    (READ_SUBTITLES_FROM_VIRTUAL_TIMELINE ? subtitlesForList.length > 0 : subtitles.length > 0) ? (
                      <SubtitleWaveformPeaks
                        ref={waveformPeaksRef}
                        rows={vrewRows}
                        onRowsChange={onVrewRowsChange}
                        audioUrl={masterAudioSrcUrl ?? waveformMediaUrl}
                        localMediaPath={videoPath}
                        precomputedWaveformJson={stitchedWaveformJsonComputed ?? waveformPeaksJsonData}
                        precomputedWaveformIsEditAxis={stitchedWaveformJsonComputed != null}
                        playheadProgramToPeaksSec={waveformPlayheadProgramToPeaksSec}
                        precomputedPeaksJsonFileUrl={null}
                        waveMountByLineRef={waveMountByLineRef}
                        activeLineIndex={waveformLineIndex}
                        activeWordId={waveformWordId}
                        waveformCardBounds={waveformLineZoomBounds}
                        cutRanges={cutRanges}
                        onZoomViewRange={setPeaksZoomViewRange}
                        onTimeRangeCut={applyTimeRangeCut}
                        onSplitActiveWordAtEditSec={splitWordAtEditSecFromWaveform}
                        onPlayEditRange={dispatchPlayRangeIntentFromWaveform}
                        onPausePlayback={pausePlayback}
                        onUndo={undoSubtitleChange}
                        playheadEditSecRef={playheadEditSecRef}
                        isPlaying={isPlaying}
                        suppressAutoFocusSeek={isWaveformFocusSuppressed()}
                        autoFocusSeekBlockToken={waveformAutoSeekBlockToken}
                        mediaDurationSec={waveformMediaDurationCapSec ?? waveformUiDurationSec}
                        onPeaksDurationComparedToMedia={onPeaksDurationComparedToMedia}
                        wordEdgeSubtitleBridge={wordEdgeSubtitleBridge}
                      />
                    ) : null}
                    {modelReady && subtitlesForList.length > 0 ? (
                      <WordCanvasPanel className="mt-3 border-t border-slate-800/90 pt-3" />
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
              {extractAwaitListPaint
                ? '자막 화면을 불러오는 중…'
                : transcribeMode === 'gpu'
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
