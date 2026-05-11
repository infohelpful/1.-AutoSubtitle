/** 정규화 편집기 — 원본(미디어) 타임코드 o_* 는 삭제 후에도 불변 */

export type SentenceId = string
export type WordId = string

export type WordEntity = {
  id: WordId
  sentenceId: SentenceId
  text: string
  /** 원본 미디어 축 시작(초) — 삭제해도 값 유지(tombstone) */
  o_start: number
  /** 원본 미디어 축 끝(초) */
  o_end: number
  is_deleted: boolean
}

export type SentenceEntity = {
  id: SentenceId
  wordIds: WordId[]
}
