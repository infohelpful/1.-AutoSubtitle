export interface Word {
  id: number
  text: string
  /** Immutable source text used by ADJUST merge & re-split. */
  originalText?: string
  start: number
  end: number
  /** true: 타임라인 빈 구간용 무음 더미(예: 텍스트 `??`) */
  isSilence?: boolean
}

/** One subtitle line: word rail → (waveform) → text edit — DOM order matches Vrew. */
export interface SubtitleRow {
  id: string
  words: Word[]
  /** Full-line edit buffer; if omitted, derived from `words.map(w => w.text).join(' ')`. */
  lineText?: string
}
