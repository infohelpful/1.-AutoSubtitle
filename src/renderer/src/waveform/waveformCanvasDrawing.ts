import { mediaSecToPeakPixelIndex, type PeaksTimelineMetrics } from './peakPixelMapping'

export function collectDeletedRangesSec(
  words: readonly { start: number; end: number; isDeleted?: boolean }[],
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

export type WaveformDimOutside = { leftSec: number; rightSec: number }

/** neighbor=좌·우 1단어(어둡게), selection=트림·구간(황금), outside=나머지 */
export type WaveformFillKind = 'outside' | 'neighbor' | 'selection'

export type WaveformFillBand = { start: number; end: number; kind: WaveformFillKind }

function pickFillKind(t: number, bands: readonly WaveformFillBand[]): WaveformFillKind {
  let best: WaveformFillKind = 'outside'
  let pr = 0
  for (const b of bands) {
    if (t < b.start || t > b.end) continue
    const p = b.kind === 'selection' ? 3 : b.kind === 'neighbor' ? 2 : 1
    if (p > pr) {
      pr = p
      best = b.kind
    }
  }
  return best
}

/**
 * Zoom strip — `SubtitleWaveformCanvas` / `VrewRowWaveformCanvas` 공통.
 *
 * `topPaddingPx`(CSS px) 만큼 상단에 빈 띠를 남기고, 나머지 영역에서 파형 막대를
 * 중앙 정렬로 그린다. `gain` 으로 막대 진폭을 추가로 증폭(가용 반높이를 넘으면
 * 위·아래에서 클램프) — 박스 크기를 키우지 않고 시각적으로 더 크게 보이게 한다.
 */
export function drawWaveformCanvas(
  canvas: HTMLCanvasElement,
  metrics: PeaksTimelineMetrics,
  winStart: number,
  winEnd: number,
  deletedRanges: Array<{ start: number; end: number }>,
  heightCssPx: number,
  dpr: number,
  opts?: {
    dimOutside?: WaveformDimOutside | null
    fillBands?: readonly WaveformFillBand[] | null
    /** 상단에 비워 둘 띠(CSS px) — 시간 라벨이 들어갈 자리 */
    topPaddingPx?: number
    /** 진폭 추가 게인 (기본 1.0) — 1보다 크면 막대가 더 커 보이고 끝은 클램프된다 */
    gain?: number
  }
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
  const topPadPx = Math.max(0, Math.floor((opts?.topPaddingPx ?? 0) * dpr))
  const drawTop = topPadPx
  const drawBottom = hPx
  const drawH = Math.max(2, drawBottom - drawTop)
  const midY = drawTop + drawH * 0.5
  const halfH = drawH * 0.5
  const gain = Math.max(0.1, opts?.gain ?? 1)
  const ampScale = halfH * 0.92 * gain
  /**
   * 색상 정책:
   *   selection (활성 단어 구간) → 황금색
   *   neighbor / outside / active (선택 안 된 구간 전체) → 흰색(어두운 알파)
   *   muted (tombstone 삭제 구간) → 짙은 회색
   */
  const strokeGold = 'rgba(255, 216, 77, 0.95)'
  const strokeNeighbor = 'rgba(255, 255, 255, 0.55)'
  const strokeActive = 'rgba(255, 255, 255, 0.85)'
  const strokeMuted = 'rgba(51, 65, 85, 0.88)'
  const strokeDim = 'rgba(255, 255, 255, 0.38)'

  const dim = opts?.dimOutside
  const bands = opts?.fillBands
  const useBands = Array.isArray(bands) && bands.length > 0

  ctx.lineWidth = Math.max(1, dpr)
  ctx.lineJoin = 'round'

  for (let x = 0; x < wPx; x += 1) {
    const t = winStart + ((x + 0.5) / wPx) * span
    const pi = mediaSecToPeakPixelIndex(metrics, t)
    const i = pi * 2
    const mn = (data[i] ?? 0) / 127
    const mx = (data[i + 1] ?? 0) / 127
    const y1Raw = midY + Math.min(mn, mx) * ampScale
    const y2Raw = midY + Math.max(mn, mx) * ampScale
    const y1 = Math.min(drawBottom, Math.max(drawTop, y1Raw))
    const y2 = Math.min(drawBottom, Math.max(drawTop, y2Raw))
    let muted = false
    for (const r of deletedRanges) {
      if (t >= r.start && t < r.end) {
        muted = true
        break
      }
    }

    let stroke: string
    let alpha: number
    let lw = Math.max(1, dpr)

    if (muted) {
      stroke = strokeMuted
      alpha = 0.35
    } else if (useBands && bands) {
      const k = pickFillKind(t, bands)
      if (k === 'selection') {
        stroke = strokeGold
        lw = Math.max(1.25, dpr * 1.1)
        alpha = 0.98
      } else if (k === 'neighbor') {
        // 인접 단어(좌·우 1개) — 선택 안 됨 → 흰색(중간 밝기)
        stroke = strokeNeighbor
        alpha = 0.85
      } else {
        // 그 외 영역 — 선택 안 됨 → 흰색(어두운 알파)
        stroke = strokeDim
        alpha = 0.7
      }
    } else {
      const dimmed = !!(dim && (t < dim.leftSec || t > dim.rightSec))
      stroke = dimmed ? strokeDim : strokeActive
      alpha = dimmed ? 0.7 : 0.95
    }

    ctx.lineWidth = lw
    ctx.strokeStyle = stroke
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.moveTo(x + 0.5, y1)
    ctx.lineTo(x + 0.5, y2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.lineWidth = Math.max(1, dpr)
}

/** Overview strip + viewport 사각형 */
export function drawOverviewWaveformViewport(
  canvas: HTMLCanvasElement,
  metrics: PeaksTimelineMetrics,
  viewWin: { start: number; end: number },
  overviewHeightCss: number
): void {
  const fullStart = 0
  const fullEnd = metrics.durationSec
  const span = Math.max(fullEnd - fullStart, 1e-9)
  const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  const parent = canvas.parentElement
  const wCss = parent?.clientWidth ?? canvas.clientWidth
  const hCss = overviewHeightCss
  const wPx = Math.max(1, Math.floor(wCss * dpr))
  const hPx = Math.floor(hCss * dpr)
  canvas.width = wPx
  canvas.height = hPx
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const data = metrics.data
  ctx.fillStyle = '#0c1018'
  ctx.fillRect(0, 0, wPx, hPx)
  const midY = hPx * 0.5
  const amp = midY * 0.85
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)'
  ctx.lineWidth = Math.max(1, dpr)
  for (let x = 0; x < wPx; x += 1) {
    const t = fullStart + ((x + 0.5) / wPx) * span
    const pi = mediaSecToPeakPixelIndex(metrics, t)
    const i = pi * 2
    const mn = (data[i] ?? 0) / 127
    const mx = (data[i + 1] ?? 0) / 127
    const y1 = midY + Math.min(mn, mx) * amp
    const y2 = midY + Math.max(mn, mx) * amp
    ctx.beginPath()
    ctx.moveTo(x + 0.5, y1)
    ctx.lineTo(x + 0.5, y2)
    ctx.stroke()
  }

  const vs = Math.min(viewWin.start, viewWin.end)
  const ve = Math.max(viewWin.start, viewWin.end)
  const x0 = ((vs - fullStart) / span) * wPx
  const x1 = ((ve - fullStart) / span) * wPx
  ctx.fillStyle = 'rgba(56, 189, 248, 0.22)'
  ctx.fillRect(x0, 0, Math.max(2, x1 - x0), hPx)
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)'
  ctx.strokeRect(x0, 0.5, Math.max(2, x1 - x0), hPx - 1)
}
