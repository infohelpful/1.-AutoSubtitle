import { create } from 'zustand'
import { shallow } from 'zustand/shallow'
import type { SentenceTokenTimeline } from '../../../shared/sentenceTokenTimeline'
import type { SentenceEntity, SentenceId, WordEntity, WordId } from './types'
import { computeVirtualPrefixBefore, recomputeVirtualPrefixFromIndex } from './virtualPrefix'

export type AudioChunksBySentence = Record<SentenceId, number[]>

export type EditorSnapshot = {
  sentenceOrder: SentenceId[]
  sentences: Record<SentenceId, SentenceEntity>
  words: Record<WordId, WordEntity>
  /** 문장 카드별 RMS(백엔드에서 문장 단위로 전달) */
  audioChunks: AudioChunksBySentence
  /** 글로벌 재생/편집 순서 */
  orderedWordIds: WordId[]
  wordGlobalIndex: Record<WordId, number>
  virtualPrefixBefore: number[]
}

function buildWordIndex(orderedWordIds: WordId[]): Record<WordId, number> {
  const m: Record<WordId, number> = {}
  for (let i = 0; i < orderedWordIds.length; i++) m[orderedWordIds[i]!] = i
  return m
}

type EditorState = EditorSnapshot & {
  hydrate: (snap: Omit<EditorSnapshot, 'virtualPrefixBefore' | 'wordGlobalIndex'>) => void
  deleteWord: (wordId: WordId) => void
  /**
   * 문장 순서·토큰 id·시간·텍스트는 동일하고 `is_deleted` 만 타임라인과 어긋날 때만 동기화.
   * 성공 시 전역 hydrate(문장×피크 슬라이스) 없이 가상 접두만 갱신 — 단어 삭제 반응 속도용.
   */
  tryPatchTombstonesFromTimeline: (timeline: SentenceTokenTimeline) => boolean
  /**
   * 문장 순서·토큰 id 가 동일하면(시간/텍스트/`is_deleted` 는 달라도 됨) 단어 엔티티만 패치하고
   * `audioChunks` 는 그대로 재사용한다. 리플 삭제처럼 토큰 구조는 유지되고 시간만 바뀌는 편집에서
   * O(N) 피크 슬라이스를 피해 단어 삭제 반응 속도를 유지한다.
   *
   * 구조 변경(분할/병합/문장 삭제) 이면 false 를 반환 → 호출부가 전체 hydrate.
   */
  patchFromTimelineIfStructureMatches: (timeline: SentenceTokenTimeline) => boolean
}

const emptySnapshot: EditorSnapshot = {
  sentenceOrder: [],
  sentences: {},
  words: {},
  audioChunks: {},
  orderedWordIds: [],
  wordGlobalIndex: {},
  virtualPrefixBefore: []
}

