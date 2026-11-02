import type { SubtitleLine } from './subtitles'

/** Caption edits never rewrite the source transcript chips or their timings. */
export function editSubtitleText(line: SubtitleLine, text: string): SubtitleLine {
  if (line.captionText === text && line.text === text) return line
  return { ...line, text, captionText: text }
}
