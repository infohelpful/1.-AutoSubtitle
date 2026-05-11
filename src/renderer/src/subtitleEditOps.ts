import { displayTextFromSubtitleWords, type SubtitleLine, type SubtitleWord } from '../../shared/subtitles'

const MIN_SEGMENT_SEC = 0.05

/**
 * 커서 위치(문자 인덱스)에 비례해 [start, end] 구간을 나눈다.
 * 단어 배열이 있으면 splitTime 과 각 단어 중점을 비교해 좌·우 배열로 나누고,
 * `text` 는 `displayTextFromSubtitleWords` 로 보이는 단어만으로 재구성한다.
 */
export function splitSubtitleLine(
  lines: readonly SubtitleLine[],
  index: number,
  cursorPos: number
): SubtitleLine[] {
  if (index < 0 || index >= lines.length) return [...lines]
  const line = lines[index]
  const { start, end, text } = line
  const dur = end - start
  if (!(dur > 0) || !Number.isFinite(dur)) return [...lines]

  const clampedCursor = Math.max(0, Math.min(Math.floor(cursorPos), text.length))
  const ratio = text.length === 0 ? 0.5 : clampedCursor / text.length
  let splitTime = start + dur * ratio
  splitTime = Math.min(Math.max(splitTime, start + MIN_SEGMENT_SEC), end - MIN_SEGMENT_SEC)
  if (!(splitTime > start && splitTime < end)) {
    splitTime = start + dur / 2
  }

  if (line.words && line.words.length > 0) {
    const leftWords: SubtitleWord[] = []
    const rightWords: SubtitleWord[] = []
    for (const w of line.words) {
      const mid = (w.start + w.end) / 2
      if (mid <= splitTime) leftWords.push(w)
      else rightWords.push(w)
    }
    const first: SubtitleLine = {
      ...line,
      start,
      end: splitTime,
      text: displayTextFromSubtitleWords(leftWords) || text.slice(0, clampedCursor),
      words: leftWords
    }
    const second: SubtitleLine = {
      ...line,
      start: splitTime,
      end,
      text: displayTextFromSubtitleWords(rightWords) || text.slice(clampedCursor),
      words: rightWords
    }
    return [...lines.slice(0, index), first, second, ...lines.slice(index + 1)]
  }

  const left = text.slice(0, clampedCursor)
  const right = text.slice(clampedCursor)
  const first: SubtitleLine = { start, end: splitTime, text: left }
  const second: SubtitleLine = { start: splitTime, end, text: right }
  return [...lines.slice(0, index), first, second, ...lines.slice(index + 1)]
}

/** 현재 줄 텍스트가 비어 있을 때만 이전 줄과 병합한다. (단어 배열은 이어 붙임) */
export function mergeEmptySubtitleWithPrevious(
  lines: readonly SubtitleLine[],
  index: number
): SubtitleLine[] | null {
  if (index <= 0 || index >= lines.length) return null
  const cur = lines[index]
  if (cur.text.length > 0) return null
  const prevLine = lines[index - 1]
  const mergedWords: SubtitleWord[] | undefined =
    prevLine.words || cur.words
      ? [...(prevLine.words ?? []), ...(cur.words ?? [])]
      : undefined
  const text =
    mergedWords && mergedWords.length > 0
      ? displayTextFromSubtitleWords(mergedWords) || prevLine.text
      : prevLine.text
  const merged: SubtitleLine = {
    start: prevLine.start,
    end: cur.end,
    text,
    ...(mergedWords ? { words: mergedWords } : {})
  }
  return [...lines.slice(0, index - 1), merged, ...lines.slice(index + 1)]
}
