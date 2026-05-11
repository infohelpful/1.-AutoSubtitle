import type { JsonWaveformData } from '../../../../shared/waveformJson'

/** 데모·스토리북용 — 짧은 8-bit min/max 스트립 */
export function makeDemoWaveformJson(durationSec: number): JsonWaveformData {
  const sample_rate = 8000
  const samples_per_pixel = 512
  const n = Math.max(8, Math.ceil((durationSec * sample_rate) / samples_per_pixel))
  const data: number[] = new Array(n * 2)
  for (let i = 0; i < n * 2; i += 1) {
    data[i] = 50 + (i % 60)
  }
  return { sample_rate, samples_per_pixel, data }
}
