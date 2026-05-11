import type { Segment } from 'peaks.js'
import type { SubtitleRow, Word } from './types'

function randomBlockSuffix(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
}

const EPS = 1e-4

/** Merge adjacent cues when end overlaps next start (after end-handle drag across boundary). */
export function mergeAdjacentOverlappingWords(words: Word[]): Word[] {
  if (words.length < 2) return words.map((w) => ({ ...w }))
  const sorted = [...words].sort((a, b) => a.start - b.start)
  const out: Word[] = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = out[out.length - 1]
    const cur = sorted[i]
    if (prev.end > cur.start + EPS) {
      if (prev.isSilence && cur.isSilence) {
        prev.text = `${prev.text}${cur.text}`
      } else {
        prev.text = `${prev.text} ${cur.text}`.trim()
      }
      prev.end = Math.max(prev.end, cur.end)
      prev.isSilence = Boolean(prev.isSilence && cur.isSilence)
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

/** Peaks dragend 이후: 한 행 안에서만 겹침·침벌 병합(행끼리 머지 방지) */
export function applyAdjacentWordMergesToRows(rows: SubtitleRow[]): SubtitleRow[] {
  return rows.map((row) => {
    const words = mergeAdjacentOverlappingWords(row.words)
    return {
      ...row,
      words,
      lineText: words.map((w) => w.text).join(' ')
    }
  })
}

export function wordsFromPeaksSegments(segments: Segment[], prevWords: Word[]): Word[] {
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime)
  const next: Word[] = sorted.map((s) => {
    const idStr = s.id !== undefined ? String(s.id) : ''
    const prev = prevWords.find((w) => w.id === idStr)
    const text =
      typeof s.labelText === 'string' && s.labelText.length > 0 ? s.labelText : (prev?.text ?? '')
    const id = prev?.id ?? (idStr || `block_orphan_${randomBlockSuffix()}`)
    return {
      id,
      text,
      start: s.startTime,
      end: s.endTime,
      isSilence: prev?.isSilence
    }
  })
  return next
}
