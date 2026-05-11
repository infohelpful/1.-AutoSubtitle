import { visibleSubtitleWords, type SubtitleLine, type SubtitleWord } from '../../shared/subtitles'
import {
  DEFAULT_GAP_THRESHOLD_SEC,
  fillGapsInSubtitleWords,
  validateSubtitleLineWords
} from '../../shared/wordContract'
import type { SubtitleRow } from './components/vrewPeaksEditor/types'
import { makeRowWordBlockId } from './components/vrewPeaksEditor/blockIds'

/** 미디어(원본) 축 [ms, me] → 프로그램(편집) 축 [start, end] 매퍼 */
export type MediaToProgramMapper = (
  mediaStartSec: number,
  mediaEndSec: number
) => { start: number; end: number }

/** 프로그램(편집) 축 [start, end] → 미디어(원본) 축 [start, end] 매퍼 */
export type ProgramToMediaMapper = (
  programStartSec: number,
  programEndSec: number
) => { start: number; end: number }

export type SubtitleLinesToVrewOptions = {
  /**
   * false 이면 gap-fill 생략 — 단어 배열을 그대로 id 부여만 해 Peaks 행으로 만든다.
   * (무음 일괄 삭제 후 등, 편집 결과를 덮어쓰지 않을 때)
   */
  gapFill?: boolean
  /**
   * 자막 단어는 원본 미디어 축이므로 Peaks 표시(편집 축) 와 맞추려면 매핑이 필요.
   * 생략하면 원본 미디어 시간을 그대로 사용한다(자막·Peaks 가 동일 축인 경우).
   */
  mapWordMediaToProgram?: MediaToProgramMapper
}

