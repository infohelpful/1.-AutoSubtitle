import type { JsonWaveformData } from '../../../../shared/waveformJson'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { computeLineZoomWindow } from '../../lineZoomWindow'
import { resolvePeaksTimelineMetrics } from '../../waveform/peakPixelMapping'
import {
  collectDeletedRangesSec,
  drawOverviewWaveformViewport,
  drawWaveformCanvas
} from '../../waveform/waveformCanvasDrawing'
import { useWaveformViewWindow } from '../../waveform/useWaveformViewWindow'
import type { Word } from './types'
import {
  applyBoundaryDrag,
  sortWordsByStart,
  type BoundaryDragTarget
} from './wordBoundaryTimes'

const ZOOM_H_TAILWIND = 112

function secToPct(sec: number, winStart: number, winEnd: number): number {
  const a = Math.min(winStart, winEnd)
  const b = Math.max(winStart, winEnd)
  const span = Math.max(b - a, 1e-9)
  const p = ((sec - a) / span) * 100
  return Math.min(100, Math.max(0, p))
}

function clientXToSec(
  clientX: number,
  rect: DOMRect,
  winStart: number,
  winEnd: number
): number {
  const a = Math.min(winStart, winEnd)
  const b = Math.max(winStart, winEnd)
  const span = Math.max(b - a, 1e-9)
  const mx = (clientX - rect.left) / Math.max(rect.width, 1)
  return a + mx * span
}

function handleSpecs(sorted: Word[]): Array<{ target: BoundaryDragTarget; sec: number }> {
  const out: Array<{ target: BoundaryDragTarget; sec: number }> = []
  if (sorted.length === 0) return out
  out.push({ target: { kind: 'first-start' }, sec: sorted[0]!.start })
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i]!
    const right = sorted[i + 1]!
    const sec = (left.end + right.start) * 0.5
    out.push({ target: { kind: 'between', leftIndex: i }, sec })
  }
  out.push({ target: { kind: 'last-end' }, sec: sorted[sorted.length - 1]!.end })
  return out
}

export type VrewRowWaveformCanvasHandle = {
  setViewWindow: (start: number, end: number) => void
}

export type VrewRowWaveformCanvasProps = {
  peaksJson: JsonWaveformData
  words: readonly Word[]
  activeWordId: string | null
  mediaDurationHintSec?: number
  /** 경계 드래그 종료 시 — Peaks `segments.dragend` 와 동일하게 부모에서 행 병합 처리 */
  onRowWordsCommit?: (nextWords: Word[]) => void
}

