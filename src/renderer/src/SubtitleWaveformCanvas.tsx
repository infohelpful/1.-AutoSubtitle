/**
 * 펼친 줄 파형 패널 — Peaks.js 없이 Canvas 로만 그린다.
 * (구 SubtitleWaveformPeaks 의 시각화 경로 대체; 세그먼트 드래그·컷 마커 등은 Word 패널·후속 작업으로 이전 가능)
 */
import { createPortal } from 'react-dom'
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react'
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { JsonWaveformData } from '../../shared/waveformJson'
import type { SubtitleLine } from '../../shared/subtitles'
import { storageWordIndexFromVisibleNonDeletedIndex } from '../../shared/subtitles'
import type { EdgeDragResult } from '../../shared/subtitleWordEdgeDrag'
import type { SubtitleRow, Word } from './components/vrewPeaksEditor/types'
import { wfLog } from './components/vrewPeaksEditor/waveformDebugLog'
import {
  computeLineZoomWindow,
  computeLineZoomWindowFromCardBounds,
  computeWordContextWindow
} from './lineZoomWindow'
import { WaveformWordConnector, type PeaksConnectorLike } from './WaveformWordConnector'
import type { CutRange } from '../../shared/ipc'
import { mergeCutRanges } from '../../shared/timelineCollapse'
import { cutRangesSignature, exactTimelineDurationSecFromWaveformJson } from './timeline/stitchWaveformJson'
import { resolvePeaksTimelineMetrics } from './waveform/peakPixelMapping'
import {
  collectDeletedRangesSec,
  drawWaveformCanvas,
  type WaveformFillBand
} from './waveform/waveformCanvasDrawing'
import { useWaveformViewWindow } from './waveform/useWaveformViewWindow'
import { useWordEdgeDrag } from './useWordEdgeDrag'

export type SubtitleWaveformPeaksHandle = {
  onWaveMountDirty: () => void
  syncPlayheadFromEditSec: (editSec: number) => void
}

export type PeaksZoomViewRange = {
  lineIndex: number
  windowStart: number
  windowEnd: number
}

/** 파형 트림 핸들 → `SentenceTokenTimeline` 경유 단어 시각 SSOT 갱신 (`useWordEdgeDrag`) */
export type WordEdgeSubtitleBridge = {
  getSubtitleLines: () => readonly SubtitleLine[]
  onSubtitleLinesCommit: (lines: SubtitleLine[]) => void
  /** 드래그 중 미리보기 — undo 스택 없이 SSOT 만 갱신 */
  onSubtitleLinesPreview?: (lines: SubtitleLine[]) => void
  /** 캔슬 시 드래그 시작 스냅샷으로 복원 */
  onSubtitleLinesRevert?: (snapshot: SubtitleLine[]) => void
  editSecToMediaSec: (editSec: number) => number
  mediaSecToEditSec: (mediaSec: number) => number
}

export type SubtitleWaveformPeaksProps = {
  rows: SubtitleRow[]
  onRowsChange: (next: SubtitleRow[]) => void
  audioUrl?: string
  localMediaPath?: string | null
  precomputedPeaksJsonFileUrl?: string | null
  precomputedWaveformJson: JsonWaveformData
  precomputedWaveformIsEditAxis?: boolean
  playheadProgramToPeaksSec?: (programSec: number) => number
  waveMountByLineRef: MutableRefObject<Map<number, HTMLDivElement>>
  activeLineIndex: number | null
  activeWordId: string | null
  waveformCardBounds: { start: number; end: number } | null
  cutRanges: CutRange[]
  onZoomViewRange?: (range: PeaksZoomViewRange | null) => void
  onTimeRangeCut?: (startSec: number, endSec: number) => void
  /**
   * 자르기 라인 위치에서 활성 단어를 두 개로 분할 (편집축 초 기준).
   * `wordIndexInVrew` 는 vrew 화면 인덱스(=가시 단어 중 N번째). 호출부(App) 가
   * `mapEditToMediaSec` 로 미디어 축 변환 후 단어 [start, end] 안에서만 적용한다.
   */
  onSplitActiveWordAtEditSec?: (
    lineIndex: number,
    wordIndexInVrew: number,
    splitEditSec: number
  ) => void
  onPlayEditRange?: (
    startSec: number,
    endSec: number,
    meta?: { wordId?: string | null; wordText?: string | null; lineIndex?: number | null }
  ) => void
  /** 재생 일시정지 — 파형 패널의 ▶ 버튼·Space 토글에서 사용 */
  onPausePlayback?: () => void
  playheadEditSecRef?: MutableRefObject<number>
  isPlaying?: boolean
  suppressAutoFocusSeek?: boolean
  autoFocusSeekBlockToken?: number
  mediaDurationSec?: number
  onPeaksDurationComparedToMedia?: (info: {
    peaksDurationSec: number
    mediaDurationSec: number | undefined
    deltaSec: number | null
    exactTimelineDurationSec?: number | null
  }) => void
  /** 파형 아래 되돌리기 — 자막 편집 undo */
  onUndo?: () => void
  /** 핸들 위 시간 라벨 */
  formatEditSec?: (sec: number) => string
  /**
   * 단어 좌·우 트림 핸들을 `applyWordEdgeDrag` 에 연결할 때만 지정.
   * `gapFill` Vrew 행과는 저장소 인덱스가 어긋날 수 있어 비활성화하는 편이 안전하다.
   */
  wordEdgeSubtitleBridge?: WordEdgeSubtitleBridge | null
}

