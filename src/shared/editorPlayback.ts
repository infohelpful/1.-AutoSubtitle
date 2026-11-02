import type { SubtitleLine } from './subtitles'
import { pickActiveSubtitleIndex } from './subtitlePresentation'
import { resolveActiveWordIndex, resolveHighlightWordIndex, type ResolverWord } from './activeWordResolver'

export function isRemovedSubtitleRow(line: SubtitleLine): boolean {
  return line.isDeleted === true || !!(line.words?.length && line.words.every(word => word.isDeleted))
}

/** Editor selection follows actual media, independently from caption lead/hold. */
export function pickActiveEditorRow(lines: readonly SubtitleLine[], time: number): number | null {
  let speech: number | null = null, gap: number | null = null, latest = -Infinity
  lines.forEach((line, index) => {
    if (isRemovedSubtitleRow(line)) return
    for (const word of line.words ?? []) {
      if (word.isDeleted || !(word.start <= time && time < word.end)) continue
      if (word.isSilence) gap = index
      else if (word.start >= latest) { latest = word.start; speech = index }
    }
  })
  return speech ?? gap ?? pickActiveSubtitleIndex(lines, time)
}

/** Gap chips light only within their own interval, never through the speech hold rule. */
export function resolveEditorHighlight(words: readonly ResolverWord[], time: number): number {
  const exact = resolveActiveWordIndex(words, time, { skipSilence: false })
  return exact >= 0 && words[exact].isSilence && resolveActiveWordIndex(words, time) < 0
    ? exact : resolveHighlightWordIndex(words, time)
}

export function sourceTimelineDuration(videoDuration: number, waveformDuration: number, subtitleEnd: number): number {
  for (const value of [videoDuration, waveformDuration, subtitleEnd]) {
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}
