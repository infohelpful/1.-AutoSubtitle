/**
 * Phase 1 — 단어 타임라인 데이터 계약 (Word contract)
 *
 * ## 단일 소스 (Source of truth)
 * - 모든 `start` / `end`는 **미디어 절대 시간(초)**. 타일·파형·내보내기는 이 값을 기준으로 동기화한다.
 *
 * ## 정렬·무결성 (불변 규칙)
 * - 한 줄(`SubtitleLine`) 안의 `words`는 **start 오름차순**으로 해석한다.
 * - 각 단어는 `start < end` 이어야 한다.
 * - **겹침**: 인접 세그먼트는 `words[i].end <= words[i+1].start + FLOAT_EPS` 를 만족하는 것이 이상적이다.
 *   (Whisper 등에서 겹치면 편집 전에 병합하거나 검증에서 오류로 잡는다.)
 * - **역전** (`start` 순서가 뒤바뀜): 허용하지 않는다. 정렬하지 않은 원본은 파서/어댑터에서 정렬 후 사용한다.
 * - **카드(자막 줄)와 배열**: `SubtitleLine.start/end`는 한 줄의 전체 구간이다.
 *   단어들은 원칙적으로 `[line.start, line.end]` 안에 있어야 하며, gap-fill 무음은 그 구간 안의 빈 시간을 메운다.
 *
 * ## Gap-fill (무음 더미)
 * - **임계값**: `DEFAULT_GAP_THRESHOLD_SEC` (기본 0.2초) 이상인 빈 구간에 더미를 삽입한다.
 * - **더미 텍스트**: `SILENCE_PLACEHOLDER_TEXT` (`??`).
 * - **삽입 위치**: (1) 줄 시작 ~ 첫 단어 시작, (2) 인접 단어 사이, (3) 마지막 단어 끝 ~ 줄 끝 (옵션으로 경계 포함).
 * - **편집 후 재실행**: 기본값 `stripPreviousSilences: true` 이면,
 *   저장된 배열에서 `isSilence: true` 항목을 제거한 뒤 다시 gap-fill 하여 **동일 정책으로 재생성**(멱등에 가깝게)한다.
 *   수동으로 무음 길이만 조정한 결과를 유지하려면 이후 단계에서 플래그를 분리한다.
 */

import type { SubtitleWord } from './subtitles'

/** 부동소수점 비교 허용 오차 (초) */
export const FLOAT_EPS = 1e-4

/** 단어 사이·줄 경계 빈 구간을 메우기 위한 최소 길이(초) */
export const DEFAULT_GAP_THRESHOLD_SEC = 0.2

/** 무음 더미에 표시할 문자열 */
export const SILENCE_PLACEHOLDER_TEXT = '??'

export type FillGapsOptions = {
  /** 기본 `DEFAULT_GAP_THRESHOLD_SEC` */
  gapThresholdSec?: number
  /** 줄의 `start`~첫 단어, 마지막 단어~`end` 도 메울지 (기본 true) */
  includeLineBoundaries?: boolean
  /**
   * true(기본): `isSilence` 단어는 제거한 뒤 구간을 다시 계산한다.
   * false: 기존 무음 행을 유지한 채로 중간만 처리(고급).
   */
  stripPreviousSilences?: boolean
}

function pushSilenceSegment(
  pieces: SubtitleWord[],
  start: number,
  end: number,
  threshold: number
): void {
  if (!(end - start >= threshold - FLOAT_EPS)) return
  if (end <= start + FLOAT_EPS) return
  pieces.push({
    start,
    end,
    word: SILENCE_PLACEHOLDER_TEXT,
    isSilence: true
  })
}

/**
 * 한 줄의 비-무음 단어들 사이·줄 경계의 빈 구간을 `isSilence: true` 더미로 채운다.
 * 원본에 이미 있는 gap-fill 무음은 기본적으로 제거 후 재계산한다.
 */
