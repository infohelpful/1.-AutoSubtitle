import type { SubtitleRow, Word } from './types'

/**
 * Maps Peaks segment drag results (flat, time-sorted) back into row buckets using word-id → row ownership from the previous snapshot.
 */
export function assignFlatWordsToRows(flat: Word[], prevRows: SubtitleRow[]): SubtitleRow[] {
  if (prevRows.length === 0) return prevRows

  const idToRowId = new Map<number, string>()
  for (const row of prevRows) {
    for (const w of row.words) idToRowId.set(w.id, row.id)
  }

  const buckets = new Map<string, Word[]>()
  for (const r of prevRows) buckets.set(r.id, [])

  for (const w of flat) {
    let rowId = idToRowId.get(w.id)
    if (!rowId) {
      const t = w.start
      let best: SubtitleRow | undefined
      let bestD = Infinity
      for (const row of prevRows) {
        for (const ow of row.words) {
          const mid = (ow.start + ow.end) / 2
          const d = Math.abs(t - mid)
          if (d < bestD) {
            bestD = d
            best = row
          }
        }
      }
      rowId = best?.id ?? prevRows[0].id
    }
    if (!buckets.has(rowId)) buckets.set(rowId, [])
    buckets.get(rowId)!.push(w)
  }

  return prevRows.map((row) => {
    const words = buckets.get(row.id) ?? []
    words.sort((a, b) => a.start - b.start)
    return {
      ...row,
      words,
      lineText: words.map((w) => w.text).join(' ')
    }
  })
}
