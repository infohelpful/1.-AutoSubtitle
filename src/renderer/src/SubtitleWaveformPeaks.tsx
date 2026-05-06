import { createPortal } from 'react-dom'
import type { MutableRefObject } from 'react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import Peaks, {
  type JsonWaveformData,
  type PeaksInstance,
  type Segment,
  type SegmentOptions
} from 'peaks.js'
import { assignFlatWordsToRows } from './components/vrewPeaksEditor/assignFlatWordsToRows'
import { createWaveformSegmentMarker, CUT_PREVIEW_SEGMENT_ID } from './components/vrewPeaksEditor/createCutPreviewSegmentMarker'
import { createCutToolPointMarker, CUT_TOOL_POINT_ID } from './components/vrewPeaksEditor/createCutToolPointMarker'
import type { SubtitleRow, Word } from './components/vrewPeaksEditor/types'
import { createSilentWavBlob } from './components/vrewPeaksEditor/silentWav'
import { wfLog } from './components/vrewPeaksEditor/waveformDebugLog'
import { timelineEditLog } from './timelineEditLog'
import { safeFitPeaksContainerView } from './peaksSafeFit'
import { computeLineZoomWindow, computeLineZoomWindowFromCardBounds } from './lineZoomWindow'
import { applyZoomThenClampEndBeforeOrAt } from './peaksZoomClamp'
import { WaveformWordConnector } from './WaveformWordConnector'

type WaveformEditTool = 'cut' | 'adjust' | null

type CutSelectionOverlay =
  | null
  | { kind: 'marker'; time: number }
  | { kind: 'range'; start: number; end: number }