export function fillGapsInSubtitleWords(
  line: { start: number; end: number; words: SubtitleWord[] },
  options?: FillGapsOptions
): SubtitleWord[] {
  const threshold = options?.gapThresholdSec ?? DEFAULT_GAP_THRESHOLD_SEC
  const includeLineBoundaries = options?.includeLineBoundaries ?? true
  const stripPreviousSilences = options?.stripPreviousSilences ?? true

  const raw = stripPreviousSilences ? line.words.filter((w) => !w.isSilence) : [...line.words]

  const cleaned: SubtitleWord[] = raw
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start + FLOAT_EPS)
    .map((w) => ({
      start: w.start,
      end: w.end,
      word: typeof w.word === 'string' ? w.word.trim() : ''
    }))
    .filter((w) => w.word.length > 0)

  cleaned.sort((a, b) => a.start - b.start || a.end - b.end)

  if (cleaned.length === 0) return []

  const pieces: SubtitleWord[] = []

  if (includeLineBoundaries) {
    pushSilenceSegment(pieces, line.start, cleaned[0].start, threshold)
  }

  for (let i = 0; i < cleaned.length; i++) {
    pieces.push({
      start: cleaned[i].start,
      end: cleaned[i].end,
      word: cleaned[i].word
    })
    if (i < cleaned.length - 1) {
      const a = cleaned[i]
      const b = cleaned[i + 1]
      if (b.start > a.end + FLOAT_EPS) {
        pushSilenceSegment(pieces, a.end, b.start, threshold)
      }
    }
  }

  if (includeLineBoundaries) {
    const last = cleaned[cleaned.length - 1]
    pushSilenceSegment(pieces, last.end, line.end, threshold)
  }

  return mergeAdjacentSilences(pieces)
}

/** 인접한 무음 세그먼트가 동일 정책으로 연속 생성된 경우 하나로 합친다. */
function mergeAdjacentSilences(words: SubtitleWord[]): SubtitleWord[] {
  if (words.length < 2) return words
  const out: SubtitleWord[] = []
  for (const w of words) {
    const prev = out[out.length - 1]
    if (
      prev &&
      prev.isSilence === true &&
      w.isSilence === true &&
      Math.abs(w.start - prev.end) < FLOAT_EPS
    ) {
      prev.end = w.end
    } else {
      out.push({ ...w })
    }
  }
  return out
}

export type ValidateSubtitleWordsResult = {
  ok: boolean
  errors: string[]
}

/**
 * 한 줄 단어 배열에 대한 간단한 불변 조건 검사.
 * (내보내기 전·Peaks 동기화 전에 호출해 디버그 시 빠른 실패를 제공한다.)
 */
export function validateSubtitleLineWords(line: {
  start: number
  end: number
  words: SubtitleWord[]
}): ValidateSubtitleWordsResult {
  const errors: string[] = []

  if (!Number.isFinite(line.start) || !Number.isFinite(line.end)) {
    errors.push('line: start and end must be finite numbers')
  } else if (line.end < line.start - FLOAT_EPS) {
    errors.push('line: end must be >= start')
  }

  const words = [...(line.words ?? [])].sort((a, b) => a.start - b.start || a.end - b.end)

  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const label = `words[${i}]`

    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) {
      errors.push(`${label}: start/end must be finite`)
      continue
    }
    if (w.end <= w.start + FLOAT_EPS) {
      errors.push(`${label}: requires end > start`)
    }

    if (i > 0) {
      const p = words[i - 1]
      if (w.start < p.end - FLOAT_EPS) {
        errors.push(`${label}: overlaps previous segment (starts before previous end)`)
      }
    }

    /** 줄 경계 대비 여유(반올림·Whisper 드리프트) */
    const boundarySlack = 0.05
    if (Number.isFinite(line.start) && Number.isFinite(line.end)) {
      if (w.start < line.start - boundarySlack || w.end > line.end + boundarySlack) {
        errors.push(`${label}: outside line range [${line.start}, ${line.end}]`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}
