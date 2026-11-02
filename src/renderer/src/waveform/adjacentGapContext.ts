import type { SubtitleRow } from '../components/vrewPeaksEditor/types'

/** Include neighboring gap chips so a row-edge handle can reach their far edge. */
export function adjacentGapContext(rows: readonly SubtitleRow[], rowIndex: number, wordIndex: number): {
  extendWindowStartToIncludeSec?: number
  extendWindowEndToIncludeSec?: number
} {
  const row = rows[rowIndex]
  if (!row?.words.length) return {}
  const out: ReturnType<typeof adjacentGapContext> = {}
  if (wordIndex === 0) {
    for (let i = rowIndex - 1; i >= 0; i--) {
      const word = rows[i].words.at(-1)
      if (!word) continue
      if (word.isSilence) out.extendWindowStartToIncludeSec = word.start
      break
    }
  }
  if (wordIndex === row.words.length - 1) {
    for (let i = rowIndex + 1; i < rows.length; i++) {
      const word = rows[i].words[0]
      if (!word) continue
      if (word.isSilence) out.extendWindowEndToIncludeSec = word.end
      break
    }
  }
  return out
}
