import type { JsonWaveformData } from '../../../shared/waveformJson'
import type { SentenceTokenTimeline } from '../../../shared/sentenceTokenTimeline'
import type { AudioChunksBySentence, EditorSnapshot } from './editorStore'
import type { SentenceEntity, WordEntity } from './types'
import { slicePeaksJsonToRmsChunkCached } from './peaksSentenceSlice'

export type EditorHydratePayload = Omit<EditorSnapshot, 'virtualPrefixBefore' | 'wordGlobalIndex'>

/**
 * `sentenceTokenTimeline` + 원본 미디어 축 peaks JSON → `useEditorStore.hydrate` 입력.
 * 토큰 id(`tok-…`)는 타임라인 SSOT 와 동일해야 한다.
 */
export function buildEditorSnapshotFromSentenceTokenTimeline(
  timeline: SentenceTokenTimeline,
  peaksJson: JsonWaveformData | null | undefined,
  mediaDurationHintSec?: number
): EditorHydratePayload {
  const sentenceOrder: string[] = []
  const sentences: Record<string, SentenceEntity> = {}
  const words: Record<string, WordEntity> = {}
  const audioChunks: AudioChunksBySentence = {}
  const orderedWordIds: string[] = []

  for (const s of timeline) {
    if (s.is_deleted) continue
    sentenceOrder.push(s.id)
    const wordIds = s.tokens.map((t) => t.id)
    sentences[s.id] = { id: s.id, wordIds }
    for (const t of s.tokens) {
      words[t.id] = {
        id: t.id,
        sentenceId: s.id,
        text: t.text,
        o_start: t.start_original,
        o_end: t.end_original,
        is_deleted: Boolean(t.is_deleted)
      }
      orderedWordIds.push(t.id)
    }

    let tMin = Infinity
    let tMax = -Infinity
    for (const t of s.tokens) {
      tMin = Math.min(tMin, t.start_original)
      tMax = Math.max(tMax, t.end_original)
    }
    if (!Number.isFinite(tMin) || !(tMax > tMin)) {
      audioChunks[s.id] = []
    } else {
      audioChunks[s.id] = slicePeaksJsonToRmsChunkCached(peaksJson, tMin, tMax, {
        mediaDurationHintSec
      })
    }
  }

  return { sentenceOrder, sentences, words, audioChunks, orderedWordIds }
}
