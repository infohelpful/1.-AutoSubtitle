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

/** [seg] 에서 단일 컷 [c] 가 덮는 부분만 제거한 남은 구간(0~2개) */
function subtractCutFromSegment(seg: CutRange, c: CutRange): CutRange[] {
  if (c.end <= seg.start + EPS || c.start >= seg.end - EPS) return [seg]
  const out: CutRange[] = []
  if (c.start > seg.start + EPS) out.push({ start: seg.start, end: Math.min(seg.end, c.start) })
  if (c.end < seg.end - EPS) out.push({ start: Math.max(seg.start, c.end), end: seg.end })
  return out.filter((x) => x.end > x.start + EPS)
}

/** seg 에서 merged 컷 합집합을 빼 남은 조각들 */
function segmentMinusUnion(seg: CutRange, unionMerged: readonly CutRange[]): CutRange[] {
  let parts: CutRange[] = [seg]
  for (const c of unionMerged) {
    const next: CutRange[] = []
    for (const p of parts) next.push(...subtractCutFromSegment(p, c))
    parts = next
    if (parts.length === 0) break
  }
  return parts
}

/**
 * 삭제(컷) 집합이 **늘어만** 났는지 — 이전에 가려진 미디어가 다시 살아나면(undo 등) false.
 * true 일 때만 `stitchWaveformJsonExpandCutsIncremental` 이 안전하다.
 */
export function cutRemovedIntervalsExpandOnly(
  oldCuts: readonly CutRange[],
  newCuts: readonly CutRange[]
): boolean {
  const O = mergeCutRanges([...oldCuts])
  const N = mergeCutRanges([...newCuts])
  for (const o of O) {
    if (segmentMinusUnion(o, N).length > 0) return false
  }
  return true
}

/** 새로 추가로 가려진 미디어 구간들 (N \\ O, 삭제 축) */
function newlyRemovedMediaIntervals(O: readonly CutRange[], N: readonly CutRange[]): CutRange[] {
  const oM = mergeCutRanges([...O])
  const out: CutRange[] = []
  for (const n of mergeCutRanges([...N])) {
    out.push(...segmentMinusUnion(n, oM))
  }
  return mergeCutRanges(out)
}

type Spf = { sr: number; spp: number; pixelCount: number; mediaDur: number }

function resolveSpfFromPeaksJson(json: JsonWaveformData, mediaDurationSec: number): Spf | null {
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
    if (!(mediaDurationSec > 0)) return null
    spp = (sr * mediaDurationSec) / pixelCount
  }
  const impliedDur = (pixelCount * spp) / sr
  const mediaDur =
    Number.isFinite(mediaDurationSec) && mediaDurationSec > 0
      ? Math.min(impliedDur, mediaDurationSec)
      : impliedDur
  return { sr, spp: spp as number, pixelCount, mediaDur }
}

/**
 * `oldCuts` 로 만든 스티치 출력에서, 새로 삭제된 미디어 [ms, me) 에 해당하는 **출력 픽셀** 구간들 (end exclusive).
 * 이전 타임라인에서 “남아 있던” 미디어가 여러 keep 조각에 걸치면 출력에서도 여러 조각이 된다(잘못 min/max 합치면 안 됨).
 */
function outputPixelSpansForNewlyRemovedMedia(
  oldCuts: readonly CutRange[],
  spf: Spf,
  ms: number,
  me: number
): { outStart: number; outEnd: number }[] {
  if (!(me > ms + EPS)) return []
  const merged = mergeCutRanges([...oldCuts])
  const keepRanges = buildMediaKeepRangesAfterCuts(spf.mediaDur, merged)
  const { sr, spp, pixelCount } = spf
  let outBase = 0
  const spans: { outStart: number; outEnd: number }[] = []
  for (const r of keepRanges) {
    const startPx = Math.max(0, Math.min(pixelCount, Math.round((r.start * sr) / spp)))
    const endPx = Math.max(0, Math.min(pixelCount, Math.round((r.end * sr) / spp)))
    const len = endPx - startPx
    if (len <= 0) {
      continue
    }
    const overlapLo = Math.max(ms, r.start)
    const overlapHi = Math.min(me, r.end)
    if (overlapHi <= overlapLo + EPS) {
      outBase += len
      continue
    }
    const spLo = Math.max(startPx, Math.min(endPx, Math.round((overlapLo * sr) / spp)))
    const spHi = Math.max(startPx, Math.min(endPx, Math.round((overlapHi * sr) / spp)))
    if (spHi <= spLo + EPS) {
      outBase += len
      continue
    }
    spans.push({ outStart: outBase + (spLo - startPx), outEnd: outBase + (spHi - startPx) })
    outBase += len
  }
  return mergeOutputSpans(spans)
}

