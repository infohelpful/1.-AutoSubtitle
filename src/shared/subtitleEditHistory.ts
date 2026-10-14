import type { SubtitleLine } from './subtitles'

/** Metadata-only edits (reading, locks, quality, IDs) are also undo transactions. */
export function subtitleLinesMeaningfullyChanged(next: SubtitleLine[], prev: SubtitleLine[]): boolean {
  if (next.length !== prev.length) return true
  for (let i = 0; i < next.length; i++) {
    const n = next[i], p = prev[i]
    if (n === p) continue
    if (!!n.isHidden !== !!p.isHidden) return true
    if (n.start !== p.start || n.end !== p.end || n.text !== p.text || !!n.isDeleted !== !!p.isDeleted) return true
    const nw = n.words ?? [], pw = p.words ?? []
    if (nw.length !== pw.length) return true
    for (let j = 0; j < nw.length; j++) {
      if (nw[j] !== pw[j] && JSON.stringify(nw[j]) !== JSON.stringify(pw[j])) return true
    }
  }
  return false
}
