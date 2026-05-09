import type { JsonWaveformData } from 'peaks.js'
import type { CutRange } from '../../../shared/ipc'
import { mergeCutRanges } from '../../../shared/timelineCollapse'

const EPS = 1e-9

/** 컷 시그니처 — 디바운스 effect 의존성·로그용 */
export function cutRangesSignature(cuts: readonly CutRange[]): string {
  return mergeCutRanges([...cuts])
    .map((c) => `${c.start.toFixed(5)}-${c.end.toFixed(5)}`)
    .join('|')
}

function getPeaksDataArray(json: JsonWaveformData): number[] | null {
  const raw = json as unknown as { data?: number[]; channels?: Array<{ data?: number[] }> }
  if (Array.isArray(raw.data) && raw.data.length > 0) return raw.data
  const ch0 = raw.channels?.[0]?.data
  if (Array.isArray(ch0) && ch0.length > 0) return ch0
  return null
}

/**
 * 파형(peaks) JSON이 나타내는 미디어 타임라인 길이(초).
 * 편집축·매핑 상한은 컨테이너 duration 대신 이 값을 우선한다.
 *
 * `samples_per_pixel` 이 없으면 `mediaDurationHintSec`(예: 컨테이너 duration)으로 역산한 뒤 길이를 구한다.
 */
export function exactTimelineDurationSecFromWaveformJson(
  json: JsonWaveformData,
  mediaDurationHintSec?: number
): number | null {
  const data = getPeaksDataArray(json)
  if (!data || data.length < 4) return null

  const sr =
    typeof json.sample_rate === 'number' && Number.isFinite(json.sample_rate) && json.sample_rate > 0
      ? json.sample_rate
      : null
  let spp =
    typeof json.samples_per_pixel === 'number' &&
    Number.isFinite(json.samples_per_pixel) &&
    json.samples_per_pixel > 0
      ? json.samples_per_pixel
      : null

  const pixelCount = Math.floor(data.length / 2)
  if (pixelCount <= 0 || !sr) return null

  if (!spp) {
    const hint = mediaDurationHintSec
    if (!(typeof hint === 'number' && Number.isFinite(hint) && hint > 0)) return null
    spp = (sr * hint) / pixelCount
  }

  const impliedDur = (pixelCount * spp) / sr
  return Number.isFinite(impliedDur) && impliedDur > 0 ? impliedDur : null
}

/**
 * stitchAudioBufferByCuts 와 동일한 미디어 타임라인 상 “남기는 구간”.
 */
export function buildMediaKeepRangesAfterCuts(mediaDuration: number, cuts: readonly CutRange[]): CutRange[] {
  const merged = mergeCutRanges([...cuts])
  const keepRanges: CutRange[] = []
  let cursor = 0
  for (const c of merged) {
    const s = Math.max(0, Math.min(mediaDuration, c.start))
    const e = Math.max(0, Math.min(mediaDuration, c.end))
    if (s > cursor + EPS) keepRanges.push({ start: cursor, end: s })
    cursor = Math.max(cursor, e)
  }
  if (cursor < mediaDuration - EPS) keepRanges.push({ start: cursor, end: mediaDuration })
  return keepRanges
}

/**
 * 원본 Peaks JSON(미디어 길이)에서 삭제 구간에 해당하는 픽셀 대역을 제거하고 이어붙여
 * 편집 타임라인 길이의 피크 데이터를 만든다.
 *
 * @param mediaDurationSec 비디오·오디오 원본 길이(초) — 피크 파일과 불일치 시 짧은 쪽으로 클램프
 * @returns 컷이 없으면 null (호출부에서 원본 JSON 사용). 컷은 있는데 실패하면 null.
 */
export function stitchWaveformJsonByCuts(
  json: JsonWaveformData,
  cuts: readonly CutRange[],
  mediaDurationSec: number
): JsonWaveformData | null {
  const merged = mergeCutRanges([...cuts])
  if (merged.length === 0) return null

  const data = getPeaksDataArray(json)
  if (!data || data.length < 4) return null

  const sr =
    typeof json.sample_rate === 'number' && Number.isFinite(json.sample_rate) && json.sample_rate > 0
      ? json.sample_rate
      : null
  let spp =
    typeof json.samples_per_pixel === 'number' &&
    Number.isFinite(json.samples_per_pixel) &&
    json.samples_per_pixel > 0
      ? json.samples_per_pixel
      : null

  const pixelCount = Math.floor(data.length / 2)
  if (pixelCount <= 0) return null

  if (!sr) return null

  if (!spp) {
    if (!(mediaDurationSec > 0)) return null
    spp = (sr * mediaDurationSec) / pixelCount
  }

  const impliedDur = (pixelCount * spp) / sr
  const mediaDur =
    Number.isFinite(mediaDurationSec) && mediaDurationSec > 0
      ? Math.min(impliedDur, mediaDurationSec)
      : impliedDur

  const keepRanges = buildMediaKeepRangesAfterCuts(mediaDur, merged)

  const out: number[] = []
  for (const r of keepRanges) {
    const sppNonNull = spp as number
    const startPx = Math.max(0, Math.min(pixelCount, Math.floor((r.start * sr) / sppNonNull)))
    const endPx = Math.max(0, Math.min(pixelCount, Math.ceil((r.end * sr) / sppNonNull)))
    if (endPx <= startPx) continue
    for (let i = startPx * 2; i < endPx * 2; i += 1) out.push(data[i] ?? 0)
  }

  if (out.length < 4) return null

  const newPixels = Math.floor(out.length / 2)
  const base = { ...(json as unknown as Record<string, unknown>) }
  delete base.channels

  return {
    ...base,
    sample_rate: sr,
    samples_per_pixel: spp,
    bits: json.bits ?? 8,
    length: newPixels,
    data: out
  } as JsonWaveformData
}
