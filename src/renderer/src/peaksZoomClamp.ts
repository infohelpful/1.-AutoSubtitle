import type { PeaksInstance } from 'peaks.js'

const EPS_SEC = 0.03
const MIN_SPAN_SEC = 0.05
const MAX_ITER = 40

/**
 * zoomLevels 양자화로 setZoom({ seconds }) 만으로는 오른쪽 끝이 카드 끝을 넘을 수 있음.
 * 짧은 구간으로 반복 좁혀 getEndTime() <= maxEnd 가 될 때까지 맞춘다.
 * Peaks 내부: setZoom 이 프레임 오프셋을 바꾸므로 항상 setZoom 후 setStartTime.
 */
export function applyZoomThenClampEndBeforeOrAt(
  peaks: PeaksInstance,
  opts: {
    windowStart: number
    spanSeconds: number
    /** 가시 영역 오른쪽 시간은 이 값 이하여야 함 (줄 끝 타임코드 / 단어 끝) */
    maxEndTime: number
  }
): void {
  const zv = peaks.views.getView('zoomview')
  if (!zv) return

  const ws = Math.max(0, opts.windowStart)
  const cap = opts.maxEndTime
  let span = Math.max(MIN_SPAN_SEC, opts.spanSeconds)

  if (!Number.isFinite(cap) || cap <= ws + 1e-6) {
    zv.setZoom({ seconds: span })
    zv.setStartTime(ws)
    return
  }

  span = Math.min(span, Math.max(MIN_SPAN_SEC, cap - ws))

  for (let i = 0; i < MAX_ITER; i++) {
    zv.setZoom({ seconds: span })
    zv.setStartTime(ws)
    const end = zv.getEndTime()
    if (end <= cap + EPS_SEC) {
      return
    }
    const over = end - cap
    span = Math.max(MIN_SPAN_SEC, span - over * 1.2)
  }
}
