import type { JsonWaveformData } from '../../../shared/waveformJson'
import { memo, useEffect, useRef, type ReactElement } from 'react'
import type { SubtitleWord } from '../../../shared/subtitles'
import {
  mediaSecToPeakPixelIndex,
  resolvePeaksTimelineMetrics,
  type PeaksTimelineMetrics
} from './peakPixelMapping'

export type SentenceLineWaveformCanvasProps = {
  peaksJson: JsonWaveformData | null | undefined
  mediaDurationHintSec?: number
  windowSec: { start: number; end: number }
  words: readonly SubtitleWord[]
  peaksDataSig?: number
  className?: string
  heightPx?: number
}

const DEFAULT_H = 40

function collectDeletedRangesSec(
  words: readonly SubtitleWord[],
  winStart: number,
  winEnd: number
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  if (!(winEnd > winStart)) return out
  for (const w of words) {
    if (w.isDeleted !== true) continue
    const a = Math.min(w.start, w.end)
    const b = Math.max(w.start, w.end)
    const s = Math.max(winStart, a)
    const e = Math.min(winEnd, b)
    if (e > s + 1e-9) out.push({ start: s, end: e })
  }
  return out
}

function isSecInDeletedRanges(t: number, ranges: Array<{ start: number; end: number }>): boolean {
  for (const r of ranges) {
    if (t >= r.start && t < r.end) return true
  }
  return false
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  metrics: PeaksTimelineMetrics,
  winStart: number,
  winEnd: number,
  deletedRanges: Array<{ start: number; end: number }>,
  heightCssPx: number,
  dpr: number
): void {
  const { data } = metrics
  const wPx = Math.max(1, Math.floor(canvas.clientWidth * dpr))
  const hPx = Math.max(1, Math.floor(heightCssPx * dpr))
  if (canvas.width !== wPx || canvas.height !== hPx) {
    canvas.width = wPx
    canvas.height = hPx
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, wPx, hPx)
  const span = Math.max(winEnd - winStart, 1e-9)
  const midY = hPx * 0.5
  const ampScale = midY * 0.92

  const strokeActive = '#fbbf24'
  const strokeMuted = 'rgba(51, 65, 85, 0.88)'

  ctx.lineWidth = Math.max(1, dpr)
  ctx.lineJoin = 'round'

  for (let x = 0; x < wPx; x += 1) {
    const t = winStart + ((x + 0.5) / wPx) * span
    const pi = mediaSecToPeakPixelIndex(metrics, t)
    const i = pi * 2
    const mn = (data[i] ?? 0) / 127
    const mx = (data[i + 1] ?? 0) / 127
    const y1 = midY + Math.min(mn, mx) * ampScale
    const y2 = midY + Math.max(mn, mx) * ampScale
    const muted = isSecInDeletedRanges(t, deletedRanges)
    ctx.strokeStyle = muted ? strokeMuted : strokeActive
    ctx.globalAlpha = muted ? 0.35 : 0.95
    ctx.beginPath()
    ctx.moveTo(x + 0.5, y1)
    ctx.lineTo(x + 0.5, y2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

export const SentenceLineWaveformCanvas = memo(function SentenceLineWaveformCanvas({
  peaksJson,
  mediaDurationHintSec,
  windowSec,
  words,
  peaksDataSig: _peaksDataSig,
  className = '',
  heightPx = DEFAULT_H
}: SentenceLineWaveformCanvasProps): ReactElement | null {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaksJson) return
    const metrics = resolvePeaksTimelineMetrics(peaksJson, mediaDurationHintSec)
    if (!metrics) return

    const winStart = Math.min(windowSec.start, windowSec.end)
    const winEnd = Math.max(windowSec.start, windowSec.end)
    if (!(winEnd > winStart)) return

    const deletedRanges = collectDeletedRangesSec(words, winStart, winEnd)
    const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1

    const paint = (): void => {
      drawWaveform(canvas, metrics, winStart, winEnd, deletedRanges, heightPx, dpr)
    }

    paint()
    const ro = new ResizeObserver(() => {
      window.requestAnimationFrame(paint)
    })
    ro.observe(canvas.parentElement ?? canvas)
    return () => ro.disconnect()
  }, [
    peaksJson,
    mediaDurationHintSec,
    windowSec.start,
    windowSec.end,
    words,
    heightPx,
    _peaksDataSig
  ])

  if (!peaksJson) return null

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 z-0 overflow-hidden rounded-sm ${className}`.trim()}
      aria-hidden
      style={{ height: heightPx }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  )
})
