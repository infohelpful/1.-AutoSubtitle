/**
 * 편집(프로그램) 타임라인 초 구간에 대해 단어를 비파괴 삭제(`isDeleted`)로 표현한다.
 * 구간 밖 타임스탬프는 유지하고, 부분 겹침은 문자 비율로 쪼갠다 — 구 예 `applyTimeRangeCutToVrewRows` 스플라이스와 달리 축을 접지 않는다.
 */
import type { SubtitleLine, SubtitleWord } from './subtitles'
import { displayTextFromSubtitleWords, visibleSubtitleWords } from './subtitles'
import { snapTimelineSec } from './timelineCollapse'

const EPS = 1e-4

function sliceCharsStart(text: string, dropCount: number): string {
  if (dropCount <= 0) return text
  const chars = [...text]
  return chars.slice(dropCount).join('')
}

function sliceCharsEnd(text: string, dropCount: number): string {
  if (dropCount <= 0) return text
  const chars = [...text]
  if (dropCount >= chars.length) return ''
  return chars.slice(0, chars.length - dropCount).join('')
}

/**
 * 단일 단어를 [cs, ce] 컷과 겹치는 만큼 tombstone 조각으로 분해한다 (편집축 초).
 */
export function tombstoneSplitSubtitleWord(w: SubtitleWord, cs: number, ce: number): SubtitleWord[] {
  const ws = w.start
  const we = w.end
  if (!(ce - cs > EPS) || !(we - ws > EPS)) return [w]
  if (ce <= ws + EPS || cs >= we - EPS) return [w]

  const o0 = Math.max(ws, cs)
  const o1 = Math.min(we, ce)
  if (o1 - o0 < EPS) return [w]

  if (cs <= ws + EPS && ce >= we - EPS) {
    return [{ ...w, isDeleted: true as const }]
  }

  const dur = we - ws
  const chars = [...w.word]

  if (chars.length === 0) {
    return [{ ...w, isDeleted: true as const }]
  }

  if (o0 <= ws + EPS && o1 < we - EPS) {
    const removed = o1 - ws
    const ratio = removed / dur
    const n = Math.min(chars.length, Math.max(0, Math.round(chars.length * ratio)))
    const tombText = chars.slice(0, n).join('').trim()
    const restText = sliceCharsStart(w.word, n).trim()
    const out: SubtitleWord[] = []
    if (o1 - ws > EPS) {
      out.push({
        ...w,
        start: ws,
        end: o1,
        word: tombText || chars.slice(0, n).join(''),
        isDeleted: true as const
      })
    }
    if (restText && we - o1 > EPS) {
      out.push({ ...w, start: o1, end: we, word: restText })
    }
    return out.filter((x) => x.end - x.start > EPS)
  }

  if (o0 > ws + EPS && o1 >= we - EPS) {
    const removed = we - o0
    const ratio = removed / dur
    const n = Math.min(chars.length, Math.max(0, Math.round(chars.length * ratio)))
    const restText = sliceCharsEnd(w.word, n).trim()
    const tombText = chars.slice(chars.length - n).join('').trim()
    const out: SubtitleWord[] = []
    if (restText && o0 - ws > EPS) {
      out.push({ ...w, start: ws, end: o0, word: restText })
    }
    if (we - o0 > EPS) {
      out.push({
        ...w,
        start: o0,
        end: we,
        word: tombText || chars.slice(chars.length - n).join(''),
        isDeleted: true as const
      })
    }
    return out.filter((x) => x.end - x.start > EPS)
  }

  if (o0 > ws + EPS && o1 < we - EPS) {
    const leftRatio = (o0 - ws) / dur
    const mid = Math.min(chars.length, Math.max(0, Math.round(chars.length * leftRatio)))
    const leftText = chars.slice(0, mid).join('').trim()
    const rightText = chars.slice(mid).join('').trim()
    const out: SubtitleWord[] = []
    if (leftText && o0 - ws > EPS) {
      out.push({ ...w, start: ws, end: o0, word: leftText })
    }
    if (o1 - o0 > EPS) {
      out.push({
        ...w,
        start: o0,
        end: o1,
        word: chars.slice(mid).join('').trim() || ' ',
        isDeleted: true as const
      })
    }
    if (rightText && we - o1 > EPS) {
      out.push({ ...w, start: o1, end: we, word: rightText })
    }
    return out.filter((x) => x.end - x.start > EPS)
  }

  return [w]
}

function rebuildLineAfterWordCuts(line: SubtitleLine, newWords: SubtitleWord[]): SubtitleLine | null {
  const vis = visibleSubtitleWords(newWords)
  if (vis.length === 0) return null
  const start = Math.min(...vis.map((w) => w.start))
  const end = Math.max(...vis.map((w) => w.end))
  return {
    ...line,
    start,
    end: Math.max(start + 0.1, end),
    words: newWords,
    text: displayTextFromSubtitleWords(newWords)
  }
}

/**
 * 모든 자막 줄에 편집축 구간 컷을 적용한다. 보이는 단어가 하나도 남지 않으면 입력을 그대로 돌려준다.
 */
export function applyProgramTimeRangeTombstoneCutToSubtitleLines(
  lines: readonly SubtitleLine[],
  cutStart: number,
  cutEnd: number
): SubtitleLine[] {
  const cs = snapTimelineSec(Math.min(cutStart, cutEnd))
  const ce = snapTimelineSec(Math.max(cutStart, cutEnd))
  if (!(ce > cs + EPS)) return [...lines]

  const next: SubtitleLine[] = []
  for (const line of lines) {
    const words = line.words
    if (!words || words.length === 0) {
      const syn: SubtitleWord = {
        start: line.start,
        end: line.end,
        word: line.text.trim() || ' '
      }
      const pieces = tombstoneSplitSubtitleWord(syn, cs, ce)
      const rebuilt = rebuildLineAfterWordCuts(line, pieces)
      if (rebuilt) next.push(rebuilt)
      continue
    }

    const flat: SubtitleWord[] = []
    for (const w of words) {
      if (w.isDeleted) {
        flat.push(w)
        continue
      }
      flat.push(...tombstoneSplitSubtitleWord(w, cs, ce))
    }
    const rebuilt = rebuildLineAfterWordCuts(line, flat)
    if (rebuilt) next.push(rebuilt)
  }

  const hasAnyVisible = next.some((l) => visibleSubtitleWords(l.words ?? []).length > 0)
  if (!hasAnyVisible) return [...lines]

  if (lines.length <= 1) return next

  return next.filter((l) => visibleSubtitleWords(l.words ?? []).length > 0)
}
