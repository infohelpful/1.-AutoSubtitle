/**
 * 자막 줄 단어들과 Peaks 줌 뷰가 같은 시간 구간을 쓰도록 — 카드 단어 칩 가로 위치와 파형 픽셀 매핑을 맞춘다.
 */
export type LineZoomWindowResult = {
  lineStart: number
  lineEnd: number
  windowStart: number
  windowEnd: number
  span: number
}

/** 카드 헤더 타임코드와 동일한 선 구간 — 칩·Peaks 줌·오버레이 선이 같은 픽셀 비율을 쓴다 */
export function computeLineZoomWindowFromCardBounds(
  lineStart: number,
  lineEnd: number,
  options?: {
    mediaDurationSec?: number | null
    /**
     * true: 줄 끝(timecode 오른쪽) 이후 패딩 없음 — 파형이 카드 끝에서 끊김(뒤 오디오 안 보임).
     * false/omit: 기존처럼 양끝 소량 패딩.
     */
    clipTrailingToLineEnd?: boolean
  }
): LineZoomWindowResult {
  const lineSpan = Math.max(lineEnd - lineStart, 0.001)
  const pad = Math.max(0.08, lineSpan * 0.04)
  const dur =
    options?.mediaDurationSec != null &&
    Number.isFinite(options.mediaDurationSec) &&
    options.mediaDurationSec > 0
      ? options.mediaDurationSec
      : Number.POSITIVE_INFINITY
  const clipEnd = options?.clipTrailingToLineEnd === true
  let windowStart = Math.max(0, lineStart - pad)
  let windowEnd = clipEnd ? Math.min(dur, lineEnd) : Math.min(dur, lineEnd + pad)
  if (clipEnd && windowEnd <= windowStart + 1e-6) {
    windowStart = Math.max(0, lineStart)
    windowEnd = Math.min(dur, lineEnd)
  }
  if (windowEnd <= windowStart + 1e-6) {
    windowEnd = Math.min(dur, windowStart + 0.12)
  }
  const span = Math.max(windowEnd - windowStart, 1e-6)
  return { lineStart, lineEnd, windowStart, windowEnd, span }
}

export function computeLineZoomWindow(
  words: readonly { start: number; end: number }[],
  options?: { mediaDurationSec?: number | null; clipTrailingToLineEnd?: boolean }
): LineZoomWindowResult | null {
  if (!words.length) return null
  const lineStart = Math.min(...words.map((w) => w.start))
  const lineEnd = Math.max(...words.map((w) => w.end))
  return computeLineZoomWindowFromCardBounds(lineStart, lineEnd, options)
}
