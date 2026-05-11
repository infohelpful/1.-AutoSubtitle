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
    /** true: 첫 단어 앞 패딩 없음 — 회색 여백 줄임 */
    clipLeadingToLineStart?: boolean
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
  const clipLead = options?.clipLeadingToLineStart === true
  let windowStart = clipLead ? Math.max(0, lineStart) : Math.max(0, lineStart - pad)
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
  options?: {
    mediaDurationSec?: number | null
    clipTrailingToLineEnd?: boolean
    clipLeadingToLineStart?: boolean
  }
): LineZoomWindowResult | null {
  if (!words.length) return null
  const lineStart = Math.min(...words.map((w) => w.start))
  const lineEnd = Math.max(...words.map((w) => w.end))
  return computeLineZoomWindowFromCardBounds(lineStart, lineEnd, options)
}

/**
 * **단어 더블클릭 — “선택 단어 + ±1 이웃” 컨텍스트 줌 창** (`SubtitleWaveformCanvas` 전용).
 *
 * 기본 창: `words[wi-1].start` ~ `words[wi+1].end` (이웃이 없으면 활성 단어 자체로 폴백).
 * 확장: `expandLeft` · `expandRight` 만큼 양옆에 단어를 더 포함 (드래그가 경계를 살짝 넘을 때마다 +1).
 *
 * @returns `null` — words 가 비었거나 인덱스가 범위 밖일 때
 */
export function computeWordContextWindow(
  words: readonly { start: number; end: number }[],
  activeWordIndex: number,
  expandLeft = 0,
  expandRight = 0,
  options?: { mediaDurationSec?: number | null }
): LineZoomWindowResult | null {
  if (!words.length) return null
  if (activeWordIndex < 0 || activeWordIndex >= words.length) return null

  const expL = Math.max(0, Math.floor(expandLeft))
  const expR = Math.max(0, Math.floor(expandRight))

  const lo = Math.max(0, activeWordIndex - 1 - expL)
  const hi = Math.min(words.length - 1, activeWordIndex + 1 + expR)

  const lineStart = words[lo]!.start
  const lineEnd = words[hi]!.end

  const dur =
    options?.mediaDurationSec != null &&
    Number.isFinite(options.mediaDurationSec) &&
    options.mediaDurationSec > 0
      ? options.mediaDurationSec
      : Number.POSITIVE_INFINITY

  // 작은 패딩 — 줄 전체 폴백(`computeLineZoomWindowFromCardBounds`) 대비 절반 정도로만,
  // 활성 단어 경계가 캔버스 가장자리에 딱 붙어 보이지 않도록.
  const span = Math.max(lineEnd - lineStart, 0.001)
  const pad = Math.max(0.04, span * 0.02)
  const windowStart = Math.max(0, lineStart - pad)
  const windowEnd = Math.min(dur, lineEnd + pad)
  const finalEnd =
    windowEnd <= windowStart + 1e-6 ? Math.min(dur, windowStart + 0.12) : windowEnd
  return {
    lineStart,
    lineEnd,
    windowStart,
    windowEnd: finalEnd,
    span: Math.max(finalEnd - windowStart, 1e-6)
  }
}