function clampPx(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

const MIN_TRIM_SPAN_SEC = 0.038

const EMPTY_SUBTITLE_LINES: readonly SubtitleLine[] = []

/** 커넥터용 — Peaks 세그먼트 없음 */
const peaksStubRef: { current: PeaksConnectorLike | null } = { current: null }

/**
 * `React.memo` 로 래핑 — Undo/Redo 처럼 `precomputedWaveformJson` 이 **이전 reference** 와 같으면
 * (LRU exact hit) 전체 컴포넌트 트리 re-render 와 내부 16개 effect 재발화를 건너뛴다.
 *
 * 새 삭제로 `stitchedWaveformJsonComputed` reference 가 매번 변하는 경우엔 memo 가 skip 못해도,
 * 다른 자식(`SubtitleVirtualList` 등) 변경으로 인한 부모 re-render 에서 stitched 가 그대로면 skip 한다.
 */
const SubtitleWaveformPeaksImpl = forwardRef<SubtitleWaveformPeaksHandle, SubtitleWaveformPeaksProps>(
  function SubtitleWaveformCanvas(
    {
      rows,
      onRowsChange: _onRowsChange,
      precomputedWaveformJson,
      precomputedWaveformIsEditAxis = false,
      playheadProgramToPeaksSec,
      waveMountByLineRef,
      activeLineIndex,
      activeWordId,
      waveformCardBounds,
      cutRanges,
      onZoomViewRange,
      onTimeRangeCut: _onTimeRangeCut,
      onSplitActiveWordAtEditSec,
      onPlayEditRange,
      onPausePlayback,
      playheadEditSecRef,
      isPlaying,
      suppressAutoFocusSeek: _suppressAutoFocusSeek,
      autoFocusSeekBlockToken: _autoFocusSeekBlockToken,
      mediaDurationSec: mediaDurationSecProp,
      onPeaksDurationComparedToMedia,
      onUndo,
      formatEditSec,
      wordEdgeSubtitleBridge
    },
    ref
  ) {
    void _onRowsChange
    void _suppressAutoFocusSeek
    void _autoFocusSeekBlockToken
    void _onTimeRangeCut

    const fmtSec =
      typeof formatEditSec === 'function'
        ? formatEditSec
        : (sec: number) => (Number.isFinite(sec) ? sec.toFixed(3) : '—')

    const mergedCutRanges = useMemo(() => mergeCutRanges([...cutRanges]), [cutRanges])
    const cutDiagSig = useMemo(() => cutRangesSignature(mergedCutRanges), [mergedCutRanges])

    const zoomCanvasRef = useRef<HTMLCanvasElement>(null)
    const zoomOuterRef = useRef<HTMLDivElement | null>(null)
    const playheadLineRef = useRef<HTMLDivElement | null>(null)
    /** App 의 setPeaksZoomViewRange 가 매번 새 객체로 재렌더 → 자식·ref 연쇄 — 동일 구간은 통과 금지 */
    const lastPublishedZoomSigRef = useRef<string | null>(null)

    const [portalRev, setPortalRev] = useState(0)
    const bumpPortal = useCallback(() => setPortalRev((n) => n + 1), [])
    const [portalHost, setPortalHost] = useState<HTMLElement | null>(null)
    /**
     * `portalHost`(파형 마운트) 의 가장 가까운 `<article>` 조상 — 활성 단어 칩과
     * 파형 박스가 모두 들어 있는 단어카드 루트. 커넥터 SVG 의 포털 대상.
     */
    const [articleEl, setArticleEl] = useState<HTMLElement | null>(null)
    /**
     * 활성 단어 칩 → 파형 트림 라인 두 끝점을 잇는 SVG 좌표.
     * `<article>` 로컬 좌표계로 저장 → 카드(article) 위에 그대로 덮어 그릴 수 있다.
     */
    const [connectorGeom, setConnectorGeom] = useState<{
      svgW: number
      svgH: number
      fromL: { x: number; y: number }
      fromR: { x: number; y: number }
      toL: { x: number; y: number }
      toR: { x: number; y: number }
    } | null>(null)
    /** 좌·우 단어 경계 넘김 시 한 단어씩 뷰 확장 */
    const [expandL, setExpandL] = useState(0)
    const [expandR, setExpandR] = useState(0)
    /** 재생·컷에 쓰는 트림 구간(편집 축 초) */
    const [editRange, setEditRange] = useState<{ start: number; end: number } | null>(null)
    /** 자르기·재생 시작 라인 (편집축 초) — 항상 `editRange` 안에서만 이동 */
    const [cutSec, setCutSec] = useState<number | null>(null)
    /**
     * 현재 드래그 중인 라인 — 드래그 중인 라인은 뒷쪽 파형이 보이도록 거의 투명하게 표시.
     * (사용자가 길이/자르기 위치를 조절하면서 막대 모양을 시각적으로 확인할 수 있게 함)
     */
    const [draggingHandle, setDraggingHandle] = useState<
      'trimStart' | 'trimEnd' | 'cut' | null
    >(null)
    /**
     * 트림 핸들이 이웃 단어의 끝점에 닿아 *흡수 commit 직전* 상태일 때만 'start'/'end' 로 셋팅.
     *  - 'start' : 왼쪽 핸들이 prev.start 에 도달 — 마우스를 떼면 prev 가 흡수됨.
     *  - 'end' : 오른쪽 핸들이 next.end 에 도달 — 마우스를 떼면 next 가 흡수됨.
     *  - null : 한계 도달 아님.
     * UI 가 핸들 색을 빨갛게 바꿔 사용자에게 "여기서 떼면 통째 합쳐진다" 를 알려준다.
     */
    const [handleAtLimit, setHandleAtLimit] = useState<'start' | 'end' | null>(null)
    /** 한 번의 드래그에서 좌·우로 단어 경계 넘김 확장 시도 횟수(대부분 1회면 충분) */
    const expandLeftTokensRef = useRef(4)
    const expandRightTokensRef = useRef(4)

    const rowsRef = useRef(rows)
    rowsRef.current = rows
    const activeLineIndexRef = useRef(activeLineIndex)
    activeLineIndexRef.current = activeLineIndex
    const activeWordIdRef = useRef(activeWordId)
    activeWordIdRef.current = activeWordId
    const isPlayingWaveRef = useRef(false)
    isPlayingWaveRef.current = Boolean(isPlaying)
    const mediaHint = mediaDurationSecProp != null && mediaDurationSecProp > 0 ? mediaDurationSecProp : undefined
    const metrics = useMemo(
      () => resolvePeaksTimelineMetrics(precomputedWaveformJson, mediaHint),
      [precomputedWaveformJson, mediaHint]
    )

    const { viewWin, setViewWin, viewWinRef } = useWaveformViewWindow(metrics, zoomOuterRef)

    const durExact = useMemo(
      () => exactTimelineDurationSecFromWaveformJson(precomputedWaveformJson, mediaHint),
      [precomputedWaveformJson, mediaHint]
    )

    /** `rows` 배열 참조만 바뀌면 layoutInitViewWin 이 매 렌더 돌아 setState 연쇄 — 활성 줄 단어 시그니처만 추적 */
    const activeRowTimesSig = useMemo((): string => {
      if (activeLineIndex == null) return ''
      const r = rows[activeLineIndex]
      if (!r?.words?.length) return `${activeLineIndex}|empty`
      return `${activeLineIndex}|${r.words.map((w) => `${w.id}:${w.start}:${w.end}`).join(';')}`
    }, [rows, activeLineIndex])

    const cardBoundsSig = useMemo((): string => {
      if (waveformCardBounds == null) return ''
      return `${waveformCardBounds.start}|${waveformCardBounds.end}`
    }, [waveformCardBounds])

    const metricsDurationKey = metrics != null ? metrics.durationSec.toFixed(8) : ''

    useEffect(() => {
      lastPublishedZoomSigRef.current = null
    }, [activeLineIndex])

    const publishZoom = useCallback(() => {
      const cb = onZoomViewRange
      const li = activeLineIndexRef.current
      const vw = viewWinRef.current
      if (!cb) return
      if (li === null || !vw || !(vw.end > vw.start + 1e-9)) {
        const sig = '__null__'
        if (lastPublishedZoomSigRef.current === sig) return
        lastPublishedZoomSigRef.current = sig
        cb(null)
        return
      }
      const sig = `${li}|${vw.start.toFixed(6)}|${vw.end.toFixed(6)}`
      if (lastPublishedZoomSigRef.current === sig) return
      lastPublishedZoomSigRef.current = sig
      cb({ lineIndex: li, windowStart: vw.start, windowEnd: vw.end })
    }, [onZoomViewRange])

    /**
     * 마지막으로 viewWin 을 *재계산* 한 키 — `activeLineIndex|가시단어슬롯|expandL|expandR`.
     * 자르기 직후 `activeWordId` 만 바뀌고(좌측 조각의 새 id) **같은 슬롯**이면 키가 동일해
     *  `computeWordContextWindow` 를 다시 돌리지 않아 파형 뷰가 튀지 않는다.
     */
    const lastViewKeyRef = useRef<string | null>(null)

    /** 활성 단어 ±이웃 중심 줌(확장 시 한 단어씩) — 선택 없을 때만 전체 줄 폴백 */
    useLayoutEffect(() => {
      /**
       * **트림 드래그 중에는 viewWin 을 고정** — 미리보기에서 `setViewWin` 을 호출하지 않지만,
       *  `editRange`/rows 가 바뀌며 이 effect 가 매 프레임 돌면 `computeWordContextWindow` 가
       *  줌을 다시 잡아 파형이 “존나 확대” 되는 현상이 난다. 트림 중에는 기존 viewWin 유지,
       *  손을 떼면 `draggingHandle` 해제 후 여기서 통상 정책으로 한 번 복구한다.
       */
      if (draggingHandle === 'trimStart' || draggingHandle === 'trimEnd') return

      if (activeLineIndex === null || !metrics) {
        setViewWin(null)
        lastViewKeyRef.current = null
        return
      }
      const row = rowsRef.current[activeLineIndex]
      const words = row?.words ?? []
      const wid = activeWordIdRef.current
      const wi = wid ? words.findIndex((x) => x.id === wid) : -1
      const key = `${activeLineIndex}|${wi}|${expandL}|${expandR}`
      if (key === lastViewKeyRef.current && viewWinRef.current) return
      /**
       * **stale id 보호** — split 직후처럼 부모가 activeWordId 를 새 조각으로 옮기기 전 한 프레임,
       *  자식 effect 가 `wi === -1` 상태에서 먼저 돌아 전체 라인 폴백 뷰로 빠지면서 파형이 “휙” 튀어 보인다.
       *  그 짧은 transient 동안 기존 viewWin 을 그대로 유지하고 lastViewKey 도 업데이트하지 않는다.
       *  다음 렌더에서 새 id 가 도착하면 정상적으로 재계산.
       */
      if (wid && wi < 0 && viewWinRef.current) return
      lastViewKeyRef.current = key

      const mediaCap = metrics.durationSec

      if (wi >= 0 && words.length > 0 && wid) {
        const ctx = computeWordContextWindow(words, wi, expandL, expandR, {
          mediaDurationSec: mediaCap
        })
        if (ctx) {
          const ns = ctx.windowStart
          const ne = ctx.windowEnd
          setViewWin((prev) => {
            if (
              prev != null &&
              Math.abs(prev.start - ns) < 1e-5 &&
              Math.abs(prev.end - ne) < 1e-5
            ) {
              return prev
            }
            return { start: ns, end: ne }
          })
          return
        }
      }

      const win =
        waveformCardBounds != null
          ? computeLineZoomWindowFromCardBounds(waveformCardBounds.start, waveformCardBounds.end, {
              mediaDurationSec: mediaCap,
              clipTrailingToLineEnd: true,
              clipLeadingToLineStart: true
            })
          : row?.words?.length
            ? computeLineZoomWindow(row.words, {
                mediaDurationSec: mediaCap,
                clipTrailingToLineEnd: true,
                clipLeadingToLineStart: true
              })
            : null
      if (!win) return
      const ns = win.windowStart
      const ne = win.windowEnd
      setViewWin((prev) => {
        if (
          prev != null &&
          Math.abs(prev.start - ns) < 1e-5 &&
          Math.abs(prev.end - ne) < 1e-5
        ) {
          return prev
        }
        return { start: ns, end: ne }
      })
    }, [
      activeLineIndex,
      metrics,
      metricsDurationKey,
      cardBoundsSig,
      activeRowTimesSig,
      expandL,
      expandR,
      activeWordId,
      draggingHandle
    ])

    useEffect(() => {
      publishZoom()
    }, [publishZoom, viewWin, activeLineIndex])

    /** 줌 해제는 publishZoom 한 경로만 — 별도 effect 로 onZoomViewRange(null) 하면 부모 이중 setState·연쇄 렌더 유발 */

    useLayoutEffect(() => {
      void portalRev
      if (activeLineIndex === null) {
        setPortalHost(null)
        return
      }
      const el = waveMountByLineRef.current.get(activeLineIndex)
      const host = el && el.isConnected ? el : null
      setPortalHost(host)
    }, [activeLineIndex, portalRev, waveMountByLineRef])

    /** 마운트의 가장 가까운 `<article>` 조상 — 단어카드 루트(`position: relative`) 를 포털 대상으로 사용 */
    useLayoutEffect(() => {
      if (!portalHost) {
        setArticleEl(null)
        return
      }
      let cur: HTMLElement | null = portalHost
      while (cur && cur.tagName.toLowerCase() !== 'article') {
        cur = cur.parentElement
      }
      setArticleEl(cur)
    }, [portalHost])

    /** 마운트 크기 변화 시 포털 재타깅 — 무제한 bumpPortal 은 ResizeObserver ↔ 렌더 재귀로 Maximum update depth 유발 */
    useLayoutEffect(() => {
      if (activeLineIndex === null) return
      const el = waveMountByLineRef.current.get(activeLineIndex)
      if (!el) return
      let lastW = -1
      let lastH = -1
      let rafPending = 0
      const scheduleBump = (): void => {
        if (rafPending) cancelAnimationFrame(rafPending)
        rafPending = requestAnimationFrame(() => {
          rafPending = 0
          bumpPortal()
        })
      }
      const ro = new ResizeObserver((entries) => {
        const cr = entries[0]?.contentRect
        const w = cr?.width ?? 0
        const h = cr?.height ?? 0
        if (lastW >= 0 && Math.abs(w - lastW) < 0.75 && Math.abs(h - lastH) < 0.75) {
          return
        }
        lastW = w
        lastH = h
        scheduleBump()
      })
      ro.observe(el)
      return () => {
        ro.disconnect()
        if (rafPending !== 0) cancelAnimationFrame(rafPending)
      }
    }, [activeLineIndex, bumpPortal, waveMountByLineRef])

    const mountLayoutKey = `${portalRev}|${activeLineIndex}|${portalHost ? '1' : '0'}`
    const wordConnectorLayoutKey = `${mountLayoutKey}|${cutDiagSig}|canvas`

    const activeWords = useMemo((): Word[] => {
      if (activeLineIndex == null) return []
      return rows[activeLineIndex]?.words ?? []
    }, [rows, activeLineIndex])

    const activeWordSpan = useMemo(() => {
      if (activeWords.length === 0 || activeWordId == null) return null
      const w = activeWords.find((x) => x.id === activeWordId)
      if (!w) return null
      return { start: w.start, end: w.end }
    }, [activeWords, activeWordId])

    const centerWordIndex = useMemo(() => {
      if (!activeWordId) return -1
      return activeWords.findIndex((w) => w.id === activeWordId)
    }, [activeWords, activeWordId])

    const centerWordIndexRef = useRef(centerWordIndex)
    centerWordIndexRef.current = centerWordIndex

    const wordEdgeBridgeRef = useRef(wordEdgeSubtitleBridge)
    wordEdgeBridgeRef.current = wordEdgeSubtitleBridge

    const contextClampLimits = useMemo(() => {
      if (centerWordIndex < 0 || activeWords.length === 0) return null
      const li = Math.max(0, centerWordIndex - 1 - expandL)
      const ri = Math.min(activeWords.length - 1, centerWordIndex + 1 + expandR)
      let lo = Infinity
      let hi = -Infinity
      for (let i = li; i <= ri; i++) {
        const w = activeWords[i]!
        lo = Math.min(lo, w.start, w.end)
        hi = Math.max(hi, w.start, w.end)
      }
      if (!(hi > lo + 1e-9)) return null
      return { lo, hi }
    }, [activeWords, centerWordIndex, expandL, expandR])

    const waveFillBands = useMemo((): WaveformFillBand[] | null => {
      if (centerWordIndex < 0 || !viewWin || !editRange) return null
      const ws = Math.min(viewWin.start, viewWin.end)
      const we = Math.max(viewWin.start, viewWin.end)
      const bands: WaveformFillBand[] = []
      if (centerWordIndex > 0) {
        const nw = activeWords[centerWordIndex - 1]!
        const a = Math.min(nw.start, nw.end)
        const b = Math.max(nw.start, nw.end)
        if (b > ws + 1e-9 && a < we - 1e-9) {
          bands.push({ start: Math.max(ws, a), end: Math.min(we, b), kind: 'neighbor' })
        }
      }
      if (centerWordIndex < activeWords.length - 1) {
        const nw = activeWords[centerWordIndex + 1]!
        const a = Math.min(nw.start, nw.end)
        const b = Math.max(nw.start, nw.end)
        if (b > ws + 1e-9 && a < we - 1e-9) {
          bands.push({ start: Math.max(ws, a), end: Math.min(we, b), kind: 'neighbor' })
        }
      }
      const es = Math.min(editRange.start, editRange.end)
      const ee = Math.max(editRange.start, editRange.end)
      bands.push({
        start: Math.max(ws, es),
        end: Math.min(we, ee),
        kind: 'selection'
      })
      return bands
    }, [centerWordIndex, viewWin, editRange, activeWords])

    /**
     * 다른 줄·단어 선택 시, **그리고 자르기로 활성 단어의 시간이 바뀐 직후** 트림 범위를 새 단어로 재설정.
     *
     * 자르기(`splitWordAtEditSecFromWaveform`)는 동일 `wordId` 를 좌·우 두 단어가 공유하게 만들어
     * `activeWordId` / `centerWordIndex` 가 그대로 유지된다. 그러면 옛 의존성 배열
     * `[activeLineIndex, activeWordId, centerWordIndex]` 만으로는 effect 가 실행되지 않아
     * `editRange` 가 분할 전 폭에 남아 “파형은 갱신 안 된 것처럼” 보인다.
     *
     * `activeWordSpan` 의 start/end 가 바뀔 때(분할로 좌측 반쪽이 됨)도 다시 잡아 준다.
     */
    const activeWordSpanSig =
      activeWordSpan != null ? `${activeWordSpan.start}:${activeWordSpan.end}` : null
    useEffect(() => {
      /**
       * **stale id 보호** — split 직후처럼 activeWordId 가 새 행 배열에 아직 없는 transient 동안에는
       *  editRange/expand 를 비우지 않고 그대로 둔다. 다음 렌더에 부모가 새 id 로 갱신하면
       *  centerWordIndex 가 다시 유효해져 이 effect 가 정상 경로로 들어간다.
       */
      if (activeLineIndex == null || !activeWordId) {
        setEditRange(null)
        setExpandL(0)
        setExpandR(0)
        return
      }
      if (centerWordIndex < 0) {
        // stale: 다음 렌더 기다림 — 기존 editRange/expand 유지
        return
      }
      const w = rowsRef.current[activeLineIndex]?.words?.[centerWordIndex]
      if (!w) return
      const lo = Math.min(w.start, w.end)
      const hi = Math.max(w.start, w.end)
      setEditRange({ start: lo, end: hi })
      setExpandL(0)
      setExpandR(0)
    }, [activeLineIndex, activeWordId, centerWordIndex, activeWordSpanSig])

    /** 타임코드·외부 편집으로 단어 경계가 바뀌면 트림만 클램프 */
    useEffect(() => {
      if (!editRange || !contextClampLimits) return
      const { lo, hi } = contextClampLimits
      setEditRange((er) => {
        if (!er) return er
        let s = Math.min(er.start, er.end)
        let e = Math.max(er.start, er.end)
        s = clampPx(s, lo, hi)
        e = clampPx(e, lo, hi)
        if (e < s + MIN_TRIM_SPAN_SEC) {
          e = Math.min(hi, s + MIN_TRIM_SPAN_SEC)
          s = Math.max(lo, e - MIN_TRIM_SPAN_SEC)
        }
        if (Math.abs(s - Math.min(er.start, er.end)) < 1e-6 && Math.abs(e - Math.max(er.start, er.end)) < 1e-6) {
          return er
        }
        return { start: s, end: e }
      })
    }, [activeRowTimesSig, contextClampLimits])

    const editRangeRef = useRef(editRange)
    editRangeRef.current = editRange
    const contextClampLimitsRef = useRef(contextClampLimits)
    contextClampLimitsRef.current = contextClampLimits
    const pointerToTimeOnStrip = useCallback((clientX: number): number => {
      const outer = zoomOuterRef.current
      const vw = viewWinRef.current
      if (!outer || !vw) return 0
      const rect = outer.getBoundingClientRect()
      const fr = clampPx((clientX - rect.left) / Math.max(rect.width, 1), 0, 1)
      const a = Math.min(vw.start, vw.end)
      const b = Math.max(vw.start, vw.end)
      return a + fr * (b - a)
    }, [])

    const getSubtitleLinesStable = useCallback(
      () => wordEdgeBridgeRef.current?.getSubtitleLines() ?? EMPTY_SUBTITLE_LINES,
      []
    )

    const mediaSecAtPointerX = useCallback(
      (clientX: number) => {
        const b = wordEdgeBridgeRef.current
        if (!b) return 0
        return b.editSecToMediaSec(pointerToTimeOnStrip(clientX))
      },
      [pointerToTimeOnStrip]
    )

    const onWordEdgePreview = useCallback((result: EdgeDragResult) => {
      const b = wordEdgeBridgeRef.current
      if (!b) return
      /**
       * **SSOT 미리보기는 의도적으로 호출하지 않는다** — 드래그 중에는 단어블록이 움직이지 않고,
       *  포인터를 떼는 순간(`onCommit`)에 한 번에 합치기가 적용된다.
       *  트림 핸들 시각만 `setEditRange` 로 갱신한다. **`viewWin` 은 건드리지 않는다** — 단어 구간이
       *  짧아질수록 `viewWin = [start,end]` 맞춤 줌이 극단적으로 커지는(로그의 ~0.04s 구간 등) 문제가 있어서,
       *  트림 중 파형 줌·스크롤은 고정이고 핸들만 움직인다.
       */
      const li = activeLineIndexRef.current
      const cwi = centerWordIndexRef.current
      if (li == null || cwi < 0) return
      const line = result.subtitles[li]
      const si = storageWordIndexFromVisibleNonDeletedIndex(line, cwi)
      const w = si >= 0 ? line?.words?.[si] : undefined
      if (!w || w.isDeleted) return
      const lo = Math.min(w.start, w.end)
      const hi = Math.max(w.start, w.end)
      const editLo = b.mediaSecToEditSec(lo)
      const editHi = b.mediaSecToEditSec(hi)
      setEditRange({ start: editLo, end: editHi })
      /**
       * **한계 시각 피드백** — 핸들이 이웃의 끝점에 도달하면 빨강.
       *  - 'start' 한계: 왼쪽 핸들이 same-line storage prev active 단어의 start 와 일치 → prev 흡수 임박.
       *  - 'end' 한계: 오른쪽 핸들이 same-line storage next active 단어의 end 와 일치 → next 흡수 임박.
       */
      if (line?.words) {
        const words = line.words
        let prevActive: typeof w | undefined
        for (let i = si - 1; i >= 0; i -= 1) {
          const ww = words[i]
          if (ww && !ww.isDeleted) {
            prevActive = ww
            break
          }
        }
        let nextActive: typeof w | undefined
        for (let i = si + 1; i < words.length; i += 1) {
          const ww = words[i]
          if (ww && !ww.isDeleted) {
            nextActive = ww
            break
          }
        }
        const limitEps = 1e-5
        let nextLimit: 'start' | 'end' | null = null
        if (prevActive && Math.abs(w.start - prevActive.start) < limitEps) {
          nextLimit = 'start'
        } else if (nextActive && Math.abs(w.end - nextActive.end) < limitEps) {
          nextLimit = 'end'
        }
        setHandleAtLimit((prev) => (prev === nextLimit ? prev : nextLimit))
      }
    }, [])

    const onWordEdgeCommit = useCallback((result: EdgeDragResult) => {
      /**
       * [진단 1] commit 직후 변경된 단어들의 lineIndex/wordIndex/start/end 와
       *          tombstone 된 단어들의 위치를 상세히 기록한다.
       *          - 단어 수와 좌표가 의도대로 바뀌었는지, cross-line 으로 새어 나가지 않았는지 확인.
       */
      const mutatedDetail = result.mutated.map((r) => {
        const w = result.subtitles[r.lineIndex]?.words?.[r.wordIndex]
        return {
          li: r.lineIndex,
          wi: r.wordIndex,
          word: w?.word ?? null,
          start: w?.start ?? null,
          end: w?.end ?? null,
          isDeleted: w?.isDeleted ?? null
        }
      })
      const tombstoneDetail = result.tombstoned.map((r) => {
        const w = result.subtitles[r.lineIndex]?.words?.[r.wordIndex]
        return {
          li: r.lineIndex,
          wi: r.wordIndex,
          word: w?.word ?? null,
          start: w?.start ?? null,
          end: w?.end ?? null
        }
      })
      wfLog('peaks', 'trim-handle commit (useWordEdgeDrag) [diag-1]', {
        mutated: result.mutated.length,
        tombstoned: result.tombstoned.length,
        mutatedDetail,
        tombstoneDetail
      })
      wordEdgeBridgeRef.current?.onSubtitleLinesCommit(result.subtitles)

      /**
       * [진단 2] commit 직후 — activeWordId / centerWordIndex / editRange / cutSec
       *          이 어떻게 남았는지 캡처. setEditRange · setCutSec 가 비동기라 ref 로 본다.
       *          ref 는 다음 paint 에서 최신화되므로 microtask + 짧은 timeout 두 단계로 기록.
       */
      const captureAfterCommit = (tag: string) => {
        wfLog('peaks', `commit 직후 상태 캡처 [diag-2 ${tag}]`, {
          activeLineIndex: activeLineIndexRef.current,
          activeWordId: activeWordIdRef.current,
          centerWordIndex: centerWordIndexRef.current,
          editRange: editRangeRef.current,
          cutSec: cutSecRef.current
        })
      }
      queueMicrotask(() => captureAfterCommit('microtask'))
      window.setTimeout(() => captureAfterCommit('t+16ms'), 16)
    }, [])

    const onWordEdgeDragFinish = useCallback(({ cancelled }: { cancelled: boolean }) => {
      setDraggingHandle(null)
      setHandleAtLimit(null)
      /**
       * 종료 후 통상 viewWin 정책으로 복귀하도록 lastViewKey 를 무효화한다.
       * 다음 useLayoutEffect 실행에서 새 viewWin 이 계산된다.
       */
      lastViewKeyRef.current = null
      if (!cancelled) return
      const li = activeLineIndexRef.current
      const cwi = centerWordIndexRef.current
      if (li == null || cwi < 0) return
      const w = rowsRef.current[li]?.words?.[cwi]
      if (!w) return
      const lo = Math.min(w.start, w.end)
      const hi = Math.max(w.start, w.end)
      setEditRange({ start: lo, end: hi })
    }, [])

    const { startDrag: startWordEdgeDrag } = useWordEdgeDrag({
      getSubtitles: getSubtitleLinesStable,
      secAtClientX: mediaSecAtPointerX,
      onPreview: onWordEdgePreview,
      onCommit: onWordEdgeCommit,
      onDragFinish: onWordEdgeDragFinish,
      onDragRevert: (snapshot) => {
        wordEdgeBridgeRef.current?.onSubtitleLinesRevert?.(snapshot)
      }
    })

    /**
     * 트림 핸들 드래그 — 끝 단어 경계(=현재 뷰 좌·우 끝)에 닿으면 잠시 브레이크를 걸어
     * 핸들이 그 자리에서 멈추도록 한다. 커서가 경계 밖으로 일정 픽셀(`BRAKE_PX_OVERSHOOT`)
     * 이상 더 끌리면 그제서야 한 단어만큼 뷰를 확장한다.
     * — 사용자가 드래그 도중 파형이 갑자기 휙 따라 움직이지 않도록 하기 위함.
     */
    const onTrimHandlePointerDown = useCallback(
      (which: 'start' | 'end') => (e: ReactPointerEvent<HTMLDivElement>) => {
        const bridge = wordEdgeBridgeRef.current
        const li = activeLineIndexRef.current
        const cwi = centerWordIndexRef.current
        if (bridge && li != null && cwi >= 0) {
          const lines = bridge.getSubtitleLines()
          const storageWi = storageWordIndexFromVisibleNonDeletedIndex(lines[li], cwi)
          if (storageWi >= 0) {
            wfLog('peaks', 'trim-handle → useWordEdgeDrag', {
              which,
              lineIndex: li,
              centerWordIndex: cwi,
              storageWi
            })
            setDraggingHandle(which === 'start' ? 'trimStart' : 'trimEnd')
            startWordEdgeDrag(
              e,
              { lineIndex: li, wordIndex: storageWi },
              which === 'start' ? 'start' : 'end'
            )
            return
          }
        }

        wfLog('peaks', 'trim-handle → local-only fallback', {
          which,
          hasBridge: !!bridge,
          activeLineIndex: li,
          centerWordIndex: cwi,
          activeWordId
        })
        e.stopPropagation()
        e.preventDefault()
        expandLeftTokensRef.current = 4
        expandRightTokensRef.current = 4
        const target = e.currentTarget
        try {
          target.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        setDraggingHandle(which === 'start' ? 'trimStart' : 'trimEnd')
        /** 경계 밖으로 이만큼(px) 더 끌어야 뷰가 확장된다 */
        const BRAKE_PX_OVERSHOOT = 18

        const move = (ev: PointerEvent): void => {
          const outer = zoomOuterRef.current
          const vw = viewWinRef.current
          if (!outer || !vw) return
          const rect = outer.getBoundingClientRect()
          const t = pointerToTimeOnStrip(ev.clientX)
          const er = editRangeRef.current
          const limits = contextClampLimitsRef.current
          if (!er || !limits) return
          const lo = limits.lo
          const hi = limits.hi
          const s = Math.min(er.start, er.end)
          const e0 = Math.max(er.start, er.end)
          const minSpan = MIN_TRIM_SPAN_SEC

          if (which === 'start') {
            if (t < lo - 1e-9) {
              const a = Math.min(vw.start, vw.end)
              const b = Math.max(vw.start, vw.end)
              const span = Math.max(b - a, 1e-9)
              const edgePx = ((lo - a) / span) * rect.width
              const curPx = ev.clientX - rect.left
              const overshoot = Math.max(0, edgePx - curPx)
              if (overshoot >= BRAKE_PX_OVERSHOOT && expandLeftTokensRef.current > 0) {
                expandLeftTokensRef.current -= 1
                setExpandL((x) => x + 1)
                setEditRange({ start: lo, end: e0 })
              } else {
                setEditRange({ start: lo, end: e0 })
              }
            } else {
              const ns = clampPx(t, lo, e0 - minSpan)
              setEditRange({ start: ns, end: e0 })
            }
          } else {
            if (t > hi + 1e-9) {
              const a = Math.min(vw.start, vw.end)
              const b = Math.max(vw.start, vw.end)
              const span = Math.max(b - a, 1e-9)
              const edgePx = ((hi - a) / span) * rect.width
              const curPx = ev.clientX - rect.left
              const overshoot = Math.max(0, curPx - edgePx)
              if (overshoot >= BRAKE_PX_OVERSHOOT && expandRightTokensRef.current > 0) {
                expandRightTokensRef.current -= 1
                setExpandR((x) => x + 1)
                setEditRange({ start: s, end: hi })
              } else {
                setEditRange({ start: s, end: hi })
              }
            } else {
              const ne = clampPx(t, s + minSpan, hi)
              setEditRange({ start: s, end: ne })
            }
          }
        }
        const up = (ev: PointerEvent): void => {
          try {
            target.releasePointerCapture(ev.pointerId)
          } catch {
            /* ignore */
          }
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
          setDraggingHandle(null)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
      },
      [pointerToTimeOnStrip, startWordEdgeDrag]
    )

    const trimHandlePct = useMemo(() => {
      if (!viewWin || !editRange) return null
      const a = Math.min(viewWin.start, viewWin.end)
      const b = Math.max(viewWin.start, viewWin.end)
      const span = Math.max(b - a, 1e-9)
      const s = Math.min(editRange.start, editRange.end)
      const e = Math.max(editRange.start, editRange.end)
      return {
        startPct: clampPx(((s - a) / span) * 100, 0, 100),
        endPct: clampPx(((e - a) / span) * 100, 0, 100),
        startSec: s,
        endSec: e
      }
    }, [viewWin, editRange])

    /**
     * 자르기 라인 — 트림 구간 내부에서만 자유롭게 이동.
     * - **새 단어 활성화(activeWordId 변경) 시 → 무조건 트림 시작점으로 초기화** (사용자 요구).
     * - 같은 단어에서 트림 구간만 바뀌면(트림 핸들 드래그 등) → 기존 cut 위치를 트림 안으로 클램프.
     * - 트림 구간 자체가 사라지면 자르기 라인도 null.
     *
     * **주의: deps 는 `editRange` 만 둔다.** `activeWordId` 를 deps 에 넣으면 단어 변경 시
     * `editRange` 가 아직 이전 단어의 범위인 상태에서 한 번 effect 가 더 돌아 cut 이 잘못된 곳으로 가는
     * 1-tick flicker 가 생긴다. word 변경은 `activeWordId` 자체를 closure 에서 읽어 트래커 ref 로 감지한다.
     */
    const cutSecLastActiveWordIdRef = useRef<string | null>(null)
    useEffect(() => {
      if (!editRange) {
        setCutSec(null)
        cutSecLastActiveWordIdRef.current = null
        return
      }
      const s = Math.min(editRange.start, editRange.end)
      const e = Math.max(editRange.start, editRange.end)
      const eps = 1e-4
      const startCut = Math.min(e - eps, s + eps)
      const wid = activeWordIdRef.current ?? null
      const wordChanged = cutSecLastActiveWordIdRef.current !== wid
      cutSecLastActiveWordIdRef.current = wid
      setCutSec((prev) => {
        if (wordChanged) return startCut
        if (prev == null || !Number.isFinite(prev)) return startCut
        if (prev <= s + eps) return s + eps
        if (prev >= e - eps) return e - eps
        return prev
      })
    }, [editRange])

    const cutSecRef = useRef<number | null>(cutSec)
    cutSecRef.current = cutSec

    const onCutLinePointerDown = useCallback(
      (e: ReactPointerEvent<HTMLDivElement>) => {
        e.stopPropagation()
        e.preventDefault()
        const target = e.currentTarget
        try {
          target.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        setDraggingHandle('cut')
        const move = (ev: PointerEvent): void => {
          const t = pointerToTimeOnStrip(ev.clientX)
          const er = editRangeRef.current
          if (!er) return
          const s = Math.min(er.start, er.end)
          const eEnd = Math.max(er.start, er.end)
          const eps = 1e-4
          const next = Math.min(eEnd - eps, Math.max(s + eps, t))
          setCutSec(next)
        }
        const up = (ev: PointerEvent): void => {
          try {
            target.releasePointerCapture(ev.pointerId)
          } catch {
            /* ignore */
          }
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
          setDraggingHandle(null)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
      },
      [pointerToTimeOnStrip]
    )

    const cutLinePct = useMemo(() => {
      if (!viewWin || cutSec == null || !Number.isFinite(cutSec)) return null
      const a = Math.min(viewWin.start, viewWin.end)
      const b = Math.max(viewWin.start, viewWin.end)
      const span = Math.max(b - a, 1e-9)
      return {
        pct: clampPx(((cutSec - a) / span) * 100, 0, 100),
        sec: cutSec
      }
    }, [viewWin, cutSec])

    /**
     * 자르기·재생 라인 부드러운 움직임 — `cutSec` 은 이미 0.01s 단위로 quantize 된 값을 받지만
     * 60Hz 화면에선 매 프레임 다른 위치로 React 가 강제 점프 그리므로 띄엄띄엄 보인다.
     * 재생 중일 때만 `left` 에 12ms 선형 transition 을 걸어 프레임 사이 빈 구간을 CSS 가 채워
     * 사용자 시야에서 0.01s 단위 진행이 자연스럽게 흐르도록 한다.
     *
     * - 드래그 중: transition 해제(드래그 추적이 지연되면 안 됨).
     * - 정지/일시정지/단어 전환: transition 해제(시작점으로 즉시 스냅).
     */
    const cutLineMotionStyle = useMemo<{ transition: string; willChange?: string }>(() => {
      if (isPlaying && draggingHandle !== 'cut') {
        return { transition: 'left 12ms linear', willChange: 'left' }
      }
      return { transition: 'none' }
    }, [isPlaying, draggingHandle])

    /** 라벨이 박스 밖으로 옮겨졌으므로 상단 패딩은 최소만(중심선 여유) */
    const WAVE_TOP_LABEL_BAND_PX = 4
    /** 진폭 게인 — 박스 크기를 키우지 않고 막대만 더 크게 보이게 (전 영역 사용) */
    const WAVE_PEAK_GAIN = 2.0

    /** 메인 파형 그리기 */
    useEffect(() => {
      const canvas = zoomCanvasRef.current
      const outer = zoomOuterRef.current
      if (!canvas || !outer || !metrics || !viewWin) return
      const rowWords = rowsRef.current[activeLineIndexRef.current ?? -1]?.words ?? []
      const winStart = Math.min(viewWin.start, viewWin.end)
      const winEnd = Math.max(viewWin.start, viewWin.end)
      const deletedRanges = collectDeletedRangesSec(rowWords, winStart, winEnd)
      const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1
      const h = outer.clientHeight || 288

      const paint = (): void => {
        const bands = waveFillBands
        const useBands = bands != null && bands.length > 0
        const baseOpts = {
          topPaddingPx: WAVE_TOP_LABEL_BAND_PX,
          gain: WAVE_PEAK_GAIN
        }
        drawWaveformCanvas(
          canvas,
          metrics,
          winStart,
          winEnd,
          deletedRanges,
          h,
          dpr,
          useBands
            ? { ...baseOpts, fillBands: bands }
            : activeWordSpan
              ? {
                  ...baseOpts,
                  dimOutside: { leftSec: activeWordSpan.start, rightSec: activeWordSpan.end }
                }
              : baseOpts
        )
      }
      paint()
      const ro = new ResizeObserver(() => window.requestAnimationFrame(paint))
      ro.observe(outer)
      return () => ro.disconnect()
    }, [metrics, viewWin, activeWordSpan, waveFillBands, mountLayoutKey, rows, activeLineIndex])

    /**
     * 재생 중에만 호출 — playhead(편집축 초)를 트림 구간으로 클램프해 `cutSec` 상태로 반영한다.
     * 정지 중에는 사용자의 드래그가 cut 라인을 움직이므로 절대 덮어쓰지 않음.
     *
     * (이전 구현은 DOM `style.left` 를 직접 갱신해 React render 와 충돌했고, 그 결과
     *  사용자 드래그가 즉시 덮여 cut 라인이 안 움직이는 것처럼 보였다. 단일 출처(state)로 통일.)
     */
    const syncPlayheadLineFromEditSec = useCallback(
      (editT: number) => {
        const oldYellow = playheadLineRef.current
        oldYellow?.style.setProperty('opacity', '0')
        oldYellow?.style.setProperty('visibility', 'hidden')

        if (!isPlayingWaveRef.current) return
        if (typeof editT !== 'number' || !Number.isFinite(editT)) return
        const er = editRangeRef.current
        if (!er) return
        const s = Math.min(er.start, er.end)
        const e = Math.max(er.start, er.end)
        if (!(e > s + 1e-9)) return
        const live = Math.min(e, Math.max(s, editT))
        setCutSec((prev) => (prev != null && Math.abs(prev - live) < 1e-4 ? prev : live))
      },
      []
    )

    useImperativeHandle(
      ref,
      () => ({
        onWaveMountDirty: bumpPortal,
        syncPlayheadFromEditSec: syncPlayheadLineFromEditSec
      }),
      [bumpPortal, syncPlayheadLineFromEditSec]
    )

    useLayoutEffect(() => {
      const r = playheadEditSecRef
      if (!r) return
      syncPlayheadLineFromEditSec(r.current)
    }, [playheadEditSecRef, syncPlayheadLineFromEditSec, mountLayoutKey, viewWin, isPlaying, activeWordId])

    /**
     * 활성 단어 칩 ↔ 파형 트림 시작/끝 라인을 잇는 SVG 좌표 재계산.
     * - `data-word-id` 로 칩 DOM 을 찾고, `zoomOuterRef` 와 `trimHandlePct` 로 파형 위 끝점을 잡는다.
     * - 좌표는 모두 `<article>` 로컬 — viewport 스크롤/리사이즈 변화에도 정확히 따라감.
     */
    const recomputeConnectorGeom = useCallback((): void => {
      if (!activeWordId || !articleEl || !trimHandlePct) {
        setConnectorGeom(null)
        return
      }
      const waveEl = zoomOuterRef.current
      if (!waveEl) {
        setConnectorGeom(null)
        return
      }
      let chipEl: HTMLElement | null = null
      try {
        chipEl = articleEl.querySelector(
          `[data-word-id="${CSS.escape(activeWordId)}"]`
        ) as HTMLElement | null
      } catch {
        chipEl = null
      }
      if (!chipEl) {
        chipEl = articleEl.querySelector(
          '[data-waveform-active-word-chip="1"]'
        ) as HTMLElement | null
      }
      if (!chipEl) {
        setConnectorGeom(null)
        return
      }
      const articleRect = articleEl.getBoundingClientRect()
      const chipRect = chipEl.getBoundingClientRect()
      const waveRect = waveEl.getBoundingClientRect()
      if (articleRect.width <= 0 || chipRect.width <= 0 || waveRect.width <= 0) {
        setConnectorGeom(null)
        return
      }
      const next = {
        svgW: articleRect.width,
        svgH: articleRect.height,
        fromL: {
          x: chipRect.left - articleRect.left,
          y: chipRect.bottom - articleRect.top
        },
        fromR: {
          x: chipRect.right - articleRect.left,
          y: chipRect.bottom - articleRect.top
        },
        toL: {
          x:
            waveRect.left -
            articleRect.left +
            (waveRect.width * trimHandlePct.startPct) / 100,
          y: waveRect.top - articleRect.top
        },
        toR: {
          x:
            waveRect.left -
            articleRect.left +
            (waveRect.width * trimHandlePct.endPct) / 100,
          y: waveRect.top - articleRect.top
        }
      }
      setConnectorGeom((prev) => {
        if (
          prev &&
          Math.abs(prev.svgW - next.svgW) < 0.5 &&
          Math.abs(prev.svgH - next.svgH) < 0.5 &&
          Math.abs(prev.fromL.x - next.fromL.x) < 0.5 &&
          Math.abs(prev.fromL.y - next.fromL.y) < 0.5 &&
          Math.abs(prev.fromR.x - next.fromR.x) < 0.5 &&
          Math.abs(prev.fromR.y - next.fromR.y) < 0.5 &&
          Math.abs(prev.toL.x - next.toL.x) < 0.5 &&
          Math.abs(prev.toL.y - next.toL.y) < 0.5 &&
          Math.abs(prev.toR.x - next.toR.x) < 0.5 &&
          Math.abs(prev.toR.y - next.toR.y) < 0.5
        ) {
          return prev
        }
        return next
      })
    }, [activeWordId, articleEl, trimHandlePct])

    /** 트림 위치·뷰 변화 시 즉시 재계산 (paint 전) */
    useLayoutEffect(() => {
      recomputeConnectorGeom()
    }, [recomputeConnectorGeom, mountLayoutKey, viewWin])

    /** 카드/칩/파형 박스 리사이즈 + 윈도우 스크롤·리사이즈 동기화 */
    useEffect(() => {
      if (!articleEl) return
      let rafPending = 0
      const schedule = (): void => {
        if (rafPending) return
        rafPending = window.requestAnimationFrame(() => {
          rafPending = 0
          recomputeConnectorGeom()
        })
      }
      const ro = new ResizeObserver(schedule)
      ro.observe(articleEl)
      const waveEl = zoomOuterRef.current
      if (waveEl) ro.observe(waveEl)
      let chip: HTMLElement | null = null
      if (activeWordId) {
        try {
          chip = articleEl.querySelector(
            `[data-word-id="${CSS.escape(activeWordId)}"]`
          ) as HTMLElement | null
        } catch {
          chip = null
        }
      }
      if (chip) ro.observe(chip)
      window.addEventListener('resize', schedule)
      window.addEventListener('scroll', schedule, true)
      return () => {
        if (rafPending) cancelAnimationFrame(rafPending)
        ro.disconnect()
        window.removeEventListener('resize', schedule)
        window.removeEventListener('scroll', schedule, true)
      }
    }, [articleEl, activeWordId, recomputeConnectorGeom])

    const peaksReportedOnce = useRef(false)
    useEffect(() => {
      if (!metrics || peaksReportedOnce.current) return
      peaksReportedOnce.current = true
      const pDur = metrics.durationSec
      const mDur = mediaDurationSecProp
      onPeaksDurationComparedToMedia?.({
        peaksDurationSec: pDur,
        mediaDurationSec: mDur,
        deltaSec:
          mDur != null && Number.isFinite(mDur) && mDur > 0 ? Math.abs(pDur - mDur) : null,
        exactTimelineDurationSec: durExact
      })
      wfLog('peaks', 'Canvas 파형 — metrics 준비', {
        durationSec: pDur,
        editAxis: precomputedWaveformIsEditAxis
      })
    }, [metrics, mediaDurationSecProp, durExact, onPeaksDurationComparedToMedia, precomputedWaveformIsEditAxis])

    const trimDurationSec =
      editRange != null ? Math.max(0, Math.abs(editRange.end - editRange.start)) : 0

    /**
     * 재생을 시작한 cut 라인 위치(편집축 초) — 재생이 트림 끝까지 자연 종료될 때
     * 이 위치로 되돌려서, 다음 ▶/Space 가 곧바로 다시 재생을 이어 받을 수 있게 한다.
     */
    const playStartSecRef = useRef<number | null>(null)

    /**
     * 재생 토글 — 자르기 라인부터 트림 끝까지 재생/일시정지.
     * - 정지 상태: `onPlayEditRange(cutSec, editRange.end, …)` 호출 (재생 시작).
     *   재생 시작 시각을 `playStartSecRef` 에 저장 → 자연 종료 시 그 자리로 자동 복귀.
     * - 재생 중: `onPausePlayback()` 호출 (정지). 사용자의 임의 일시정지는 cut 라인을
     *   그 자리에 둔다(이어 재생 가능). 자연 종료(=playhead 가 트림 끝 근처)면 시작 지점으로 복귀.
     */
    const togglePlayFromCutLine = useCallback(() => {
      const er = editRangeRef.current
      const li = activeLineIndexRef.current
      if (!er || li == null) return
      if (isPlayingWaveRef.current) {
        onPausePlayback?.()
        return
      }
      const s = Math.min(er.start, er.end)
      const e = Math.max(er.start, er.end)
      let startT = cutSecRef.current != null ? cutSecRef.current : s
      // cut 라인이 끝 근처(<=50ms) 면 트림 시작점부터 재생 — 자연 종료 직후 다시 ▶ 누른 경우 대응
      if (startT >= e - 0.05) startT = s
      const clamped = Math.min(e - 1e-4, Math.max(s + 1e-4, startT))
      playStartSecRef.current = clamped
      const wid = activeWordIdRef.current
      const w = wid ? activeWords.find((x) => x.id === wid) : undefined
      onPlayEditRange?.(clamped, e, {
        wordId: wid,
        wordText: w?.text ?? null,
        lineIndex: li
      })
    }, [activeWords, onPausePlayback, onPlayEditRange])

    /**
     * `isPlaying` 이 true → false 전환되면 **무조건** 자르기 라인을 트림 시작점으로 복귀.
     *  - 사용자 요구: "재생이 끝나면 자동으로 시작지점으로 가야하고 무조건이야".
     *  - 자연 종료/임의 일시정지 구분 없이 동일하게 시작점으로 되돌린다.
     *  - 다음 ▶/Space 가 곧바로 트림 시작점부터 재생을 시작.
     */
    const prevIsPlayingForRewindRef = useRef<boolean>(Boolean(isPlaying))
    useEffect(() => {
      const was = prevIsPlayingForRewindRef.current
      const now = Boolean(isPlaying)
      prevIsPlayingForRewindRef.current = now
      if (!(was && !now)) return
      playStartSecRef.current = null
      const er = editRangeRef.current
      if (!er) return
      const s = Math.min(er.start, er.end)
      const e = Math.max(er.start, er.end)
      const eps = 1e-4
      const back = Math.min(e - eps, s + eps)
      setCutSec(back)
    }, [isPlaying])

    /**
     * 파형 패널이 열려 있을 때 Space 키로 재생/정지 토글.
     * - 입력 필드/contenteditable 안에서는 동작하지 않음 — 기존 textarea 입력을 막지 않는다.
     * - `preventDefault()` 로 페이지 스크롤·다른 글로벌 핸들러 중복 발화 차단.
     */
    useEffect(() => {
      if (activeLineIndex == null) return
      const onKey = (e: globalThis.KeyboardEvent): void => {
        if (e.code !== 'Space' && e.key !== ' ') return
        const t = e.target as HTMLElement | null
        if (t && t.closest('textarea, input, [contenteditable="true"]')) return
        e.preventDefault()
        e.stopPropagation()
        togglePlayFromCutLine()
      }
      window.addEventListener('keydown', onKey, true)
      return () => window.removeEventListener('keydown', onKey, true)
    }, [activeLineIndex, togglePlayFromCutLine])

    const waveformPortal =
      portalHost &&
      createPortal(
        <div className="subtitle-waveform-flow-root relative w-full min-w-0">
          <div className="subtitle-waveform-stack w-full min-w-0 px-1 pb-1 pt-0">
            <div className="w-full min-w-0">
              {/*
                패널 가로 위치 — `--subwave-panel-left-px` 가 있으면 그 픽셀만큼 왼쪽에서 시프트,
                없으면 `margin: 0 auto` 로 가운데 정렬. 부모(`SubtitleVirtualList`) 가 활성 단어 칩
                중앙을 기준으로 계산해 카드 영역 안에서 클램프한 값을 넣어 준다.
              */}
              <div
                className="w-[min(100%,21rem)] max-w-full"
                style={{
                  marginLeft: 'var(--subwave-panel-left-px, auto)',
                  marginRight: 'auto'
                }}
              >
                {/*
                  ── 박스 위쪽 라벨 스트립 ──
                  시작/자르기/끝 시간 라벨이 박스 외부에 떠 있고, 박스 안의 라인과 동일한
                  좌표계(부모 폭 기준 %) 로 정렬된다. 라벨은 라인 움직임을 그대로 따라가며
                  너비가 박스에 영향을 주지 않도록 `pointer-events-none` 으로 둔다.
                */}
                {activeWordId && (trimHandlePct || cutLinePct) ? (
                  <div className="pointer-events-none relative mb-1 h-5 w-full">
                    {trimHandlePct ? (
                      <>
                        <span
                          className="absolute -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900/95 px-1.5 py-[2px] font-mono text-[10px] leading-tight text-white/95 shadow-sm ring-1 ring-white/15"
                          style={{ left: `${trimHandlePct.startPct}%`, top: 0 }}
                        >
                          {fmtSec(trimHandlePct.startSec)}
                        </span>
                        <span
                          className="absolute -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900/95 px-1.5 py-[2px] font-mono text-[10px] leading-tight text-white/95 shadow-sm ring-1 ring-white/15"
                          style={{ left: `${trimHandlePct.endPct}%`, top: 0 }}
                        >
                          {fmtSec(trimHandlePct.endSec)}
                        </span>
                      </>
                    ) : null}
                    {cutLinePct != null ? (
                      <span
                        className="absolute -translate-x-1/2 whitespace-nowrap rounded-md bg-sky-500 px-1.5 py-[2px] font-mono text-[10px] font-semibold leading-tight text-white shadow-[0_2px_6px_rgba(2,132,199,0.55)]"
                        style={{ left: `${cutLinePct.pct}%`, top: 0, ...cutLineMotionStyle }}
                      >
                        {fmtSec(cutLinePct.sec)}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {/* 흰 라인 둥근 사각형 — 안쪽으로 파형·핸들·자르기 라인만 (라벨은 위 스트립으로 분리) */}
                <div
                  ref={zoomOuterRef}
                  className="relative isolate h-28 w-full min-w-0 overflow-hidden rounded-xl border-2 border-white/85 bg-[#0c1018]"
                >
                  {/**
                   * 파형 본체 드래그(패닝) **비활성** — 사용자가 파형을 잡아 좌우로 끌면
                   *  뷰가 미디어 길이만큼 흘러내려 단어 트림/자르기에 방해가 되므로
                   *  포인터 이벤트를 받지 않게 둔다. 휠 줌은 외곽(`zoomOuterRef`)에서 그대로 유효.
                   */}
                  <div
                    className="pointer-events-none absolute inset-0 z-0"
                    aria-hidden
                  />
                  <canvas
                    ref={zoomCanvasRef}
                    className="pointer-events-none absolute inset-0 z-[1] block h-full w-full"
                  />
                  {/* 예전 노란 playhead 라인은 제거 — 재생 표시는 cut 라인 자체가 움직여 대신한다 */}
                  <div ref={playheadLineRef} className="hidden" aria-hidden />

                  {/* 트림 핸들 — 흰 세로 라인 + 그립 노브(라벨 없음, 외부 스트립에서 표시) */}
                  {trimHandlePct && activeWordId ? (
                    <div className="pointer-events-none absolute inset-0 z-[45]">
                      {(['start', 'end'] as const).map((which) => {
                        const pct =
                          which === 'start' ? trimHandlePct.startPct : trimHandlePct.endPct
                        const isDraggingThis =
                          (which === 'start' && draggingHandle === 'trimStart') ||
                          (which === 'end' && draggingHandle === 'trimEnd')
                        /**
                         * 한계 도달 시각화 — 이 핸들이 이웃 단어의 끝점에 닿아 *흡수 commit 직전* 이면 빨강.
                         * 사용자는 이 상태에서 마우스를 떼면 prev/next 가 통째 흡수됨을 시각으로 미리 안다.
                         */
                        const atLimit = handleAtLimit === which
                        return (
                          <div
                            key={which}
                            className="pointer-events-auto absolute inset-y-0 w-8 -translate-x-1/2 cursor-ew-resize touch-none"
                            style={{ left: `${pct}%` }}
                            onPointerDown={onTrimHandlePointerDown(which)}
                            role="slider"
                            aria-label={which === 'start' ? '구간 시작' : '구간 끝'}
                          >
                            <div
                              className="pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 transition-opacity duration-75"
                              style={{
                                opacity: isDraggingThis ? 0.25 : 1,
                                background: atLimit ? 'rgb(248 113 113)' : 'rgba(255,255,255,0.95)',
                                boxShadow: atLimit
                                  ? '0 0 8px rgba(248,113,113,0.85)'
                                  : '0 0 6px rgba(255,255,255,0.5)'
                              }}
                            />
                            <div
                              className="pointer-events-none absolute left-1/2 top-1/2 flex h-6 w-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[3px] shadow-md transition-opacity duration-75"
                              style={{
                                opacity: isDraggingThis ? 0.3 : 1,
                                border: atLimit
                                  ? '1px solid rgb(127 29 29)'
                                  : '1px solid rgba(15,23,42,0.8)',
                                background: atLimit ? 'rgb(248 113 113)' : 'white'
                              }}
                            >
                              <span
                                className="block h-3 w-[1px]"
                                style={{
                                  background: atLimit
                                    ? 'rgba(127,29,29,0.85)'
                                    : 'rgba(100,116,139,0.8)'
                                }}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : null}

                  {/* 자르기·재생 라인 — 점선(하늘색) + 그립 노브 (라벨 없음, 외부 스트립에서 표시) */}
                  {cutLinePct != null && activeWordId ? (
                    <div className="pointer-events-none absolute inset-0 z-[60]">
                      <div
                        className="pointer-events-auto absolute inset-y-0 w-8 -translate-x-1/2 cursor-ew-resize touch-none"
                        style={{ left: `${cutLinePct.pct}%`, ...cutLineMotionStyle }}
                        onPointerDown={onCutLinePointerDown}
                        role="slider"
                        aria-label="자르기·재생 시작 라인"
                      >
                        <div
                          className="pointer-events-none absolute inset-y-1 left-1/2 -translate-x-1/2 transition-opacity duration-75"
                          style={{
                            width: 0,
                            borderLeft: '2px dashed rgb(56 189 248)',
                            opacity: draggingHandle === 'cut' ? 0.25 : 1
                          }}
                        />
                        <div
                          className="pointer-events-none absolute left-1/2 top-1/2 flex h-6 w-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[3px] border border-sky-700 bg-sky-400 shadow-md transition-opacity duration-75"
                          style={{ opacity: draggingHandle === 'cut' ? 0.35 : 1 }}
                        >
                          <span className="block h-3 w-[1px] bg-white/70" />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>

                {editRange != null && trimDurationSec > 1e-6 ? (
                  <div className="mt-2 flex justify-center">
                    <span className="rounded-full bg-sky-400/22 px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-sky-100/95">
                      {trimDurationSec.toFixed(1)}초
                    </span>
                  </div>
                ) : null}

                {activeLineIndex !== null ? (
                  <div className="mt-3 flex justify-center gap-5">
                    <button
                      type="button"
                      aria-label={isPlaying ? '재생 일시정지' : '자르기 라인부터 재생'}
                      disabled={!editRange || cutSec == null}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-300/45 bg-white text-slate-800 shadow-md transition hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-35"
                      onClick={togglePlayFromCutLine}
                    >
                      {isPlaying ? (
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                        </svg>
                      ) : (
                        <svg className="ml-0.5 h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label="자르기 라인 위치에서 단어 분할"
                      disabled={!editRange || cutSec == null || centerWordIndex < 0}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-300/45 bg-white text-slate-800 shadow-md transition hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-35"
                      onClick={() => {
                        if (
                          !editRange ||
                          cutSec == null ||
                          activeLineIndex == null ||
                          centerWordIndex < 0
                        )
                          return
                        onSplitActiveWordAtEditSec?.(activeLineIndex, centerWordIndex, cutSec)
                      }}
                    >
                      <svg
                        className="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden
                      >
                        <circle cx="6" cy="6" r="3" />
                        <circle cx="6" cy="18" r="3" />
                        <path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" strokeLinecap="round" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      aria-label="되돌리기"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-300/45 bg-white text-slate-800 shadow-md transition hover:bg-slate-50"
                      onClick={() => onUndo?.()}
                    >
                      <svg
                        className="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden
                      >
                        <path
                          d="M9 14 4 9l5-5M4 9h11a4 4 0 014 4v1"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>,
        portalHost
      )

    /**
     * 활성 단어 칩 → 파형 트림 라인 두 끝점을 잇는 SVG.
     * - `<article>` (단어카드 루트) 안에 `position: absolute; inset: 0` 으로 깔린다.
     * - 마운트(`subtitle-waveform-mount`) 가 `z-10` 이므로 라벨/파형 박스 뒤에 자연스럽게 묻힘.
     * - `pointer-events: none` — 클릭/드래그는 통과시켜 사용자 입력을 방해하지 않는다.
     */
    const connectorOverlay =
      articleEl && connectorGeom
        ? createPortal(
            <svg
              aria-hidden
              width={connectorGeom.svgW}
              height={connectorGeom.svgH}
              viewBox={`0 0 ${connectorGeom.svgW} ${connectorGeom.svgH}`}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: connectorGeom.svgW,
                height: connectorGeom.svgH,
                pointerEvents: 'none',
                overflow: 'visible'
              }}
            >
              <line
                x1={connectorGeom.fromL.x}
                y1={connectorGeom.fromL.y}
                x2={connectorGeom.toL.x}
                y2={connectorGeom.toL.y}
                stroke="rgba(180, 200, 220, 0.55)"
                strokeWidth={1.25}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1={connectorGeom.fromR.x}
                y1={connectorGeom.fromR.y}
                x2={connectorGeom.toR.x}
                y2={connectorGeom.toR.y}
                stroke="rgba(180, 200, 220, 0.55)"
                strokeWidth={1.25}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>,
            articleEl
          )
        : null

    return (
      <>
        {waveformPortal}
        {connectorOverlay}
        <WaveformWordConnector
          activeLineIndex={activeLineIndex}
          peaksRef={peaksStubRef}
          zoomRef={zoomOuterRef}
          peaksReady={false}
          overlayVisible={activeLineIndex !== null}
          layoutKey={wordConnectorLayoutKey}
        />
      </>
    )
  }
)

export const SubtitleWaveformPeaks = memo(SubtitleWaveformPeaksImpl)
