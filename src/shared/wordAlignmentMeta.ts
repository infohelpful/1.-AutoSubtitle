/**
 * 단어 정렬 메타데이터 — 사이드카(WhisperX 강제 정렬) 결과와 사용자 편집 상태를 단어에 붙여 보존한다.
 *
 * - `start`/`end`(기존 필드)는 화면·재생이 쓰는 확정 시간이고, `sourceStart`/`sourceEnd`/`rawStart`/`rawEnd`는
 *   엔진이 낸 추정치·원시값이다. 서로 덮어쓰지 않는다.
 * - 상태가 없는 단어(레거시)는 `estimated` 로 취급한다. 정렬되지 않은 시간을 `aligned` 로 표시하지 않는다.
 * - 모델 점수(`alignmentScore`)는 정확도 확률이 아니다.
 */

export const ALIGNMENT_STATUSES = ['aligned', 'estimated', 'manual', 'unaligned', 'stale'] as const
export type AlignmentStatus = (typeof ALIGNMENT_STATUSES)[number]

export type WordAlignmentMeta = {
  /** 인덱스와 독립적인 단어 ID(사이드카가 부여) */
  id?: string
  /** New spoken word created when an edited phrase is split during realignment. */
  parentWordId?: string
  segmentId?: string
  alignmentStatus?: AlignmentStatus
  /** 엔진 점수 — 정확도 확률 아님. 없으면 null */
  alignmentScore?: number | null
  /** 강제 정렬이 낸 시간. 못 찾았으면 null */
  sourceStart?: number | null
  sourceEnd?: number | null
  /** 정렬 이전 ASR 원시 시간 */
  rawStart?: number | null
  rawEnd?: number | null
  engine?: string
  modelRevision?: string
  /** 모델 입력 문자열(표시 문자열과 다를 수 있음) */
  alignmentText?: string
  readingOverride?: string
  textSpanMap?: Array<{ displayStart: number; displayEnd: number; alignmentStart: number; alignmentEnd: number }>
  charSpans?: Array<{ char: string; start: number; end: number; score: number; alignmentStart?: number; alignmentEnd?: number }>
  reviewReasons?: string[]
  /** 사용자가 직접 고정한 경계 — 재정렬이 덮어쓰지 않는다 */
  manualStartLocked?: boolean
  manualEndLocked?: boolean
}

/** 이 이하의 시간 차이는 편집이 아니라 부동소수·축 변환 오차로 본다(초). */
export const WORD_EDIT_TIME_EPS_SEC = 1e-3

const MAX_REVIEW_REASONS = 16
const MAX_STRING_LEN = 256

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function finiteOrNull(v: unknown): number | null | undefined {
  if (v === null) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return undefined
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_STRING_LEN ? v : undefined
}

