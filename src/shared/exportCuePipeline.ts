/**
 * Phase 6 — 파일 내보내기(SRT·VTT·ASS·TXT)·영상 번인(`export:by-format`) 전에만 사용하는 큐.
 * 렌더러는 편집 SSOT(`SubtitleLine[]`)를 여기로 넘겨, tombstone·무음 더미를 제외한 보이는 텍스트 구간만 만든다.
 */
import type { SubtitleLine } from './subtitles'
import { subtitleCueLinesForExport } from './subtitles'

export type ExportCueLine = {
  start: number
  end: number
  text: string
}

/** IPC `ExportRequest.subtitles` 및 메인 `buildMappedSubtitles` 입력 형태와 동일한 플랫 큐 */
export function buildExportCueLines(lines: readonly SubtitleLine[]): ExportCueLine[] {
  return subtitleCueLinesForExport(lines)
}
