import type { SubtitleLine } from './subtitles'

export type SubtitlePresentationSpan = { index: number; start: number; end: number }
const cache = new WeakMap<readonly SubtitleLine[], SubtitlePresentationSpan[]>()

/** Display boundaries only. Word/audio timestamps remain on the original media axis. */
export function subtitlePresentationSpans(lines: readonly SubtitleLine[]): SubtitlePresentationSpan[] {
  const cached = cache.get(lines)
  if (cached) return cached
  const spans = lines.flatMap((line, index) => {
    if (line.isDeleted || (line.words?.length && line.words.every(word => word.isDeleted))) return []
    if (!Number.isFinite(line.start) || !Number.isFinite(line.end)) return []
    const visible = line.words?.filter(word => !word.isDeleted)
    // Older projects can keep stale row bounds after a word deletion.
    if (visible?.length && line.words?.some(word => word.isDeleted)) {
      return [{ index, start: Math.min(...visible.map(word => word.start)), end: Math.max(...visible.map(word => word.end)) }]
    }
    return [{ index, start: line.start, end: line.end }]
  }).sort((a, b) => a.start - b.start || a.index - b.index)
  for (let i = 0; i + 1 < spans.length; i++) {
    // An explicit empty/silence row still clears the subtitle at its own start.
    spans[i].end = spans[i + 1].start
  }
  cache.set(lines, spans)
  return spans
}

export function pickActiveSubtitleIndex(lines: readonly SubtitleLine[], time: number): number | null {
  if (!Number.isFinite(time)) return null
  const spans = subtitlePresentationSpans(lines)
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid].start <= time) lo = mid + 1
    else hi = mid - 1
  }
  const span = spans[hi]
  return span && time < span.end ? span.index : null
}

export function subtitlePresentationEnd(lines: readonly SubtitleLine[], index: number): number {
  return subtitlePresentationSpans(lines).find(span => span.index === index)?.end ?? lines[index]?.end ?? 0
}

export function subtitlePresentationStart(lines: readonly SubtitleLine[], index: number): number {
  return subtitlePresentationSpans(lines).find(span => span.index === index)?.start ?? lines[index]?.start ?? 0
}
