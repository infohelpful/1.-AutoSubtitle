/**
 * Sentence(문장) — Token(단어) 계층 + 가상 타임라인(비파괴 편집 축).
 * AutoSubtitle 기존 SubtitleLine 과 독립적으로 두고, 추후 어댑터로 연결 가능.
 *
 * 시간 정밀도: 가상 구간 누적·매핑은 밀리초 정수(ms)로 계산해 부동소수 누적 오차를 줄임.
 */

/** 단일 단어 토큰 — 원본 미디어 절대 시간(초) */
export interface TimelineToken {
  id: string
  text: string
  start_original: number
  end_original: number
  is_deleted?: boolean
  /** gap-fill 무음 더미 — `SubtitleWord.isSilence` 와 동기 */
  isSilence?: boolean
}

/** 문장 = 토큰 배열 */
export interface TimelineSentence {
  id: string
  tokens: TimelineToken[]
  is_deleted?: boolean
}

/** 프로젝트 타임라인 = 문장 배열 */
export type SentenceTokenTimeline = TimelineSentence[]

/** 가상 축상의 연속 구간(재생 순서대로 펼친 결과) */
export interface VirtualSegment {
  sentenceId: string
  tokenId: string
  text: string
  start_original: number
  end_original: number
  /** 가상 타임라인상 시작(ms), 누적 */
  virtual_start_ms: number
  /** 가상 타임라인상 끝(ms), exclusive와 유사하게 [start,end) 해석 */
  virtual_end_ms: number
}

export type VirtualTimelineResult = {
  segments: VirtualSegment[]
  /** 삭제 제외 후 가상 타임라인 전체 길이(ms) */
  total_virtual_duration_ms: number
}

const MS = 1000

export function secToMs(sec: number): number {
  return Math.round(sec * MS)
}

export function msToSec(ms: number): number {
  return ms / MS
}

function durationMsOriginal(startSec: number, endSec: number): number {
  return Math.max(0, secToMs(endSec) - secToMs(startSec))
}

/**
 * 삭제된 문장·단어를 제외하고, 남은 토큰을 문장 순서·토큰 순으로 펼쳐
 * 가상 시작/끝(ms)을 누적 할당한다.
 */
export function calculateVirtualTimeline(timeline: SentenceTokenTimeline): VirtualTimelineResult {
  const segments: VirtualSegment[] = []
  let cursorMs = 0

  for (const sentence of timeline) {
    if (sentence.is_deleted) continue
    for (const token of sentence.tokens) {
      if (token.is_deleted) continue
      const dur = durationMsOriginal(token.start_original, token.end_original)
      if (dur <= 0) continue
      const vs = cursorMs
      const ve = cursorMs + dur
      segments.push({
        sentenceId: sentence.id,
        tokenId: token.id,
        text: token.text,
        start_original: token.start_original,
        end_original: token.end_original,
        virtual_start_ms: vs,
        virtual_end_ms: ve
      })
      cursorMs = ve
    }
  }

  return {
    segments,
    total_virtual_duration_ms: cursorMs
  }
}

/** virtual_ms 가 속한 세그먼트 인덱스 — segments는 virtual_start 오름차순 정렬 전제 */
export function findSegmentIndexByVirtualMs(segments: readonly VirtualSegment[], virtualMs: number): number {
  if (segments.length === 0) return -1
  let lo = 0
  let hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segments[mid]!
    if (virtualMs < s.virtual_start_ms) hi = mid - 1
    else if (virtualMs >= s.virtual_end_ms) lo = mid + 1
    else return mid
  }
  return -1
}

/** original_sec 가 속한 세그먼트 인델스 — original 구간 기준 정렬 전제 */
export function findSegmentIndexByOriginalSec(segments: readonly VirtualSegment[], originalSec: number): number {
  if (segments.length === 0) return -1
  let lo = 0
  let hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segments[mid]!
    if (originalSec < s.start_original) hi = mid - 1
    else if (originalSec >= s.end_original) lo = mid + 1
    else return mid
  }
  return -1
}

/**
 * 가상 타임라인 시각(초) → 원본 미디어 시각(초).
 * 구간 내면 선형 보간; 구간 밖이면 가장 가까운 경계로 클램프.
 */
export function getOriginalTime(
  timeline: SentenceTokenTimeline,
  virtualTimeSec: number,
  cached?: VirtualTimelineResult
): number {
  const { segments } = cached ?? calculateVirtualTimeline(timeline)
  if (segments.length === 0) return 0
  const vm = secToMs(virtualTimeSec)
  const idx = findSegmentIndexByVirtualMs(segments, vm)
  if (idx < 0) {
    if (vm <= segments[0]!.virtual_start_ms) return segments[0]!.start_original
    return segments[segments.length - 1]!.end_original
  }
  const seg = segments[idx]!
  const offsetMs = vm - seg.virtual_start_ms
  const durOrigMs = secToMs(seg.end_original) - secToMs(seg.start_original)
  const durVirtMs = seg.virtual_end_ms - seg.virtual_start_ms
  if (durVirtMs <= 0) return seg.start_original
  const ratio = offsetMs / durVirtMs
  const origMs = secToMs(seg.start_original) + ratio * durOrigMs
  return msToSec(Math.round(origMs))
}

