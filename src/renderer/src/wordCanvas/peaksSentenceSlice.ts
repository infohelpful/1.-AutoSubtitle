import type { JsonWaveformData } from '../../../shared/waveformJson'
import { exactTimelineDurationSecFromWaveformJson } from '../timeline/stitchWaveformJson'

function getPeaksDataArray(json: JsonWaveformData): number[] | null {
  const raw = json as unknown as { data?: number[]; channels?: Array<{ data?: number[] }> }
  if (Array.isArray(raw.data) && raw.data.length > 0) return raw.data
  const ch0 = raw.channels?.[0]?.data
  if (Array.isArray(ch0) && ch0.length > 0) return ch0
  return null
}

/** 동일 미디어의 피크 JSON 이라도 새 객체 참조가 들어올 때 hydrate 중복을 피하기 위한 길이 시그니처 */
export function peaksJsonRawDataLength(json: JsonWaveformData | null | undefined): number {
  if (json == null) return 0
  const data = getPeaksDataArray(json)
  return data?.length ?? 0
}

/** 픽셀 하나(min/max 쌍)의 진폭 상한 — 바 파형용 단일 스칼라 */
function pixelAmp(data: readonly number[], pixelIndex: number): number {
  const i = pixelIndex * 2
  const mn = data[i] ?? 0
  const mx = data[i + 1] ?? 0
  return Math.max(Math.abs(mn), Math.abs(mx))
}

export type SlicePeaksOpts = {
  mediaDurationHintSec?: number
  /** 출력 포인트 수 (기본 80) */
  targetPoints?: number
}

/**
 * 원본 미디어 축 peaks JSON 에서 [startSec, endSec] 구간을 잘라 RMS 근사 배열로 만든다.
 * stitched 편집축 JSON 과 혼용하면 시간축이 어긋나므로 — 호출부에서는 원본 media-axis JSON 을 넘길 것.
 */
export function slicePeaksJsonToRmsChunk(
  json: JsonWaveformData | null | undefined,
  startSec: number,
  endSec: number,
  opts?: SlicePeaksOpts
): number[] {
  if (json == null) return []
  const data = getPeaksDataArray(json)
  if (!data || data.length < 4) return []
  const pixelCount = Math.floor(data.length / 2)
  if (pixelCount <= 0) return []

  const dur =
    exactTimelineDurationSecFromWaveformJson(json, opts?.mediaDurationHintSec) ??
    (opts?.mediaDurationHintSec != null &&
    Number.isFinite(opts.mediaDurationHintSec) &&
    opts.mediaDurationHintSec > 0
      ? opts.mediaDurationHintSec
      : null)
  if (dur == null || !(dur > 0)) return []

  const t0 = Math.max(0, Math.min(startSec, endSec))
  const t1 = Math.max(0, Math.max(startSec, endSec))
  if (!(t1 > t0)) return []

  const targetPoints = opts?.targetPoints ?? 80

  const p0 = Math.floor((t0 / dur) * pixelCount)
  const p1 = Math.min(pixelCount, Math.ceil((t1 / dur) * pixelCount))
  if (p1 <= p0) return []

  const span = p1 - p0
  const bins = Math.min(targetPoints, span)
  if (bins <= 0) return []

  const pixelsPerBin = span / bins
  const out: number[] = []
  for (let b = 0; b < bins; b++) {
    const bs = p0 + Math.floor(b * pixelsPerBin)
    const be = p0 + Math.floor((b + 1) * pixelsPerBin)
    let sum = 0
    let n = 0
    for (let p = bs; p < be && p < p1; p++) {
      sum += pixelAmp(data, p)
      n++
    }
    out.push(n > 0 ? sum / n : 0)
  }
  return out
}

const SLICE_CACHE_MAX = 8192
const sliceResultCache = new Map<string, number[]>()

function sliceCacheKey(
  peaksDataLen: number,
  startMs: number,
  endMs: number,
  durHintKey: string,
  targetPoints: number
): string {
  return `${peaksDataLen}|${startMs}|${endMs}|${durHintKey}|${targetPoints}`
}

/**
 * 동일 미디어·동일 구간 슬라이스를 반복 호출할 때(타임라인 hydrate 등) 배열을 재사용해 삭제 반응 속도를 낸다.
 */
export function slicePeaksJsonToRmsChunkCached(
  json: JsonWaveformData | null | undefined,
  startSec: number,
  endSec: number,
  opts?: SlicePeaksOpts
): number[] {
  const peaksLen = peaksJsonRawDataLength(json)
  const lo = Math.max(0, Math.min(startSec, endSec))
  const hi = Math.max(0, Math.max(startSec, endSec))
  const startMs = Math.round(lo * 1000)
  const endMs = Math.round(hi * 1000)
  const durHintKey =
    opts?.mediaDurationHintSec != null && Number.isFinite(opts.mediaDurationHintSec)
      ? String(Math.round(opts.mediaDurationHintSec * 1000))
      : 'x'
  const tp = opts?.targetPoints ?? 80
  const key = sliceCacheKey(peaksLen, startMs, endMs, durHintKey, tp)
  const hit = sliceResultCache.get(key)
  if (hit) return hit

  const fresh = slicePeaksJsonToRmsChunk(json, startSec, endSec, opts)
  if (sliceResultCache.size >= SLICE_CACHE_MAX) {
    const drop = sliceResultCache.size - SLICE_CACHE_MAX + 256
    const iter = sliceResultCache.keys()
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value as string | undefined
      if (k !== undefined) sliceResultCache.delete(k)
    }
  }
  sliceResultCache.set(key, fresh)
  return fresh
}
