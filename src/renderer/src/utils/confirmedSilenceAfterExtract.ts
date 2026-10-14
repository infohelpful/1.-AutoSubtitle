import type { SubtitleLine, SubtitleWord } from '../../../shared/subtitles'
import type { JsonWaveformData } from '../../../shared/waveformJson'

/** Fresh extraction or explicit uncut-project repair only; never on automatic load.
 * Timestamp gaps are unclassified. Preserve every speech word/lock/character
 * boundary; only mark sustained quiet audio OUTSIDE those word intervals.
 */
export function confirmExtractedSilence(lines: readonly SubtitleLine[], waveform: JsonWaveformData | null, duration: number): SubtitleLine[] {
  const speech = lines.map(line => ({ ...line,
    words: line.words?.filter(w => !w.isSilence && w.word.trim() !== '--')
  })).filter(line => line.words?.length || (line.text.trim() && line.text.trim() !== '--'))
  const data = waveform?.data
  const sr = waveform?.sample_rate ?? 0, spp = waveform?.samples_per_pixel ?? 0
  const bits = waveform?.bits ?? 8
  if (!Array.isArray(data) || (waveform?.channels != null && waveform.channels !== 1) ||
      !Number.isFinite(sr) || !Number.isFinite(spp) || sr <= 0 || spp <= 0 ||
      ![8,16].includes(bits) || !Number.isFinite(duration) || duration <= 0) return speech
  const step = spp / sr, count = Math.floor(data.length / 2)
  // Coarse/incomplete waveform data cannot establish a 200ms silence reliably.
  if (step > .02 || count < 2) return speech
  const gate = 2 ** (bits - 1) * .01 // conservative -40dBFS peak, not a speech detector
  const quietParts = (start: number, end: number): SubtitleWord[] => {
    const parts: SubtitleWord[] = []
    const first = Math.max(0, Math.ceil(start / step)), last = Math.min(count, Math.floor(end / step))
    let run = -1
    const close = (p: number) => {
      if (run < 0) return
      // Keep breath/consonant/quantization edges out of the silence marker.
      const s = run * step + .02, e = p * step - .02
      if (e - s >= .2 - 1e-9) parts.push({ start: s, end: e, word: '--', isSilence: true })
      run = -1
    }
    for (let p = first; p < last; p++) {
      const min = data[p * 2], max = data[p * 2 + 1]
      if (Number.isFinite(min) && Number.isFinite(max) && Math.max(Math.abs(min), Math.abs(max)) <= gate) {
        if (run < 0) run = p
      } else close(p)
    }
    close(last)
    return parts
  }
  const words = speech.flatMap((line, index) => (line.words?.length ? line.words :
    [{ start: line.start, end: line.end, word: line.text }]).map(word => ({ word, index })))
    .sort((a,b) => a.word.start - b.word.start || a.word.end - b.word.end)
  const rows: SubtitleLine[] = []
  let end = 0, previousLine = -1
  const add = (start: number, finish: number, nextLine: number) => {
    if (finish - start < .24) return
    for (const gap of quietParts(start, finish)) {
      if (previousLine >= 0 && previousLine === nextLine) speech[previousLine].words!.push(gap)
      else rows.push({ start: gap.start, end: gap.end, text: '', words: [gap] })
    }
  }
  for (const { word, index } of words) {
    add(end, Math.min(duration, word.start), index)
    if (word.end > end) { end = word.end; previousLine = index }
  }
  add(end, duration, -1)
  for (const line of speech) line.words?.sort((a,b) => a.start - b.start || a.end - b.end)
  return [...speech, ...rows].sort((a,b) => a.start - b.start)
}
