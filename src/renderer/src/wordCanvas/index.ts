/**
 * 문장 카드 단위 파형 + 정규화 스토어 — Peaks 전역 인스턴스 대신 로컬 캔버스로 확장 가능.
 *
 * 통합(App): `buildEditorSnapshotFromSentenceTokenTimeline(timeline, waveformPeaksJsonData, durationHint)`
 * 로 hydrate — 원본 미디어 축 peaks 만 사용(스티치 편집축 JSON 과 혼용 금지).
 * UI: `<WordCanvasPanel />` 또는 행마다 `<SentenceCard sentenceId={...} />`.
 *
 * Profiler 확인: 단어 삭제 시 `words[id]` 레코드만 바뀌므로 해당 문장의 SentenceCard만 구독 갱신.
 */

export type { WordEntity, SentenceEntity, SentenceId, WordId } from './types'
export {
  useEditorStore,
  useVirtualStartTime,
  selectVirtualStartTime,
  useSentenceWords,
  useSentenceWordIds,
  useAudioChunksForSentence,
  type EditorSnapshot,
  type AudioChunksBySentence
} from './editorStore'
export { computeVirtualPrefixBefore, recomputeVirtualPrefixFromIndex } from './virtualPrefix'
export { SentenceCard, type SentenceCardProps } from './SentenceCard'
export { WordCanvasPanel, type WordCanvasPanelProps } from './WordCanvasPanel'
export {
  buildEditorSnapshotFromSentenceTokenTimeline,
  type EditorHydratePayload
} from './buildEditorSnapshotFromTimeline'
export {
  peaksJsonRawDataLength,
  slicePeaksJsonToRmsChunk,
  slicePeaksJsonToRmsChunkCached,
  type SlicePeaksOpts
} from './peaksSentenceSlice'
export { WaveformCanvas, type WaveformCanvasProps } from './WaveformCanvas'
export { useDrawWaveform, type DrawWaveformOpts } from './useDrawWaveform'
