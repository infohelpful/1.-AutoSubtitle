import { mediaSecToPeakPixelIndex, type PeaksTimelineMetrics } from './peakPixelMapping'
import type { EdlSkipMapping } from './edlSkipMapping'

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
 * 면 채우기 색상 정책 — selection(황금) / neighbor(흰색 중간) / active(흰색 진함) /
 * dim(흰색 옅음) / muted(슬레이트). stroke 보다 점유 면적이 크므로 alpha 를 낮춘다.
 */
const FILL_COLOR = {
  selection: 'rgba(255, 216, 77, 0.88)',
  neighbor: 'rgba(255, 255, 255, 0.45)',
  active: 'rgba(255, 255, 255, 0.72)',
  dim: 'rgba(255, 255, 255, 0.28)',
  muted: 'rgba(51, 65, 85, 0.32)'
} as const
/** 윗선 강조 stroke 색 — 채움 색보다 진하게 잡아 silhouette 상단 라인을 부각 (사진 같은 룩) */
const OUTLINE_COLOR = {
  selection: 'rgba(255, 232, 132, 1)',
  neighbor: 'rgba(255, 255, 255, 0.82)',
  active: 'rgba(255, 255, 255, 1)',
  dim: 'rgba(255, 255, 255, 0.55)',
  muted: 'rgba(100, 116, 139, 0.55)'
} as const
type WaveformDrawKind = keyof typeof FILL_COLOR

/**
 * Zoom strip — `SubtitleWaveformCanvas` / `VrewRowWaveformCanvas` 공통.
 *
 * **면 실루엣 (silhouette + 윗선 강조)** — 픽셀별 `(min, max)` 진폭 envelope 으로
 *  상·하 두 곡선을 잇는 polygon 을 한 번에 채우고, 위쪽 envelope 만 1px stroke 로
 *  강조해 사진처럼 윗선이 도드라지는 시각을 만든다.
 *
 * 색 영역(`fillBands` / `dimOutside` / 삭제구간) 은 같은 polygon 을 region 별 clip 으로
 *  여러 색으로 fill 해 처리한다 — region 수가 보통 3~5 개라 fill 호출은 그대로 가볍다.
 *
 * `topPaddingPx`(CSS px) 만큼 상단에 빈 띠를 남기고, 나머지 영역에서 envelope 을
 * 중앙 정렬로 그린다. `gain` 으로 진폭을 추가로 증폭(가용 반높이를 넘으면 위·아래
 * 에서 클램프) — 박스 크기를 키우지 않고 시각적으로 더 크게 보이게 한다.
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
    /**
     * EDL 표시 압축 매핑 — 지정 시 픽셀→시간 변환이 piecewise-linear 로 동작.
     *  - 삭제 구간(skip) 의 시간대는 *어떤 픽셀도 매핑되지 않아* 막대가 그려지지 않음.
     *  - viewSpan 이 같아도 strip 의 실제 시간폭은 `skipMapping.activeSpanSec` 로 줄어든 게 정상 — 호출부에서 박스 폭을 같이 줄여야 시각이 자연스럽게 이어붙음.
     *  - 미지정 시 종래 선형 매핑(전체 viewSpan 을 wPx 에 매핑) 그대로 동작.
     */
    skipMapping?: EdlSkipMapping | null
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
  const skipMapping = opts?.skipMapping ?? null
  const topPadPx = Math.max(0, Math.floor((opts?.topPaddingPx ?? 0) * dpr))
  const drawTop = topPadPx
  const drawBottom = hPx
  const drawH = Math.max(2, drawBottom - drawTop)
  const midY = drawTop + drawH * 0.5
  const halfH = drawH * 0.5
  const gain = Math.max(0.1, opts?.gain ?? 1)
  const ampScale = halfH * 0.92 * gain

  const dim = opts?.dimOutside
  const bands = opts?.fillBands
  const useBands = Array.isArray(bands) && bands.length > 0

  /**
   * 무음 구간(피크 데이터 min/max 가 모두 0)이라도 중심선(midY) 에 얇은 가로 띠가 보이도록
   * envelope 의 상·하 곡선 사이를 최소 `minBarPx` 만큼 벌려둔다 — 그렇지 않으면 polygon 이
   * 1px 미만으로 압축되어 무음 구간이 텅 비어 보인다.
   */
  const minBarPx = Math.max(1, Math.round(dpr))

  /**
   * 1) 픽셀별 envelope (top/bot Y) 와 kind(색 영역) 동시 산출. skipMapping 이 활성화돼 있으면
   *    삭제 구간의 픽셀은 자동으로 양옆 활성 시각으로 클램프되어 muted 가 트리거되지 않는다.
   */
  const topY = new Float32Array(wPx)
  const botY = new Float32Array(wPx)
  const kindAt = new Array<WaveformDrawKind>(wPx)
  for (let x = 0; x < wPx; x += 1) {
    const t = skipMapping
      ? skipMapping.pixelToMediaSec(x + 0.5, wPx)
      : winStart + ((x + 0.5) / wPx) * span
    const pi = mediaSecToPeakPixelIndex(metrics, t)
    const i = pi * 2
    const mn = (data[i] ?? 0) / 127
    const mx = (data[i + 1] ?? 0) / 127
    let y1 = midY + Math.min(mn, mx) * ampScale
    let y2 = midY + Math.max(mn, mx) * ampScale
    if (y2 - y1 < minBarPx) {
      const cy = (y1 + y2) * 0.5
      y1 = cy - minBarPx * 0.5
      y2 = cy + minBarPx * 0.5
    }
    topY[x] = Math.min(drawBottom, Math.max(drawTop, y1))
    botY[x] = Math.min(drawBottom, Math.max(drawTop, y2))

    let muted = false
    if (!skipMapping) {
      for (const r of deletedRanges) {
        if (t >= r.start && t < r.end) {
          muted = true
          break
        }
      }
    }
    let k: WaveformDrawKind
    if (muted) {
      k = 'muted'
    } else if (useBands && bands) {
      const bk = pickFillKind(t, bands)
      k = bk === 'selection' ? 'selection' : bk === 'neighbor' ? 'neighbor' : 'dim'
    } else {
      const dimmed = !!(dim && (t < dim.leftSec || t > dim.rightSec))
      k = dimmed ? 'dim' : 'active'
    }
    kindAt[x] = k
  }

  /** 2) 같은 kind 가 연속되는 region 으로 분할 (보통 3~5 개) */
  type Region = { x0: number; x1: number; kind: WaveformDrawKind }
  const regions: Region[] = []
  let curKind = kindAt[0]!
  let curX0 = 0
  for (let x = 1; x < wPx; x += 1) {
    if (kindAt[x] !== curKind) {
      regions.push({ x0: curX0, x1: x, kind: curKind })
      curKind = kindAt[x]!
      curX0 = x
    }
  }
  regions.push({ x0: curX0, x1: wPx, kind: curKind })

  /** 3) envelope polygon 한 번만 빌드 — upper L→R, lower R→L, close */
  const envelope = new Path2D()
  envelope.moveTo(0.5, topY[0]!)
  for (let x = 1; x < wPx; x += 1) envelope.lineTo(x + 0.5, topY[x]!)
  for (let x = wPx - 1; x >= 0; x -= 1) envelope.lineTo(x + 0.5, botY[x]!)
  envelope.closePath()

  /** 4) region 별 clip + fill — 같은 polygon 을 영역마다 다른 색으로 칠함 */
  for (const r of regions) {
    if (r.x1 <= r.x0) continue
    ctx.save()
    ctx.beginPath()
    ctx.rect(r.x0, 0, r.x1 - r.x0, hPx)
    ctx.clip()
    ctx.fillStyle = FILL_COLOR[r.kind]
    ctx.fill(envelope)
    ctx.restore()
  }

  /** 5) 윗선 강조 stroke — region 마다 upper envelope 만 따라가며 1px 라인 */
  ctx.lineWidth = Math.max(1, dpr)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'butt'
  for (const r of regions) {
    if (r.x1 <= r.x0) continue
    ctx.strokeStyle = OUTLINE_COLOR[r.kind]
    ctx.beginPath()
    ctx.moveTo(r.x0 + 0.5, topY[r.x0]!)
    for (let x = r.x0 + 1; x < r.x1; x += 1) ctx.lineTo(x + 0.5, topY[x]!)
    ctx.stroke()
  }

  ctx.globalAlpha = 1
  ctx.lineWidth = Math.max(1, dpr)
}

