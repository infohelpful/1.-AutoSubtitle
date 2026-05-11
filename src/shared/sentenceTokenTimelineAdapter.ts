/**
 * SubtitleLine[] ↔ SentenceTokenTimeline 어댑터.
 * React/App 단일 소스는 SentenceTokenTimeline; UI·IPC·내보내기는 파생 SubtitleLine[] 를 사용한다.
 */
import type { SubtitleLine, SubtitleWord } from './subtitles'
import { displayTextFromSubtitleWords, visibleSubtitleWords } from './subtitles'
import type { SentenceTokenTimeline, TimelineSentence, TimelineToken } from './sentenceTokenTimeline'

function sentenceIdForLineIndex(li: number): string {
  return `sub-${li}`
}

function tokenIdFor(li: number, wi: number): string {
  return `tok-${li}-${wi}`
}

/**
 * 기존 자막 줄 배열 → 문장·토큰 타임라인.
 * 줄 인덱스가 문장 id(stable)에 대응한다.
 */
export function subtitleLinesToSentenceTokenTimeline(lines: readonly SubtitleLine[]): SentenceTokenTimeline {
  const out: TimelineSentence[] = []
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!
    const words = line.words
    if (words && words.length > 0) {
      const tokens: TimelineToken[] = words.map((w, wi) => {
        const t: TimelineToken = {
          id: tokenIdFor(li, wi),
          text: w.word,
          start_original: w.start,
          end_original: w.end
        }
        if (w.isDeleted === true) t.is_deleted = true
        if (w.isSilence === true) t.isSilence = true
        return t
      })
      out.push({ id: sentenceIdForLineIndex(li), tokens, is_deleted: false })
    } else {
      out.push({
        id: sentenceIdForLineIndex(li),
        tokens: [
          {
            id: tokenIdFor(li, 0),
            text: (line.text ?? '').trim() || ' ',
            start_original: line.start,
            end_original: line.end
          }
        ],
        is_deleted: false
      })
    }
  }
  return out
}

/**
 * 타임라인 → 자막 줄 배열 (편집기·Peaks·저장 포맷과 호환).
 */
export function sentenceTokenTimelineToSubtitleLines(timeline: SentenceTokenTimeline): SubtitleLine[] {
  const result: SubtitleLine[] = []
  for (const sentence of timeline) {
    if (sentence.is_deleted === true) continue
    const raw = sentence.tokens
    if (raw.length === 0) continue

    const words: SubtitleWord[] = raw.map((t) => {
      const w: SubtitleWord = {
        start: t.start_original,
        end: t.end_original,
        word: t.text
      }
      if (t.is_deleted === true) w.isDeleted = true
      if (t.isSilence === true) w.isSilence = true
      return w
    })

    const vis = visibleSubtitleWords(words)
    const start =
      vis.length > 0 ? Math.min(...vis.map((w) => w.start)) : Math.min(...words.map((w) => w.start))
    const end =
      vis.length > 0 ? Math.max(...vis.map((w) => w.end)) : Math.max(...words.map((w) => w.end))
    const text = displayTextFromSubtitleWords(words)
    result.push({
      start,
      end: Math.max(start + 0.1, end),
      text,
      words
    })
  }
  return result
}
