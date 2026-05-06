/**
 * Phase 5 — 편집 후 타임라인 정책
 *
 * ## Gap 재계산 (gap-fill)
 * - 편집(무음 삭제·단어 삭제·세그먼트 드래그 병합) 직후 **자동으로 무음 더미(??)를 다시 넣지 않는다.**
 * - 대신 App 상태 `gapFillWhenBuildingVrew`(기본 true)가 true일 때만
 *   `subtitleLinesToVrewRows` 가 `fillGapsInSubtitleWords` 를 실행한다.
 * - 무음 일괄 삭제 실행 시 `gapFillWhenBuildingVrew = false` 로 두어, 이후 vrew 변환에서
 *   구간 메우기를 생략한다.
 * - 타임라인 간격을 다시 맞추려면 UI에서 gap-fill 을 다시 켠다(동일 정책으로 재삽입).
 */

import type { SubtitleLine } from './subtitles'

/** 편집으로 단어 배열을 바꾼 뒤 자동 gap-fill 을 하지 않는다는 정책(문서용). */
export const NO_AUTO_GAP_FILL_AFTER_EDIT = true

export function removeSilenceWordsFromSubtitleLines(lines: SubtitleLine[]): SubtitleLine[] {
  const out: SubtitleLine[] = []
  for (const line of lines) {
    const words = (line.words ?? []).filter((w) => !w.isSilence)
    if (words.length === 0) continue
    const start = Math.min(...words.map((w) => w.start))
    const end = Math.max(...words.map((w) => w.end))
    out.push({
      ...line,
      start,
      end,
      words,
      text: words.map((w) => w.word).join(' ').trim()
    })
  }
  return out
}
