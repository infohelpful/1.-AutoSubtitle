import type { SubtitleLine, SubtitleWord } from '../../../shared/subtitles'
import type { JsonWaveformData } from '../../../shared/waveformJson'

/** Restore missing non-caption regions, without touching speech or reviving user cuts.
 * Sub-200ms word gaps remain normal spacing; explicit SRT cue gaps and leading/trailing media are represented.
 * A timestamp gap alone is not evidence of silence: unknown audio gets its own label.
 */
function attachTrailingAudioRows(lines: SubtitleLine[]): SubtitleLine[] {
  const result: SubtitleLine[] = []
  for (const line of lines) {
    const words = line.words?.filter(word => !word.isDeleted) ?? []
    const audioOnly = !line.isDeleted && !line.text.trim() && words.length > 0 &&
      words.every(word => word.isSilence && word.gapKind === 'unclassified')
    const previous = result[result.length - 1]
    const hasSpeech = previous && !previous.isDeleted && previous.words?.some(word =>
      !word.isDeleted && !word.isSilence)
    if (audioOnly && hasSpeech && line.start >= previous.end - 1e-6) {
      result[result.length - 1] = {
        ...previous,
        end: Math.max(previous.end, line.end),
        words: [...previous.words!, ...line.words!]
      }
    } else {
      result.push(line)
    }
  }
  return result
}

export function completeMediaCoverage(
  lines: readonly SubtitleLine[], duration: number, waveform: JsonWaveformData | null,
  excluded: readonly { start: number; end: number }[] = []
): SubtitleLine[] {
  if (!Number.isFinite(duration) || duration <= 0) return [...lines]
  const output = [...lines]
  const intervals = lines.flatMap((line, index) =>
    (line.words?.length ? line.words : [line]).map(word => ({start: word.start, end: word.end, index})))
  intervals.push(...excluded.map(range => ({...range, index: -1})))
  const ordered = intervals.filter(iv => Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end > iv.start)
    .sort((a,b) => a.start - b.start || a.end - b.end)
  const quiet = (start: number, end: number): boolean => {
    const step = (waveform?.samples_per_pixel ?? 0) / (waveform?.sample_rate ?? 0)
    const data = waveform?.data, bits = waveform?.bits ?? 8
    if (!data || !(step > 0 && step <= .02) || ![8,16].includes(bits) || (waveform?.channels ?? 1) !== 1) return false
    const first = Math.floor(start / step), last = Math.ceil(end / step)
    if (last * 2 > data.length) return false
    const gate = 2 ** (bits - 1) * .01
    for (let p=first; p<last; p++) {
      if (!Number.isFinite(data[p*2]) || !Number.isFinite(data[p*2+1]) ||
          Math.max(Math.abs(data[p*2]),Math.abs(data[p*2+1])) > gate) return false
    }
    return true
  }
  let cursor=0, previous=-1
  const add = (start: number, end: number, next: number) => {
    const explicitCueGap = previous !== next && [previous, next].some(index =>
      index >= 0 && lines[index]?.words?.some(word => word.engine === 'srt-import'))
    if (end-start < 1e-6 || (!explicitCueGap && start > 0 && end < duration && end-start < .2-1e-9)) return
    // A waveform's last partial pixel can end a fraction of a millisecond early.
    // Extend the adjacent non-caption chip, rather than creating a near-zero row.
    if (next === -1 && end === duration && end-start <= .02 && previous >= 0) {
      const line=output[previous]
      const wi=line.words?.findIndex(word=>word.isSilence && !word.isDeleted && !word.manualEndLocked && Math.abs(word.end-start)<1e-6) ?? -1
      if (wi >= 0) {
        const words=[...line.words!]
        words[wi]={...words[wi],end}
        output[previous]={...line,end:Math.max(line.end,end),words}
        return
      }
    }
    const isQuiet = quiet(start,end)
    const word: SubtitleWord = {start,end,word:isQuiet?'--':'오디오',isSilence:true,
      ...(isQuiet?{}:{gapKind:'unclassified' as const})}
    if (previous >= 0 && previous === next && output[previous].words?.length) {
      const line=output[previous]
      output[previous]={...line,words:[...line.words!,word].sort((a,b)=>a.start-b.start)}
    } else output.push({start,end,text:'',words:[word]})
  }
  for (const iv of ordered) {
    if (iv.start >= duration) break
    add(cursor,Math.min(duration,iv.start),iv.index)
    if(iv.end>cursor) {cursor=Math.min(duration,iv.end);previous=iv.index}
  }
  add(cursor,duration,-1)
  return attachTrailingAudioRows(output.sort((a,b)=>a.start-b.start))
}