export const useEditorStore = create<EditorState>((set, get) => ({
  ...emptySnapshot,

  hydrate: (snap) => {
    const orderedWordIds = snap.orderedWordIds.slice()
    const wordGlobalIndex = buildWordIndex(orderedWordIds)
    const virtualPrefixBefore = computeVirtualPrefixBefore(orderedWordIds, snap.words)
    set({
      sentenceOrder: snap.sentenceOrder.slice(),
      sentences: { ...snap.sentences },
      words: { ...snap.words },
      audioChunks: { ...snap.audioChunks },
      orderedWordIds,
      wordGlobalIndex,
      virtualPrefixBefore
    })
  },

  deleteWord: (wordId) => {
    const state = get()
    const w = state.words[wordId]
    if (!w || w.is_deleted) return

    const idx = state.wordGlobalIndex[wordId]
    if (idx === undefined) return

    const nextWords: Record<WordId, WordEntity> = {
      ...state.words,
      [wordId]: { ...w, is_deleted: true }
    }
    const virtualPrefixBefore = recomputeVirtualPrefixFromIndex(
      state.orderedWordIds,
      nextWords,
      idx,
      state.virtualPrefixBefore
    )

    set({ words: nextWords, virtualPrefixBefore })
  },

  tryPatchTombstonesFromTimeline: (timeline) => {
    const state = get()
    const nextWords: Record<WordId, WordEntity> = { ...state.words }
    let anyChange = false

    const active = timeline.filter((s) => !s.is_deleted)
    if (active.length !== state.sentenceOrder.length) return false

    for (let si = 0; si < active.length; si++) {
      const s = active[si]!
      if (state.sentenceOrder[si] !== s.id) return false
      const ent = state.sentences[s.id]
      if (!ent || ent.wordIds.length !== s.tokens.length) return false

      for (let wi = 0; wi < s.tokens.length; wi++) {
        const t = s.tokens[wi]!
        if (ent.wordIds[wi] !== t.id) return false
        const w = nextWords[t.id]
        if (!w) return false
        if (w.o_start !== t.start_original || w.o_end !== t.end_original) return false
        if (w.text !== t.text) return false
        const del = Boolean(t.is_deleted)
        if (w.is_deleted !== del) {
          nextWords[t.id] = { ...w, is_deleted: del }
          anyChange = true
        }
      }
    }

    if (!anyChange) return true

    const virtualPrefixBefore = computeVirtualPrefixBefore(state.orderedWordIds, nextWords)
    set({ words: nextWords, virtualPrefixBefore })
    return true
  },

  patchFromTimelineIfStructureMatches: (timeline) => {
    const state = get()
    const active = timeline.filter((s) => !s.is_deleted)
    if (active.length !== state.sentenceOrder.length) return false

    for (let si = 0; si < active.length; si++) {
      const s = active[si]!
      if (state.sentenceOrder[si] !== s.id) return false
      const ent = state.sentences[s.id]
      if (!ent || ent.wordIds.length !== s.tokens.length) return false
      for (let wi = 0; wi < s.tokens.length; wi++) {
        const t = s.tokens[wi]!
        if (ent.wordIds[wi] !== t.id) return false
        if (!state.words[t.id]) return false
      }
    }

    const nextWords: Record<WordId, WordEntity> = { ...state.words }
    let anyChange = false
    for (const s of active) {
      for (const t of s.tokens) {
        const w = nextWords[t.id]!
        const del = Boolean(t.is_deleted)
        if (
          w.is_deleted === del &&
          w.o_start === t.start_original &&
          w.o_end === t.end_original &&
          w.text === t.text
        ) {
          continue
        }
        nextWords[t.id] = {
          ...w,
          is_deleted: del,
          o_start: t.start_original,
          o_end: t.end_original,
          text: t.text
        }
        anyChange = true
      }
    }

    if (!anyChange) return true

    const virtualPrefixBefore = computeVirtualPrefixBefore(state.orderedWordIds, nextWords)
    set({ words: nextWords, virtualPrefixBefore })
    return true
  }
}))

/** 렌더/재생 시점에만 호출 — 단일 wordId 의 가상 시작 시각 */
export function selectVirtualStartTime(state: EditorSnapshot, wordId: WordId): number {
  const idx = state.wordGlobalIndex[wordId]
  if (idx === undefined) return 0
  return state.virtualPrefixBefore[idx] ?? 0
}

/** 단일 스칼라 구독 — 해당 word 의 접두 가상시각이 바뀔 때만 리렌더 */
export function useVirtualStartTime(wordId: WordId | undefined): number {
  return useEditorStore((s) => (wordId ? selectVirtualStartTime(s, wordId) : 0))
}

const EMPTY_WORD_IDS: WordId[] = []
const EMPTY_WORDS: WordEntity[] = []

/** 문장 카드: 해당 sentence 의 word 엔티티만 얕게 구독 */
export function useSentenceWords(sentenceId: SentenceId): WordEntity[] {
  return useEditorStore((s) => {
    const ids = s.sentences[sentenceId]?.wordIds
    if (!ids?.length) return EMPTY_WORDS
    const row = ids.map((id) => s.words[id]).filter((x): x is WordEntity => Boolean(x))
    return row
  }, shallow)
}

export function useSentenceWordIds(sentenceId: SentenceId): WordId[] {
  return useEditorStore((s) => s.sentences[sentenceId]?.wordIds ?? EMPTY_WORD_IDS, shallow)
}

export function useAudioChunksForSentence(sentenceId: SentenceId): number[] | undefined {
  return useEditorStore((s) => s.audioChunks[sentenceId])
}
