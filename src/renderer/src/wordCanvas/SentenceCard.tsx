import { memo, type ReactElement } from 'react'
import { useAudioChunksForSentence, useSentenceWords } from './editorStore'
import type { SentenceId } from './types'
import { WaveformCanvas } from './WaveformCanvas'

export type SentenceCardProps = {
  sentenceId: SentenceId
  className?: string
}

/**
 * 문장 단위 파형. 가시 행만 마운트되도록 `WordCanvasPanel` 이 react-window List 로 감싼다
 * (수백 개 IntersectionObserver + setState 가 한 프레임에 몰리면 depth 초과).
 */
function SentenceCardInner({ sentenceId, className }: SentenceCardProps): ReactElement {
  const words = useSentenceWords(sentenceId)
  const chunks = useAudioChunksForSentence(sentenceId)
  const hasChunks = chunks != null && chunks.length > 0

  return (
    <article className={className} data-sentence-id={sentenceId}>
      {hasChunks ? (
        <WaveformCanvas sentenceId={sentenceId} chunks={chunks} words={words} />
      ) : (
        <div
          className="flex h-24 items-center justify-center rounded-md bg-slate-900 text-xs text-slate-500"
          data-waveform-placeholder
        >
          파형 청크 없음
        </div>
      )}
    </article>
  )
}

export const SentenceCard = memo(SentenceCardInner)
