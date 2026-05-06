import type { SubtitleLine, SubtitleWord } from '../../shared/subtitles'
import {
  DEFAULT_GAP_THRESHOLD_SEC,
  fillGapsInSubtitleWords,
  validateSubtitleLineWords
} from '../../shared/wordContract'
import type { SubtitleRow } from './components/vrewPeaksEditor/types'

export type SubtitleLinesToVrewOptions = {
  /**
   * false 이면 gap-fill 생략 — 단어 배열을 그대로 id 부여만 해 Peaks 행으로 만든다.
   * (무음 일괄 삭제 후 등, 편집 결과를 덮어쓰지 않을 때)
   */
  gapFill?: boolean
}

/** 한 줄 자막 ↔ Peaks 한 행 (단어 타임코드가 없으면 줄 전체를 한 단어로) */
export function subtitleLinesToVrewRows(lines: SubtitleLine[], options?: SubtitleLinesToVrewOptions): SubtitleRow[] {
  const gapFill = options?.gapFill !== false

  return lines.map((line, idx) => {
    const rowId = `sub-${idx}`

    const warnIfInvalid = (payload: { start: number; end: number; words: SubtitleWord[] }) => {
      if (!import.meta.env.DEV) return
      const v = validateSubtitleLineWords(payload)
      if (!v.ok) console.warn('[wordContract]', rowId, v.errors)
    }

    if (line.words && line.words.length > 0) {
      if (!gapFill) {
        const words = line.words.map((w, wi) => ({
          id: idx * 65536 + wi,
          text: w.word,
          start: w.start,
          end: w.end,
          ...(w.isSilence ? ({ isSilence: true } as const) : {})
        }))
        warnIfInvalid({
          start: line.start,
          end: line.end,
          words: words.map((x) => ({
            start: x.start,
            end: x.end,
            word: x.text,
            ...(x.isSilence ? { isSilence: true as const } : {})
          }))
        })
        return { id: rowId, words, lineText: line.text }
      }

      const nonSilent = line.words.filter((w) => !w.isSilence)
      let subtitleWords: SubtitleWord[]

      if (nonSilent.length === 0) {
        subtitleWords = [
          {
            start: line.start,
            end: line.end,
            word: line.text.trim() || ' ',
            isSilence: false
          }
        ]
      } else {
        subtitleWords = fillGapsInSubtitleWords(
          { start: line.start, end: line.end, words: line.words },
          {
            gapThresholdSec: DEFAULT_GAP_THRESHOLD_SEC,
            includeLineBoundaries: true,
            stripPreviousSilences: true
          }
        )
      }

      warnIfInvalid({ start: line.start, end: line.end, words: subtitleWords })

      const words = subtitleWords.map((w, wi) => ({
        id: idx * 65536 + wi,
        text: w.word,
        start: w.start,
        end: w.end,
        ...(w.isSilence ? ({ isSilence: true } as const) : {})
      }))
      return { id: rowId, words, lineText: line.text }
    }

    const fallback = {
      id: idx * 65536,
      text: line.text.trim() || ' ',
      start: line.start,
      end: line.end
    }
    warnIfInvalid({
      start: line.start,
      end: line.end,
      words: [
        {
          start: fallback.start,
          end: fallback.end,
          word: fallback.text
        }
      ]
    })
    return {
      id: rowId,
      words: [fallback],
      lineText: line.text
    }
  })
}

export function vrewRowsToSubtitleLines(rows: SubtitleRow[]): SubtitleLine[] {
  return rows.map((row) => {
    const ws = row.words
    if (ws.length === 0) {
      return { start: 0, end: 0, text: row.lineText ?? '', words: [] }
    }
    const start = Math.min(...ws.map((w) => w.start))
    const end = Math.max(...ws.map((w) => w.end))
    const words: SubtitleWord[] = ws.map((w) => {
      const sw: SubtitleWord = {
        start: w.start,
        end: w.end,
        word: w.text
      }
      if (w.isSilence) sw.isSilence = true
      return sw
    })
    const text = row.lineText ?? words.map((x) => x.word).join(' ')
    return { start, end, text, words }
  })
}
