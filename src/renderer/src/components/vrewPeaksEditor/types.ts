export interface Word {
  /** `block_{그룹}_{줄내순번}` — 자르기 시 `block_1_2_1` 처럼 부모 ID 뒤에 세그먼트 번호를 덧붙인다. */
  id: string
  text: string
  /** Immutable source text used by ADJUST merge & re-split. */
  originalText?: string
  start: number
  end: number
  /** true: 타임라인 빈 구간용 무음 더미(예: 텍스트 `--`) */
  isSilence?: boolean
}

/** One subtitle line: word rail → (waveform) → text edit — DOM order matches Vrew. */
export interface SubtitleRow {
  id: string
  words: Word[]
  /** Full-line edit buffer; if omitted, derived from `words.map(w => w.text).join(' ')`. */
  lineText?: string
}
