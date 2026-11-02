import { editSubtitleText } from './editSubtitleText'
import { subtitleLineEditDisplayText, type SubtitleLine } from './subtitles'

export type SubtitleSearchOptions = { caseSensitive?: boolean }
export type SubtitleSearchMatch = { line: number; start: number; end: number }

function isRemovedRow(line: SubtitleLine): boolean {
  return line.isDeleted === true || (!!line.words?.length && line.words.every(w => w.isDeleted))
}

function findIn(text: string, query: string, caseSensitive: boolean): number[] {
  if (!query) return []
  const hay = caseSensitive ? text : text.toLocaleLowerCase()
  const needle = caseSensitive ? query : query.toLocaleLowerCase()
  const out: number[] = []
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push(at)
  return out
}

/** Literal matches in each row's caption text (what the edit box shows). */
export function findSubtitleMatches(
  lines: readonly SubtitleLine[], query: string, options: SubtitleSearchOptions = {}
): SubtitleSearchMatch[] {
  if (!query) return []
  const out: SubtitleSearchMatch[] = []
  lines.forEach((line, i) => {
    if (isRemovedRow(line)) return
    for (const start of findIn(subtitleLineEditDisplayText(line), query, !!options.caseSensitive)) {
      out.push({ line: i, start, end: start + query.length })
    }
  })
  return out
}

/** Replace one match; source word chips are untouched (caption override only). */
export function replaceSubtitleMatch(
  lines: readonly SubtitleLine[], match: SubtitleSearchMatch, replacement: string
): SubtitleLine[] {
  const line = lines[match.line]
  if (!line) return [...lines]
  const text = subtitleLineEditDisplayText(line)
  const next = text.slice(0, match.start) + replacement + text.slice(match.end)
  return lines.map((l, i) => i === match.line ? editSubtitleText(l, next) : l)
}

/** Replace every match; returns the new lines and how many were replaced. */
export function replaceAllSubtitleMatches(
  lines: readonly SubtitleLine[], query: string, replacement: string, options: SubtitleSearchOptions = {}
): { lines: SubtitleLine[]; count: number } {
  let count = 0
  const next = lines.map(line => {
    if (!query || isRemovedRow(line)) return line
    const text = subtitleLineEditDisplayText(line)
    const hits = findIn(text, query, !!options.caseSensitive)
    if (!hits.length) return line
    count += hits.length
    let out = '', from = 0
    for (const at of hits) { out += text.slice(from, at) + replacement; from = at + query.length }
    return editSubtitleText(line, out + text.slice(from))
  })
  return { lines: next, count }
}
