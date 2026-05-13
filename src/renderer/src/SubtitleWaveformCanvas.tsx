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
import { buildEdlSkipMapping, type EdlSkipMapping } from './waveform/edlSkipMapping'
import { useWaveformViewWindow } from './waveform/useWaveformViewWindow'
import { useWordEdgeDrag } from './useWordEdgeDrag'
import playIconUrl from '@resources/Play.svg'
import pauseIconUrl from '@resources/Pause.svg'
import cutIconUrl from '@resources/cut.svg'
import undoIconUrl from '@resources/undo.svg'

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
  /**
   * EDL skip 표시 압축에 쓰이는 통합 컷 리스트 (하드컷 + 단어 tombstone + 가상삭제).
   *  - viewWin 안에 들어오는 구간만 시각적으로 압축되어 strip 의 픽셀↔초 매핑이 piecewise-linear 로 동작.
   *  - **데이터/재생/SSOT 시간 자체는 그대로** — 미디어 축 단일 정책 유지.
   *  - 미지정/빈 배열 시: 종래 선형 매핑(viewSpan 전체를 strip 폭에 매핑).
   */
  playbackSkipRanges?: ReadonlyArray<CutRange> | null
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
      wordEdgeSubtitleBridge,
      playbackSkipRanges
    },
    ref
  ) {
    void _onRowsChange
    void _suppressAutoFocusSeek
    void _autoFocusSeekBlockToken
    void _onTimeRangeCut

    /**
     * 자르기 라인 라벨 포매터.
     *  - playhead 내부 양자화는 1ms (`PLAYHEAD_STEP_SEC=0.001`) 라 매 frame paint 가 일어나지만,
     *    라벨까지 ms 자릿수를 노출하면 60Hz 로 끝자리가 깜박여 가독성이 떨어진다.
     *  - 따라서 기본 포매터는 **10ms(centisecond) 정밀도**로 고정 — 위치는 부드럽게,
     *    라벨은 안정적으로 표시.
     *  - 호출 측이 `formatEditSec` 을 지정한 경우(타임코드 표시 등) 는 그대로 존중.
     */
    const fmtSec =
      typeof formatEditSec === 'function'
        ? formatEditSec
        : (sec: number) => (Number.isFinite(sec) ? sec.toFixed(2) : '—')

    const mergedCutRanges = useMemo(() => mergeCutRanges([...cutRanges]), [cutRanges])
    const cutDiagSig = useMemo(() => cutRangesSignature(mergedCutRanges), [mergedCutRanges])

    const zoomCanvasRef = useRef<HTMLCanvasElement>(null)
    const zoomOuterRef = useRef<HTMLDivElement | null>(null)
    /** PPS 박스 래퍼 — 카드(`article`) 대비 동적 위치 보정 시 실제 뷰포트 bbox 측정용 */
    const waveStripBoxRef = useRef<HTMLDivElement | null>(null)
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

    /**
     * **고정 PPS 정책** — 활성 단어를 처음 선택했을 때 (`activeWordId` 가 새로 잡힐 때) 한 번
     *  `pps = boxWidth0 / initialViewSpan` 으로 계산해 박제. 이후 흡수 commit 으로 viewWin 시간폭이
     *  늘어나도 PPS 는 변하지 않고, 박스 픽셀 폭이 시간폭에 비례해 늘어난다 (zoom-out 없이 물리적 추가).
     */
    const ppsRef = useRef<number | null>(null)
    /** 박스 left/width 픽셀 — mount 좌측 기준. portal 인라인 스타일로 직접 매핑된다. */
    const [boxLayoutPx, setBoxLayoutPx] = useState<{ left: number; width: number } | null>(null)
    const boxLayoutPxRef = useRef<{ left: number; width: number } | null>(null)
    boxLayoutPxRef.current = boxLayoutPx
    /** 마지막 트림 핸들 방향 — commit 직후 viewWin 확장 시 어느 쪽 픽셀을 고정할지 결정. */
    const lastTrimEdgeRef = useRef<'start' | 'end' | null>(null)
    /** 현재 PPS 가 박제된 단어 ID — 같으면 PPS/박스 left 유지, 다르면 새로 캡처. */
    const lockedPpsWordIdRef = useRef<string | null>(null)

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
    const metricsRef = useRef(metrics)
    metricsRef.current = metrics

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
     * **viewWin 박제** — `activeLineIndex|activeWordId|wordStartEnd` 가 바뀔 때만 ±1 이웃으로
     *  `computeWordContextWindow(..., 0, 0)` 한 번 잡는다. 드래그 중에는 `setViewWin` 호출이 없어
     *  파형이 절대 움직이지 않는다(스크롤 0). 흡수 commit 으로 활성 단어의 start/end 가 바뀌면
     *  anchor 가 바뀌어 새로운 ±1 V0 가 즉시 재고정되고, 이때만 다음/이전 단어의 파동이 한 칸씩 붙는다.
     */
    const viewWinLockedAnchorRef = useRef<string | null>(null)
    /**
     * 단어 블록 선택(`activeWordId` 있음) 시 ±1 컨텍스트 창을 **한 번만** 잡고 ref 에 박제.
     * `viewWinRef` 가 아직 커밋 전이거나 deps 로 effect 가 재돌아도 동일 anchor 면 `setViewWin` 호출 안 함.
     */
    const frozenWordViewWinRef = useRef<{ anchorKey: string; start: number; end: number } | null>(null)

    /**
     * viewWin 박제 effect 전용 — `portalHost` / `articleEl` state 에 의존하면 형제 layout effect 의
     *  setState 와 같은 틱에서 순서·재실행이 꼬이거나, 박스 폭 변경 → ResizeObserver → bumpPortal 과
     *  맞물려 Maximum update depth 가 날 수 있다. ref 로 잡은 마운트 DOM 에서 `<article>` 만 올라간다.
     */
    const getWaveformMountAndArticleEl = useCallback((): {
      mount: HTMLElement
      article: HTMLElement
    } | null => {
      const li = activeLineIndex
      if (li == null) return null
      const raw = waveMountByLineRef.current.get(li)
      const mount = raw && raw.isConnected ? raw : null
      if (!mount) return null
      let cur: HTMLElement | null = mount
      while (cur && cur.tagName.toLowerCase() !== 'article') {
        cur = cur.parentElement
      }
      if (!cur) return null
      return { mount, article: cur }
    }, [activeLineIndex, waveMountByLineRef])

    /** 활성 단어 ±1 이웃 V0 한 번만 — 이후 viewWin 고정 */
    useLayoutEffect(() => {
      /**
       * **트림 드래그 중에는 viewWin 을 고정** — 미리보기에서 `setViewWin` 을 호출하지 않지만,
       *  `editRange`/rows 가 바뀌며 이 effect 가 매 프레임 돌면 `computeWordContextWindow` 가
       *  줌을 다시 잡아 파형이 “존나 확대” 되는 현상이 난다. 트림 중에는 기존 viewWin 유지,
       *  손을 떼면 `draggingHandle` 해제 후 여기서 통상 정책으로 한 번 복구한다.
       */
      if (draggingHandle === 'trimStart' || draggingHandle === 'trimEnd') return

      if (activeLineIndex === null || !metrics) {
        wfLog('peaks', 'setViewWin [diag-vw] reset(null)', {
          reason: activeLineIndex === null ? 'no-active-line' : 'no-metrics'
        })
        setViewWin(null)
        viewWinLockedAnchorRef.current = null
        frozenWordViewWinRef.current = null
        ppsRef.current = null
        lockedPpsWordIdRef.current = null
        lastTrimEdgeRef.current = null
        setBoxLayoutPx(null)
        return
      }
      const row = rowsRef.current[activeLineIndex]
      const words = row?.words ?? []
      const wid = activeWordIdRef.current
      const wi = wid ? words.findIndex((x) => x.id === wid) : -1
      const activeW = wi >= 0 ? words[wi] : null
      /**
       * **anchor 에 활성 단어 start/end 포함** — 흡수 commit 후 단어 폭이 바뀌면 자동으로 재고정.
       *  rows 의 Word 는 화면용(visible) 단어만 포함하므로 흡수된 단어는 이미 빠져 있어 ±1 이웃이
       *  자연스레 새 이웃으로 갱신된다 → 다음/이전 단어 파동이 한 단어씩 추가된다.
       */
      const wSig = activeW ? `${activeW.start.toFixed(6)}:${activeW.end.toFixed(6)}` : ''
      const anchorKey = `${activeLineIndex}|${wid ?? ''}|${wSig}`
      /**
       * 같은 단어 앵커면 ref 기준으로 즉시 종료 — `viewWinRef`/deps 재실행과 무관하게 박제.
       */
      if (wid && frozenWordViewWinRef.current?.anchorKey === anchorKey) return
      /**
       * **stale id 보호** — split 직후처럼 부모가 activeWordId 를 새 조각으로 옮기기 전 한 프레임,
       *  자식 effect 가 `wi === -1` 상태에서 먼저 돌아 전체 라인 폴백 뷰로 빠지면서 파형이 “휙” 튀어 보인다.
       *  그 짧은 transient 동안 기존 viewWin 을 그대로 유지하고 locked anchor 도 업데이트하지 않는다.
       */
      if (wid && wi < 0 && viewWinRef.current) return

      const mediaCap = metrics.durationSec

      if (wi >= 0 && words.length > 0 && wid && activeW) {
        /** ±1 컨텍스트(좌1·활성·우1) — 처음 박스에 들어갈 시간 폭의 기준 */
        const ctx = computeWordContextWindow(words, wi, 0, 0, {
          mediaDurationSec: mediaCap
        })
        if (!ctx) {
          if (viewWinRef.current) return
        } else {
          const isFirstLockForWord = lockedPpsWordIdRef.current !== wid
          const PANEL_MAX_PX = 448

          if (isFirstLockForWord) {
            /**
             * **첫 lock** — PPS / 박스 left·width / viewWin 을 모두 처음 캡처.
             *  활성 단어 mid 가 단어 칩(`data-word-id`) 의 가로 중앙 픽셀에 오도록 박스 left 결정.
             *  mount/chip 이 아직 렌더되지 않았으면 lock 자체를 미룬다 — viewWin 유지하고 effect 재시도.
             */
            const mc = getWaveformMountAndArticleEl()
            if (!mc) return
            const { mount: mountEl, article: cardEl } = mc
            const mountRect = mountEl.getBoundingClientRect()
            const mountW = mountRect.width
            const mountLeft = mountRect.left
            if (mountW <= 0) return

            let chipEl: HTMLElement | null = null
            try {
              chipEl = cardEl.querySelector(
                `[data-word-id="${CSS.escape(wid)}"]`
              ) as HTMLElement | null
            } catch {
              chipEl = null
            }
            if (!chipEl) {
              chipEl = cardEl.querySelector(
                '[data-waveform-active-word-chip="1"]'
              ) as HTMLElement | null
            }
            if (!chipEl) return

            const boxWidth0 = Math.max(1, Math.min(mountW, PANEL_MAX_PX))
            /**
             * **PPS 박제 정책 — activeSpan 기준**. EDL skip(=tombstone/하드컷) 으로 시각 압축된
             *  실제 표시 시간폭을 분모로 잡아야 흡수/복구로 viewWin 이 늘어도 박스 폭이 표시 폭에 비례.
             */
            const futureMap = buildEdlSkipMapping(
              { start: ctx.windowStart, end: ctx.windowEnd },
              playbackSkipRangesRef.current
            )
            const activeSpan = Math.max(futureMap.activeSpanSec, 1e-6)
            const pps = boxWidth0 / activeSpan

            const wa = Math.min(activeW.start, activeW.end)
            const wb = Math.max(activeW.start, activeW.end)
            const wMid = (wa + wb) / 2

            const chipRect = chipEl.getBoundingClientRect()
            const chipCenterFromMount = (chipRect.left + chipRect.right) / 2 - mountLeft

            /** 박스 안에서 wMid 가 위치할 픽셀(박스 left 기준) — piecewise 매핑으로 활성 좌표에 정렬 */
            const wMidPxOnBox = futureMap.mediaSecToActiveSec(wMid) * pps
            const idealLeft = chipCenterFromMount - wMidPxOnBox
            /** 최초 lock 때만 mount 폭 안으로 클램프 — 카드 안에서 시작이 잘 보이게. */
            const maxLeft = Math.max(0, (mountW || boxWidth0) - boxWidth0)
            const left = clampPx(idealLeft, 0, maxLeft)

            const nextWin = { start: ctx.windowStart, end: ctx.windowEnd }
            ppsRef.current = pps
            lockedPpsWordIdRef.current = wid
            lastTrimEdgeRef.current = null
            viewWinLockedAnchorRef.current = anchorKey
            frozenWordViewWinRef.current = { anchorKey, ...nextWin }
            setBoxLayoutPx((p) => {
              const next = { left, width: boxWidth0 }
              if (
                p != null &&
                Math.abs(p.left - next.left) < 0.5 &&
                Math.abs(p.width - next.width) < 0.5
              ) {
                return p
              }
              return next
            })
            setViewWin((prev) => {
              if (
                prev != null &&
                Math.abs(prev.start - nextWin.start) < 1e-5 &&
                Math.abs(prev.end - nextWin.end) < 1e-5
              ) {
                return prev
              }
              wfLog('peaks', 'setViewWin [diag-vw] first-lock', {
                anchorKey,
                pps,
                boxWidth0,
                left,
                viewWin: { s: +nextWin.start.toFixed(4), e: +nextWin.end.toFixed(4) }
              })
              return nextWin
            })
            return
          }

          /**
           * **재고정** — 같은 단어 ID, 단어 start/end 가 바뀐 경우(=흡수 commit 직후).
           *  PPS 유지, 흡수 방향에 따라 한쪽 픽셀만 고정하고 viewWin 시간폭을 늘려 박스 width 증가.
           */
          const pps = ppsRef.current
          const prevWin = frozenWordViewWinRef.current
          const prevLayout = boxLayoutPxRef.current
          const dir = lastTrimEdgeRef.current
          if (pps != null && prevWin != null && prevLayout != null && dir != null) {
            let nextStart = prevWin.start
            let nextEnd = prevWin.end
            if (dir === 'end') {
              /** 우측 흡수 — 좌측 픽셀(left) 고정, 우측만 자람. ctx.windowEnd 가 새 우 이웃 끝. */
              nextEnd = Math.max(prevWin.end, ctx.windowEnd)
            } else {
              /** 좌측 흡수 — 우측 픽셀(right edge) 고정, 좌측만 자람. ctx.windowStart 가 새 좌 이웃 시작. */
              nextStart = Math.min(prevWin.start, ctx.windowStart)
            }
            /**
             * **새 박스 폭 = pps × 새 activeSpan**. viewSpan 기반(`nextEnd - nextStart`) 으로 계산하던
             *  옛 식은 EDL skip 압축 적용 시 표시 시간폭과 어긋나 박스가 카드 폭을 넘어가는 현상이 났다.
             *  좌측 흡수 시 우측 픽셀을 고정하려면 `nextLeft = oldRight - newWidth` 로 직접 잡는다.
             */
            const newMap = buildEdlSkipMapping(
              { start: nextStart, end: nextEnd },
              playbackSkipRangesRef.current
            )
            const newWidth = pps * Math.max(newMap.activeSpanSec, 1e-6)
            const nextLeft =
              dir === 'end'
                ? prevLayout.left
                : prevLayout.left + prevLayout.width - newWidth
            const nextWin = { start: nextStart, end: nextEnd }
            const nextBox = { left: nextLeft, width: newWidth }
            viewWinLockedAnchorRef.current = anchorKey
            frozenWordViewWinRef.current = { anchorKey, ...nextWin }
            /** 트림 방향 소비 — 다음 흡수 전까지는 다시 적용되지 않게 */
            lastTrimEdgeRef.current = null
            setBoxLayoutPx((p) =>
              p != null &&
              Math.abs(p.left - nextBox.left) < 0.5 &&
              Math.abs(p.width - nextBox.width) < 0.5
                ? p
                : nextBox
            )
            setViewWin((prev) => {
              if (
                prev != null &&
                Math.abs(prev.start - nextWin.start) < 1e-5 &&
                Math.abs(prev.end - nextWin.end) < 1e-5
              ) {
                return prev
              }
              wfLog('peaks', 'setViewWin [diag-vw] re-lock after absorb', {
                anchorKey,
                dir,
                prevWin: { s: +prevWin.start.toFixed(4), e: +prevWin.end.toFixed(4) },
                nextWin: { s: +nextWin.start.toFixed(4), e: +nextWin.end.toFixed(4) },
                boxLeft: nextLeft,
                boxWidth: newWidth
              })
              return nextWin
            })
            return
          }

          /**
           * 흡수 방향 정보가 없거나 prev 상태가 빠진 비정상 — 기존 박스 폭 유지하고 ctx 범위만 반영.
           */
          const fallbackWin = { start: ctx.windowStart, end: ctx.windowEnd }
          viewWinLockedAnchorRef.current = anchorKey
          frozenWordViewWinRef.current = { anchorKey, ...fallbackWin }
          setViewWin((prev) => {
            if (
              prev != null &&
              Math.abs(prev.start - fallbackWin.start) < 1e-5 &&
              Math.abs(prev.end - fallbackWin.end) < 1e-5
            ) {
              return prev
            }
            return fallbackWin
          })
          return
        }
      }

      /**
       * **단어 박제 보호** — 활성 단어가 있고 박제된 viewWin 이 살아있다면, ctx 가 잠시 못 잡혔다는
       *  이유로 폴백(라인/카드) 으로 떨어져 `setViewWin` 을 호출하면 파형이 흔들린다. 그대로 유지.
       */
      if (wid && frozenWordViewWinRef.current) return

      frozenWordViewWinRef.current = null
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
      viewWinLockedAnchorRef.current = null
      setViewWin((prev) => {
        if (
          prev != null &&
          Math.abs(prev.start - ns) < 1e-5 &&
          Math.abs(prev.end - ne) < 1e-5
        ) {
          return prev
        }
        wfLog('peaks', 'setViewWin [diag-vw] line-fallback commit', {
          reason: waveformCardBounds != null ? 'card-bounds' : 'line-words',
          prev: prev ? { s: +prev.start.toFixed(4), e: +prev.end.toFixed(4) } : null,
          next: { s: +ns.toFixed(4), e: +ne.toFixed(4) },
          hasActiveWord: Boolean(wid)
        })
        return { start: ns, end: ne }
      })
    }, [
      activeLineIndex,
      activeWordId,
      activeRowTimesSig,
      metrics,
      draggingHandle,
      cardBoundsSig,
      portalRev,
      getWaveformMountAndArticleEl,
      setViewWin
    ])

    useEffect(() => {
      publishZoom()
    }, [publishZoom, viewWin, activeLineIndex])

    /**
     * **동적 위치 보정 (카드 경계)** — PPS 박스(`boxLayoutPx`) 사용 시에만.
     *  스트립 전 너비 ≤ 단어 카드(`article`) 안쪽 가용 너비(=Wcard − 2×pad) 일 때, 좌/우 짤림을
     *  `marginLeft` 만큼 보정해 카드 안에 들어오게 한다. PPS·viewWin·트림 클램프는 건드리지 않는다.
     *
     * `pad = Wcard × 1%` — 카드 좌·우 끝선에 파동이 딱 붙어서 짤린건지 헷갈리는 현상을 막기 위한
     *  시각적 여백. 95% 흡수 차단(`MAX_WAVE_TO_CARD_RATIO`)과는 직교 — 박스 폭은 그대로 두고
     *  표시 위치만 안쪽으로 보정한다.
     */
    useLayoutEffect(() => {
      if (boxLayoutPx == null) return
      const mc = getWaveformMountAndArticleEl()
      const stripEl = waveStripBoxRef.current
      if (!mc || !stripEl?.isConnected) return
      const ar = mc.article.getBoundingClientRect()
      const sr = stripEl.getBoundingClientRect()
      const Wwave = sr.width
      const Wcard = ar.width
      if (!(Wcard > 1)) return
      const pad = Wcard * 0.01
      if (Wwave > Wcard - 2 * pad + 0.75) return

      const lo = ar.left + pad - sr.left
      const hi = ar.right - pad - sr.right
      if (lo > hi + 0.5) return

      const delta = Math.max(lo, Math.min(hi, 0))
      if (Math.abs(delta) < 0.25) return

      const nextLeft = boxLayoutPx.left + delta
      setBoxLayoutPx((prev) => {
        if (!prev) return prev
        if (Math.abs(prev.left - nextLeft) < 0.25 && Math.abs(prev.width - boxLayoutPx.width) < 0.25) {
          return prev
        }
        return { left: nextLeft, width: prev.width }
      })
    }, [boxLayoutPx, portalRev, activeLineIndex, getWaveformMountAndArticleEl])

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

    /**
     * **EDL skip 표시 압축** — viewWin 안의 통합 컷(하드컷 + tombstone + 가상삭제) 을
     *  piecewise-linear 픽셀↔초 매핑으로 변환한다. 데이터/재생 시간은 미디어 축 그대로.
     *  - viewWin 이 없으면 항상 활성폭 0 의 *비어 있는* 매핑을 만들어 호출부의 null 분기를 줄인다 (skipMapping 이 항상 valid).
     *  - playbackSkipRanges 가 비어 있거나 viewWin 밖이면 `skipsClipped.length === 0` 이라 종래 선형 매핑과 동등.
     */
    const skipMapping = useMemo<EdlSkipMapping>(() => {
      const win = viewWin ?? { start: 0, end: 0 }
      const skips = playbackSkipRanges ?? []
      return buildEdlSkipMapping(win, skips)
    }, [viewWin, playbackSkipRanges])
    const skipMappingRef = useRef(skipMapping)
    skipMappingRef.current = skipMapping
    /**
     * **원본 skipRanges ref** — `clampNewSecToViewWinMedia` 가 *흡수 후의 가상 viewWin* 으로
     *  새 activeSpan 을 예측할 때, 현재 viewWin 에 클립된 `skipMapping.skipsClipped` 가 아니라
     *  *전체 원본 skip 리스트* 로 다시 build 해야 한다. ref 로 잡아 callback 의 stale closure 회피.
     */
    const playbackSkipRangesRef = useRef<ReadonlyArray<CutRange>>(playbackSkipRanges ?? [])
    playbackSkipRangesRef.current = playbackSkipRanges ?? []

    /**
     * **activeSpan 변동 시 박스 폭 재맞춤** — 같은 활성 단어/viewWin 상태에서 사용자가 *다른 단어를 삭제* 해
     *  새 tombstone 이 viewWin 안에 들어오면 `skipMapping.activeSpanSec` 가 감소한다. PPS 박제 정책상
     *  박스 픽셀 폭은 `pps × activeSpan` 이어야 표시 시간폭과 일치한다. lock effect 는 anchor 변경 시에만 도므로
     *  여기서 별도로 activeSpan 변경을 잡아 폭만 동기화.
     */
    useEffect(() => {
      const pps = ppsRef.current
      const layout = boxLayoutPxRef.current
      if (pps == null || layout == null) return
      const newWidth = pps * Math.max(skipMapping.activeSpanSec, 1e-6)
      if (Math.abs(layout.width - newWidth) < 0.5) return
      setBoxLayoutPx((prev) => {
        if (!prev) return prev
        if (Math.abs(prev.width - newWidth) < 0.5) return prev
        return { left: prev.left, width: newWidth }
      })
    }, [skipMapping])

    const contextClampLimits = useMemo(() => {
      if (!viewWin) return null
      const lo = Math.min(viewWin.start, viewWin.end)
      const hi = Math.max(viewWin.start, viewWin.end)
      if (!(hi > lo + 1e-9)) return null
      return { lo, hi }
    }, [viewWin])

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
       *  editRange 를 비우지 않고 그대로 둔다. 다음 렌더에 부모가 새 id 로 갱신하면
       *  centerWordIndex 가 다시 유효해져 이 effect 가 정상 경로로 들어간다.
       */
      if (activeLineIndex == null || !activeWordId) {
        setEditRange(null)
        return
      }
      if (centerWordIndex < 0) {
        // stale: 다음 렌더 기다림 — 기존 editRange 유지
        return
      }
      const w = rowsRef.current[activeLineIndex]?.words?.[centerWordIndex]
      if (!w) return
      const lo = Math.min(w.start, w.end)
      const hi = Math.max(w.start, w.end)
      setEditRange({ start: lo, end: hi })
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
    /**
     * 클라이언트 X 좌표 → 미디어 축 초. EDL skip 압축 매핑이 활성이면 piecewise-linear,
     *  매핑이 없으면(=skipsClipped 0 개) viewWin 선형. 출력은 항상 *미디어 축* 단일 정의.
     */
    const pointerToTimeOnStrip = useCallback((clientX: number): number => {
      const outer = zoomOuterRef.current
      const vw = viewWinRef.current
      const map = skipMappingRef.current
      if (!outer || !vw) return 0
      const rect = outer.getBoundingClientRect()
      const width = Math.max(rect.width, 1)
      const xPx = clampPx(clientX - rect.left, 0, width)
      if (map.activeSpanSec > 0) {
        return map.pixelToMediaSec(xPx, width)
      }
      const fr = xPx / width
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

    /**
     * `applyWordEdgeDrag` 축(미디어 초) — 현재 viewWin(=V0) 안으로 양방향 클램프.
     *  트림 핸들은 절대 V0 밖으로 못 나가고 viewWin 도 드래그 중 확장되지 않는다(스크롤 0).
     *  V0 끝에서 손을 떼면 commit 의 흡수 로직이 이웃 단어를 합치고, 그 결과 활성 단어의 start/end 가
     *  바뀌면 위쪽 layout effect 의 `anchorKey`(start/end 포함) 가 바뀌어 **±1 V0 를 새 단어 기준으로 재고정**.
     *  → 흡수된 쪽에 이전엔 보이지 않던 다음/이전 단어 파동이 자연스럽게 한 칸씩 붙는다.
     *
     * **카드 95% 흡수 차단** — PPS 가 박제된 상태에서, *다음 흡수가 발생하면* viewWin 시간폭이 늘어
     *  `pps × span` 으로 계산되는 박스 폭이 단어카드(`<article>`) 폭의 95% 를 넘는 경우,
     *  해당 방향의 클램프 한계를 흡수 임계점 직전(`±ABSORB_GUARD_SEC`)으로 좁혀
     *  사용자가 끝까지 끌어도 흡수가 발생하지 않게 한다. `Wwave > 0.95 × Wcard` 가 되는 시점부터는
     *  새 이웃 파동이 더 이상 추가되지 않으므로 카드 밖 짤림이 발생하지 않는다.
     */
    const clampNewSecToViewWinMedia = useCallback((sec: number): number => {
      const b = wordEdgeBridgeRef.current
      const vw = viewWinRef.current
      if (!b || !vw) return sec
      const loE = Math.min(vw.start, vw.end)
      const hiE = Math.max(vw.start, vw.end)
      const loM = b.editSecToMediaSec(loE)
      const hiM = b.editSecToMediaSec(hiE)
      let minE = Math.min(loM, hiM)
      let maxE = Math.max(loM, hiM)

      /** 카드 95% 상한 흡수 차단 — 미래 박스 폭 예측 */
      const pps = ppsRef.current
      const li = activeLineIndexRef.current
      const cwi = centerWordIndexRef.current
      const dir = lastTrimEdgeRef.current
      const ABSORB_GUARD_SEC = 0.005
      const MAX_WAVE_TO_CARD_RATIO = 0.95
      if (pps != null && li != null && cwi >= 0 && dir != null) {
        const rawMount = waveMountByLineRef.current.get(li)
        const mount = rawMount && rawMount.isConnected ? rawMount : null
        let article: HTMLElement | null = mount
        while (article && article.tagName.toLowerCase() !== 'article') {
          article = article.parentElement
        }
        if (article) {
          const Wcard = article.getBoundingClientRect().width
          const words = rowsRef.current[li]?.words ?? []
          const activeW = cwi >= 0 && cwi < words.length ? words[cwi] : null
          const mediaCap = metricsRef.current?.durationSec ?? Number.POSITIVE_INFINITY
          const limit = Wcard * MAX_WAVE_TO_CARD_RATIO
          if (Wcard > 1 && activeW) {
            /**
             * **미래 박스 폭 예측** — EDL skip 표시 압축 적용 후의 실제 시간폭(activeSpan) 으로 계산.
             *  - 흡수가 발생해도 트림 commit 의 tombstone 은 `mergedByEdgeTrim: true` 라
             *    `mergeWaveformPeaksStitchCutRanges` 에서 제외되어 *추가* 되지 않는다 (= 기존 컷 리스트 유지).
             *  - 새 viewWin 안에 들어오는 *기존 컷* 길이만 빼면 그 흡수 직후의 activeSpan 이 정확히 나옴.
             */
            const allSkips = playbackSkipRangesRef.current
            const futureActiveSpan = (ws: number, we: number): number => {
              if (!(we > ws + 1e-9)) return 0
              const m = buildEdlSkipMapping({ start: ws, end: we }, allSkips)
              return m.activeSpanSec
            }
            if (dir === 'end' && cwi + 1 < words.length) {
              const nextW = words[cwi + 1]!
              const newWords = words.slice()
              newWords.splice(cwi + 1, 1)
              const aStart = Math.min(activeW.start, activeW.end)
              const aEnd = Math.max(activeW.start, activeW.end)
              const nEnd = Math.max(nextW.start, nextW.end)
              newWords[cwi] = { ...activeW, start: aStart, end: Math.max(aEnd, nEnd) }
              const ctx = computeWordContextWindow(newWords, cwi, 0, 0, {
                mediaDurationSec: mediaCap
              })
              if (ctx) {
                const nextActive = Math.max(futureActiveSpan(ctx.windowStart, ctx.windowEnd), 1e-6)
                const nextWidth = pps * nextActive
                if (nextWidth > limit) {
                  const mediaNextEnd = b.editSecToMediaSec(nEnd)
                  const restricted = mediaNextEnd - ABSORB_GUARD_SEC
                  const newMaxE = Math.min(maxE, restricted)
                  if (newMaxE > minE + 1e-6) maxE = newMaxE
                }
              }
            } else if (dir === 'start' && cwi - 1 >= 0) {
              const prevW = words[cwi - 1]!
              const newWords = words.slice()
              newWords.splice(cwi - 1, 1)
              const newCwi = cwi - 1
              const aStart = Math.min(activeW.start, activeW.end)
              const aEnd = Math.max(activeW.start, activeW.end)
              const pStart = Math.min(prevW.start, prevW.end)
              newWords[newCwi] = { ...activeW, start: Math.min(aStart, pStart), end: aEnd }
              const ctx = computeWordContextWindow(newWords, newCwi, 0, 0, {
                mediaDurationSec: mediaCap
              })
              if (ctx) {
                const nextActive = Math.max(futureActiveSpan(ctx.windowStart, ctx.windowEnd), 1e-6)
                const nextWidth = pps * nextActive
                if (nextWidth > limit) {
                  const mediaPrevStart = b.editSecToMediaSec(pStart)
                  const restricted = mediaPrevStart + ABSORB_GUARD_SEC
                  const newMinE = Math.max(minE, restricted)
                  if (newMinE < maxE - 1e-6) minE = newMinE
                }
              }
            }
          }
        }
      }

      return clampPx(sec, minE, maxE)
    }, [waveMountByLineRef])

    const onWordEdgePreview = useCallback((result: EdgeDragResult) => {
      const b = wordEdgeBridgeRef.current
      if (!b) return
      /**
       * **SSOT 미리보기는 의도적으로 호출하지 않는다** — 드래그 중에는 단어블록이 움직이지 않고,
       *  포인터를 떼는 순간(`onCommit`)에 한 번에 합치기가 적용된다.
       *  트림 핸들 시각만 `setEditRange` 로 갱신한다. `viewWin` 은 기본 박제이며,
       *  핸들이 창 끝 밖으로 나가려 할 때만 `clampNewSecToViewWinMedia` 가 이웃 단어 구간을 붙인다.
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
        const vw = viewWinRef.current
        const wEditS = b.mediaSecToEditSec(lo)
        const wEditE = b.mediaSecToEditSec(hi)
        let atStart = Boolean(prevActive && Math.abs(w.start - prevActive.start) < limitEps)
        let atEnd = Boolean(nextActive && Math.abs(w.end - nextActive.end) < limitEps)
        if (vw) {
          const vLo = Math.min(vw.start, vw.end)
          const vHi = Math.max(vw.start, vw.end)
          if (Math.abs(wEditS - vLo) < limitEps) atStart = true
          if (Math.abs(wEditE - vHi) < limitEps) atEnd = true
        }
        const nextLimit: 'start' | 'end' | null = atStart ? 'start' : atEnd ? 'end' : null
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

      /**
       * **viewWin** — commit 시에는 `setViewWin` 하지 않음. 트림 중 이웃 붙이기는
       *  `clampNewSecToViewWinMedia` 가 담당한다.
       */

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
      clampNewSec: clampNewSecToViewWinMedia,
      onPreview: onWordEdgePreview,
      onCommit: onWordEdgeCommit,
      onDragFinish: onWordEdgeDragFinish,
      onDragRevert: (snapshot) => {
        wordEdgeBridgeRef.current?.onSubtitleLinesRevert?.(snapshot)
      }
    })

    /**
     * 트림 핸들 드래그 — 브리지 없을 때만 로컬 `editRange` 갱신. 한계는 `viewWin`(±1 이웃 V0) 과 동일.
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
            /** 흡수 commit 후 layout effect 가 어느 쪽 픽셀을 고정할지 결정 — 즉시 기록 */
            lastTrimEdgeRef.current = which
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
        const target = e.currentTarget
        try {
          target.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        setDraggingHandle(which === 'start' ? 'trimStart' : 'trimEnd')

        const move = (ev: PointerEvent): void => {
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
            const ns = clampPx(t, lo, e0 - minSpan)
            setEditRange({ start: ns, end: e0 })
          } else {
            const ne = clampPx(t, s + minSpan, hi)
            setEditRange({ start: s, end: ne })
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

    /**
     * 트림 핸들 좌·우 픽셀 위치 (%). EDL skip 압축 매핑 적용 시 *activeSpan* 기준 비율이라
     *  삭제 구간이 viewWin 안에 있어도 핸들이 시각적으로 압축된 위치에 정확히 붙는다.
     */
    const trimHandlePct = useMemo(() => {
      if (!viewWin || !editRange) return null
      const span = Math.max(skipMapping.activeSpanSec, 1e-9)
      const s = Math.min(editRange.start, editRange.end)
      const e = Math.max(editRange.start, editRange.end)
      const sActive = skipMapping.mediaSecToActiveSec(s)
      const eActive = skipMapping.mediaSecToActiveSec(e)
      return {
        startPct: clampPx((sActive / span) * 100, 0, 100),
        endPct: clampPx((eActive / span) * 100, 0, 100),
        startSec: s,
        endSec: e
      }
    }, [viewWin, editRange, skipMapping])

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
      const span = Math.max(skipMapping.activeSpanSec, 1e-9)
      const activeSec = skipMapping.mediaSecToActiveSec(cutSec)
      return {
        pct: clampPx((activeSec / span) * 100, 0, 100),
        sec: cutSec
      }
    }, [viewWin, cutSec, skipMapping])

    /**
     * 재생 중 cut 라인 위치/라벨을 **React 리렌더 없이** App 의 매 프레임 콜백 안에서
     * 직접 DOM 갱신하기 위한 ref/상태.
     *  - `cutLineLabelRef` : 시간 라벨 (`fmtSec` 결과를 textContent 로 imperative 갱신)
     *  - `cutLineSliderRef`: 캔버스 내부 자르기·재생 슬라이더 (style.left 만 갱신)
     *  - 재생 중 React 가 SubtitleWaveformCanvas 를 리렌더하지 않도록 `setCutSec` 호출은
     *    drag/seek/start/stop 시점에만 — 재생 도중에는 어떠한 state 도 변경 안 함.
     */
    const cutLineLabelRef = useRef<HTMLSpanElement | null>(null)
    const cutLineSliderRef = useRef<HTMLDivElement | null>(null)
    const cutLineHandleRef = useRef<HTMLDivElement | null>(null)
    const isCutLinePlayingMotion = isPlaying && draggingHandle !== 'cut'

    /**
     * **fmtSec 의 ref-안정 버전** — `useCallback` 으로 받지 못한 외부 prop fn 을 ref 로 보관해
     * 재생 중 라벨 텍스트 imperative 갱신에서 dep 변화로 인한 effect 재시작 없이 사용.
     */
    const fmtSecRef = useRef(fmtSec)
    fmtSecRef.current = fmtSec

    /**
     * **paintCutLine perf 누산기** — App tick 의 `syncPlayheadFromEditSec` 진입 횟수와
     * 그 안에서 paintCutLine 이 실제 DOM 갱신을 한 횟수를 분리해 측정한다.
     * tick 수 ≠ paint 수 면 early-return 분기(refs stale/유효 범위 아님 등) 가 의심됨.
     */
    const paintPerfRef = useRef<{
      active: boolean
      calls: number
      shorts: number
      pxMin: number
      pxMax: number
      sumPaintMs: number
      maxPaintMs: number
      lastPct: number
      maxPctJumpPx: number
    }>({
      active: false,
      calls: 0,
      shorts: 0,
      pxMin: 1e9,
      pxMax: -1e9,
      sumPaintMs: 0,
      maxPaintMs: 0,
      lastPct: -1,
      maxPctJumpPx: 0
    })

    /**
     * playhead(editSec) 를 받아 cut 라인 두 DOM 의 `style.left` 와 라벨 텍스트를 즉시 갱신.
     *  - `paintCutLine(editT)` 는 App 의 매 frame `commitEditSecToUi → syncPlayheadFromEditSec`
     *    체인에서 호출되어 1-프레임 lag 없이 즉시 paint 전 좌표 반영.
     *  - 별도 rAF 루프 불필요(이전엔 두 rAF 순서 문제로 1프레임 지연 발생) — App 의 tick 에 piggyback.
     */
    const paintCutLine = useCallback(
      (editT: number): void => {
        const t0 = performance.now()
        const er = editRangeRef.current
        const map = skipMappingRef.current
        const perf = paintPerfRef.current
        if (!er || !map) {
          if (perf.active) perf.shorts += 1
          return
        }
        if (typeof editT !== 'number' || !Number.isFinite(editT)) {
          if (perf.active) perf.shorts += 1
          return
        }
        const s = Math.min(er.start, er.end)
        const e = Math.max(er.start, er.end)
        if (!(e > s + 1e-9)) {
          if (perf.active) perf.shorts += 1
          return
        }
        const live = Math.min(e, Math.max(s, editT))
        const span = Math.max(map.activeSpanSec, 1e-9)
        const activeSec = map.mediaSecToActiveSec(live)
        const pct = clampPx((activeSec / span) * 100, 0, 100)
        const lt = `${pct}%`
        const lbl = cutLineLabelRef.current
        const sld = cutLineSliderRef.current
        const hdl = cutLineHandleRef.current
        if (lbl) {
          if (lbl.style.left !== lt) lbl.style.left = lt
          const txt = fmtSecRef.current(live)
          if (lbl.textContent !== txt) lbl.textContent = txt
        }
        if (sld) {
          if (sld.style.left !== lt) sld.style.left = lt
        }
        if (hdl) {
          if (hdl.style.left !== lt) hdl.style.left = lt
        }
        if (perf.active) {
          perf.calls += 1
          if (pct < perf.pxMin) perf.pxMin = pct
          if (pct > perf.pxMax) perf.pxMax = pct
          const dt = performance.now() - t0
          perf.sumPaintMs += dt
          if (dt > perf.maxPaintMs) perf.maxPaintMs = dt
          if (perf.lastPct >= 0) {
            const jump = Math.abs(pct - perf.lastPct)
            if (jump > perf.maxPctJumpPx) perf.maxPctJumpPx = jump
          }
          perf.lastPct = pct
        }
      },
      []
    )

    /**
     * **React 렌더 직후 1회 동기 보정** (브라우저 paint 전).
     *  - isCutLinePlayingMotion 이 true 로 막 전환된 직후엔 JSX 의 `left` 가 비워져 React 가 inline `left`
     *    를 지운 상태로 commit → 곧바로 paintCutLine 으로 복원.
     *  - 재생 중에는 cutSec/cutLinePct 가 바뀌지 않으므로 SubtitleWaveformCanvas 리렌더 자체가 거의 없음.
     *  - deps 없음 → 매 렌더마다 동작하되 isCutLinePlayingMotion 가 false 면 즉시 return.
     */
    useLayoutEffect(() => {
      if (!isCutLinePlayingMotion) return
      const editT = playheadEditSecRef?.current
      if (typeof editT === 'number' && Number.isFinite(editT)) paintCutLine(editT)
    })

    /**
     * **재생 세션 단위 paintCutLine perf 송신** — App 의 rAF tick 측정 (App side perf)
     * 과 짝이 되어, "App 이 호출한 횟수" vs "Canvas 가 실제 paint 한 횟수" 가 일치하는지
     * 확인할 수 있다. 일치하면 imperative chain 정상, 차이 나면 early-return 분기 의심.
     */
    useEffect(() => {
      const perf = paintPerfRef.current
      if (isPlaying) {
        perf.active = true
        perf.calls = 0
        perf.shorts = 0
        perf.pxMin = 1e9
        perf.pxMax = -1e9
        perf.sumPaintMs = 0
        perf.maxPaintMs = 0
        perf.lastPct = -1
        perf.maxPctJumpPx = 0
      } else if (perf.calls > 0 || perf.shorts > 0) {
        wfLog('perf', 'paintCutLine session', {
          calls: perf.calls,
          shorts: perf.shorts,
          pctMin: +perf.pxMin.toFixed(2),
          pctMax: +perf.pxMax.toFixed(2),
          pctSpan: +(perf.pxMax - perf.pxMin).toFixed(2),
          maxPctJump: +perf.maxPctJumpPx.toFixed(2),
          avgPaintMs:
            perf.calls > 0 ? +(perf.sumPaintMs / perf.calls).toFixed(3) : 0,
          maxPaintMs: +perf.maxPaintMs.toFixed(3)
        })
        perf.active = false
      } else {
        perf.active = false
      }
    }, [isPlaying])

    /**
     * 재생 토글 시 will-change 힌트만 토글 — GPU 레이어 합성 비용을 idle 상태에서 회수.
     */
    useEffect(() => {
      const lbl = cutLineLabelRef.current
      const sld = cutLineSliderRef.current
      const hdl = cutLineHandleRef.current
      if (isCutLinePlayingMotion) {
        if (lbl) lbl.style.willChange = 'left'
        if (sld) sld.style.willChange = 'left'
        if (hdl) hdl.style.willChange = 'left'
      } else {
        if (lbl) {
          lbl.style.willChange = ''
          lbl.style.transition = ''
        }
        if (sld) {
          sld.style.willChange = ''
          sld.style.transition = ''
        }
        if (hdl) {
          hdl.style.willChange = ''
          hdl.style.transition = ''
        }
      }
    }, [isCutLinePlayingMotion])

    /** 라벨이 박스 밖으로 옮겨졌으므로 상단 패딩은 최소만(중심선 여유) */
    const WAVE_TOP_LABEL_BAND_PX = 4
    /** 진폭 게인 — 박스 크기를 키우지 않고 막대만 더 크게 보이게 (전 영역 사용) */
    const WAVE_PEAK_GAIN = 2.0

    /**
     * 메인 파형 그리기.
     *
     * **EDL skip 표시 압축** — `skipMapping` 을 `drawWaveformCanvas` 에 넘기면 픽셀→시간 변환이
     *  piecewise-linear 로 동작해 삭제 구간(tombstone/하드컷) 의 시간대는 어떤 픽셀도 매핑되지 않아
     *  완전히 사라지고 양옆 활성 파동이 시각적으로 이어붙는다.
     *  - `deletedRanges` (= `collectDeletedRangesSec` 의 row 기반 결과) 는 호환을 위해 그대로 넘기지만
     *    `skipMapping` 적용 시 어떤 픽셀도 그 구간에 매핑되지 않아 muted 분기는 dead.
     */
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
          gain: WAVE_PEAK_GAIN,
          skipMapping
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
    }, [
      metrics,
      viewWin,
      activeWordSpan,
      waveFillBands,
      mountLayoutKey,
      rows,
      activeLineIndex,
      skipMapping
    ])

    /**
     * App 의 `commitEditSecToUi` → `syncPlayheadFromEditSec(editSec)` 진입점.
     *  - 재생 중: `paintCutLine(editT)` 로 cut 라인 DOM 만 imperative 갱신 (React 리렌더 0).
     *  - 정지 중: 사용자의 드래그/seek 가 cutSec 의 단일 출처이므로 어떤 갱신도 하지 않음.
     *
     * **이전 구현 (setCutSec throttle 25Hz)** 의 문제:
     *  - 25Hz React 리렌더 → 매번 큰 컴포넌트 reconcile → 50–100ms longtask 다발 → 화면이 그 동안 freeze.
     *  - App tick rAF 와 별도 rAF 가 비결정 순서로 돌아 한 프레임 lag 발생.
     *  → 두 문제 모두 “재생 중 setCutSec 미호출 + App tick 콜백 안에서 직접 DOM paint” 로 제거.
     */
    const syncPlayheadLineFromEditSec = useCallback(
      (editT: number) => {
        const oldYellow = playheadLineRef.current
        oldYellow?.style.setProperty('opacity', '0')
        oldYellow?.style.setProperty('visibility', 'hidden')

        if (!isPlayingWaveRef.current) return
        if (typeof editT !== 'number' || !Number.isFinite(editT)) return
        paintCutLine(editT)
      },
      [paintCutLine]
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
     *
     * **위치 박제 정책** — 같은 활성 단어 동안 트림으로 칩 폭/위치가 바뀌어도 연결선은 처음 측정한 좌표로 고정.
     *   다른 단어를 더블클릭(`activeWordId` 변경) 하면 그 시점 한 번 재측정.
     */
    const connectorAnchorRef = useRef<string | null>(null)
    const recomputeConnectorGeom = useCallback((force = false): void => {
      if (!activeWordId || !articleEl || !trimHandlePct) {
        setConnectorGeom(null)
        connectorAnchorRef.current = null
        return
      }
      const anchorKey = `${activeLineIndex ?? -1}|${activeWordId}`
      if (!force && connectorAnchorRef.current === anchorKey) return

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
      connectorAnchorRef.current = anchorKey
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
    }, [activeLineIndex, activeWordId, articleEl, trimHandlePct, boxLayoutPx])

    /** 활성 단어 / 줄 변경 시 한 번 재측정 (paint 전) */
    useLayoutEffect(() => {
      connectorAnchorRef.current = null
      recomputeConnectorGeom(true)
    }, [activeLineIndex, activeWordId, articleEl, boxLayoutPx, recomputeConnectorGeom])

    /**
     * **첫 측정이 한 프레임 늦게 들어오는 케이스** — 칩이 아직 렌더 전이면 위 effect 가 조용히 실패한다.
     *  ResizeObserver 로 카드 layout 첫 안정화만 잡아서 1회 측정 후 즉시 자기 자신을 해제.
     *  그 다음 트림으로 인한 layout 변화는 무시 → 연결선 박제.
     */
    useEffect(() => {
      if (!articleEl) return
      if (connectorAnchorRef.current != null) return
      let settled = false
      const ro = new ResizeObserver(() => {
        if (settled) return
        recomputeConnectorGeom(true)
        if (connectorAnchorRef.current != null) {
          settled = true
          ro.disconnect()
        }
      })
      ro.observe(articleEl)
      const waveEl = zoomOuterRef.current
      if (waveEl) ro.observe(waveEl)
      return () => ro.disconnect()
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
     *
     * **부드러운 rewind 애니메이션 (시각 점프 방지)**
     *  - 단순 `setCutSec(start)` 만 호출하면 React 가 즉시 새 `left` 를 commit → cut 라인이
     *    오른쪽 끝에서 왼쪽 시작점까지 **순간 이동(teleport)** → 짧은 단어일수록 "막 건너뜀" 으로 체감.
     *  - 따라서 transition: left 220ms 를 켠 뒤, **다음 rAF 에서** setCutSec 을 호출해
     *    React 가 새 `left` 를 commit 하는 시점에 브라우저가 부드럽게 보간하도록 한다.
     *  - 220ms 후 transition 을 제거해 다음 사용자 드래그가 지연되지 않게 회수.
     *  - cleanup 에서도 즉시 회수 — 사용자가 rewind 도중 다시 ▶ 누르면 paintCutLine 이 transition 없이
     *    즉시 동작해야 함.
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

      const animTargets = [
        cutLineLabelRef.current,
        cutLineSliderRef.current,
        cutLineHandleRef.current
      ].filter((el): el is HTMLElement => el != null)

      const REWIND_MS = 220
      const TRANSITION = `left ${REWIND_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`
      animTargets.forEach((el) => {
        el.style.transition = TRANSITION
        el.style.willChange = 'left'
      })

      /**
       * **rAF 다음 frame 에서 setCutSec** — transition 을 DOM 에 commit 한 뒤 left 가 바뀌어야
       * 브라우저가 보간을 트리거. 같은 task 안에서 둘 다 바꾸면 "최종값으로 즉시 이동" 처럼 보일 수 있다.
       */
      const rafId = window.requestAnimationFrame(() => {
        setCutSec(back)
      })

      const tid = window.setTimeout(() => {
        animTargets.forEach((el) => {
          el.style.transition = ''
          el.style.willChange = ''
        })
      }, REWIND_MS + 40)

      return (): void => {
        window.cancelAnimationFrame(rafId)
        window.clearTimeout(tid)
        animTargets.forEach((el) => {
          el.style.transition = ''
          el.style.willChange = ''
        })
      }
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
        <div
          className="subtitle-waveform-flow-root relative w-full min-w-0"
          style={{ overflow: 'visible' }}
        >
          <div
            className="subtitle-waveform-stack w-full min-w-0 px-1 pb-1 pt-0"
            style={{ overflow: 'visible' }}
          >
            <div className="w-full min-w-0" style={{ overflow: 'visible' }}>
              {/*
                패널 가로 위치 — `--subwave-panel-left-px` 가 있으면 그 픽셀만큼 왼쪽에서 시프트,
                없으면 `margin: 0 auto` 로 가운데 정렬. 부모(`SubtitleVirtualList`) 가 활성 단어 칩
                중앙을 기준으로 계산해 카드 영역 안에서 클램프한 값을 넣어 준다.
              */}
              <div
                ref={waveStripBoxRef}
                className="min-w-0"
                style={
                  boxLayoutPx != null
                    ? {
                        marginLeft: `${boxLayoutPx.left}px`,
                        marginRight: 0,
                        width: `${boxLayoutPx.width}px`,
                        maxWidth: 'none'
                      }
                    : {
                        marginLeft: 'var(--subwave-panel-left-px, auto)',
                        marginRight: 'auto',
                        width: 'min(100%, 28rem)',
                        maxWidth: '100%'
                      }
                }
              >
                {/*
                  ── 박스 위쪽 라벨 + 자르기 핸들 스트립 ──
                  자르기(=재생) 라인의 현재 시간 라벨(상단) 과 ▽ 역삼각형 그립(하단) 이 같은 X 위치에서
                  세로로 쌓인다. 박스 외부라 `overflow-hidden` 제약이 없어 ▽ 크기를 충분히 키울 수 있다.
                  ▽ 의 hit-zone 이 자르기 드래그 진입점 — 박스 안의 dashed 라인은 시각만(pointer-events-none).
                */}
                {activeWordId && cutLinePct != null ? (
                  <div className="relative mb-1 h-9 w-full">
                    <span
                      ref={cutLineLabelRef}
                      className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-md bg-sky-500 px-1.5 py-[2px] font-mono text-[10px] font-semibold leading-tight text-white shadow-[0_2px_6px_rgba(2,132,199,0.55)]"
                      style={
                        isCutLinePlayingMotion
                          ? { top: 0 }
                          : { left: `${cutLinePct.pct}%`, top: 0 }
                      }
                    >
                      {fmtSec(cutLinePct.sec)}
                    </span>
                    {/**
                     * ▽ 역삼각형 그립 — 박스 외부에 위치해 크기 자유. CSS border 트릭으로 그림.
                     *  - 시각 size: 30px(가로) × 22px(세로) — 라인의 “큰 화살촉” 처럼 보임.
                     *  - hit-zone: 가로 40px × 세로 28px (여백 포함) — 정확히 잡기 쉬움.
                     *  - apex 가 박스 상단을 향해 박스 아래쪽 시작점에 자연스럽게 이어짐.
                     */}
                    <div
                      ref={cutLineHandleRef}
                      className="absolute -translate-x-1/2 cursor-ew-resize touch-none"
                      style={
                        isCutLinePlayingMotion
                          ? { bottom: -4, width: 40, height: 28 }
                          : { left: `${cutLinePct.pct}%`, bottom: -4, width: 40, height: 28 }
                      }
                      onPointerDown={onCutLinePointerDown}
                      role="slider"
                      aria-label="자르기·재생 시작 라인"
                    >
                      <div
                        className="pointer-events-none absolute left-1/2 bottom-0 -translate-x-1/2 transition-opacity duration-75"
                        style={{
                          width: 0,
                          height: 0,
                          borderLeft: '15px solid transparent',
                          borderRight: '15px solid transparent',
                          borderTop: '22px solid rgb(56 189 248)',
                          filter: 'drop-shadow(0 2px 3px rgba(2,132,199,0.55))',
                          opacity: draggingHandle === 'cut' ? 0.45 : 1
                        }}
                        aria-hidden
                      />
                    </div>
                  </div>
                ) : null}

                {/* 흰 라인 둥근 사각형 — 안쪽으로 파형·핸들·자르기 라인만 (라벨은 위 스트립으로 분리) */}
                <div
                  ref={zoomOuterRef}
                  className="relative isolate h-36 w-full min-w-0 overflow-hidden rounded-xl border-2 border-white/85 bg-[#0c1018]"
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

                  {/**
                   * 자르기·재생 라인 — 박스 안에는 dashed 라인(시각만) 만 그림.
                   *  드래그 hit-zone 과 ▽ 그립은 박스 외부 상단 라벨 스트립으로 분리됨 (`cutLineHandleRef`).
                   *  - 그 결과 트림 핸들의 가운데 □ 그립과 같은 X 라도 클릭 충돌 없음.
                   */}
                  {cutLinePct != null && activeWordId ? (
                    <div className="pointer-events-none absolute inset-0 z-[60]">
                      <div
                        ref={cutLineSliderRef}
                        className="pointer-events-none absolute inset-y-0 w-8 -translate-x-1/2"
                        style={
                          isCutLinePlayingMotion ? undefined : { left: `${cutLinePct.pct}%` }
                        }
                        aria-hidden
                      >
                        <div
                          className="pointer-events-none absolute inset-y-1 left-1/2 -translate-x-1/2 transition-opacity duration-75"
                          style={{
                            width: 0,
                            borderLeft: '2px dashed rgb(56 189 248)',
                            opacity: draggingHandle === 'cut' ? 0.25 : 1
                          }}
                        />
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
                      <img
                        src={isPlaying ? pauseIconUrl : playIconUrl}
                        alt=""
                        aria-hidden
                        draggable={false}
                        className="h-5 w-5 select-none"
                      />
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
                      <img
                        src={cutIconUrl}
                        alt=""
                        aria-hidden
                        draggable={false}
                        className="h-5 w-5 select-none"
                      />
                    </button>
                    <button
                      type="button"
                      aria-label="되돌리기"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-300/45 bg-white text-slate-800 shadow-md transition hover:bg-slate-50"
                      onClick={() => onUndo?.()}
                    >
                      <img
                        src={undoIconUrl}
                        alt=""
                        aria-hidden
                        draggable={false}
                        className="h-5 w-5 select-none"
                      />
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
