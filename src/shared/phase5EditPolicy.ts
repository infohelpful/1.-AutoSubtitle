/**
 * Phase 5 — 편집 후 타임라인 정책
 *
 * ## Gap 재계산 (gap-fill)
 * - 편집(단어 삭제·세그먼트 드래그 병합) 직후 **자동으로 무음 더미(--)를 다시 넣지 않는다.**
 * - App 상태 `gapFillWhenBuildingVrew`(기본 **false** — Peaks·자막 단어 1:1)가 true일 때만
 *   `subtitleLinesToVrewRows` 가 `fillGapsInSubtitleWords` 를 실행한다.
 * - 무음 블록 제거는 사용자가 단어 편집·삭제로 처리한다.
 * - 타임라인 간격을 다시 맞추려면 UI에서 gap-fill 을 다시 켠다(동일 정책으로 재삽입).
 */

import type { SubtitleLine } from './subtitles'
import { displayTextFromSubtitleWords, visibleSubtitleWords } from './subtitles'

/** 편집으로 단어 배열을 바꾼 뒤 자동 gap-fill 을 하지 않는다는 정책(문서용). */
export const NO_AUTO_GAP_FILL_AFTER_EDIT = true

/**
 * Peaks 행을 만들 때 빈 구간을 무음 더미(`fillGapsInSubtitleWords`) 로 메울지 결정한다.
 *
 * - tombstone(`isDeleted`)이 한 줄이라도 있으면 → 항상 false (이미 편집된 결과를 덮어쓰지 않음).
 * - 그렇지 않으면 → 사용자의 `gapFillWhenBuildingVrew` 그대로 반영.
 */
export function shouldFillGapsWhenBuildingVrewRows(
  gapFillWhenBuildingVrew: boolean,
  subtitlesContainDeletedWords: boolean
): boolean {
  if (subtitlesContainDeletedWords) return false
  return gapFillWhenBuildingVrew
}

export function removeSilenceWordsFromSubtitleLines(lines: SubtitleLine[]): SubtitleLine[] {
  const out: SubtitleLine[] = []
  for (const line of lines) {
    const words = (line.words ?? []).filter((w) => !w.isSilence)
    if (words.length === 0) continue
    const vis = visibleSubtitleWords(words)
    if (vis.length === 0) continue
    const start = Math.min(...vis.map((w) => w.start))
    const end = Math.max(...vis.map((w) => w.end))
    out.push({
      ...line,
      start,
      end,
      words,
      text: displayTextFromSubtitleWords(words)
    })
  }
  return out
}
