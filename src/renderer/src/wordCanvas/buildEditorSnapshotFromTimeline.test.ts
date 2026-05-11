import { describe, expect, it } from 'vitest'
import type { JsonWaveformData } from '../../../shared/waveformJson'
import { buildEditorSnapshotFromSentenceTokenTimeline } from './buildEditorSnapshotFromTimeline'

function tinyPeaksJson(): JsonWaveformData {
  const pixels = 20
  const data: number[] = new Array(pixels * 2).fill(0).map((_, i) => i % 64)
  return {
    sample_rate: 8000,
    samples_per_pixel: 100,
    bits: 8,
    length: pixels,
    data
  } as JsonWaveformData
}

describe('buildEditorSnapshotFromSentenceTokenTimeline', () => {
  it('문장·토큰·orderedWordIds·오디오 청크 키 정렬', () => {
    const snap = buildEditorSnapshotFromSentenceTokenTimeline(
      [
        {
          id: 'sub-0',
          tokens: [
            {
              id: 'tok-0-0',
              text: 'a',
              start_original: 0,
              end_original: 1,
              is_deleted: false
            },
            {
              id: 'tok-0-1',
              text: 'b',
              start_original: 1,
              end_original: 2,
              is_deleted: true
            }
          ]
        }
      ],
      tinyPeaksJson(),
      10
    )
    expect(snap.sentenceOrder).toEqual(['sub-0'])
    expect(snap.sentences['sub-0']?.wordIds).toEqual(['tok-0-0', 'tok-0-1'])
    expect(snap.orderedWordIds).toEqual(['tok-0-0', 'tok-0-1'])
    expect(snap.words['tok-0-1']?.is_deleted).toBe(true)
    expect(snap.audioChunks['sub-0']?.length).toBeGreaterThan(0)
  })

  it('is_deleted 문장은 제외', () => {
    const snap = buildEditorSnapshotFromSentenceTokenTimeline(
      [
        { id: 'sub-x', is_deleted: true, tokens: [{ id: 't1', text: 'x', start_original: 0, end_original: 1 }] },
        {
          id: 'sub-0',
          tokens: [{ id: 'tok-0-0', text: 'a', start_original: 0, end_original: 1, is_deleted: false }]
        }
      ],
      null,
      undefined
    )
    expect(snap.sentenceOrder).toEqual(['sub-0'])
    expect(snap.words['t1']).toBeUndefined()
  })
})
