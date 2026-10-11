import type { SubtitleLine } from './subtitles'

/** Assign once at ingestion/edit boundaries. Preserve references when nothing changed. */
export function ensureWordIdentities(lines: SubtitleLine[], makeId = () => crypto.randomUUID()): SubtitleLine[] {
  const reserved = new Set(lines.flatMap(l => (l.words ?? []).map(w => w.id).filter((id): id is string => !!id)))
  const seen = new Set<string>()
  let changed = false
  const result = lines.map(line => {
    let lineChanged = false
    const words = line.words?.map(word => {
      if (word.isSilence) return word
      if (word.id && !seen.has(word.id)) { seen.add(word.id); return word }
      let id: string
      do { id = `word-${makeId()}` } while (reserved.has(id))
      reserved.add(id)
      seen.add(id)
      lineChanged = changed = true
      return { ...word, id }
    })
    return lineChanged ? { ...line, words } : line
  })
  return changed ? result : lines
}