function clampPx(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function normalizeCutRange(a: number, b: number): { start: number; end: number } {
  return a <= b ? { start: a, end: b } : { start: b, end: a }
}

/** Peaks `zoomview.click` 시간과 clientX→time 변환 차이 흡수(경계에서 바깥 클릭 오판 방지) */
const CUT_TIME_MATCH_EPS_SEC = 0.12

/**
 * Web Audio 버퍼 경로 — 짧은 줄에서 얇은 줌.
 * audiowaveform JSON(`waveformData`) 경로 — waveform-data 가 저해상도 피크만 가질 때
 * 첫 zoom 이 너무 작으면 `WaveformData.resample(): Zoom level … too low, minimum: …` 로 실패함.
 */
const PEAKS_ZOOM_LEVELS_WEBAUDIO = [
  8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384
] as const

/** dataUri만 있고 samples_per_pixel 미상일 때(구 80pps JSON 호환) */
const PEAKS_ZOOM_LEVELS_PRECOMPUTED_FALLBACK = [
  600, 1024, 2048, 4096, 8192, 16384, 32768, 65536
] as const

/** waveform-data 는 scale < samples_per_pixel 이면 리샘플 불가 — zoomLevels 최소가 JSON spp 이상이어야 함 */
function buildZoomLevelsFromSamplesPerPixel(spp: number): number[] {
  const first = Math.max(1, Math.floor(spp))
  const out: number[] = []
  let v = first
  for (let i = 0; i < 14 && v < 262144; i++) {
    out.push(Math.floor(v))
    v *= 2
  }
  return out
}

function zoomLevelsForPrebuiltPeaks(opts: {
  inlineJson: JsonWaveformData | null | undefined
  useDataUriWithoutInline: boolean
}): readonly number[] {
  const spp = opts.inlineJson?.samples_per_pixel
  if (typeof spp === 'number' && Number.isFinite(spp) && spp > 0) {
    return buildZoomLevelsFromSamplesPerPixel(spp)
  }
  if (opts.useDataUriWithoutInline) {
    return PEAKS_ZOOM_LEVELS_PRECOMPUTED_FALLBACK
  }
  return buildZoomLevelsFromSamplesPerPixel(64)
}

/** 길이 조절(ADJUST)일 때만 세그먼트 가장자리·시간 팁 표시. 그 외에는 오버레이만 유지 */
function buildSegmentOptions(
  w: Word,
  rows: SubtitleRow[],
  activeLineIndex: number | null,
  activeWordId: number | null,
  activeTool: WaveformEditTool
): SegmentOptions {
  const allowAdjust = activeTool === 'adjust'
  const base: SegmentOptions = {
    id: String(w.id),
    startTime: w.start,
    endTime: w.end,
    editable: allowAdjust,
    labelText: '',
    waveformColor: '#aeb4b6'
  }

  if (!allowAdjust) {
    if (activeLineIndex === null || activeWordId === null) {
      return {
        ...base,
        color: '#aeb4b6',
        markers: false,
        overlay: false
      }
    }

    const row = rows[activeLineIndex]
    if (!row?.words?.length) {
      return {
        ...base,
        color: '#aeb4b6',
        markers: false,
        overlay: false
      }
    }

    const wi = row.words.findIndex((x) => x.id === activeWordId)
    if (wi < 0) {
      return { ...base, markers: false, overlay: false }
    }

    if (w.id === activeWordId) {
      return {
        ...base,
        markers: false,
        overlay: false,
        color: '#ffd54f',
        waveformColor: '#ffd54f'
      }
    }

    return { ...base, markers: false, overlay: false }
  }

  if (activeLineIndex === null || activeWordId === null) {
    return {
      ...base,
      color: '#aeb4b6',
      markers: true,
      overlay: false
    }
  }

  const row = rows[activeLineIndex]
  if (!row?.words?.length) {
    return {
      ...base,
      color: '#aeb4b6',
      markers: true,
      overlay: false
    }
  }

  const wi = row.words.findIndex((x) => x.id === activeWordId)
  if (wi < 0) {
    return { ...base, markers: false, overlay: false }
  }

  if (w.id === activeWordId) {
    return {
      ...base,
      markers: true,
      overlay: false,
      color: '#ffd54f',
      waveformColor: '#ffd54f'
    }
  }

  return { ...base, color: '#aeb4b6', markers: false, overlay: false }
}

function flattenWords(rows: SubtitleRow[]): Word[] {
  return rows.flatMap((r) => r.words).sort((a, b) => a.start - b.start)
}

function applyWordsToPeaks(
  peaks: PeaksInstance,
  list: Word[],
  rows: SubtitleRow[],
  activeLineIndex: number | null,
  activeWordId: number | null,
  activeTool: WaveformEditTool,
  cutOverlay: CutSelectionOverlay | null
): void {
  peaks.segments.removeAll()
  for (const w of list) {
    peaks.segments.add(buildSegmentOptions(w, rows, activeLineIndex, activeWordId, activeTool))
  }
  if (activeTool === 'cut') {
    paintCutSelectionOverlay(peaks, cutOverlay)
  } else {
    removeCutOverlayGraphics(peaks)
  }
}

type SegmentBoundarySnapshot = {
  startTime: number
  endTime: number
}

function applyDirectionalAdjustResplit(args: {
  words: Word[]
  currentIndex: number
  oldSegment: SegmentBoundarySnapshot
  newSegment: SegmentBoundarySnapshot
}): Word[] {
  const { words, currentIndex, oldSegment, newSegment } = args
  const next = words.map((w) => ({ ...w }))

  const isLeftEdgeDragged = newSegment.startTime !== oldSegment.startTime
  const isRightEdgeDragged = newSegment.endTime !== oldSegment.endTime

  let leftWordIndex = -1
  let rightWordIndex = -1
  let newBoundaryTime = 0

  if (isRightEdgeDragged) {
    leftWordIndex = currentIndex
    rightWordIndex = currentIndex + 1
    newBoundaryTime = newSegment.endTime
  } else if (isLeftEdgeDragged) {
    leftWordIndex = currentIndex - 1
    rightWordIndex = currentIndex
    newBoundaryTime = newSegment.startTime
  } else {
    return next
  }

  const leftWord = next[leftWordIndex]
  const rightWord = next[rightWordIndex]
  if (!leftWord || !rightWord) return next

  const totalDuration = rightWord.end - leftWord.start
  if (totalDuration < 0.1) return next

  newBoundaryTime = Math.max(leftWord.start + 0.05, Math.min(newBoundaryTime, rightWord.end - 0.05))

  leftWord.end = newBoundaryTime
  rightWord.start = newBoundaryTime

  const isLeftSilence =
    Boolean(leftWord.isSilence) || leftWord.text === '??' || leftWord.text === '-'
  const isRightSilence =
    Boolean(rightWord.isSilence) || rightWord.text === '??' || rightWord.text === '-'

  if (isLeftSilence || isRightSilence) {
    if (!leftWord.originalText) leftWord.originalText = leftWord.text
    if (!rightWord.originalText) rightWord.originalText = rightWord.text
    leftWord.text = leftWord.originalText ?? leftWord.text
    rightWord.text = rightWord.originalText ?? rightWord.text
    return next
  }

  if (!leftWord.originalText) leftWord.originalText = leftWord.text
  if (!rightWord.originalText) rightWord.originalText = rightWord.text

  const combinedText = `${leftWord.originalText ?? ''}${rightWord.originalText ?? ''}`
  const totalChars = combinedText.length
  if (totalChars === 0) {
    leftWord.text = ''
    rightWord.text = ''
    return next
  }

  const ratio = (newBoundaryTime - leftWord.start) / totalDuration
  const clampedRatio = Math.max(0, Math.min(1, ratio))
  let splitIndex = Math.floor(totalChars * clampedRatio)

  if (splitIndex === 0 && totalChars > 1) {
    splitIndex = 1
  } else if (splitIndex === totalChars && totalChars > 1) {
    splitIndex = totalChars - 1
  }

  leftWord.text = combinedText.slice(0, splitIndex).trim()
  rightWord.text = combinedText.slice(splitIndex).trim()
  return next
}

function isTimeOnWordSegment(peaks: PeaksInstance, t: number): boolean {
  for (const seg of peaks.segments.getSegments()) {
    if (String(seg.id) === CUT_PREVIEW_SEGMENT_ID) continue
    if (t + 1e-5 >= seg.startTime && t - 1e-5 <= seg.endTime) return true
  }
  return false
}

function removeCutOverlayGraphics(peaks: PeaksInstance): void {
  try {
    peaks.points.removeById(CUT_TOOL_POINT_ID)
    peaks.segments.removeById(CUT_PREVIEW_SEGMENT_ID)
  } catch {
    /* ignore */
  }
}

function paintCutSelectionOverlay(peaks: PeaksInstance, overlay: CutSelectionOverlay): void {
  if (!overlay) {
    removeCutOverlayGraphics(peaks)
    return
  }
  removeCutOverlayGraphics(peaks)
  try {
    if (overlay.kind === 'marker') {
      peaks.points.add({
        id: CUT_TOOL_POINT_ID,
        time: overlay.time,
        editable: false,
        color: '#d97706'
      })
    } else {
      const { start: a, end: b } = normalizeCutRange(overlay.start, overlay.end)
      peaks.segments.add({
        id: CUT_PREVIEW_SEGMENT_ID,
        startTime: a,
        endTime: b,
        editable: true,
        labelText: '자르기 영역',
        color: 'rgba(255, 0, 0, 0.4)',
        borderColor: 'rgba(200, 20, 20, 0.9)',
        markers: true,
        overlay: true
      })
    }
  } catch {
    /* ignore */
  }
}

export type SubtitleWaveformPeaksHandle = {
  /** 행에서 wave 마운트 DOM을 App 쪽 맵에 넣은 뒤 포털 타깃을 다시 잡게 할 때 호출 */
  onWaveMountDirty: () => void
}

/** zoomLevels 양자화 뒤 실제 표시 구간 — 단어 칹 %는 반드시 이 값과 같아야 세로선·세그먼트와 픽셀 일치 */
export type PeaksZoomViewRange = {
  lineIndex: number
  windowStart: number
  windowEnd: number
}

export type SubtitleWaveformPeaksProps = {
  rows: SubtitleRow[]
  onRowsChange: (next: SubtitleRow[]) => void
  audioUrl?: string
  /** 로컬 디스크 절대 경로 — Peaks가 http 창에서 file:// 를 XHR로 못 읽을 때 메인에서 읽어 AudioBuffer 생성 */
  localMediaPath?: string | null
  /** App에서 미리 decodeAudioData 한 전체 트랙 — 있으면 자식에서 파일을 다시 읽지 않음 */
  prefetchedAudioBuffer?: AudioBuffer | null
  /**
   * Python+audiowaveform이 만든 Peaks.js 호환 JSON — `file://` URL. 있으면 webAudio/decodeAudioData 를 쓰지 않는다.
   */
  precomputedPeaksJsonFileUrl?: string | null
  /**
   * 메인에서 `readLocalPeaksJsonFile`로 읽은 객체 — `waveformData`로 직접 주입(비동기 dataUri/XHR 제거).
   */
  precomputedWaveformJson?: JsonWaveformData | null
  /** App에서 유지 — layout effect 순서 때문에 Peaks ref보다 먼저 행이 등록해야 함 */
  waveMountByLineRef: MutableRefObject<Map<number, HTMLDivElement>>
  /** 자막 줄 인덱스 (SubtitleLine 배열과 동일) — 파동을 그 줄 카드 안에 붙임 */
  activeLineIndex: number | null
  activeWordId: number | null
  /** 카드 헤더 타임코드와 동일 — 줌 창을 단어 min/max 가 아닌 줄 구간으로 맞춘다 */
  waveformCardBounds: { start: number; end: number } | null
  /** Peaks zoomview 가 실제로 그리는 시간 구간 — 칹 레일과 동기화 */
  onZoomViewRange?: (range: PeaksZoomViewRange | null) => void
  /**
   * CUT 모드에서 구간 삭제 확정 시 — 재생 스킵 범위 등록 + 자막 단어 동기화(부모).
   */
  onTimeRangeCut?: (startSec: number, endSec: number) => void
}

/**
 * zoom/overview 는 포털로 활성 줄 `.subtitle-waveform-mount`에 붙인다.
 * 줄(activeLineIndex)이 바뀌거나, 같은 줄이라도 가상 리스트로 `.subtitle-waveform-mount` DOM 이 바뀌면(portalHost 참조)
 * Peaks 를 destroy→init 해 새 컨테이너에 다시 묶는다.
 * (포털만 옮기고 인스턴스를 유지하면 Konva 스테이지가 문서 밖 컨테이너를 참조해 빈 파형이 된다.)
 */
export const SubtitleWaveformPeaks = forwardRef<SubtitleWaveformPeaksHandle, SubtitleWaveformPeaksProps>(
  function SubtitleWaveformPeaks(
    {
      rows,
      onRowsChange,
      audioUrl,
      localMediaPath,
      prefetchedAudioBuffer,
      precomputedPeaksJsonFileUrl,
      precomputedWaveformJson,
      waveMountByLineRef,
      activeLineIndex,
      activeWordId,
      waveformCardBounds,
      onZoomViewRange,
      onTimeRangeCut
    },
    ref
  ) {
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const audioContextRef = useRef<AudioContext | null>(null)
    const zoomRef = useRef<HTMLDivElement | null>(null)
    const overviewRef = useRef<HTMLDivElement | null>(null)

    const peaksRef = useRef<PeaksInstance | null>(null)
    const isDraggingRef = useRef(false)
    const rowsRef = useRef(rows)
    const onRowsChangeRef = useRef(onRowsChange)
    const activeLineIndexRef = useRef(activeLineIndex)
    const activeWordIdRef = useRef(activeWordId)

    const [portalRev, setPortalRev] = useState(0)
    /** 활성 줄 마운트 DOM — 포털 타깃이 바뀌면 Peaks 컨테이너가 바뀌므로 재바인딩한다 */
    const [portalHost, setPortalHost] = useState<HTMLElement | null>(null)
    const portalHostLiveRef = useRef<HTMLElement | null>(null)
    portalHostLiveRef.current = portalHost
    const [hostReady, setHostReady] = useState(false)
    const [peaksReady, setPeaksReady] = useState(false)

    const bumpPortal = useCallback(() => setPortalRev((n) => n + 1), [])

    const flatWords = useMemo(() => flattenWords(rows), [rows])

    const rowsSig = useMemo(
      () =>
        rows
          .map((r) =>
            [
              r.id,
              r.lineText ?? '',
              ...r.words.map((w) => `${w.id}|${w.start}|${w.end}|${w.text}`)
            ].join(':')
          )
          .join(';'),
      [rows]
    )

    const wordsSig = useMemo(
      () => flatWords.map((w) => `${w.id}|${w.start.toFixed(4)}|${w.end.toFixed(4)}|${w.text}`).join(';'),
      [flatWords]
    )

    const prefetchedAudioBufferSig = useMemo(() => {
      const b = prefetchedAudioBuffer
      if (!b) return ''
      return `${b.length}|${b.duration}|${b.numberOfChannels}|${b.sampleRate}`
    }, [prefetchedAudioBuffer])

    const silentDurationSec = useMemo(() => {
      const maxEnd = flatWords.reduce((m, w) => Math.max(m, w.end), 0)
      return Math.max(60, Math.ceil(maxEnd) + 25)
    }, [flatWords])
    const silentDurationSecRef = useRef(silentDurationSec)
    silentDurationSecRef.current = silentDurationSec

    const mountLoggedRef = useRef(false)
    useEffect(() => {
      if (mountLoggedRef.current) return
      mountLoggedRef.current = true
      wfLog('lifecycle', 'SubtitleWaveformPeaks mount', {
        rowCount: rows.length,
        flatWordCount: flatWords.length,
        silentDurationSec,
        audioUrl: audioUrl ?? '(silent wav)'
      })
      void window.api
        .logWaveformDebug('lifecycle', 'waveform.log 위치는 userData/logs/waveform.log (아래 path 참고)')
        .then((r) => {
          wfLog('lifecycle', 'logPath', r.path)
        })
        .catch(() => {
          wfLog('lifecycle', 'logWaveformDebug IPC unavailable')
        })
    }, [rows.length, flatWords.length, silentDurationSec, audioUrl])

    useEffect(() => {
      rowsRef.current = rows
    }, [rows])

    useEffect(() => {
      onRowsChangeRef.current = onRowsChange
    }, [onRowsChange])

    useEffect(() => {
      activeLineIndexRef.current = activeLineIndex
      activeWordIdRef.current = activeWordId
    }, [activeLineIndex, activeWordId])

    const onZoomViewRangeRef = useRef(onZoomViewRange)
    useEffect(() => {
      onZoomViewRangeRef.current = onZoomViewRange
    }, [onZoomViewRange])

    const onTimeRangeCutRef = useRef(onTimeRangeCut)
    useEffect(() => {
      onTimeRangeCutRef.current = onTimeRangeCut
    }, [onTimeRangeCut])

    const [activeTool, setActiveTool] = useState<WaveformEditTool>(null)
    const [cutSelection, setCutSelection] = useState<CutSelectionOverlay>(null)
    const [oneShotPlayheadSec, setOneShotPlayheadSec] = useState<number | null>(null)
    const [oneShotPlayheadPct, setOneShotPlayheadPct] = useState<number | null>(null)
    const adjustDragStartSegmentsRef = useRef<Map<string, SegmentBoundarySnapshot>>(new Map())
    const activeToolRef = useRef<WaveformEditTool>(null)
    const cutSelectionRef = useRef<CutSelectionOverlay>(null)
    /** setState 직후에도 즉시 최신 — Peaks zoomview.click 이 같은 틱에 오면 ref 지연으로 오동작 */
    const syncCutSelection = useCallback((next: CutSelectionOverlay) => {
      cutSelectionRef.current = next
      setCutSelection(next)
    }, [])
    const cutDragAnchorTimeRef = useRef<number | null>(null)
    const cutDraggingRef = useRef(false)
    const cutDragRangeCommittedRef = useRef(false)
    const oneShotEndRef = useRef<number | null>(null)
    const oneShotRafRef = useRef<number | null>(null)
    useEffect(() => {
      activeToolRef.current = activeTool
    }, [activeTool])
    const waveformCardBoundsRef = useRef(waveformCardBounds)
    useEffect(() => {
      waveformCardBoundsRef.current = waveformCardBounds
    }, [waveformCardBounds])

    /** Peaks.init 의존성에 넣지 않음 — 버퍼 도착 시 destroy→재생성 루프로 빈 파형 방지 */
    const prefetchedAudioBufferRef = useRef(prefetchedAudioBuffer)
    prefetchedAudioBufferRef.current = prefetchedAudioBuffer

    /** zoomview 가 줄 끝 이후까지 그릴 때 오른쪽을 덮어 실제로 안 보이게 */
    const [zoomEndClipPx, setZoomEndClipPx] = useState(0)

    /** setZoom({seconds}) 요청과 무관 — peaks 가 zoomLevels 에 맞춘 실제 구간 */
    const publishZoomViewRange = useCallback((): void => {
      const cb = onZoomViewRangeRef.current
      if (!cb) return
      const peaks = peaksRef.current
      const li = activeLineIndexRef.current
      if (!peaks || li === null) {
        cb(null)
        return
      }
      const zv = peaks.views.getView('zoomview')
      if (!zv) {
        cb(null)
        return
      }
      const windowStart = zv.getStartTime()
      const windowEnd = zv.getEndTime()
      if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart + 1e-9) {
        cb(null)
        return
      }
      cb({ lineIndex: li, windowStart, windowEnd })
    }, [])

    const publishZoomViewRangeRef = useRef(publishZoomViewRange)
    publishZoomViewRangeRef.current = publishZoomViewRange

    useEffect(() => {
      if (activeLineIndex === null) {
        onZoomViewRangeRef.current?.(null)
      }
    }, [activeLineIndex])

    useEffect(() => {
      if (activeLineIndex === null) {
        setActiveTool(null)
        syncCutSelection(null)
      }
    }, [activeLineIndex])

    useImperativeHandle(ref, () => ({ onWaveMountDirty: bumpPortal }), [bumpPortal])

    useLayoutEffect(() => {
      void portalRev
      if (activeLineIndex === null) {
        setPortalHost(null)
        return
      }
      const el = waveMountByLineRef.current.get(activeLineIndex)
      const next = el && el.isConnected ? el : null
      setPortalHost(next)
      if (!next) {
        wfLog('portal', 'flow: 줄 마운트 없음', { activeLineIndex })
      }
    }, [activeLineIndex, portalRev, waveMountByLineRef])

    useEffect(() => {
      bumpPortal()
    }, [activeLineIndex, bumpPortal])

    /** portalRev 를 deps 에 넣으면: bump → 리렌더 → effect 재실행 → RO 재구독 → bump… 무한 루프 */
    useLayoutEffect(() => {
      if (activeLineIndex === null) return
      const el = waveMountByLineRef.current.get(activeLineIndex)
      if (!el) return
      const ro = new ResizeObserver(() => bumpPortal())
      ro.observe(el)
      return () => ro.disconnect()
    }, [activeLineIndex, bumpPortal, waveMountByLineRef])

    const mountLayoutKey = `${portalRev}|${activeLineIndex}|${portalHost ? '1' : '0'}|${rowsSig}`

    useEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady) return
      const publish = (): void => {
        publishZoomViewRange()
      }
      peaks.on('zoomview.update', publish)
      queueMicrotask(() => {
        queueMicrotask(publish)
      })
      return () => {
        peaks.off('zoomview.update', publish)
      }
    }, [peaksReady, mountLayoutKey, publishZoomViewRange])

    const lastHostRefsLogged = useRef<boolean | null>(null)
    /** 포털·줌 refit 한 프레임 동안만 끊겨 보일 때 hostReady=false 가 되면 Peaks 가 destroy→init 루프에 들어가 CUT UI 가 통째로 날아간다 → 끄기만 지연 */
    const hostReadyFalseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    /**
     * 문서에 안 붙은 컨테이너에 Peaks가 남는 것만 막는다.
     * `contains()` 는 포털 DOM 이동 직후 한 프레임에서 오판할 수 있어 쓰지 않는다.
     * rAF 한 번 더 돌려 ref·연결 상태가 안정된 뒤 hostReady 를 맞춘다.
     */
    useLayoutEffect(() => {
      let innerRaf = 0
      const measure = (): void => {
        const ph = portalHost
        const z = zoomRef.current
        const o = overviewRef.current
        const ok = Boolean(
          ph && ph.isConnected && z && o && z.isConnected && o.isConnected
        )
        if (ok) {
          if (hostReadyFalseTimerRef.current != null) {
            clearTimeout(hostReadyFalseTimerRef.current)
            hostReadyFalseTimerRef.current = null
          }
          setHostReady(true)
        } else {
          if (hostReadyFalseTimerRef.current != null) {
            clearTimeout(hostReadyFalseTimerRef.current)
          }
          hostReadyFalseTimerRef.current = setTimeout(() => {
            hostReadyFalseTimerRef.current = null
            const ph2 = portalHostLiveRef.current
            const z2 = zoomRef.current
            const o2 = overviewRef.current
            const ok2 = Boolean(
              ph2 && ph2.isConnected && z2 && o2 && z2.isConnected && o2.isConnected
            )
            if (!ok2) {
              setHostReady(false)
            }
          }, 180)
        }
        if (lastHostRefsLogged.current !== ok) {
          lastHostRefsLogged.current = ok
          wfLog('host', 'zoom/overview refs', {
            refsReady: ok,
            hasPortal: Boolean(ph),
            phConn: ph ? ph.isConnected : false,
            zConn: z ? z.isConnected : false,
            oConn: o ? o.isConnected : false
          })
        }
      }
      measure()
      const outer = requestAnimationFrame(() => {
        measure()
        innerRaf = requestAnimationFrame(measure)
      })
      return () => {
        cancelAnimationFrame(outer)
        cancelAnimationFrame(innerRaf)
        if (hostReadyFalseTimerRef.current != null) {
          clearTimeout(hostReadyFalseTimerRef.current)
          hostReadyFalseTimerRef.current = null
        }
      }
    }, [mountLayoutKey, portalHost])

    /** Peaks setZoom(seconds) 는 `_getScale` 에 view `_width` 가 들어가므로, 호출 직전에 항상 컨테이너 폭을 동기화한다. */
    const syncZoomContainersFromDom = useCallback((peaks: PeaksInstance) => {
      safeFitPeaksContainerView(peaks, 'zoomview', zoomRef.current)
      safeFitPeaksContainerView(peaks, 'overview', overviewRef.current)
    }, [])

    const applyCardAlignedZoomView = useCallback(
      (peaks: PeaksInstance) => {
        if (activeLineIndex === null) return
        syncZoomContainersFromDom(peaks)
        const row = rowsRef.current[activeLineIndex]
        const dur = peaks.player.getDuration()
        const mediaCap = Number.isFinite(dur) && dur > 0 ? dur : null
        const win =
          waveformCardBounds != null
            ? computeLineZoomWindowFromCardBounds(waveformCardBounds.start, waveformCardBounds.end, {
                mediaDurationSec: mediaCap ?? undefined,
                clipTrailingToLineEnd: true
              })
            : row?.words?.length
              ? computeLineZoomWindow(row.words, {
                  mediaDurationSec: mediaCap ?? undefined,
                  clipTrailingToLineEnd: true
                })
              : null
        if (!win) return
        const maxEnd =
          waveformCardBounds != null
            ? waveformCardBounds.end
            : row?.words?.length
              ? Math.max(...row.words.map((w) => w.end))
              : win.lineEnd
        applyZoomThenClampEndBeforeOrAt(peaks, {
          windowStart: win.windowStart,
          spanSeconds: win.span,
          maxEndTime: maxEnd
        })
        queueMicrotask(() => publishZoomViewRange())
      },
      [activeLineIndex, waveformCardBounds, publishZoomViewRange, syncZoomContainersFromDom]
    )

    /**
     * 줌 뷰 시간축 = 카드 줄 구간(row.start/end) + 패딩 — 단어 칩 가로 비율과 동일.
     * 플레이헤드는 선택 단어의 start 로 이동해 타일 클릭·파형과 동일 시간축을 공유한다.
     */
    const focusWordAtTime = useCallback(
      (word: Word) => {
        const peaks = peaksRef.current
        if (!peaks) return
        if (activeLineIndex === null || activeLineIndex < 0) return

        syncZoomContainersFromDom(peaks)

        const row = rowsRef.current[activeLineIndex]
        if (!row?.words?.length) return

        const dur = peaks.player.getDuration()
        const mediaCap = Number.isFinite(dur) && dur > 0 ? dur : null
        const win =
          waveformCardBounds != null
            ? computeLineZoomWindowFromCardBounds(waveformCardBounds.start, waveformCardBounds.end, {
                mediaDurationSec: mediaCap ?? undefined,
                clipTrailingToLineEnd: true
              })
            : computeLineZoomWindow(row.words, {
                mediaDurationSec: mediaCap ?? undefined,
                clipTrailingToLineEnd: true
              })
        if (!win) return

        const maxEnd =
          waveformCardBounds != null ? waveformCardBounds.end : Math.max(...row.words.map((w) => w.end))

        peaks.player.seek(word.start)
        applyZoomThenClampEndBeforeOrAt(peaks, {
          windowStart: win.windowStart,
          spanSeconds: win.span,
          maxEndTime: maxEnd
        })
        const zv = peaks.views.getView('zoomview')
        const visibleSpan = zv ? zv.getEndTime() - zv.getStartTime() : -1
        wfLog('seek', 'focusWordAtTime', {
          wordId: word.id,
          seekTo: word.start,
          lineStart: win.lineStart,
          lineEnd: win.lineEnd,
          windowStart: win.windowStart,
          windowEnd: win.windowEnd,
          zoomSeconds: win.span,
          visibleSpanSec: visibleSpan,
          zw: zoomRef.current?.clientWidth ?? 0,
          duration: dur,
          sentenceZoom: true,
          zoomFromCardBounds: waveformCardBounds != null
        })
        queueMicrotask(() => publishZoomViewRange())
      },
      [activeLineIndex, waveformCardBounds, publishZoomViewRange, syncZoomContainersFromDom]
    )

    /**
     * 줄 끝 클립 오버레이 + 리사이즈 시: Peaks `_getScale(seconds)=seconds*sr/_width` 이므로 **fit 먼저**, 그 다음 `applyZoom`/seek.
     */
    useLayoutEffect(() => {
      const peaks = peaksRef.current
      const el = zoomRef.current
      if (!peaks || !peaksReady || !el) {
        setZoomEndClipPx(0)
        return
      }
      if (activeLineIndex === null) {
        setZoomEndClipPx(0)
        return
      }

      const update = (): void => {
        const p = peaksRef.current
        const zv = p?.views.getView('zoomview')
        const container = zoomRef.current
        if (!p || !zv || !container) {
          setZoomEndClipPx(0)
          return
        }
        const b = waveformCardBoundsRef.current
        const li = activeLineIndexRef.current
        const cap =
          b != null
            ? b.end
            : li != null && rowsRef.current[li]?.words?.length
              ? Math.max(...rowsRef.current[li]!.words.map((w) => w.end))
              : null
        if (cap == null || !Number.isFinite(cap)) {
          setZoomEndClipPx(0)
          return
        }
        const t0 = zv.getStartTime()
        const t1 = zv.getEndTime()
        const cw = container.clientWidth
        const span = t1 - t0
        if (cw < 2 || span < 1e-6) {
          setZoomEndClipPx(0)
          return
        }
        if (cap >= t1 - 0.012) {
          setZoomEndClipPx(0)
          return
        }
        const hideFrac = (t1 - cap) / span
        setZoomEndClipPx(Math.max(0, Math.min(cw, hideFrac * cw)))
      }

      update()
      peaks.on('zoomview.update', update)
      const ro = new ResizeObserver(() => {
        const p = peaksRef.current
        const z = zoomRef.current
        if (p && z && activeLineIndexRef.current !== null) {
          safeFitPeaksContainerView(p, 'zoomview', z)
          safeFitPeaksContainerView(p, 'overview', overviewRef.current)
          const li = activeLineIndexRef.current
          const wid = activeWordIdRef.current
          const editingWord =
            wid != null ? rowsRef.current[li]?.words?.find((x) => x.id === wid) : undefined
          if (editingWord) {
            focusWordAtTime(editingWord)
          } else {
            applyCardAlignedZoomView(p)
          }
          queueMicrotask(() => publishZoomViewRangeRef.current())
        }
        update()
      })
      ro.observe(el)
      return () => {
        peaks.off('zoomview.update', update)
        ro.disconnect()
        setZoomEndClipPx(0)
      }
    }, [
      peaksReady,
      mountLayoutKey,
      activeLineIndex,
      rowsSig,
      focusWordAtTime,
      applyCardAlignedZoomView
    ])

    useLayoutEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady || activeWordId === null || activeLineIndex === null) return
      const row = rowsRef.current[activeLineIndex]
      const w = row?.words.find((x) => x.id === activeWordId)
      if (w) {
        wfLog('seek', 'layout: seek after peaksReady/activeWord', { lineIndex: activeLineIndex, wordId: activeWordId })
        safeFitPeaksContainerView(peaks, 'zoomview', zoomRef.current)
        safeFitPeaksContainerView(peaks, 'overview', overviewRef.current)
        focusWordAtTime(w)
      } else {
        wfLog('seek', 'layout: word not found for seek', { activeLineIndex, activeWordId })
      }
    }, [activeLineIndex, activeWordId, focusWordAtTime, peaksReady, rowsSig])

    useLayoutEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady) return

      const refitZoomSizeOnly = (): void => {
        try {
          const p = peaksRef.current
          if (!p || activeLineIndexRef.current === null) return
          safeFitPeaksContainerView(p, 'zoomview', zoomRef.current)
          safeFitPeaksContainerView(p, 'overview', overviewRef.current)
          const li = activeLineIndexRef.current
          const wid = activeWordIdRef.current
          const ew =
            wid != null ? rowsRef.current[li]?.words?.find((x) => x.id === wid) : undefined
          if (ew) {
            focusWordAtTime(ew)
          } else {
            applyCardAlignedZoomView(p)
          }
          queueMicrotask(() => publishZoomViewRangeRef.current())
          wfLog('view', 'zoom refit (애니메이션 후 폭→줌 재적용)', {
            zw: zoomRef.current?.clientWidth ?? 0,
            zh: zoomRef.current?.clientHeight ?? 0
          })
        } catch (e) {
          wfLog('view', 'refitZoomSizeOnly error', e)
        }
      }

      const runFit = (): void => {
        try {
          const editingWord =
            activeLineIndex !== null && activeWordId !== null
              ? rowsRef.current[activeLineIndex]?.words?.find((x) => x.id === activeWordId)
              : undefined

          /**
           * 반드시 fitToContainer 로 최종 _width 확정 후 setZoom — 순서 바뀌면 왼쪽 1/3만 파형이 있는 현상.
           */
          if (activeLineIndex !== null) {
            safeFitPeaksContainerView(peaks, 'zoomview', zoomRef.current)
            safeFitPeaksContainerView(peaks, 'overview', overviewRef.current)
            if (editingWord) {
              focusWordAtTime(editingWord)
            } else {
              applyCardAlignedZoomView(peaks)
            }
            queueMicrotask(() => publishZoomViewRangeRef.current())
          } else {
            safeFitPeaksContainerView(peaks, 'zoomview', zoomRef.current)
            safeFitPeaksContainerView(peaks, 'overview', overviewRef.current)
          }
          wfLog('view', 'zoom/overview refit', {
            blockZoomOnly: Boolean(editingWord),
            cardZoomOnly: !editingWord && activeLineIndex !== null,
            zw: zoomRef.current?.clientWidth ?? 0,
            zh: zoomRef.current?.clientHeight ?? 0
          })
        } catch (e) {
          wfLog('view', 'fitToContainer error', e)
        }
      }
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(runFit)
      })
      /** 아코디언·레이아웃 안정화용 재적용 — 지연을 키우면 더블클릭 직후 체감이 ~1초까지 늘어남 */
      const t = window.setTimeout(runFit, 48)
      /** 아코디언 전환 후 seek 없이 스테이지만 너비 동기화 */
      const t2 = window.setTimeout(refitZoomSizeOnly, 110)
      const t3 = window.setTimeout(refitZoomSizeOnly, 200)
      const t4 = window.setTimeout(refitZoomSizeOnly, 360)
      return () => {
        cancelAnimationFrame(id)
        window.clearTimeout(t)
        window.clearTimeout(t2)
        window.clearTimeout(t3)
        window.clearTimeout(t4)
      }
    }, [
      activeLineIndex,
      activeWordId,
      peaksReady,
      mountLayoutKey,
      focusWordAtTime,
      applyCardAlignedZoomView
    ])

    const peaksInitGenRef = useRef(0)

    useEffect(() => {
      const audio = audioRef.current
      if (activeLineIndex === null) {
        wfLog('peaks', 'Peaks.init 스킵 (파형 편집 줄 없음)')
        return
      }
      if (!hostReady || !audio) {
        wfLog('peaks', 'Peaks.init 스킵', {
          hostReady,
          hasAudio: Boolean(audio),
          hasZoom: Boolean(zoomRef.current),
          hasOverview: Boolean(overviewRef.current)
        })
        return
      }

      const silentDur = silentDurationSecRef.current
      const initGen = ++peaksInitGenRef.current
      let peaksInstance: PeaksInstance | null = null
      let cancelled = false
      let rafWait = 0
      /**
       * 프리패치 AudioBuffer 가 있으면 Web Audio 경로(스플라이스 반영)를 쓴다.
       * JSON만 쓰면 CUT 후 파형을 닫았다 열 때 전체 길이 피크가 다시 그려져 삭제 구간이 부활한다.
       */
      const hasPrefetchBuffer = prefetchedAudioBufferRef.current != null
      const useInlineWaveformData = Boolean(precomputedWaveformJson) && !hasPrefetchBuffer
      const useDataUri =
        Boolean(precomputedPeaksJsonFileUrl) && !useInlineWaveformData && !hasPrefetchBuffer
      const usePrebuiltPeaks = useInlineWaveformData || useDataUri

      wfLog('peaks', 'Peaks.init 시작', {
        activeLineIndex,
        portalHostConnected: portalHost ? portalHost.isConnected : null,
        silentDur,
        segmentCount: flattenWords(rowsRef.current).length,
        audioCtxState: audioContextRef.current?.state,
        localMediaPath: localMediaPath ?? null,
        useIpcDecode: Boolean(localMediaPath && window.api.readLocalMediaFileBuffer),
        usePrefetchBuffer: Boolean(prefetchedAudioBufferRef.current),
        usePrebuiltPeaks: usePrebuiltPeaks,
        useInlineWaveformData: useInlineWaveformData
      })

      if (!audioUrl) {
        const prev = audio.dataset.blobUrl
        if (prev) URL.revokeObjectURL(prev)
        const blob = createSilentWavBlob(silentDur)
        const url = URL.createObjectURL(blob)
        audio.dataset.blobUrl = url
        audio.src = url
      } else {
        audio.src = audioUrl
      }

      if (!usePrebuiltPeaks) {
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContext()
        }
      }

      const ctx = audioContextRef.current

      /**
       * 세그먼트는 콜백에서 applyWordsToPeaks 로 한 번만 넣는다.
       * init 시 수천 개를 넘기면 Peaks/Konva 쪽 초기 비용이 커지고, 어차피 콜백에서 전부 다시 넣는다(중복).
       */
      const onDragStart = (): void => {
        isDraggingRef.current = true
        if (activeToolRef.current !== 'adjust') return
        const inst = peaksRef.current
        if (!inst) return
        const snapshot = new Map<string, SegmentBoundarySnapshot>()
        for (const seg of inst.segments.getSegments()) {
          const id = String(seg.id ?? '')
          if (!id || id === CUT_PREVIEW_SEGMENT_ID) continue
          snapshot.set(id, { startTime: seg.startTime, endTime: seg.endTime })
        }
        adjustDragStartSegmentsRef.current = snapshot
      }

      /**
       * CUT + insert-segment: 드래그로 생긴 가짜 세그먼트를 dragend 에서 단어로 넣지 않음(process 순서상 dragend 가 insert 이벤트보다 먼저 옴).
       */
      const onDragEnd = (): void => {
        isDraggingRef.current = false
        if (activeToolRef.current === 'cut') {
          const inst = peaksRef.current
          if (!inst) return
          const cutSeg = inst.segments
            .getSegments()
            .find((s) => String(s.id ?? '') === CUT_PREVIEW_SEGMENT_ID)
          if (cutSeg) {
            const { start: a, end: b } = normalizeCutRange(cutSeg.startTime, cutSeg.endTime)
            syncCutSelection({ kind: 'range', start: a, end: b })
            queueMicrotask(() => {
              const p = peaksRef.current
              if (!p) return
              applyWordsToPeaks(
                p,
                flattenWords(rowsRef.current),
                rowsRef.current,
                activeLineIndexRef.current,
                activeWordIdRef.current,
                activeToolRef.current,
                cutSelectionRef.current
              )
            })
          }
          return
        }
        /** 기본 상태/null + ADJUST 단어 편집/병합 */
        if (activeToolRef.current !== 'adjust') {
          return
        }
        const inst = peaksRef.current
        if (!inst) return
        const wordSegs = inst.segments.getSegments().filter((s) => String(s.id ?? '') !== CUT_PREVIEW_SEGMENT_ID)
        const prevSegMap = adjustDragStartSegmentsRef.current
        const changedSeg = wordSegs.find((seg) => {
          const prev = prevSegMap.get(String(seg.id ?? ''))
          if (!prev) return false
          return prev.startTime !== seg.startTime || prev.endTime !== seg.endTime
        })
        if (!changedSeg) return

        const oldSegment = prevSegMap.get(String(changedSeg.id ?? ''))
        if (!oldSegment) return

        const prevFlat = flattenWords(rowsRef.current).sort((a, b) => a.start - b.start)
        const currentIndex = prevFlat.findIndex((w) => String(w.id) === String(changedSeg.id ?? ''))
        if (currentIndex < 0) return
        const flat = applyDirectionalAdjustResplit({
          words: prevFlat,
          currentIndex,
          oldSegment,
          newSegment: { startTime: changedSeg.startTime, endTime: changedSeg.endTime }
        })
        const nextRows = assignFlatWordsToRows(flat, rowsRef.current)
        onRowsChangeRef.current(nextRows)
        applyWordsToPeaks(
          inst,
          flattenWords(nextRows),
          nextRows,
          activeLineIndexRef.current,
          activeWordIdRef.current,
          activeToolRef.current,
          cutSelectionRef.current
        )

        const li = activeLineIndexRef.current
        const wid = activeWordIdRef.current
        if (li === null || wid === null) return
        const row = nextRows[li]
        const w = row?.words?.find((x) => x.id === wid)
        if (!row?.words?.length || !w) return
        safeFitPeaksContainerView(inst, 'zoomview', zoomRef.current)
        safeFitPeaksContainerView(inst, 'overview', overviewRef.current)
        const dur = inst.player.getDuration()
        const mediaCap = Number.isFinite(dur) && dur > 0 ? dur : null
        const win = computeLineZoomWindow(row.words, {
          mediaDurationSec: mediaCap ?? undefined,
          clipTrailingToLineEnd: true
        })
        if (!win) return
        const maxEnd = Math.max(...row.words.map((w) => w.end))
        inst.player.seek(w.start)
        applyZoomThenClampEndBeforeOrAt(inst, {
          windowStart: win.windowStart,
          spanSeconds: win.span,
          maxEndTime: maxEnd
        })
        queueMicrotask(() => publishZoomViewRangeRef.current())
      }

      /** 빈 파형 드래그(insert-segment)로 구간 확정 시 — 클릭 2번이 아니라 이 경로가 주력 */
      const onSegmentsInsert = (event: { segment: Segment }): void => {
        if (activeToolRef.current !== 'cut') {
          try {
            peaksRef.current?.segments.removeById(String(event.segment.id))
          } catch {
            /* ignore */
          }
          return
        }
        const seg = event.segment
      const { start: a, end: b } = normalizeCutRange(seg.startTime, seg.endTime)
        if (b - a < 0.012) return
        syncCutSelection({ kind: 'range', start: a, end: b })
        queueMicrotask(() => {
          const inst = peaksRef.current
          if (!inst) return
          applyWordsToPeaks(
            inst,
            flattenWords(rowsRef.current),
            rowsRef.current,
            activeLineIndexRef.current,
            activeWordIdRef.current,
            activeToolRef.current,
            cutSelectionRef.current
          )
        })
      }

      let decodedAudioBuffer: AudioBuffer | undefined = usePrebuiltPeaks
        ? undefined
        : prefetchedAudioBufferRef.current != null
          ? prefetchedAudioBufferRef.current
          : undefined

      const runPeaksInit = (): void => {
        if (cancelled || initGen !== peaksInitGenRef.current) return
        const zoomEl = zoomRef.current
        const ovEl = overviewRef.current
        if (!zoomEl || !ovEl) {
          wfLog('peaks', 'Peaks.init 대기 (refs)', { rafWait })
          rafWait++
          if (rafWait > 90) {
            wfLog('peaks', 'Peaks.init 포기 — zoom/overview ref 없음')
            return
          }
          requestAnimationFrame(runPeaksInit)
          return
        }
        if (
          zoomEl.clientWidth <= 0 ||
          zoomEl.clientHeight <= 0 ||
          ovEl.clientWidth <= 0 ||
          ovEl.clientHeight <= 0
        ) {
          wfLog('peaks', 'Peaks.init 대기 (zoom/overview 컨테이너 준비 안 됨)', {
            rafWait,
            zw: zoomEl.clientWidth,
            zh: zoomEl.clientHeight,
            ow: ovEl.clientWidth,
            oh: ovEl.clientHeight,
            holdReason:
              zoomEl.clientWidth <= 0 || zoomEl.clientHeight <= 0 ? 'zoom' : 'overview'
          })
          rafWait++
          if (rafWait > 120) {
            wfLog('peaks', 'Peaks.init 포기 — 컨테이너가 계속 0×0')
            return
          }
          requestAnimationFrame(runPeaksInit)
          return
        }

        wfLog('peaks', 'Peaks.init 호출', {
          zw: zoomEl.clientWidth,
          zh: zoomEl.clientHeight,
          ow: ovEl.clientWidth,
          oh: ovEl.clientHeight,
          hasDecodedBuffer: Boolean(decodedAudioBuffer),
          inlineWaveformJson: useInlineWaveformData,
          dataUriJson: useDataUri
        })

        const sharedPeaksOpts = {
          waveformColor: '#aeb4b6',
          playedWaveformColor: '#ffd54f',
          /** 화살표/단축키로 zoomview 가로 스크롤 방지 */
          keyboard: false,
          zoomview: {
            container: zoomEl,
            /** 단어 타임라인과 1:1 유지 — 휠로 줌 시간축 이동 금지 */
            wheelMode: 'none' as const,
            enablePoints: true,
            /** 비활성/활성 파형 색 */
            waveformColor: '#aeb4b6',
            playedWaveformColor: '#ffd54f',
            /** false: 파형이 컨테이너 가로 전체에 시간 선형 매핑 — 자막 타임라인과 픽셀 일치 */
            showAxisLabels: false,
            showPlayheadTime: false,
            axisTopMarkerHeight: 0,
            axisBottomMarkerHeight: 0
          },
          overview: {
            container: ovEl,
            waveformColor: '#aeb4b6',
            playedWaveformColor: '#ffd54f'
          },
          mediaElement: audio,
          /**
           * 첫 값은 waveform JSON 의 samples_per_pixel(네이티브 scale) 이상이어야 리샘플이 된다.
           * audiowaveform 80pps → spp≈600 이면 짧은 자막 줄을 화면에 펼칠 scale 로 못 내려가 빈 오른쪽만 보임.
           */
          zoomLevels: [
            ...(usePrebuiltPeaks
              ? zoomLevelsForPrebuiltPeaks({
                  inlineJson: precomputedWaveformJson,
                  useDataUriWithoutInline: useDataUri
                })
              : PEAKS_ZOOM_LEVELS_WEBAUDIO)
          ],
          segmentOptions: {
            markers: false,
            overlay: false,
            overlayOpacity: 0,
            overlayColor: '#aeb4b6',
            overlayBorderColor: '#aeb4b6',
            overlayBorderWidth: 1,
            overlayCornerRadius: 4,
            waveformColor: '#aeb4b6',
            playedWaveformColor: '#ffd54f',
            startMarkerColor: '#6b7280',
            endMarkerColor: '#6b7280'
          },
          createSegmentMarker: createWaveformSegmentMarker,
          createPointMarker: createCutToolPointMarker,
          segments: []
        }

        const peaksInitOpts = useInlineWaveformData
          ? {
              ...sharedPeaksOpts,
              waveformData: { json: precomputedWaveformJson as JsonWaveformData }
            }
          : useDataUri
            ? {
                ...sharedPeaksOpts,
                dataUri: { json: precomputedPeaksJsonFileUrl as string }
              }
            : {
                ...sharedPeaksOpts,
                webAudio:
                  decodedAudioBuffer && ctx
                    ? { audioContext: ctx, audioBuffer: decodedAudioBuffer }
                    : { audioContext: ctx! }
              }

        Peaks.init(
          peaksInitOpts as Parameters<typeof Peaks.init>[0],
          (err, peaks) => {
            if (initGen !== peaksInitGenRef.current) {
              if (peaks) {
                try {
                  peaks.destroy()
                } catch {
                  /* ignore */
                }
              }
              return
            }
            if (err || !peaks) {
              console.error('[SubtitleWaveformPeaks] Peaks.init failed', err)
              wfLog('peaks', 'Peaks.init 실패', { err: err?.message ?? String(err), staleGen: false })
              return
            }
            peaksInstance = peaks
            peaksRef.current = peaks

            applyWordsToPeaks(
              peaks,
              flattenWords(rowsRef.current),
              rowsRef.current,
              activeLineIndex,
              activeWordId,
              activeToolRef.current,
              activeToolRef.current === 'cut' ? cutSelectionRef.current : null
            )

            const zv = peaks.views.getView('zoomview')
            zv?.setSegmentDragMode('overlap')
            try {
              /** scroll 모드는 드래그 시 파형이 이동하므로 항상 insert-segment 유지 */
              zv?.setWaveformDragMode('insert-segment')
              // 옵션이 내부 기본값에 덮일 수 있어 init 직후 색상을 한 번 더 강제한다.
              zv?.setWaveformColor('#aeb4b6')
              zv?.setPlayedWaveformColor('#ffd54f')
              const ovColorView = peaks.views.getView('overview')
              ovColorView?.setWaveformColor?.('#aeb4b6')
              ovColorView?.setPlayedWaveformColor?.('#ffd54f')
              zv?.setWheelMode('none', { captureVerticalScroll: false })
              zv?.enableAutoScroll(false)
              zv?.enableSeek(activeToolRef.current === 'adjust')
              zv?.enableMarkerEditing(
                activeToolRef.current === 'adjust' || activeToolRef.current === 'cut'
              )
              zv?.enableSegmentDragging(false)
              const ov = peaks.views.getView('overview') as {
                enableSeek?: (e: boolean) => void
                setWaveformColor?: (color: string) => void
                setPlayedWaveformColor?: (color: string | null) => void
              } | null
              ov?.enableSeek?.(activeToolRef.current === 'adjust')
            } catch {
              /* ignore */
            }

            peaks.on('segments.dragstart', onDragStart)
            peaks.on('segments.dragend', onDragEnd)
            peaks.on('segments.insert', onSegmentsInsert)

            const dur = peaks.player.getDuration()
            wfLog('peaks', 'Peaks.init 완료', {
              duration: dur,
              zoomView: Boolean(peaks.views.getView('zoomview')),
              overviewView: Boolean(peaks.views.getView('overview'))
            })

            setPeaksReady(true)
          }
        )
      }

      const startPipeline = async (): Promise<void> => {
        if (usePrebuiltPeaks) {
          wfLog(
            'peaks',
            useInlineWaveformData
              ? '사전 피크 waveformData(메모리) — 디코딩·XHR 생략'
              : '사전 피크 JSON(dataUri) — 브라우저 디코딩 생략',
            useInlineWaveformData
              ? { peakPoints: precomputedWaveformJson?.length ?? 0 }
              : { jsonUrl: precomputedPeaksJsonFileUrl ?? null }
          )
          if (cancelled || initGen !== peaksInitGenRef.current) return
          runPeaksInit()
          return
        }
        if (!ctx) {
          wfLog('peaks', 'AudioContext 없음 — 파형 초기화 불가')
          return
        }
        if (decodedAudioBuffer) {
          wfLog('peaks', 'App 프리패치 AudioBuffer 사용', {
            duration: decodedAudioBuffer.duration,
            channels: decodedAudioBuffer.numberOfChannels
          })
        } else if (
          localMediaPath &&
          typeof window.api.readLocalMediaFileBuffer === 'function'
        ) {
          try {
            const res = await window.api.readLocalMediaFileBuffer(localMediaPath)
            if (cancelled || initGen !== peaksInitGenRef.current) return
            if (res.ok) {
              decodedAudioBuffer = await ctx.decodeAudioData(res.arrayBuffer.slice(0))
              wfLog('peaks', 'decodeAudioData 완료 (폴백 IPC)', {
                duration: decodedAudioBuffer.duration,
                channels: decodedAudioBuffer.numberOfChannels
              })
            } else {
              wfLog('peaks', '로컬 미디어 파일 읽기 실패(XHR 폴백)', res)
            }
          } catch (e) {
            wfLog('peaks', 'IPC/decodeAudioData 예외', e)
          }
        }
        if (cancelled || initGen !== peaksInitGenRef.current) return
        /** 이중 rAF 는 첫 페인트 대기용이었으나, runPeaksInit 이 0×0 이면 rAF 로 재시도하므로 즉시 호출이 더 빠름 */
        runPeaksInit()
      }

      void startPipeline()

      return () => {
        cancelled = true
        peaksInitGenRef.current++
        wfLog('peaks', 'Peaks 인스턴스 destroy (effect cleanup)')
        setPeaksReady(false)
        if (peaksInstance) {
          try {
            peaksInstance.off('segments.dragstart', onDragStart)
            peaksInstance.off('segments.dragend', onDragEnd)
            peaksInstance.off('segments.insert', onSegmentsInsert)
            peaksInstance.destroy()
          } catch {
            /* ignore */
          }
        }
        peaksRef.current = null
        if (audio.dataset.blobUrl) {
          URL.revokeObjectURL(audio.dataset.blobUrl)
          delete audio.dataset.blobUrl
        }
      }
    }, [
      audioUrl,
      localMediaPath,
      hostReady,
      activeLineIndex,
      portalHost,
      precomputedPeaksJsonFileUrl,
      precomputedWaveformJson,
      prefetchedAudioBufferSig
    ])

    /** 포털 타깃(줄) 이동 후 Konva 스테이지가 안 그려지는 경우 — fit + batchDraw */
    useLayoutEffect(() => {
      const p = peaksRef.current
      if (!p || !peaksReady || !portalHost) return
      try {
        safeFitPeaksContainerView(p, 'zoomview', zoomRef.current)
        safeFitPeaksContainerView(p, 'overview', overviewRef.current)
        const zv = p.views.getView('zoomview') as unknown as { getStage?: () => { batchDraw?: () => void } }
        zv?.getStage?.()?.batchDraw?.()
      } catch (e) {
        wfLog('view', 'portalHost 이동 후 refit/batchDraw', e)
      }
      queueMicrotask(() => publishZoomViewRangeRef.current())
    }, [portalHost, peaksReady])

    /** 단어 레일 레이아웃·포털 이동 직후 한 틱 더 refit — Konva/폭 어긋남 완화 */
    useEffect(() => {
      if (!peaksReady || !portalHost) return
      const t = window.setTimeout(() => {
        const p = peaksRef.current
        if (!p) return
        try {
          safeFitPeaksContainerView(p, 'zoomview', zoomRef.current)
          safeFitPeaksContainerView(p, 'overview', overviewRef.current)
          const zv = p.views.getView('zoomview') as unknown as {
            getStage?: () => { batchDraw?: () => void }
          }
          zv?.getStage?.()?.batchDraw?.()
        } catch {
          /* ignore */
        }
        queueMicrotask(() => publishZoomViewRangeRef.current())
      }, 420)
      return () => window.clearTimeout(t)
    }, [portalHost, peaksReady])

    useEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady) return
      /**
       * ADJUST 드래그 중에는 Peaks 가 세그먼트를 직접 옮기므로 여기서 removeAll+재삽입을 스킵한다.
       * CUT(insert-segment) 드래그 중에는 removeAll 이 CUT 프리뷰를 지우므로, 드래그 끝난 뒤에도
       * paintCutSelectionOverlay 가 다시 돌아가야 구간이 유지된다 — 이 경우엔 스킵하면 안 된다.
       */
      if (isDraggingRef.current && activeTool !== 'cut') return
      applyWordsToPeaks(
        peaks,
        flatWords,
        rowsRef.current,
        activeLineIndex,
        activeWordId,
        activeTool,
        activeTool === 'cut' ? cutSelectionRef.current : null
      )
      wfLog('segments', 'applyWordsToPeaks', { wordCount: flatWords.length })
    }, [wordsSig, rowsSig, flatWords, peaksReady, activeLineIndex, activeWordId, activeTool, cutSelection])

    useEffect(() => {
      if (!audioContextRef.current) return
      void audioContextRef.current.resume().then(
        () => wfLog('audio', 'AudioContext.resume', { state: audioContextRef.current?.state }),
        () => wfLog('audio', 'AudioContext.resume rejected')
      )
    }, [activeLineIndex, activeWordId])

    useEffect(() => {
      if (activeTool !== 'cut') {
        syncCutSelection(null)
        const p = peaksRef.current
        if (p) paintCutSelectionOverlay(p, null)
      }
    }, [activeTool])

    const stopOneShotPlayback = useCallback((): void => {
      const audio = audioRef.current
      if (audio && !audio.paused) {
        audio.pause()
      }
      if (oneShotRafRef.current !== null) {
        cancelAnimationFrame(oneShotRafRef.current)
        oneShotRafRef.current = null
      }
      oneShotEndRef.current = null
      setOneShotPlayheadSec(null)
      setOneShotPlayheadPct(null)
    }, [])

    const playSelectedWordOnce = useCallback((): void => {
      const li = activeLineIndexRef.current
      const wid = activeWordIdRef.current
      if (li === null || wid === null) return
      const row = rowsRef.current[li]
      const w = row?.words?.find((x) => x.id === wid)
      if (!w || !(w.end > w.start + 1e-4)) return
      const audio = audioRef.current
      if (!audio) return
      stopOneShotPlayback()
      oneShotEndRef.current = w.end
      audio.currentTime = w.start
      setOneShotPlayheadSec(w.start)
      void audio.play().catch(() => {
        stopOneShotPlayback()
      })

      const tick = (): void => {
        const el = audioRef.current
        const end = oneShotEndRef.current
        if (!el || end == null) {
          oneShotRafRef.current = null
          return
        }
        const t = el.currentTime
        setOneShotPlayheadSec(t)
        if (t >= end - 0.003 || el.paused) {
          el.pause()
          oneShotRafRef.current = null
          oneShotEndRef.current = null
          setOneShotPlayheadSec(null)
          setOneShotPlayheadPct(null)
          return
        }
        oneShotRafRef.current = requestAnimationFrame(tick)
      }
      oneShotRafRef.current = requestAnimationFrame(tick)
    }, [stopOneShotPlayback])

    useEffect(() => {
      const onKey = (e: KeyboardEvent): void => {
        if (e.code !== 'Space' || e.repeat) return
        if (activeLineIndexRef.current === null || activeWordIdRef.current === null) return
        const target = e.target as HTMLElement | null
        if (target?.closest('input,textarea,[contenteditable="true"]')) return
        e.preventDefault()
        e.stopPropagation()
        playSelectedWordOnce()
      }
      window.addEventListener('keydown', onKey, true)
      return () => window.removeEventListener('keydown', onKey, true)
    }, [playSelectedWordOnce])

    useEffect(() => {
      if (activeWordId === null) {
        stopOneShotPlayback()
      }
    }, [activeWordId, stopOneShotPlayback])

    useEffect(
      () => () => {
        stopOneShotPlayback()
      },
      [stopOneShotPlayback]
    )

    const confirmPendingCutRef = useRef<() => void>(() => undefined)

    const confirmPendingCut = useCallback(() => {
      const p = peaksRef.current
      const cutSeg = p?.segments
        .getSegments()
        .find((s) => String(s.id ?? '') === CUT_PREVIEW_SEGMENT_ID)
      let a: number
      let b: number
      if (cutSeg) {
        const n = normalizeCutRange(cutSeg.startTime, cutSeg.endTime)
        a = n.start
        b = n.end
      } else {
        const sel = cutSelectionRef.current
        if (!sel || sel.kind !== 'range') {
          timelineEditLog('cut-ui', 'confirmPendingCut 스킵 — range 선택 아님', { sel })
          return
        }
        const n = normalizeCutRange(sel.start, sel.end)
        a = n.start
        b = n.end
      }
      if (!(b - a > 0.001)) {
        timelineEditLog('cut-ui', 'confirmPendingCut 스킵 — 구간 너무 짧음', { a, b })
        return
      }
      const hasCb = typeof onTimeRangeCutRef.current === 'function'
      timelineEditLog('cut-ui', 'confirmPendingCut — 부모에 CUT 전달', {
        startSec: a,
        endSec: b,
        hasOnTimeRangeCut: hasCb
      })
      if (!hasCb) {
        wfLog('cut-ui', 'onTimeRangeCut 미연결 — App applyTimeRangeCut 호출 안 됨')
      }
      onTimeRangeCutRef.current?.(a, b)
      syncCutSelection(null)
      if (p) paintCutSelectionOverlay(p, null)
    }, [])

    useEffect(() => {
      confirmPendingCutRef.current = confirmPendingCut
    }, [confirmPendingCut])

    useEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady || activeLineIndex === null) return

      const handler = (evt: { time: number; evt: MouseEvent }): void => {
        if (activeToolRef.current !== 'cut') return
        const selfPeaks = peaksRef.current
        if (!selfPeaks) return

        let t = evt.time
        const dur = selfPeaks.player.getDuration()
        if (Number.isFinite(dur) && dur > 0) t = Math.max(0, Math.min(t, dur))
        else t = Math.max(0, t)
        if (!Number.isFinite(t)) return

        const sel = cutSelectionRef.current

        /** 1차 클릭만 ‘단어 블록 아닌 곳’ — 2차는 파형 전역에서 끝점 허용(안 그러면 단어로 파형이 가득할 때 구간 완성 불가·삭제 버튼 없음) */
        if (!sel && isTimeOnWordSegment(selfPeaks, t)) return

        if (sel?.kind === 'range') {
          /**
           * range 선택 취소는 pointerdown(바깥) + ESC 만 담당.
           * Peaks `zoomview.click` 의 time 은 드래그 직후 clientX 기반과 어긋나 ‘바깥 클릭’으로 오판해 선택이 즉시 날아가는 경우가 있다.
           */
          if (!evt.evt.shiftKey) return
          syncCutSelection({ kind: 'marker', time: t })
          queueMicrotask(() => {
            const pl = peaksRef.current
            if (pl) paintCutSelectionOverlay(pl, { kind: 'marker', time: t })
          })
          return
        }
        if (!sel) {
          syncCutSelection({ kind: 'marker', time: t })
          queueMicrotask(() => {
            const pl = peaksRef.current
            if (pl) paintCutSelectionOverlay(pl, { kind: 'marker', time: t })
          })
          return
        }
        if (sel.kind === 'marker') {
          const t0 = sel.time
          const { start, end } = normalizeCutRange(t0, t)
          if (end - start < 0.02) return
          syncCutSelection({ kind: 'range', start, end })
          queueMicrotask(() => {
            const pl = peaksRef.current
            if (pl) paintCutSelectionOverlay(pl, { kind: 'range', start, end })
          })
        }
      }

      peaks.on('zoomview.click', handler)
      return () => {
        peaks.off('zoomview.click', handler)
      }
    }, [peaksReady, activeLineIndex])

    useEffect(() => {
      const zoomEl = zoomRef.current
      if (!zoomEl) return

      const getTimeFromClientX = (clientX: number): number | null => {
        const p = peaksRef.current
        const zv = p?.views.getView('zoomview')
        if (!zv) return null
        const t0 = zv.getStartTime()
        const t1 = zv.getEndTime()
        if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0 + 1e-9) return null
        const r = zoomEl.getBoundingClientRect()
        const w = r.width
        if (!(w > 1)) return null
        const frac = clampPx((clientX - r.left) / w, 0, 1)
        const t = t0 + (t1 - t0) * frac
        return Number.isFinite(t) ? t : null
      }

      const onPointerDown = (e: PointerEvent): void => {
        if (activeToolRef.current !== 'cut') return
        if (e.button !== 0) return
        const t = getTimeFromClientX(e.clientX)
        if (t == null) return
        const sel = cutSelectionRef.current
        if (sel?.kind === 'range') {
          const a = Math.min(sel.start, sel.end)
          const b = Math.max(sel.start, sel.end)
          const eps = CUT_TIME_MATCH_EPS_SEC
          if (t < a - eps || t > b + eps) {
            syncCutSelection(null)
            const p = peaksRef.current
            if (p) paintCutSelectionOverlay(p, null)
          }
          return
        }
        cutDraggingRef.current = true
        cutDragRangeCommittedRef.current = false
        cutDragAnchorTimeRef.current = t
        syncCutSelection({ kind: 'marker', time: t })
        queueMicrotask(() => {
          const p = peaksRef.current
          if (p) paintCutSelectionOverlay(p, { kind: 'marker', time: t })
        })
      }

      const onPointerMove = (e: PointerEvent): void => {
        if (activeToolRef.current !== 'cut') return
        if (!cutDraggingRef.current) return
        const anchor = cutDragAnchorTimeRef.current
        if (anchor == null) return
        const t = getTimeFromClientX(e.clientX)
        if (t == null) return
        const { start, end } = normalizeCutRange(anchor, t)
        if (end - start < 0.005) return
        cutDragRangeCommittedRef.current = true
        syncCutSelection({ kind: 'range', start, end })
        queueMicrotask(() => {
          const p = peaksRef.current
          if (p) paintCutSelectionOverlay(p, { kind: 'range', start, end })
        })
      }

      const endDrag = (e: PointerEvent): void => {
        const wasDragging = cutDraggingRef.current
        const committedAtStart = cutDragRangeCommittedRef.current
        const anchor = cutDragAnchorTimeRef.current
        let committedRange = committedAtStart
        if (wasDragging && anchor != null && !committedRange) {
          const t = getTimeFromClientX(e.clientX)
          if (t != null) {
            const { start, end } = normalizeCutRange(anchor, t)
            if (end - start >= 0.005) {
              committedRange = true
              syncCutSelection({ kind: 'range', start, end })
              const p = peaksRef.current
              if (p) paintCutSelectionOverlay(p, { kind: 'range', start, end })
            }
          }
        }
        cutDraggingRef.current = false
        cutDragRangeCommittedRef.current = false
        cutDragAnchorTimeRef.current = null
      }

      zoomEl.addEventListener('pointerdown', onPointerDown)
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', endDrag, true)
      window.addEventListener('pointercancel', endDrag, true)
      return () => {
        zoomEl.removeEventListener('pointerdown', onPointerDown)
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', endDrag, true)
        window.removeEventListener('pointercancel', endDrag, true)
      }
    }, [peaksReady])

    useLayoutEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady) return
      const zv = peaks.views.getView('zoomview')
      const ov = peaks.views.getView('overview') as {
        enableSeek?: (e: boolean) => void
        setWaveformColor?: (color: string) => void
        setPlayedWaveformColor?: (color: string | null) => void
      } | null
      if (!zv) return
      try {
        /** scroll 모드 복귀를 막아 파형 드래그 이동을 고정 차단 */
        zv.setWaveformDragMode('insert-segment')
        zv.setWaveformColor('#aeb4b6')
        zv.setPlayedWaveformColor('#ffd54f')
        ov?.setWaveformColor?.('#aeb4b6')
        ov?.setPlayedWaveformColor?.('#ffd54f')
        zv.setWheelMode('none', { captureVerticalScroll: false })
        zv.enableAutoScroll(false)
        zv.enableSeek(activeTool === 'adjust')
        zv.enableMarkerEditing(activeTool === 'adjust' || activeTool === 'cut')
        zv.enableSegmentDragging(false)
        ov?.enableSeek?.(activeTool === 'adjust')
      } catch {
        /* ignore */
      }
    }, [activeTool, peaksReady, mountLayoutKey])

    /** 줌 refit / batchDraw 직후에도 CUT 미리보기가 세그먼트 스택에서 밀리지 않도록 매 레이아웃에서 재적용 */
    useLayoutEffect(() => {
      const p = peaksRef.current
      if (!p || !peaksReady || activeTool !== 'cut') return
      paintCutSelectionOverlay(p, cutSelectionRef.current)
      try {
        const zv = p.views.getView('zoomview') as unknown as { getStage?: () => { batchDraw?: () => void } }
        zv?.getStage?.()?.batchDraw?.()
      } catch {
        /* ignore */
      }
    }, [peaksReady, activeTool, cutSelection, mountLayoutKey])

    useEffect(() => {
      if (cutSelection?.kind !== 'range') return
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
          syncCutSelection(null)
          const p = peaksRef.current
          if (p) paintCutSelectionOverlay(p, null)
          return
        }
        if (e.key === 'Delete') {
          e.preventDefault()
          confirmPendingCutRef.current()
        }
      }
      window.addEventListener('keydown', onKey, true)
      return () => window.removeEventListener('keydown', onKey, true)
    }, [cutSelection])

    const [cutDeleteBarLayout, setCutDeleteBarLayout] = useState<{
      top: number
      /** 뷰포트 X — 선택 구간의 화면상 가로 중앙 (줌뷰 시간축과 동일 매핑) */
      centerX: number
    } | null>(null)

    const updateCutDeleteBarLayout = useCallback((): void => {
      const el = zoomRef.current
      const sel = cutSelectionRef.current
      if (!el?.isConnected || !sel || sel.kind !== 'range') {
        setCutDeleteBarLayout(null)
        return
      }
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) {
        setCutDeleteBarLayout(null)
        return
      }
      const top = r.bottom + 8
      const plotLeft = r.left
      const plotRight = r.left + r.width
      const peaks = peaksRef.current
      const cutSeg = peaks?.segments
        .getSegments()
        .find((s) => String(s.id ?? '') === CUT_PREVIEW_SEGMENT_ID)
      const a = cutSeg
        ? Math.min(cutSeg.startTime, cutSeg.endTime)
        : Math.min(sel.start, sel.end)
      const b = cutSeg
        ? Math.max(cutSeg.startTime, cutSeg.endTime)
        : Math.max(sel.start, sel.end)
      const zv = peaks?.views.getView('zoomview')
      let centerX = plotLeft + r.width / 2
      if (zv) {
        const t0 = zv.getStartTime()
        const t1 = zv.getEndTime()
        const span = t1 - t0
        if (span > 1e-9) {
          const xAt = (t: number) => plotLeft + ((t - t0) / span) * r.width
          const xl = clampPx(Math.min(xAt(a), xAt(b)), plotLeft, plotRight)
          const xr = clampPx(Math.max(xAt(a), xAt(b)), plotLeft, plotRight)
          centerX = (xl + xr) / 2
        }
      }
      setCutDeleteBarLayout({ top, centerX })
    }, [])

    useLayoutEffect(() => {
      if (cutSelection?.kind !== 'range') {
        setCutDeleteBarLayout(null)
        return
      }
      updateCutDeleteBarLayout()
      const rafIds: number[] = []
      const chain = (remaining: number): void => {
        updateCutDeleteBarLayout()
        if (remaining > 0) {
          rafIds.push(requestAnimationFrame(() => chain(remaining - 1)))
        }
      }
      rafIds.push(requestAnimationFrame(() => chain(4)))
      const el = zoomRef.current
      const ro =
        el && typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(() => {
              updateCutDeleteBarLayout()
            })
          : null
      if (el && ro) ro.observe(el)
      const onWin = (): void => {
        updateCutDeleteBarLayout()
      }
      window.addEventListener('resize', onWin)
      window.addEventListener('scroll', onWin, true)
      return () => {
        for (const id of rafIds) cancelAnimationFrame(id)
        window.removeEventListener('resize', onWin)
        window.removeEventListener('scroll', onWin, true)
        ro?.disconnect()
      }
    }, [cutSelection, mountLayoutKey, peaksReady, hostReady, updateCutDeleteBarLayout])

    useEffect(() => {
      const t = oneShotPlayheadSec
      const peaks = peaksRef.current
      const zv = peaks?.views.getView('zoomview')
      if (t == null || !zv) {
        setOneShotPlayheadPct(null)
        return
      }
      const t0 = zv.getStartTime()
      const t1 = zv.getEndTime()
      const span = t1 - t0
      if (!(span > 1e-9)) {
        setOneShotPlayheadPct(null)
        return
      }
      const pct = ((t - t0) / span) * 100
      if (!Number.isFinite(pct)) {
        setOneShotPlayheadPct(null)
        return
      }
      setOneShotPlayheadPct(clampPx(pct, 0, 100))
    }, [oneShotPlayheadSec, peaksReady, mountLayoutKey])

    useEffect(() => {
      if (cutSelection?.kind !== 'range') return
      const peaks = peaksRef.current
      if (!peaks || !peaksReady) return
      const onZ = (): void => {
        updateCutDeleteBarLayout()
        if (activeToolRef.current === 'cut') {
          paintCutSelectionOverlay(peaks, cutSelectionRef.current)
          try {
            const zv = peaks.views.getView('zoomview') as unknown as {
              getStage?: () => { batchDraw?: () => void }
            }
            zv?.getStage?.()?.batchDraw?.()
          } catch {
            /* ignore */
          }
        }
      }
      peaks.on('zoomview.update', onZ)
      return () => {
        peaks.off('zoomview.update', onZ)
      }
    }, [cutSelection, peaksReady, updateCutDeleteBarLayout])

    const waveformPortal =
      portalHost &&
      createPortal(
        <div className="subtitle-waveform-flow-root relative w-full min-w-0">
          <div className="subtitle-waveform-stack flex w-full min-w-0 flex-col px-0 pb-0 pt-0">
            {activeLineIndex !== null ? (
              <div className="flex w-full flex-wrap items-center gap-2 border-x-0 border-b border-white/[0.08] bg-[#0c1018]/95 px-2 py-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-white/50">파형 도구</span>
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    activeTool === 'cut'
                      ? 'bg-white/15 text-white ring-1 ring-white/30'
                      : 'bg-white/5 text-white/80 hover:bg-white/10'
                  }`}
                  onClick={() => setActiveTool((v) => (v === 'cut' ? null : 'cut'))}
                >
                  자르기 (CUT)
                </button>
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    activeTool === 'adjust'
                      ? 'bg-white/15 text-white ring-1 ring-white/30'
                      : 'bg-white/5 text-white/80 hover:bg-white/10'
                  }`}
                  onClick={() => setActiveTool((v) => (v === 'adjust' ? null : 'adjust'))}
                >
                  길이 조절 (ADJUST)
                </button>
              </div>
            ) : null}
            <div className="relative isolate h-72 w-full min-w-0 overflow-hidden rounded-lg border-x-0 border-y border-vrew-border bg-[#0c1018]">
              <div
                ref={zoomRef}
                className={`relative z-0 h-72 w-full min-w-0 ${
                  activeTool === 'cut' ? 'cursor-crosshair' : activeTool === 'adjust' ? 'cursor-ew-resize' : ''
                }`}
              />
              {zoomEndClipPx > 0.5 ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 right-0 z-[5]"
                  style={{
                    width: zoomEndClipPx,
                    backgroundColor: '#0c1018'
                  }}
                />
              ) : null}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-[100] transform-gpu"
                style={{ transform: 'translateZ(0.02px)' }}
              >
                {oneShotPlayheadPct != null ? (
                  <div
                    className="absolute inset-y-0 w-px bg-yellow-300/95"
                    style={{ left: `${oneShotPlayheadPct}%` }}
                  />
                ) : null}
              </div>
            </div>
            {/**
             * Peaks.init 은 overview 컨테이너에 높이가 있어야 함(h=0 이면 영원히 대기 후 포기).
             * 단어 편집 중에는 보이지 않게만 하고(h 유지) opacity 로 숨긴다.
             */}
            <div
              ref={overviewRef}
              className={`${
                activeLineIndex !== null && activeWordId !== null
                  ? 'h-10 min-h-[2.5rem] pointer-events-none border-y-0 border-x-0 opacity-0'
                  : 'h-24'
              } w-full min-w-0 shrink-0 overflow-hidden rounded-lg border-x-0 border-y border-vrew-border bg-[#0c1018]`}
              aria-hidden={activeLineIndex !== null && activeWordId !== null}
            />
          </div>
        </div>,
        portalHost
      )

    /**
     * 삭제 CTA — body 포털로 overflow 를 피함.
     * 버튼은 전체 파형 중앙이 아니라, CUT 로 고른 시간 구간이 줌뷰에서 차지하는 가로 구간의 중앙 아래에 둔다.
     * 줌 박스 측정 실패 시에만 화면 하단 폴백.
     */
    const cutDeletePortal =
      cutSelection?.kind === 'range' && typeof document !== 'undefined'
        ? createPortal(
            <div
              data-waveform-app-portal="1"
              className="pointer-events-auto flex justify-center px-2"
              style={
                cutDeleteBarLayout
                  ? {
                      position: 'fixed',
                      left: cutDeleteBarLayout.centerX,
                      top: cutDeleteBarLayout.top,
                      transform: 'translateX(-50%)',
                      zIndex: 2147483646
                    }
                  : {
                      position: 'fixed',
                      left: 0,
                      right: 0,
                      bottom: 'max(1.25rem, env(safe-area-inset-bottom, 0px))',
                      zIndex: 2147483646,
                      paddingLeft: 16,
                      paddingRight: 16
                    }
              }
            >
              <button
                type="button"
                className="rounded-lg bg-red-600 px-6 py-2.5 text-sm font-bold text-white shadow-2xl shadow-black/70 ring-2 ring-white/40 hover:bg-red-500"
                onClick={() => confirmPendingCut()}
              >
                선택 구간 삭제
              </button>
            </div>,
            document.body
          )
        : null

    return (
      <>
        <audio ref={audioRef} preload="auto" className="hidden" controls={false} />
        {waveformPortal}
        {cutDeletePortal}
        <WaveformWordConnector
          activeLineIndex={activeLineIndex}
          peaksRef={peaksRef}
          zoomRef={zoomRef}
          peaksReady={peaksReady}
          overlayVisible={activeLineIndex !== null}
          layoutKey={mountLayoutKey}
        />
      </>
    )
  }
)
