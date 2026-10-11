import type { SubtitleLine } from './subtitles'
import { markWordEdited } from './wordAlignmentMeta'
import { scrubTimelineNoiseFromWordPiece } from './wordContract'

/** Keep source intervals and IDs when correcting text. New text has no measured timing. */
export function editSubtitleText(line: SubtitleLine, text: string): SubtitleLine {
  if (line.text === text) return line
  const before = line.text
  let start = 0
  while (start < before.length && start < text.length && before[start] === text[start]) start++
  let end = before.length, nextEnd = text.length
  while (end > start && nextEnd > start && before[end - 1] === text[nextEnd - 1]) { end--; nextEnd-- }
  const inserted = text.slice(start, nextEnd)
  let cursor = 0
  const spans = (line.words ?? []).flatMap((word, index) => {
    if (word.isDeleted || word.isSilence) return []
    const label = scrubTimelineNoiseFromWordPiece(word.word)
    if (!label) return []
    const at = before.indexOf(label, cursor)
    if (at < 0) return []
    cursor = at + label.length
    return [{ index, start: at, end: cursor, label }]
  })
  // Insertions in a separator belong to the following word, or the last word at EOF.
  const owner = spans.find(s => s.end > start) ?? spans.at(-1)
  const words = line.words?.map((word, index) => {
    const span = spans.find(s => s.index === index)
    if (!span) return word
    const a = Math.max(0, Math.min(span.label.length, start - span.start))
    const b = Math.max(a, Math.min(span.label.length, end - span.start))
    const label = span.label.slice(0, a) + (owner === span ? inserted : '') + span.label.slice(b)
    return label === span.label ? word : markWordEdited(word, { ...word, word: label })
  })
  return { ...line, text, words }
}
