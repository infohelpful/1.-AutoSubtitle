import { expect, it } from 'vitest'
import type { SubtitleLine } from '../../../shared/subtitles'
import type { JsonWaveformData } from '../../../shared/waveformJson'
import { confirmExtractedSilence } from './confirmedSilenceAfterExtract'

function peaks(quiet: Array<[number, number]> = []): JsonWaveformData {
  return { sample_rate: 1000, samples_per_pixel: 10, bits: 8, channels: 1,
    data: Array.from({ length: 600 }, (_, i) => quiet.some(([s,e]) => i / 200 >= s && i / 200 < e) ? 0 : (i % 2 ? 45 : -45)) }
}
const speech: SubtitleLine = { start: 0, end: 2, text: '같은데요 다음', words: [
  { id: 'a', start: 0, end: .8, word: '같은데요', alignmentStatus: 'aligned', sourceStart: 0, sourceEnd: .8 },
  { id: 'b', start: 1.2, end: 2, word: '다음', alignmentStatus: 'manual', manualStartLocked: true }
] }
const silences = (lines: SubtitleLine[]) => lines.flatMap(l => l.words ?? []).filter(w => w.isSilence || w.word.trim() === '--')

it('does not label a voiced timestamp gap or quiet consonant inside an aligned word as silence', () => {
  const before = structuredClone(speech)
  const result = confirmExtractedSilence([speech], peaks([[.2,.5]]), 2)
  expect(silences(result)).toEqual([])
  expect(result[0].words).toEqual(before.words)
  expect(speech).toEqual(before)
})

it('removes legacy timestamp-only silence rows containing speech', () => {
  const lines: SubtitleLine[] = [{ ...speech, end: .8, words: [speech.words![0]] },
    { start: .8, end: 1.2, text: '--', words: [{ start: .8, end: 1.2, word: '--', isSilence: true }] },
    { start: 1.2, end: 2, text: '다음', words: [speech.words![1]] }]
  const result = confirmExtractedSilence(lines, peaks(), 2)
  expect(result).toHaveLength(2)
  expect(silences(result)).toEqual([])
})

it('retains only a sustained low-energy part of an inter-word gap without changing speech times', () => {
  const result = confirmExtractedSilence([speech], peaks([[.8,1.2]]), 2)
  const gaps = silences(result)
  expect(gaps).toHaveLength(1)
  expect(gaps[0].start).toBeGreaterThanOrEqual(.8)
  expect(gaps[0].end).toBeLessThanOrEqual(1.2)
  expect(result[0].words!.filter(w => !w.isSilence)).toEqual(speech.words)
  expect(confirmExtractedSilence(result, peaks([[.8,1.2]]), 2)).toEqual(result)
})

it('does not turn missing, truncated, or unsupported waveform data into silence', () => {
  for (const waveform of [{ ...peaks(), data: [] }, { ...peaks(), data: [0,0] }, { ...peaks(), channels: 2 }]) {
    expect(silences(confirmExtractedSilence([speech], waveform, 3))).toEqual([])
  }
})

it('retains unaligned text-only cues rather than losing recognized speech', () => {
  const line = { start: 0, end: 2, text: '단어 시간이 없는 문장', words: [] }
  expect(confirmExtractedSilence([line], null, 2)).toEqual([line])
  expect(confirmExtractedSilence([line], peaks([[0,3]]), 2)).toEqual([line])
})

it('does not create a gap inside another overlapping speaker word', () => {
  const covering = { start: .4, end: 1.8, text: '겹말', words: [{ start: .4, end: 1.8, word: '겹말' }] }
  expect(silences(confirmExtractedSilence([speech, covering], peaks([[.8,1.2]]), 2))).toEqual([])
})
