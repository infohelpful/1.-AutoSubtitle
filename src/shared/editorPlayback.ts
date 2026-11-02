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
  const presented = pickActiveSubtitleIndex(lines, time)
  // Two rows can contain overlapping forced-alignment words. While a caption
  // row is on screen, keep its chips active until the shared row boundary.
  if (speech !== null && presented !== null && speech !== presented &&
      time < lines[presented].end && !lines[presented].isHidden &&
      lines[presented].words?.some(word => !word.isDeleted && !word.isSilence)) return presented
  return speech ?? gap ?? presented
}

/** A trailing unknown-audio chip keeps the preceding spoken word highlighted. */
export function resolveEditorHighlight(words: readonly ResolverWord[], time: number): number {
  const exact = resolveActiveWordIndex(words, time, { skipSilence: false })
  if (exact >= 0 && words[exact].isSilence && resolveActiveWordIndex(words, time) < 0) {
    if (words[exact].gapKind === 'unclassified') {
      for (let i = exact - 1; i >= 0; i--) {
        if (!words[i].isDeleted && !words[i].isSilence) return i
      }
    }
    return exact
  }
  return resolveHighlightWordIndex(words, time)
}

export function sourceTimelineDuration(videoDuration: number, waveformDuration: number, subtitleEnd: number): number {
  for (const value of [videoDuration, waveformDuration, subtitleEnd]) {
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}