/** 한 줄 자막 ↔ Peaks 한 행 (단어 타임코드가 없으면 줄 전체를 한 단어로) */
export function subtitleLinesToVrewRows(lines: SubtitleLine[], options?: SubtitleLinesToVrewOptions): SubtitleRow[] {
  const gapFill = options?.gapFill !== false
  const mapMP = options?.mapWordMediaToProgram

  /** 단어 1개를 미디어→프로그램 축으로 변환 (옵션 없으면 그대로 통과) */
  const toProg = (start: number, end: number): { start: number; end: number } =>
    mapMP ? mapMP(start, end) : { start, end }

  return lines.map((line, idx) => {
    const rowId = `sub-${idx}`

    const warnIfInvalid = (payload: { start: number; end: number; words: SubtitleWord[] }) => {
      if (!import.meta.env.DEV) return
      const v = validateSubtitleLineWords(payload)
      if (!v.ok) console.warn('[wordContract]', rowId, v.errors)
    }

    if (line.words && line.words.length > 0) {
      const visibleOnly = line.words.filter((w) => !w.isDeleted)
      if (!gapFill) {
        const words = visibleOnly.map((w, wi) => {
          const p = toProg(w.start, w.end)
          return {
            id: makeRowWordBlockId(idx + 1, wi + 1),
            text: w.word,
            start: p.start,
            end: p.end,
            ...(w.isSilence ? ({ isSilence: true } as const) : {})
          }
        })
        const lineProg = toProg(line.start, line.end)
        warnIfInvalid({
          start: lineProg.start,
          end: lineProg.end,
          words: words.map((x) => ({
            start: x.start,
            end: x.end,
            word: x.text,
            ...(x.isSilence ? { isSilence: true as const } : {})
          }))
        })
        return { id: rowId, words, lineText: line.text }
      }

      const nonSilent = visibleOnly.filter((w) => !w.isSilence)
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
        // gap-fill 은 미디어 축에서 수행 — 단어 사이 무음 더미도 미디어 축 기준 계산
        subtitleWords = fillGapsInSubtitleWords(
          { start: line.start, end: line.end, words: visibleOnly },
          {
            gapThresholdSec: DEFAULT_GAP_THRESHOLD_SEC,
            includeLineBoundaries: true,
            stripPreviousSilences: true
          }
        )
      }

      warnIfInvalid({ start: line.start, end: line.end, words: subtitleWords })

      const words = subtitleWords.map((w, wi) => {
        const p = toProg(w.start, w.end)
        return {
          id: makeRowWordBlockId(idx + 1, wi + 1),
          text: w.word,
          start: p.start,
          end: p.end,
          ...(w.isSilence ? ({ isSilence: true } as const) : {})
        }
      })
      return { id: rowId, words, lineText: line.text }
    }

    const lineProg = toProg(line.start, line.end)
    const fallback = {
      id: makeRowWordBlockId(idx + 1, 1),
      text: line.text.trim() || ' ',
      start: lineProg.start,
      end: lineProg.end
    }
    warnIfInvalid({
      start: lineProg.start,
      end: lineProg.end,
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

export type MergeVrewRowsIntoSubtitleLinesOptions = {
  /**
   * Peaks 가 돌려주는 단어 시간은 프로그램(편집) 축이므로 자막 저장 전 미디어 축으로 되돌릴 매퍼.
   * 생략하면 들어온 시간을 그대로 사용한다.
   */
  mapProgramWordToMedia?: ProgramToMediaMapper
}

/**
 * Peaks 행 변경을 자막 줄에 반영하면서, 기존 줄의 `isDeleted` tombstone 은 인덱스·시간 그대로 유지한다.
 *
 * 조건: 줄 개수가 같고, 각 줄의 보이는(`!isDeleted`) 단어 수 == Peaks 단어 수.
 * 깨지면 `vrewRowsToSubtitleLines` 전면 교체로 폴백한다.
 */
export function mergeVrewRowsIntoSubtitleLines(
  prev: SubtitleLine[],
  nextRows: SubtitleRow[],
  options?: MergeVrewRowsIntoSubtitleLinesOptions
): SubtitleLine[] {
  const mapPM = options?.mapProgramWordToMedia
  /** Peaks 가 준 프로그램 시각을 미디어 축으로 되돌리거나, 매퍼 없으면 그대로 통과 */
  const toMedia = (start: number, end: number): { start: number; end: number } =>
    mapPM ? mapPM(start, end) : { start, end }

  if (prev.length !== nextRows.length) return vrewRowsToSubtitleLines(nextRows, options)

  const merged: SubtitleLine[] = []
  for (let i = 0; i < prev.length; i++) {
    const prevLine = prev[i]!
    const row = nextRows[i]!
    const prevWords = prevLine.words ?? []
    const visiblePrev = visibleSubtitleWords(prevWords)

    if (prevWords.length === 0 || visiblePrev.length !== row.words.length) {
      // 줄 단위로 폴백: 이 줄만 전면 교체
      const replaced = vrewRowsToSubtitleLines([row], options)[0]
      if (replaced) merged.push(replaced)
      else merged.push(prevLine)
      continue
    }

    const nextWords: SubtitleWord[] = []
    let vi = 0
    for (const w of prevWords) {
      if (w.isDeleted) {
        nextWords.push(w)
      } else {
        const peak = row.words[vi]
        vi += 1
        if (!peak) {
          nextWords.push(w)
          continue
        }
        const m = toMedia(peak.start, peak.end)
        const sw: SubtitleWord = {
          ...w,
          start: m.start,
          end: m.end,
          word: peak.text ?? w.word
        }
        if (peak.isSilence) sw.isSilence = true
        else delete sw.isSilence
        nextWords.push(sw)
      }
    }

    const visNext = visibleSubtitleWords(nextWords)
    const start =
      visNext.length > 0 ? Math.min(...visNext.map((w) => w.start)) : prevLine.start
    const end =
      visNext.length > 0 ? Math.max(...visNext.map((w) => w.end)) : prevLine.end
    const text = row.lineText ?? prevLine.text
    merged.push({ ...prevLine, start, end, text, words: nextWords })
  }
  return merged
}

export function vrewRowsToSubtitleLines(
  rows: SubtitleRow[],
  options?: MergeVrewRowsIntoSubtitleLinesOptions
): SubtitleLine[] {
  const mapPM = options?.mapProgramWordToMedia
  const toMedia = (start: number, end: number): { start: number; end: number } =>
    mapPM ? mapPM(start, end) : { start, end }

  return rows.map((row) => {
    const ws = row.words
    if (ws.length === 0) {
      return { start: 0, end: 0, text: row.lineText ?? '', words: [] }
    }
    const mapped = ws.map((w) => {
      const m = toMedia(w.start, w.end)
      return { ...w, start: m.start, end: m.end }
    })
    const start = Math.min(...mapped.map((w) => w.start))
    const end = Math.max(...mapped.map((w) => w.end))
    const words: SubtitleWord[] = mapped.map((w) => {
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