/** `stitchWaveformJsonByCuts` 와 동일 규칙의 출력 픽셀 수만 계산 (전체 복사 없음) */
function stitchedOutputPixelCount(
  json: JsonWaveformData,
  cuts: readonly CutRange[],
  mediaDurationSec: number
): number | null {
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
  if (pixelCount <= 0 || !sr) return null
  if (!spp) {
    if (!(mediaDurationSec > 0)) return null
    spp = (sr * mediaDurationSec) / pixelCount
  }
  const impliedDur = (pixelCount * spp) / sr
  const mediaDur =
    Number.isFinite(mediaDurationSec) && mediaDurationSec > 0
      ? Math.min(impliedDur, mediaDurationSec)
      : impliedDur
  const sppNonNull = spp as number
  const keepRanges = buildMediaKeepRangesAfterCuts(mediaDur, merged)
  let totalOut = 0
  for (const r of keepRanges) {
    const startPx = Math.max(0, Math.min(pixelCount, Math.round((r.start * sr) / sppNonNull)))
    const endPx = Math.max(0, Math.min(pixelCount, Math.round((r.end * sr) / sppNonNull)))
    const len = endPx - startPx
    if (len > 0) totalOut += len
  }
  return totalOut < 2 ? null : totalOut
}

/**
 * `stitchWaveformJsonByCuts` 결과의 편집축 길이(초)와 동일 — **픽셀 버퍼를 만들지 않음**.
 *
 * `timelineMediaEndHint` 등에서 `mergedWaveformPeaksStitchCuts`(즉시) 과
 * `stitchedWaveformJsonComputed`(deferred) 가 한 프레임 어긋날 때 매핑·하이라이트 싱크가 깨지는 것을 막는다.
 */
export function stitchedEditAxisDurationSecFromCuts(
  json: JsonWaveformData,
  cuts: readonly CutRange[],
  mediaDurationSec: number,
  mediaDurationHintSec?: number
): number | null {
  const px = stitchedOutputPixelCount(json, cuts, mediaDurationSec)
  if (px == null || px < 2) return null
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
  const sppNonNull = spp as number
  const impliedDur = (px * sppNonNull) / sr
  return Number.isFinite(impliedDur) && impliedDur > 0 ? impliedDur : null
}

function mergeOutputSpans(spans: readonly { outStart: number; outEnd: number }[]): { outStart: number; outEnd: number }[] {
  if (spans.length === 0) return []
  const s = [...spans].sort((a, b) => a.outStart - b.outStart)
  const out: { outStart: number; outEnd: number }[] = []
  let cur = { ...s[0]! }
  for (let i = 1; i < s.length; i += 1) {
    const n = s[i]!
    if (n.outStart <= cur.outEnd + EPS) cur.outEnd = Math.max(cur.outEnd, n.outEnd)
    else {
      out.push(cur)
      cur = { ...n }
    }
  }
  out.push(cur)
  return out
}

function removeOutputPixelSpansFromData(data: number[], spans: readonly { outStart: number; outEnd: number }[]): number[] {
  if (spans.length === 0) return data
  const merged = mergeOutputSpans(spans)
  let removePairs = 0
  for (const sp of merged) removePairs += (sp.outEnd - sp.outStart) * 2
  const out = new Array<number>(data.length - removePairs)
  let w = 0
  let read = 0
  for (const sp of merged) {
    const b0 = sp.outStart * 2
    const b1 = sp.outEnd * 2
    while (read < b0 && w < out.length) out[w++] = data[read++]!
    read = b1
  }
  while (read < data.length && w < out.length) out[w++] = data[read++]!
  return out
}

/**
 * 이전 스티치 결과 + 컷 집합만 확장(삭제 추가)된 경우, 전체 픽셀을 다시 붙이지 않고
 * **새로 가려진 미디어**에 대응하는 출력 구간만 잘라 낸다.
 *
 * @returns 실패 시 null → 호출부에서 `stitchWaveformJsonByCuts` 전체 재계산.
 */
