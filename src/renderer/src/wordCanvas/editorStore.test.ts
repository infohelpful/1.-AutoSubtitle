import { beforeEach, describe, expect, it } from 'vitest'
import type { SentenceTokenTimeline } from '../../../shared/sentenceTokenTimeline'
import { selectVirtualStartTime, useEditorStore } from './editorStore'
import type { WordEntity } from './types'
import { computeVirtualPrefixBefore, recomputeVirtualPrefixFromIndex } from './virtualPrefix'

describe('virtualPrefix', () => {
  const ordered = ['w1', 'w2', 'w3']
  const words: Record<string, WordEntity> = {
    w1: { id: 'w1', sentenceId: 's1', text: 'a', o_start: 0, o_end: 1, is_deleted: false },
    w2: { id: 'w2', sentenceId: 's1', text: 'b', o_start: 1, o_end: 3, is_deleted: false },
    w3: { id: 'w3', sentenceId: 's1', text: 'c', o_start: 3, o_end: 4, is_deleted: false }
  }

  it('prefix 누적 — 삭제 전', () => {
    const p = computeVirtualPrefixBefore(ordered, words)
    expect(p).toEqual([0, 1, 3])
  })

  it('w2 삭제 후 접미 재계산 — 가상 시작이 당겨짐', () => {
    const full = computeVirtualPrefixBefore(ordered, words)
    const next = {
      ...words,
      w2: { ...words.w2!, is_deleted: true }
    }
    const p = recomputeVirtualPrefixFromIndex(ordered, next, 1, full)
    expect(p[0]).toBe(0)
    expect(p[1]).toBe(1)
    expect(p[2]).toBe(1)
  })
})

describe('useEditorStore', () => {
  beforeEach(() => {
    useEditorStore.setState({
      sentenceOrder: [],
      sentences: {},
      words: {},
      audioChunks: {},
      orderedWordIds: [],
      wordGlobalIndex: {},
      virtualPrefixBefore: []
    })
  })

  it('deleteWord 는 is_deleted 만 토글하고 가상 시작이 접미만 갱신', () => {
    useEditorStore.getState().hydrate({
      sentenceOrder: ['s1'],
      sentences: { s1: { id: 's1', wordIds: ['w1', 'w2'] } },
      words: {
        w1: { id: 'w1', sentenceId: 's1', text: 'a', o_start: 0, o_end: 1, is_deleted: false },
        w2: { id: 'w2', sentenceId: 's1', text: 'b', o_start: 1, o_end: 3, is_deleted: false }
      },
      audioChunks: {},
      orderedWordIds: ['w1', 'w2']
    })
    expect(selectVirtualStartTime(useEditorStore.getState(), 'w2')).toBe(1)
    useEditorStore.getState().deleteWord('w1')
    expect(useEditorStore.getState().words.w1?.is_deleted).toBe(true)
    expect(selectVirtualStartTime(useEditorStore.getState(), 'w2')).toBe(0)
  })

  it('tryPatchTombstonesFromTimeline — 구조 동일·tombstone 만 반영', () => {
    useEditorStore.getState().hydrate({
      sentenceOrder: ['s1'],
      sentences: { s1: { id: 's1', wordIds: ['w1', 'w2'] } },
      words: {
        w1: { id: 'w1', sentenceId: 's1', text: 'a', o_start: 0, o_end: 1, is_deleted: false },
        w2: { id: 'w2', sentenceId: 's1', text: 'b', o_start: 1, o_end: 3, is_deleted: false }
      },
      audioChunks: {},
      orderedWordIds: ['w1', 'w2']
    })
    const tl: SentenceTokenTimeline = [
      {
        id: 's1',
        tokens: [
          { id: 'w1', text: 'a', start_original: 0, end_original: 1, is_deleted: true },
          { id: 'w2', text: 'b', start_original: 1, end_original: 3 }
        ]
      }
    ]
    expect(useEditorStore.getState().tryPatchTombstonesFromTimeline(tl)).toBe(true)
    expect(useEditorStore.getState().words.w1?.is_deleted).toBe(true)
    expect(selectVirtualStartTime(useEditorStore.getState(), 'w2')).toBe(0)
  })

  it('patchFromTimelineIfStructureMatches — 리플로 시간이 바뀌어도 audioChunks 는 재사용', () => {
    const initialChunks = { s1: [0.1, 0.2, 0.3] }
    useEditorStore.getState().hydrate({
      sentenceOrder: ['s1'],
      sentences: { s1: { id: 's1', wordIds: ['w1', 'w2'] } },
      words: {
        w1: { id: 'w1', sentenceId: 's1', text: 'a', o_start: 5, o_end: 6, is_deleted: false },
        w2: { id: 'w2', sentenceId: 's1', text: 'b', o_start: 6, o_end: 9, is_deleted: false }
      },
      audioChunks: initialChunks,
      orderedWordIds: ['w1', 'w2']
    })
    const chunksRefBefore = useEditorStore.getState().audioChunks.s1
    const tl: SentenceTokenTimeline = [
      {
        id: 's1',
        tokens: [
          { id: 'w1', text: 'a', start_original: 5, end_original: 5, is_deleted: true },
          { id: 'w2', text: 'b', start_original: 5, end_original: 8 }
        ]
      }
    ]
    expect(useEditorStore.getState().patchFromTimelineIfStructureMatches(tl)).toBe(true)
    const st = useEditorStore.getState()
    expect(st.words.w1?.is_deleted).toBe(true)
    expect(st.words.w1?.o_end).toBe(5)
    expect(st.words.w2?.o_start).toBe(5)
    expect(st.words.w2?.o_end).toBe(8)
    expect(st.audioChunks.s1).toBe(chunksRefBefore)
  })

  it('patchFromTimelineIfStructureMatches — 구조 변경(토큰 수 다름) 시 false', () => {
    useEditorStore.getState().hydrate({
      sentenceOrder: ['s1'],
      sentences: { s1: { id: 's1', wordIds: ['w1', 'w2'] } },
      words: {
        w1: { id: 'w1', sentenceId: 's1', text: 'a', o_start: 0, o_end: 1, is_deleted: false },
        w2: { id: 'w2', sentenceId: 's1', text: 'b', o_start: 1, o_end: 3, is_deleted: false }
      },
      audioChunks: { s1: [1, 2, 3] },
      orderedWordIds: ['w1', 'w2']
    })
    const tl: SentenceTokenTimeline = [
      {
        id: 's1',
        tokens: [
          { id: 'w1', text: 'a', start_original: 0, end_original: 1 },
          { id: 'wnew', text: 'c', start_original: 1, end_original: 2 },
          { id: 'w2', text: 'b', start_original: 2, end_original: 4 }
        ]
      }
    ]
    expect(useEditorStore.getState().patchFromTimelineIfStructureMatches(tl)).toBe(false)
  })
})
