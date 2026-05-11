import type { JsonWaveformData } from '../../../shared/waveformJson'
import { exactTimelineDurationSecFromWaveformJson } from '../timeline/stitchWaveformJson'

function getPeaksDataArray(json: JsonWaveformData): number[] | null {
  const raw = json as unknown as { data?: number[]; channels?: Array<{ data?: number[] }> }
  if (Array.isArray(raw.data) && raw.data.length > 0) return raw.data
  const ch0 = raw.channels?.[0]?.data
  if (Array.isArray(ch0) && ch0.length > 0) return ch0
  return null
}

export type PeaksTimelineMetrics = {
  data: readonly number[]
  pixelCount: number
  durationSec: number
}

/**
 * `slicePeaksJsonToRmsChunk` · 스티치와 동일한 축 — 시간→픽셀 정책은 여기 한 곳만 따른다.
 */
export function resolvePeaksTimelineMetrics(
  json: JsonWaveformData | null | undefined,
  mediaDurationHintSec?: number
): PeaksTimelineMetrics | null {
  if (json == null) return null
  const data = getPeaksDataArray(json as JsonWaveformData)
  if (!data || data.length < 4) return null
  const pixelCount = Math.floor(data.length / 2)
  if (pixelCount <= 0) return null

  const dur =
    exactTimelineDurationSecFromWaveformJson(json, mediaDurationHintSec) ??
    (mediaDurationHintSec != null &&
    Number.isFinite(mediaDurationHintSec) &&
    mediaDurationHintSec > 0
      ? mediaDurationHintSec
      : null)
  if (dur == null || !(dur > 0)) return null

  return { data, pixelCount, durationSec: dur }
}

/**
 * 미디어 시간(초) → 픽셀 인덱스 [0, pixelCount). 정책: 시작은 floor, 끝은 ceil — slicePeaksJson 과 동일.
 */
export function mediaSecondsToPeakPixelRange(
  metrics: PeaksTimelineMetrics,
  startSec: number,
  endSec: number
): { startPixel: number; endPixel: number } {
  const { pixelCount, durationSec } = metrics
  const t0 = Math.max(0, Math.min(startSec, endSec))
  const t1 = Math.max(0, Math.max(startSec, endSec))
  const p0 = Math.floor((t0 / durationSec) * pixelCount)
  const p1 = Math.min(pixelCount, Math.ceil((t1 / durationSec) * pixelCount))
  const startPixel = Math.max(0, Math.min(p0, pixelCount - 1))
  const endPixel = Math.max(startPixel + 1, Math.min(p1, pixelCount))
  return { startPixel, endPixel }
}

/** 단일 시각이 속하는 픽셀 (바 디스플레이 샘플링용) */
export function mediaSecToPeakPixelIndex(metrics: PeaksTimelineMetrics, timeSec: number): number {
  const { pixelCount, durationSec } = metrics
  const t = Math.max(0, Math.min(timeSec, durationSec))
  const p = Math.floor((t / durationSec) * pixelCount)
  return Math.max(0, Math.min(p, pixelCount - 1))
}