export const VrewRowWaveformCanvas = forwardRef<VrewRowWaveformCanvasHandle, VrewRowWaveformCanvasProps>(
  function VrewRowWaveformCanvas(
    { peaksJson, words, activeWordId, mediaDurationHintSec, onRowWordsCommit },
    ref
  ) {
    const zoomCanvasRef = useRef<HTMLCanvasElement>(null)
    const zoomOuterRef = useRef<HTMLDivElement | null>(null)
    const overviewCanvasRef = useRef<HTMLCanvasElement>(null)
    const overviewOuterRef = useRef<HTMLDivElement | null>(null)

    const OVERVIEW_H = 80

    const [dragPreview, setDragPreview] = useState<Word[] | null>(null)
    const dragTargetRef = useRef<BoundaryDragTarget | null>(null)
    const wordsAtDragStartRef = useRef<Word[] | null>(null)

    const mediaHint =
      mediaDurationHintSec != null && mediaDurationHintSec > 0 ? mediaDurationHintSec : undefined
    const metrics = useMemo(
      () => resolvePeaksTimelineMetrics(peaksJson, mediaHint),
      [peaksJson, mediaHint]
    )

    const {
      viewWin,
      setViewWin,
      viewWinRef,
      onZoomPointerDown,
      onZoomPointerMove,
      onZoomPointerUp,
      onZoomWheel
    } = useWaveformViewWindow(metrics, zoomOuterRef)

    const wordsStructureKey = useMemo(() => words.map((w) => w.id).join(';'), [words])

    const wordsKey = useMemo(
      () => words.map((w) => `${w.id}|${w.start}|${w.end}`).join(';'),
      [words]
    )

    useLayoutEffect(() => {
      if (!metrics) return
      const win = words.length
        ? computeLineZoomWindow(words, {
            mediaDurationSec: metrics.durationSec,
            clipTrailingToLineEnd: true,
            clipLeadingToLineStart: true
          })
        : null
      if (!win) return
      setViewWin({ start: win.windowStart, end: win.windowEnd })
    }, [metrics, wordsStructureKey, words.length, setViewWin])

    useImperativeHandle(
      ref,
      () => ({
        setViewWindow: (start: number, end: number) => {
          if (end > start + 1e-6) setViewWin({ start, end })
        }
      }),
      [setViewWin]
    )

    const displayWords = dragPreview ?? words

    const activeWordSpan = useMemo(() => {
      if (activeWordId == null) return null
      const w = displayWords.find((x) => x.id === activeWordId)
      if (!w) return null
      return { start: w.start, end: w.end }
    }, [displayWords, activeWordId])

    const sortedDisplay = useMemo(() => sortWordsByStart(displayWords), [displayWords])
    const boundaryUi = useMemo(() => handleSpecs(sortedDisplay), [sortedDisplay])

    const mountKey = `${wordsKey}|${viewWin?.start ?? 0}|${viewWin?.end ?? 0}|${dragPreview ? 'd' : ''}`

    useEffect(() => {
      const canvas = zoomCanvasRef.current
      const outer = zoomOuterRef.current
      if (!canvas || !outer || !metrics || !viewWin) return
      const winStart = Math.min(viewWin.start, viewWin.end)
      const winEnd = Math.max(viewWin.start, viewWin.end)
      const deletedRanges = collectDeletedRangesSec(displayWords, winStart, winEnd)
      const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1
      const h = outer.clientHeight || ZOOM_H_TAILWIND

      const paint = (): void => {
        drawWaveformCanvas(
          canvas,
          metrics,
          winStart,
          winEnd,
          deletedRanges,
          h,
          dpr,
          activeWordSpan
            ? { dimOutside: { leftSec: activeWordSpan.start, rightSec: activeWordSpan.end } }
            : undefined
        )
      }
      paint()
      const ro = new ResizeObserver(() => window.requestAnimationFrame(paint))
      ro.observe(outer)
      return () => ro.disconnect()
    }, [metrics, viewWin, activeWordSpan, displayWords, mountKey])

    useEffect(() => {
      const canvas = overviewCanvasRef.current
      const outer = overviewOuterRef.current
      if (!canvas || !outer || !metrics || !viewWin) return
      const paint = (): void => {
        drawOverviewWaveformViewport(canvas, metrics, viewWin, OVERVIEW_H)
      }
      paint()
      const ro = new ResizeObserver(() => window.requestAnimationFrame(paint))
      ro.observe(outer)
      return () => ro.disconnect()
    }, [metrics, viewWin, mountKey])

    const applyDragMove = useCallback(
      (clientX: number): void => {
        const outer = zoomOuterRef.current
        const vw = viewWinRef.current
        const m = metrics
        const target = dragTargetRef.current
        const base = wordsAtDragStartRef.current
        if (!outer || !vw || !m || !target || !base.length) return
        const rect = outer.getBoundingClientRect()
        const newT = clientXToSec(clientX, rect, vw.start, vw.end)
        const sorted = sortWordsByStart(base)
        const prevById = new Map<string, Word>(base.map((w) => [w.id, w]))
        const next = applyBoundaryDrag(prevById, sorted, target, newT, m.durationSec)
        setDragPreview(next)
      },
      [metrics, viewWinRef]
    )

    const endBoundaryDrag = useCallback(
      (ev: ReactPointerEvent): void => {
        try {
          ;(ev.target as HTMLElement).releasePointerCapture(ev.pointerId)
        } catch {
          /* ignore */
        }
        dragTargetRef.current = null
        wordsAtDragStartRef.current = null
        setDragPreview((prev) => {
          if (prev && onRowWordsCommit) {
            onRowWordsCommit(prev)
          }
          return null
        })
      },
      [onRowWordsCommit]
    )

    const onBoundaryPointerDown = useCallback(
      (e: ReactPointerEvent, target: BoundaryDragTarget) => {
        if (!onRowWordsCommit || !metrics) return
        e.stopPropagation()
        wordsAtDragStartRef.current = [...words]
        dragTargetRef.current = target
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        applyDragMove(e.clientX)
      },
      [onRowWordsCommit, metrics, words, applyDragMove]
    )

    const onBoundaryPointerMove = useCallback(
      (e: ReactPointerEvent) => {
        if (!dragTargetRef.current) return
        e.stopPropagation()
        applyDragMove(e.clientX)
      },
      [applyDragMove]
    )

    const onBoundaryPointerUp = useCallback(
      (e: ReactPointerEvent) => {
        if (!dragTargetRef.current) return
        e.stopPropagation()
        endBoundaryDrag(e)
      },
      [endBoundaryDrag]
    )

    if (!metrics) {
      return (
        <div className="rounded-lg border border-vrew-border bg-vrew-bg px-2 py-2 text-xs text-vrew-muted">
          피크 데이터를 읽을 수 없습니다.
        </div>
      )
    }

    const winStart = viewWin ? Math.min(viewWin.start, viewWin.end) : 0
    const winEnd = viewWin ? Math.max(viewWin.start, viewWin.end) : 1

    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div
          ref={zoomOuterRef}
          className="relative isolate h-28 w-full min-w-0 cursor-grab overflow-hidden rounded-lg border border-vrew-border bg-[#0c1018] active:cursor-grabbing"
          onPointerDown={onZoomPointerDown}
          onPointerMove={onZoomPointerMove}
          onPointerUp={onZoomPointerUp}
          onPointerCancel={onZoomPointerUp}
          onWheel={onZoomWheel}
        >
          <canvas ref={zoomCanvasRef} className="pointer-events-none absolute inset-0 block h-full w-full" />
          {viewWin && onRowWordsCommit && boundaryUi.length > 0 ? (
            <div className="pointer-events-none absolute inset-0 z-10">
              {boundaryUi.map((h, idx) => (
                <button
                  key={`${h.target.kind}-${idx}`}
                  type="button"
                  tabIndex={-1}
                  aria-label="단어 경계"
                  className="pointer-events-auto absolute top-0 h-full min-w-[14px] -translate-x-1/2 cursor-ew-resize border-0 bg-transparent p-0 outline-none ring-vrew-accent/40 focus-visible:ring-2"
                  style={{ left: `${secToPct(h.sec, winStart, winEnd)}%` }}
                  onPointerDown={(e) => {
                    onBoundaryPointerDown(e, h.target)
                  }}
                  onPointerMove={onBoundaryPointerMove}
                  onPointerUp={onBoundaryPointerUp}
                  onPointerCancel={onBoundaryPointerUp}
                >
                  <span className="pointer-events-none absolute inset-y-1 left-1/2 block w-0.5 -translate-x-1/2 rounded-sm bg-sky-400/90 shadow-sm" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div
          ref={overviewOuterRef}
          className="relative h-20 w-full min-w-0 overflow-hidden rounded-lg border border-vrew-border bg-[#0c1018]"
        >
          <canvas ref={overviewCanvasRef} className="block h-full w-full" />
        </div>
        <p className="text-[10px] text-vrew-muted/90">
          Canvas 파형 — 드래그 이동 · 휠 줌 · 세로 막대로 단어 경계 (Peaks 없음)
        </p>
      </div>
    )
  }
)
