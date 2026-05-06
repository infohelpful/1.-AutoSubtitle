import { createPortal } from 'react-dom'
import type { MutableRefObject, ReactPortal } from 'react'
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { PeaksInstance } from 'peaks.js'

export type WaveformWordConnectorProps = {
  activeLineIndex: number | null
  peaksRef: MutableRefObject<PeaksInstance | null>
  zoomRef: MutableRefObject<HTMLDivElement | null>
  peaksReady: boolean
  overlayVisible: boolean
  /** overlay·자막 데이터 동기화 시 선 재계산 */
  layoutKey: string
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** 칩 DOM 순서대로 — data-word-start/end (자막 줄 시간) */
function listWordTimesFromDom(lineIndex: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  const prefix = `subtitle-word-${lineIndex}-`
  for (let i = 0; i < 512; i++) {
    const el = document.getElementById(`${prefix}${i}`) as HTMLElement | null
    if (!el) break
    const ds = el.dataset.wordStart
    const de = el.dataset.wordEnd
    if (ds === undefined || de === undefined) continue
    const s = Number(ds)
    const e = Number(de)
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue
    out.push({ start: s, end: e })
  }
  return out
}

function subtitleWordRowBottomPx(lineIndex: number): number {
  let maxB = 0
  const prefix = `subtitle-word-${lineIndex}-`
  for (let i = 0; i < 512; i++) {
    const el = document.getElementById(`${prefix}${i}`) as HTMLElement | null
    if (!el) break
    maxB = Math.max(maxB, el.getBoundingClientRect().bottom)
  }
  return maxB
}

/** Peaks 미준비 시에만 칩 픽셀 경계로 세로선 (로딩 폴백) */
function buildSegmentsFromChipRects(activeLineIndex: number, zr: DOMRect): VSegment[] {
  const segs: VSegment[] = []
  const prefix = `subtitle-word-${activeLineIndex}-`
  for (let i = 0; i < 512; i++) {
    const el = document.getElementById(`${prefix}${i}`) as HTMLElement | null
    if (!el) break
    const cr = el.getBoundingClientRect()
    const y1 = zr.top
    const y2 = Math.max(cr.bottom, zr.bottom)
    segs.push({ x: cr.left, y1, y2 })
    segs.push({ x: cr.right, y1, y2 })
  }
  return segs
}

type VSegment = { x: number; y1: number; y2: number }

export function WaveformWordConnector({
  activeLineIndex,
  peaksRef,
  zoomRef,
  peaksReady,
  overlayVisible,
  layoutKey
}: WaveformWordConnectorProps): ReactPortal | null {
  const [wordBoundarySegments, setWordBoundarySegments] = useState<VSegment[]>([])
  const [vp, setVp] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 0,
    h: typeof window !== 'undefined' ? window.innerHeight : 0
  }))

  const refresh = useCallback(() => {
    if (!overlayVisible || activeLineIndex === null) {
      setWordBoundarySegments([])
      return
    }

    const zoomEl = zoomRef.current
    if (!zoomEl) {
      setWordBoundarySegments([])
      return
    }
    const zr = zoomEl.getBoundingClientRect()
    if (zr.width <= 0 || zr.height <= 0) {
      setWordBoundarySegments([])
      return
    }

    const plotLeft = zr.left
    const plotW = zr.width
    const words = listWordTimesFromDom(activeLineIndex)

    if (peaksReady && words.length > 0) {
      const peaks = peaksRef.current
      const zv = peaks?.views.getView('zoomview')
      if (zv) {
        const t0 = zv.getStartTime()
        const t1 = zv.getEndTime()
        const span = t1 - t0
        if (span > 1e-9) {
          const xAt = (t: number) => plotLeft + ((t - t0) / span) * plotW
          const y1 = zr.top
          const rowBottom = subtitleWordRowBottomPx(activeLineIndex)
          const y2 = Math.max(rowBottom > 0 ? rowBottom : zr.bottom, zr.bottom)
          const segs: VSegment[] = []
          for (const w of words) {
            segs.push({
              x: clamp(xAt(w.start), plotLeft, plotLeft + plotW),
              y1,
              y2
            })
            segs.push({
              x: clamp(xAt(w.end), plotLeft, plotLeft + plotW),
              y1,
              y2
            })
          }
          setWordBoundarySegments(segs)
          return
        }
      }
    }

    setWordBoundarySegments(buildSegmentsFromChipRects(activeLineIndex, zr))
  }, [overlayVisible, activeLineIndex, peaksReady, peaksRef, zoomRef])

  useLayoutEffect(() => {
    refresh()
  }, [refresh, layoutKey])

  useEffect(() => {
    const onWin = (): void => {
      setVp({ w: window.innerWidth, h: window.innerHeight })
      requestAnimationFrame(refresh)
    }
    window.addEventListener('resize', onWin)
    window.addEventListener('scroll', onWin, true)
    onWin()
    return () => {
      window.removeEventListener('resize', onWin)
      window.removeEventListener('scroll', onWin, true)
    }
  }, [refresh])

  useEffect(() => {
    const peaks = peaksRef.current
    if (!peaks || !peaksReady) {
      return
    }
    let rafPending = 0
    const onZ = (): void => {
      if (rafPending) return
      rafPending = requestAnimationFrame(() => {
        rafPending = 0
        refresh()
      })
    }
    peaks.on('zoomview.update', onZ)
    peaks.on('segments.dragend', onZ)
    peaks.on('segments.dragged', onZ)
    return () => {
      if (rafPending) cancelAnimationFrame(rafPending)
      peaks.off('zoomview.update', onZ)
      peaks.off('segments.dragend', onZ)
      peaks.off('segments.dragged', onZ)
    }
  }, [peaksReady, refresh, peaksRef])

  useEffect(() => {
    if (!overlayVisible || activeLineIndex === null) return

    let ro: ResizeObserver | null = null
    const observedChips = new Set<Element>()

    const setup = (): void => {
      const zoomEl = zoomRef.current
      if (!zoomEl) return

      if (!ro) {
        ro = new ResizeObserver(() => requestAnimationFrame(refresh))
      }
      ro.observe(zoomEl)
      for (let i = 0; i < 512; i++) {
        const chip = document.getElementById(`subtitle-word-${activeLineIndex}-${i}`)
        if (!chip) break
        if (!observedChips.has(chip)) {
          ro.observe(chip)
          observedChips.add(chip)
        }
      }
      requestAnimationFrame(refresh)
    }

    setup()

    let attempts = 0
    let raf = 0
    const retry = (): void => {
      const times = listWordTimesFromDom(activeLineIndex)
      if (times.length === 0 && attempts < 90) {
        attempts++
        raf = requestAnimationFrame(retry)
        return
      }
      setup()
    }
    raf = requestAnimationFrame(retry)

    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [overlayVisible, activeLineIndex, refresh, zoomRef])

  if (typeof document === 'undefined') return null

  if (wordBoundarySegments.length === 0) return null

  const strokeBoundary = 'rgba(82, 89, 102, 0.92)'

  return createPortal(
    <svg
      className="subtitle-waveform-word-connector pointer-events-none"
      width={vp.w}
      height={vp.h}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        zIndex: 46,
        overflow: 'visible'
      }}
      aria-hidden
    >
      {wordBoundarySegments.map((s, i) => (
        <line
          key={`wb-${i}-${s.x.toFixed(1)}`}
          x1={s.x}
          y1={s.y1}
          x2={s.x}
          y2={s.y2}
          stroke={strokeBoundary}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>,
    document.body
  )
}
