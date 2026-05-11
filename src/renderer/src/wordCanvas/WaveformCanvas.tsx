import { memo, useMemo, useRef, type ReactElement } from 'react'
import type { WordEntity } from './types'
import { useDrawWaveform } from './useDrawWaveform'

export type WaveformCanvasProps = {
  sentenceId: string
  chunks: number[]
  words: WordEntity[]
}

function sentenceMediaExtent(words: WordEntity[]): { start: number; end: number } {
  if (words.length === 0) return { start: 0, end: 1 }
  let lo = Infinity
  let hi = -Infinity
  for (const w of words) {
    lo = Math.min(lo, w.o_start)
    hi = Math.max(hi, w.o_end)
  }
  if (!(hi > lo)) return { start: lo, end: lo + 1e-3 }
  return { start: lo, end: hi }
}

function WaveformCanvasInner({ sentenceId, chunks, words }: WaveformCanvasProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const { mediaStart, mediaEnd } = useMemo(() => sentenceMediaExtent(words), [words])

  const drawOpts = useMemo(
    () => ({
      chunks,
      words,
      mediaStart,
      mediaEnd
    }),
    [chunks, words, mediaStart, mediaEnd]
  )

  useDrawWaveform(canvasRef, wrapRef, drawOpts)

  return (
    <div
      ref={wrapRef}
      className="relative h-24 w-full overflow-hidden rounded-md bg-slate-950"
    >
      <canvas
        ref={canvasRef}
        data-sentence-id={sentenceId}
        className="block h-full w-full"
        aria-label={`sentence waveform ${sentenceId}`}
      />
    </div>
  )
}

/** 얕은 비교: chunks 참조·words 내용(삭제 플래그)이 바뀔 때만 다시 그림 */
export const WaveformCanvas = memo(WaveformCanvasInner, (prev, next) => {
  if (prev.sentenceId !== next.sentenceId) return false
  if (prev.chunks !== next.chunks || prev.chunks.length !== next.chunks.length) return false
  if (prev.words.length !== next.words.length) return false
  for (let i = 0; i < prev.words.length; i++) {
    const a = prev.words[i]!
    const b = next.words[i]!
    if (a.id !== b.id || a.is_deleted !== b.is_deleted || a.o_start !== b.o_start || a.o_end !== b.o_end) {
      return false
    }
  }
  return true
})
