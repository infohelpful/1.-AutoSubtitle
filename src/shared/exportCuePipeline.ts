/**
 * Phase 6 — 파일 내보내기(SRT·VTT·ASS·TXT)·영상 번인(`export:by-format`) 전에만 사용하는 큐.
 * 렌더러는 편집 SSOT(`SubtitleLine[]`)를 여기로 넘겨, tombstone·무음 더미를 제외한 보이는 텍스트 구간만 만든다.
 */
import type { SubtitleLine } from './subtitles'
import { subtitleCueLinesForExport, subtitleWordPiecesForExport } from './subtitles'

export type ExportCueWord = {
  start: number
  end: number
  text: string
}

export type ExportCueLine = {
  start: number
  end: number
  text: string
  /** 단어 강조 버닝용 발화 구간(원본 시간). 줄 `start`/`end` 와 별개이며 줄 텍스트 조각과 1:1 이다. */
  words?: ExportCueWord[]
}

export type BuildExportCueLinesOptions = {
  /** true 이면 영상 단어 강조 버닝용으로 단어 조각을 함께 싣는다. 기본 false(줄 단위만). */
  includeWords?: boolean
}

/** IPC `ExportRequest.subtitles` 및 메인 `buildMappedSubtitles` 입력 형태와 동일한 플랫 큐 */
export function buildExportCueLines(
  lines: readonly SubtitleLine[],
  options?: BuildExportCueLinesOptions
): ExportCueLine[] {
  const cues = subtitleCueLinesForExport(lines)
  if (!options?.includeWords) return cues
  // subtitleCueLinesForExport 는 tombstone·빈 텍스트 줄을 건너뛰므로 같은 규칙으로 줄을 다시 고른다.
  const kept: SubtitleLine[] = []
  for (const line of lines) {
    if (subtitleCueLinesForExport([line]).length > 0) kept.push(line)
  }
  return cues.map((cue, i) => {
    const pieces = subtitleWordPiecesForExport(kept[i]?.words)
    return pieces.length > 0 ? { ...cue, words: pieces } : cue
  })
}
