import type { SubtitleWord } from './subtitles'

export function setWordReading(word: SubtitleWord, value: string): SubtitleWord {
  const reading = value.normalize('NFC').trim()
  if ([...reading].length > 256) throw new Error('발음은 256자 이하로 입력해 주세요.')
  if (word.isDeleted || word.isSilence || !word.word.trim()) return word
  if ((word.readingOverride ?? '') === reading) return word
  const next: SubtitleWord = { ...word, alignmentStatus: 'stale', alignmentScore: null,
    sourceStart: null, sourceEnd: null,
    reviewReasons: [...new Set([...(word.reviewReasons ?? []), 'reading_edited'])].slice(-16) }
  delete next.alignmentText
  delete next.charSpans
  delete next.textSpanMap
  if (reading) next.readingOverride = reading
  else delete next.readingOverride
  return next
}