/** 외부 JSON(사이드카 응답·저장 파일)에서 검증된 부분만 뽑는다. 잘못된 값은 버린다. */
export function parseWordAlignmentMeta(raw: Record<string, unknown>): WordAlignmentMeta {
  const out: WordAlignmentMeta = {}
  const id = nonEmptyString(raw.id)
  if (id !== undefined) out.id = id
  const parentWordId = nonEmptyString(raw.parentWordId)
  if (parentWordId !== undefined) out.parentWordId = parentWordId
  const segmentId = nonEmptyString(raw.segmentId)
  if (segmentId !== undefined) out.segmentId = segmentId
  if (
    typeof raw.alignmentStatus === 'string' &&
    (ALIGNMENT_STATUSES as readonly string[]).includes(raw.alignmentStatus)
  ) {
    out.alignmentStatus = raw.alignmentStatus as AlignmentStatus
  }
  for (const key of ['alignmentScore', 'sourceStart', 'sourceEnd', 'rawStart', 'rawEnd'] as const) {
    const v = finiteOrNull(raw[key])
    if (v !== undefined) out[key] = v
  }
  const engine = nonEmptyString(raw.engine)
  if (engine !== undefined) out.engine = engine
  const modelRevision = nonEmptyString(raw.modelRevision)
  if (modelRevision !== undefined) out.modelRevision = modelRevision
  if (typeof raw.alignmentText === 'string' && raw.alignmentText.length <= MAX_STRING_LEN) {
    out.alignmentText = raw.alignmentText
  }
  const reading = nonEmptyString(raw.readingOverride)
  if (reading !== undefined) out.readingOverride = reading
  if (Array.isArray(raw.textSpanMap)) {
    const spans = raw.textSpanMap.slice(0, MAX_STRING_LEN).filter(isRecord).filter(s =>
      ['displayStart', 'displayEnd', 'alignmentStart', 'alignmentEnd'].every(k =>
        Number.isSafeInteger(s[k]) && Number(s[k]) >= 0 && Number(s[k]) <= MAX_STRING_LEN) &&
      Number(s.displayEnd) > Number(s.displayStart) && Number(s.alignmentEnd) > Number(s.alignmentStart))
    if (spans.length === raw.textSpanMap.length) out.textSpanMap = spans.map(s => ({
      displayStart: Number(s.displayStart), displayEnd: Number(s.displayEnd),
      alignmentStart: Number(s.alignmentStart), alignmentEnd: Number(s.alignmentEnd)
    }))
  }
  if (Array.isArray(raw.charSpans)) {
    // Punctuation without an acoustic interval is deliberately omitted.
    out.charSpans = raw.charSpans.slice(0, MAX_STRING_LEN).filter(isRecord).flatMap(s => {
      if (typeof s.char !== 'string' || [...s.char].length !== 1 ||
          typeof s.start !== 'number' || typeof s.end !== 'number' || typeof s.score !== 'number' ||
          ![s.start, s.end, s.score].every(Number.isFinite) || s.start < 0 || s.end <= s.start) return []
      const span: NonNullable<WordAlignmentMeta['charSpans']>[number] = {
        char: s.char, start: s.start, end: s.end, score: s.score
      }
      if (Number.isSafeInteger(s.alignmentStart) && Number(s.alignmentStart) >= 0 &&
          Number(s.alignmentEnd) === Number(s.alignmentStart) + 1 && Number(s.alignmentEnd) <= MAX_STRING_LEN) {
        span.alignmentStart = Number(s.alignmentStart)
        span.alignmentEnd = Number(s.alignmentEnd)
      }
      return [span]
    })
  }
  if (Array.isArray(raw.reviewReasons)) {
    const reasons = raw.reviewReasons
      .filter((r): r is string => typeof r === 'string' && r.length > 0 && r.length <= MAX_STRING_LEN)
      .slice(0, MAX_REVIEW_REASONS)
    if (reasons.length > 0) out.reviewReasons = reasons
  }
  if (raw.manualStartLocked === true) out.manualStartLocked = true
  if (raw.manualEndLocked === true) out.manualEndLocked = true
  return out
}

/** `parseWordAlignmentMeta` 용 입력 가드 */
export function parseWordAlignmentMetaFrom(raw: unknown): WordAlignmentMeta {
  return isRecord(raw) ? parseWordAlignmentMeta(raw) : {}
}

/** 상태가 없는 레거시 단어는 `estimated` — `aligned` 로 오표시하지 않는다. */
export function effectiveAlignmentStatus(word: WordAlignmentMeta): AlignmentStatus {
  return word.alignmentStatus ?? 'estimated'
}

type EditableWord = WordAlignmentMeta & {
  start: number
  end: number
  word: string
  isSilence?: boolean
}

/**
 * 사용자 편집 결과를 단어 정렬 상태에 반영한다.
 * - 시간이 바뀐 쪽 경계는 manual lock 이 되고 단어는 `manual` 이다(엔진 추정치는 감사용으로 유지).
 * - 정렬된 단어의 글자가 바뀌면 `stale` — 시간은 유지하되 재정렬 대상이다. 레거시/추정/미정렬 단어는 상태를 새로 붙이지 않는다.
 * - 무음 더미는 정렬 상태를 갖지 않는다.
 */
export function markWordEdited<T extends EditableWord>(
  prev: T,
  next: { start: number; end: number; word: string }
): T & WordAlignmentMeta {
  const result: T & WordAlignmentMeta = { ...prev, start: next.start, end: next.end, word: next.word }
  if (prev.isSilence === true) return result

  const textChanged = next.word !== prev.word
  if (textChanged) {
    delete result.charSpans
    delete result.textSpanMap
    delete result.alignmentText
    delete result.readingOverride
  }
  const startChanged = Math.abs(next.start - prev.start) > WORD_EDIT_TIME_EPS_SEC
  const endChanged = Math.abs(next.end - prev.end) > WORD_EDIT_TIME_EPS_SEC

  if (textChanged && prev.alignmentStatus === 'aligned') {
    result.alignmentStatus = 'stale'
    const reasons = new Set(prev.reviewReasons ?? [])
    reasons.add('text_edited')
    result.reviewReasons = [...reasons].slice(0, MAX_REVIEW_REASONS)
  }
  if (startChanged || endChanged) {
    if (startChanged) result.manualStartLocked = true
    if (endChanged) result.manualEndLocked = true
    result.alignmentStatus = 'manual'
  }
  return result
}
