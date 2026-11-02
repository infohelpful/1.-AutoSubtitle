import type { JsonWaveformData } from '../../../shared/waveformJson'
import { describe, expect, it } from 'vitest'
import { mediaSecondsToPeakPixelRange, resolvePeaksTimelineMetrics, peakEnvelopeForMediaInterval } from './peakPixelMapping'
import { buildEdlSkipMapping } from './edlSkipMapping'

describe('peakPixelMapping', () => {
  it('keeps short voice peaks when one display pixel spans several source bins', () => {
    const metrics = { data: [-5, 5, -100, 110, -3, 3, -2, 2], pixelCount: 4, durationSec: 1 }
    expect(peakEnvelopeForMediaInterval(metrics, 0, 1)).toEqual({ min: -100, max: 110 })
  })

  it('uses the same source samples after earlier deletion and excludes peaks inside a cut seam', () => {
    const metrics = { data: [-1, 1, -120, 120, -3, 3, -4, 4, -5, 5], pixelCount: 5, durationSec: 5 }
    const skips = [{ start: 1, end: 2 }]
    const map = buildEdlSkipMapping({ start: 0, end: 5 }, skips)
    expect(peakEnvelopeForMediaInterval(metrics, map.pixelToMediaSec(0, 4), map.pixelToMediaSec(1, 4), skips))
      .toEqual({ min: -1, max: 1 })
    const laterMap = buildEdlSkipMapping({ start: 3, end: 5 }, skips)
    expect(peakEnvelopeForMediaInterval(metrics, laterMap.pixelToMediaSec(0, 2), laterMap.pixelToMediaSec(1, 2), skips))
      .toEqual(peakEnvelopeForMediaInterval(metrics, 3, 4))
  })
  const json = {
    sample_rate: 48000,
    samples_per_pixel: 512,
    bits: 8,
    length: 100,
    data: new Array(200).fill(0).map((_, i) => (i % 2 === 0 ? -64 : 64))
  } as unknown as JsonWaveformData

  it('resolvePeaksTimelineMetrics · mediaSecondsToPeakPixelRange 클램프', () => {
    const m = resolvePeaksTimelineMetrics(json, 10)
    expect(m).not.toBeNull()
    const { startPixel, endPixel } = mediaSecondsToPeakPixelRange(m!, 1.0, 3.0)
    expect(startPixel).toBeGreaterThanOrEqual(0)
    expect(endPixel).toBeLessThanOrEqual(m!.pixelCount)
    expect(endPixel).toBeGreaterThan(startPixel)
  })
})