export function stitchWaveformJsonExpandCutsIncremental(
  prevStitched: JsonWaveformData,
  oldCuts: readonly CutRange[],
  srcJson: JsonWaveformData,
  newCuts: readonly CutRange[],
  mediaDurationSec: number
): JsonWaveformData | null {
  if (!cutRemovedIntervalsExpandOnly(oldCuts, newCuts)) return null

  const prevData = getPeaksDataArray(prevStitched)
  if (!prevData || prevData.length < 4) return null

  const spfSrc = resolveSpfFromPeaksJson(srcJson, mediaDurationSec)
  const spfPrev = resolveSpfFromPeaksJson(prevStitched, mediaDurationSec)
  if (!spfSrc || !spfPrev) return null
  if (Math.abs(spfSrc.sr - spfPrev.sr) > 0.5 || Math.abs(spfSrc.spp - spfPrev.spp) > spfPrev.spp * 1e-6 + 1e-9) {
    return null
  }
  const expectedPrevLen = stitchedOutputPixelCount(srcJson, oldCuts, mediaDurationSec)
  if (expectedPrevLen != null && expectedPrevLen !== Math.floor(prevData.length / 2)) return null

  const O = mergeCutRanges([...oldCuts])
  const N = mergeCutRanges([...newCuts])
  const added = newlyRemovedMediaIntervals(O, N)
  if (added.length === 0) return null

  const spans: { outStart: number; outEnd: number }[] = []
  for (const iv of added) {
    const sps = outputPixelSpansForNewlyRemovedMedia(oldCuts, spfSrc, iv.start, iv.end)
    if (sps.length === 0) return null
    spans.push(...sps)
  }
  const mergedSpans = mergeOutputSpans(spans)
  const prevPx = Math.floor(prevData.length / 2)
  for (const sp of mergedSpans) {
    if (sp.outStart < 0 || sp.outEnd > prevPx || sp.outEnd <= sp.outStart) return null
  }

  const newData = removeOutputPixelSpansFromData(prevData, mergedSpans)
  const newPixels = Math.floor(newData.length / 2)
  if (newPixels < 2) return null

  const expectedNewLen = stitchedOutputPixelCount(srcJson, newCuts, mediaDurationSec)
  if (expectedNewLen != null && expectedNewLen !== newPixels) return null

  const base = { ...(prevStitched as unknown as Record<string, unknown>) }
  delete base.channels

  return {
    ...base,
    sample_rate: spfSrc.sr,
    samples_per_pixel: spfSrc.spp,
    bits: prevStitched.bits ?? 8,
    length: newPixels,
    data: newData
  } as JsonWaveformData
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
  const sppNonNull = spp as number

  /**
   * 픽셀 경계를 모든 keepRange 양 끝에서 **동일한 라운딩(Math.round)** 으로 잡는다.
   *
   * 이전엔 `floor(start)` + `ceil(end)` 라서 컷 직후 segment 가 source 기준으로 1~2 픽셀
   * 앞당겨 시작했다(예: spp=128, sr=22050 기준 컷당 ~6ms). 클립 매핑(`buildTimelineClips`)은
   * 정확한 실수 좌표를 쓰므로 컷 직후 chip 의 edit 시각(클립 매핑) ↔ 그 위치의 픽셀 데이터(소스
   * 미디어 시간) 가 ~컷 수 × 6ms 누적되어 어긋나, 사용자에게는 "삭제된 단어블록 부분부터 목소리·파형이
   * 틀어진다" 로 보였다.
   *
   * `round` 로 통일하면 각 keep segment 의 source 시작·끝과 destination 위치가 같은 양자화 격자에
   * 떨어지므로 컷이 누적돼도 chip ↔ 파형 픽셀의 시각 정렬이 ≤ 0.5 px (≈3 ms) 안에서 유지된다.
   */
  const srcStarts: number[] = []
  const segLens: number[] = []
  let totalOut = 0
  for (const r of keepRanges) {
    const startPx = Math.max(0, Math.min(pixelCount, Math.round((r.start * sr) / sppNonNull)))
    const endPx = Math.max(0, Math.min(pixelCount, Math.round((r.end * sr) / sppNonNull)))
    const len = endPx - startPx
    if (len <= 0) continue
    srcStarts.push(startPx)
    segLens.push(len)
    totalOut += len
  }

  if (totalOut < 2) return null

  /** 단일 배열을 한 번에 채워 push 의 amortized 비용을 피한다(대용량 피크에서 비용 ↓). */
  const out = new Array<number>(totalOut * 2)
  let writeBase = 0
  for (let k = 0; k < segLens.length; k += 1) {
    const srcStart = srcStarts[k]!
    const len = segLens[k]!
    const srcIdx0 = srcStart * 2
    const writeIdx0 = writeBase * 2
    const lenTimes2 = len * 2
    for (let i = 0; i < lenTimes2; i += 1) {
      out[writeIdx0 + i] = data[srcIdx0 + i] ?? 0
    }
    writeBase += len
  }

  const newPixels = totalOut
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