/**
 * Overview strip + viewport 사각형 — 메인 strip 과 통일된 **면 실루엣** 룩.
 * envelope polygon 한 번 fill + upper envelope 1px stroke.
 */
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
  const minBarPx = Math.max(1, Math.round(dpr))

  const topY = new Float32Array(wPx)
  const botY = new Float32Array(wPx)
  for (let x = 0; x < wPx; x += 1) {
    const t = fullStart + ((x + 0.5) / wPx) * span
    const pi = mediaSecToPeakPixelIndex(metrics, t)
    const i = pi * 2
    const mn = (data[i] ?? 0) / 127
    const mx = (data[i + 1] ?? 0) / 127
    let y1 = midY + Math.min(mn, mx) * amp
    let y2 = midY + Math.max(mn, mx) * amp
    if (y2 - y1 < minBarPx) {
      const cy = (y1 + y2) * 0.5
      y1 = cy - minBarPx * 0.5
      y2 = cy + minBarPx * 0.5
    }
    topY[x] = Math.max(0, Math.min(hPx, y1))
    botY[x] = Math.max(0, Math.min(hPx, y2))
  }

  const envelope = new Path2D()
  envelope.moveTo(0.5, topY[0]!)
  for (let x = 1; x < wPx; x += 1) envelope.lineTo(x + 0.5, topY[x]!)
  for (let x = wPx - 1; x >= 0; x -= 1) envelope.lineTo(x + 0.5, botY[x]!)
  envelope.closePath()

  ctx.fillStyle = 'rgba(148, 163, 184, 0.45)'
  ctx.fill(envelope)

  ctx.lineWidth = Math.max(1, dpr)
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(186, 200, 222, 0.85)'
  ctx.beginPath()
  ctx.moveTo(0.5, topY[0]!)
  for (let x = 1; x < wPx; x += 1) ctx.lineTo(x + 0.5, topY[x]!)
  ctx.stroke()

  const vs = Math.min(viewWin.start, viewWin.end)
  const ve = Math.max(viewWin.start, viewWin.end)
  const x0 = ((vs - fullStart) / span) * wPx
  const x1 = ((ve - fullStart) / span) * wPx
  ctx.fillStyle = 'rgba(56, 189, 248, 0.22)'
  ctx.fillRect(x0, 0, Math.max(2, x1 - x0), hPx)
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)'
  ctx.strokeRect(x0, 0.5, Math.max(2, x1 - x0), hPx - 1)
}
