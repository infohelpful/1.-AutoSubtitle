/**
 * audiowaveform / Python 파이프라인이 만드는 Peaks.js 호환 피크 JSON 형태.
 * 런타임에 `peaks.js` 패키지 없이 파형 렌더링·스티치만 할 때 사용한다.
 */
export type JsonWaveformData = {
  sample_rate: number
  samples_per_pixel?: number
  bits?: number
  length?: number
  data?: number[]
  channels?: Array<{ data?: number[] }>
}
