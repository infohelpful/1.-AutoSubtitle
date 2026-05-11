import { useEffect, useRef } from 'react'
import type { WordEntity } from './types'

export type DrawWaveformOpts = {
  chunks: number[]
  words: WordEntity[]
  /** 문장이 차지하는 원본 미디어 구간(초) */
  mediaStart: number
  mediaEnd: number
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * RMS 배열을 막대 파형으로 그린다. 단어 tombstone 구간은 회색 반투명 오버레이.
 * ResizeObserver 는 React state 를 올리지 않고 캔버스만 다시 그림 — depth 초과 루프 방지.
 */
export function useDrawWaveform(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  wrapRef: React.RefObject<HTMLDivElement | null>,
  opts: DrawWaveformOpts
): void {
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const redraw = (): void => {
      const rect = wrap.getBoundingClientRect()
      const cssWidth = Math.max(32, rect.width)
      const cssHeight = Math.max(48, rect.height)
      if (cssWidth <= 0 || cssHeight <= 0) return

      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
      const wPx = Math.floor(cssWidth * dpr)
      const hPx = Math.floor(cssHeight * dpr)
      canvas.width = wPx
      canvas.height = hPx
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const { chunks, words, mediaStart, mediaEnd } = optsRef.current
      const dur = Math.max(1e-9, mediaEnd - mediaStart)
      const n = chunks.length
      if (n === 0) {
        ctx.clearRect(0, 0, wPx, hPx)
        ctx.fillStyle = '#1e293b'
        ctx.fillRect(0, 0, wPx, hPx)
        return
      }

      let mx = 0
      for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(chunks[i] ?? 0))
      const norm = mx > 1e-12 ? 1 / mx : 1

      ctx.clearRect(0, 0, wPx, hPx)
      ctx.fillStyle = '#0f172a'
      ctx.fillRect(0, 0, wPx, hPx)

      const barW = Math.max(1, wPx / n)
      for (let i = 0; i < n; i++) {
        const amp = Math.abs(chunks[i] ?? 0) * norm
        const bh = amp * hPx * 0.92
        const x = (i / n) * wPx
        const y = (hPx - bh) / 2
        ctx.fillStyle = '#64748b'
        ctx.fillRect(x, y, barW + 0.5, bh)
      }

      for (const w of words) {
        const x0 = ((w.o_start - mediaStart) / dur) * wPx
        const x1 = ((w.o_end - mediaStart) / dur) * wPx
        if (x1 <= 0 || x0 >= wPx) continue
        const ax0 = clamp(Math.min(x0, x1), 0, wPx)
        const ax1 = clamp(Math.max(x0, x1), 0, wPx)
        if (ax1 <= ax0) continue
        if (w.is_deleted) {
          ctx.fillStyle = 'rgba(15, 23, 42, 0.72)'
          ctx.fillRect(ax0, 0, ax1 - ax0, hPx)
          ctx.fillStyle = 'rgba(148, 163, 184, 0.35)'
          ctx.fillRect(ax0, 0, ax1 - ax0, hPx)
        } else {
          ctx.fillStyle = 'rgba(56, 189, 248, 0.12)'
          ctx.fillRect(ax0, 0, ax1 - ax0, hPx)
        }
      }
    }

    redraw()
    const ro = new ResizeObserver(() => {
      redraw()
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [canvasRef, wrapRef, opts.chunks, opts.words, opts.mediaStart, opts.mediaEnd])
}