/**
 * 원본 미디어 시각(초) → 가상 타임라인 시각(초).
 * 해당 원본 구간을 포함하는 토큰이 없으면(삭제됨·틈) NaN.
 */
export function getVirtualTime(timeline: SentenceTokenTimeline, originalTimeSec: number, cached?: VirtualTimelineResult): number {
  const { segments } = cached ?? calculateVirtualTimeline(timeline)
  if (segments.length === 0) return Number.NaN
  const idx = findSegmentIndexByOriginalSec(segments, originalTimeSec)
  if (idx < 0) return Number.NaN
  const seg = segments[idx]!
  const offsetOrigMs = secToMs(originalTimeSec) - secToMs(seg.start_original)
  const durOrigMs = secToMs(seg.end_original) - secToMs(seg.start_original)
  const durVirtMs = seg.virtual_end_ms - seg.virtual_start_ms
  if (durOrigMs <= 0) return msToSec(seg.virtual_start_ms)
  const ratio = offsetOrigMs / durOrigMs
  const vm = seg.virtual_start_ms + ratio * durVirtMs
  return msToSec(Math.round(vm))
}

function cloneTimeline(timeline: SentenceTokenTimeline): SentenceTokenTimeline {
  return timeline.map((s) => ({
    ...s,
    tokens: s.tokens.map((t) => ({ ...t }))
  }))
}

/**
 * 주어진 문장·토큰을 원본 시각 T_split 에서 둘로 분할.
 * 텍스트는 문자 수에 비례해 나눔(정수 문자 인덱스).
 * 반환: 새 타임라인(불변 복사본 기반).
 */
export function splitTokenAtOriginalTime(
  timeline: SentenceTokenTimeline,
  sentenceId: string,
  tokenId: string,
  splitOriginalSec: number
): SentenceTokenTimeline {
  const next = cloneTimeline(timeline)
  const sentence = next.find((s) => s.id === sentenceId)
  if (!sentence || sentence.is_deleted) return timeline
  const ti = sentence.tokens.findIndex((t) => t.id === tokenId)
  if (ti < 0) return timeline
  const tok = sentence.tokens[ti]!
  if (tok.is_deleted) return timeline
  const a = tok.start_original
  const b = tok.end_original
  if (!(splitOriginalSec > a && splitOriginalSec < b)) return timeline

  const dur = b - a
  const ratio = (splitOriginalSec - a) / dur
  const chars = [...tok.text]
  const cut = Math.min(chars.length, Math.max(0, Math.round(chars.length * ratio)))
  const leftText = chars.slice(0, cut).join('').trim()
  const rightText = chars.slice(cut).join('').trim()
  if (!leftText || !rightText) return timeline

  const left: TimelineToken = {
    id: `${tokenId}_L_${secToMs(splitOriginalSec)}`,
    text: leftText,
    start_original: a,
    end_original: splitOriginalSec,
    is_deleted: false
  }
  const right: TimelineToken = {
    id: `${tokenId}_R_${secToMs(splitOriginalSec)}`,
    text: rightText,
    start_original: splitOriginalSec,
    end_original: b,
    is_deleted: false
  }
  const rest = [...sentence.tokens.slice(0, ti), left, right, ...sentence.tokens.slice(ti + 1)]
  sentence.tokens = rest
  return next
}

/**
 * --- Rendering & Sync (의사코드) ---
 *
 * syncEngine_tick(masterTimeOriginalSec: number):
 *   vt = calculateVirtualTimeline(store.timeline)   // 또는 스토어에 캐시 invalidation
 *   vSec = getVirtualTime(store.timeline, masterTimeOriginalSec, vt)
 *   if (Number.isNaN(vSec)) clearHighlight(); return
 *
 *   // 활성 세그먼트: O(log n)
 *   idx = findSegmentIndexByVirtualMs(vt.segments, secToMs(vSec))
 *   active = vt.segments[idx]
 *
 *   waveform.scrollLeft = mapVirtualSecToPixel(vSec) - viewportCenterOffset   // 별도 픽셀 맵
 *   ui.setActiveSentenceToken(active.sentenceId, active.tokenId)
 *
 * rAF 루프(60fps):
 *   last = -1
 *   function frame():
 *     t = video.currentTime   // 원본 마스터
 *     if (Math.abs(t - last) < 1e-4 && !video.seeking) { rAF(frame); return }
 *     last = t
 *     syncEngine_tick(t)
 *     rAF(frame)
 *
 * 최적화:
 *   - 세그먼트 배열은 virtual_start_ms 정렬 유지 → 이진 탐색
 *   - 타임라인 구조 변경 시에만 calculateVirtualTimeline 재실행
 *   - React: SentenceRow·TokenChip 을 memo, 활성 id만 props로 내려 부분 리렌더
 */
