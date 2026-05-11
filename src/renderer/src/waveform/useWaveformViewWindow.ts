import type { Dispatch, PointerEvent, RefObject, SetStateAction, WheelEvent } from 'react'
import { useCallback, useRef, useState } from 'react'
import type { PeaksTimelineMetrics } from './peakPixelMapping'

export type ViewTimeWindow = { start: number; end: number }

/**
 * 파형 줌 스트립 패닝·휠 줌 — Canvas 파형 패널 공통
 */
export function useWaveformViewWindow(
  metrics: PeaksTimelineMetrics | null,
  zoomOuterRef: RefObject<HTMLDivElement | null>
): {
  viewWin: ViewTimeWindow | null
  setViewWin: Dispatch<SetStateAction<ViewTimeWindow | null>>
  viewWinRef: { current: ViewTimeWindow | null }
  onZoomPointerDown: (e: PointerEvent<HTMLDivElement>) => void
  onZoomPointerMove: (e: PointerEvent<HTMLDivElement>) => void
  onZoomPointerUp: (e: PointerEvent<HTMLDivElement>) => void
  onZoomWheel: (e: WheelEvent<HTMLDivElement>) => void
} {
  const [viewWin, setViewWin] = useState<ViewTimeWindow | null>(null)
  const viewWinRef = useRef<ViewTimeWindow | null>(null)
  viewWinRef.current = viewWin

  const panRef = useRef<{ startX: number; win0: ViewTimeWindow } | null>(null)

  const onZoomPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!metrics || !viewWinRef.current) return
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      panRef.current = { startX: e.clientX, win0: { ...viewWinRef.current } }
    },
    [metrics]
  )

  const onZoomPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const p = panRef.current
      if (!p || !metrics) return
      const outer = zoomOuterRef.current
      if (!outer) return
      const w = outer.clientWidth
      if (w < 8) return
      const dx = e.clientX - p.startX
      const span0 = p.win0.end - p.win0.start
      const dSec = (-dx / w) * span0
      const dur = metrics.durationSec
      let ns = p.win0.start + dSec
      let ne = p.win0.end + dSec
      if (ns < 0) {
        ne -= ns
        ns = 0
      }
      if (ne > dur) {
        const over = ne - dur
        ns -= over
        ne = dur
        if (ns < 0) ns = 0
      }
      if (ne > ns + 1e-6) setViewWin({ start: ns, end: ne })
    },
    [metrics, zoomOuterRef]
  )

  const onZoomPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    panRef.current = null
  }, [])

  const onZoomWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>) => {
      if (!metrics || !viewWinRef.current) return
      e.preventDefault()
      const outer = zoomOuterRef.current
      if (!outer) return
      const w = outer.clientWidth
      const rect = outer.getBoundingClientRect()
      const mx = (e.clientX - rect.left) / Math.max(w, 1)
      const vw = viewWinRef.current
      const tAtMx = vw.start + mx * (vw.end - vw.start)
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12
      let half = (vw.end - vw.start) * 0.5 * factor
      const minSpan = 0.05
      const maxSpan = metrics.durationSec
      half = Math.min(Math.max(half, minSpan), maxSpan)
      let ns = tAtMx - half * mx
      let ne = tAtMx + half * (1 - mx)
      if (ns < 0) {
        ne -= ns
        ns = 0
      }
      if (ne > metrics.durationSec) {
        const over = ne - metrics.durationSec
        ns -= over
        ne = metrics.durationSec
        if (ns < 0) ns = 0
      }
      if (ne > ns + 1e-6) setViewWin({ start: ns, end: ne })
    },
    [metrics, zoomOuterRef]
  )

  return {
    viewWin,
    setViewWin,
    viewWinRef,
    onZoomPointerDown,
    onZoomPointerMove,
    onZoomPointerUp,
    onZoomWheel
  }
}
