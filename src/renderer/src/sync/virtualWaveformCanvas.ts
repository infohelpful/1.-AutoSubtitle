/**
 * Task 3 — 뷰포트에 해당하는 RMS 구간만 slice 해 Canvas 에 그림.
 * 연속 재생 시에는 전체 클리어 대신 ctx.translate 로 스크롤 오프셋만 바꾸는 패턴을 권장.
 */

/** `extract_rms_peaks.py --bin-out` 포맷 파싱 → Canvas용 Float32Array */
export function parseAsrfRmsBin(buf: ArrayBuffer): { samplesPerSec: number; rms: Float32Array } {
  const u8 = new Uint8Array(buf)
  if (u8.length < 12 || u8[0] !== 0x41 || u8[1] !== 0x53 || u8[2] !== 0x52 || u8[3] !== 0x46) {
    throw new Error('Invalid ASRF header')
  }
  const v = new DataView(buf)
  const samplesPerSec = v.getUint32(4, true)
  const count = v.getUint32(8, true)
  const need = 12 + count * 4
  if (u8.length < need) throw new Error('ASRF truncated')
  return {
    samplesPerSec,
    rms: new Float32Array(buf.slice(12, need))
  }
}

export type WaveformDrawStyle = {
  background?: string
  barColor?: string
  barGapRatio?: number
}

const DEFAULT_STYLE: Required<WaveformDrawStyle> = {
  background: '#1a1a1e',
  barColor: '#6b9bd1',
  barGapRatio: 0.15
}

/**
 * 구간 [viewStartSec, viewEndSec] 에 해당하는 RMS 인덱스만 잘라 막대 그리기.
 * `rms` 는 초당 `samplesPerSec` 개(예: 100 → 10ms 간격).
 */
export function drawWaveformViewport(
  ctx: CanvasRenderingContext2D,
  rms: Float32Array,
  samplesPerSec: number,
  viewStartSec: number,
  viewEndSec: number,
  widthPx: number,
  heightPx: number,
  style: WaveformDrawStyle = {}
): void {
  const s = { ...DEFAULT_STYLE, ...style }
  const dur = Math.max(1e-9, viewEndSec - viewStartSec)
  const i0 = Math.max(0, Math.floor(viewStartSec * samplesPerSec))
  const i1 = Math.min(rms.length, Math.ceil(viewEndSec * samplesPerSec))
  ctx.fillStyle = s.background
  ctx.fillRect(0, 0, widthPx, heightPx)
  if (i1 <= i0) return

  const span = i1 - i0
  const barW = widthPx / Math.max(1, span)
  const gap = barW * s.barGapRatio
  const useW = Math.max(1, barW - gap)
  const mid = heightPx / 2
  const t0 = viewStartSec
  const t1 = viewEndSec

  ctx.fillStyle = s.barColor
  for (let idx = i0; idx < i1; idx += 1) {
    const tSec = idx / samplesPerSec
    const xLocal = ((tSec - t0) / (t1 - t0)) * widthPx
    const v = Math.min(1, Math.max(0, rms[idx] ?? 0))
    const h = v * (heightPx * 0.45)
    ctx.fillRect(xLocal, mid - h, useW, h * 2)
  }
}

/**
 * 재생 진행 시: 전체 redraw 대신 `translateX` 만 바꿔 같은 프레임 데이터를 밀어 보여줄 수 있음.
 * (정밀 스크럽 시에는 `drawWaveformViewport` 로 매 프레임 slice 가 안전)
 */
export function setWaveformScrollTransform(ctx: CanvasRenderingContext2D, translateXPx: number): void {
  ctx.setTransform(1, 0, 0, 1, translateXPx, 0)
}
