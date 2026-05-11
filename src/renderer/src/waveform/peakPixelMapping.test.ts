import type { JsonWaveformData } from '../../../shared/waveformJson'
import { describe, expect, it } from 'vitest'
import { mediaSecondsToPeakPixelRange, resolvePeaksTimelineMetrics } from './peakPixelMapping'

describe('peakPixelMapping', () => {
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
