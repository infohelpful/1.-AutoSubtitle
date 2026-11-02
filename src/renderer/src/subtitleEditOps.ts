import { partitionLineAtSpeechBoundaries } from '../../shared/lineBreak'
import { displayTextFromSubtitleWords, type SubtitleLine, type SubtitleWord } from '../../shared/subtitles'
import { scrubTimelineNoiseFromWordPiece } from '../../shared/wordContract'
import {
  editedCaptionOf, mergedCaption, sourceBoundaryForCaptionOffset, sourcePieces, splitCaptionAtSourceBoundary, withCaption
} from '../../shared/captionSplit'

const MIN_SEGMENT_SEC = 0.05

type CaptionPair = [string | undefined, string | undefined]

function splitRowAtWord(
  lines: readonly SubtitleLine[], index: number, wordIndex: number, captions?: CaptionPair
): SubtitleLine[] | null {
  if (index < 0 || index >= lines.length) return null
  const cur = lines[index]!
  const words = cur.words ?? []
  if (wordIndex <= 0 || wordIndex >= words.length) return null
  const leftWords = words.slice(0, wordIndex)
  const rightWords = words.slice(wordIndex)
  const leftEnd = leftWords[leftWords.length - 1]!.end
  const rightStart = rightWords[0]!.start
  let splitTime = (leftEnd + rightStart) / 2
  if (!Number.isFinite(splitTime)) splitTime = rightStart
  splitTime = Math.max(cur.start + 0.1, Math.min(cur.end - 0.1, splitTime))
  if (!(splitTime > cur.start && splitTime < cur.end)) return null

  let first: SubtitleLine = { ...cur, end: splitTime, words: leftWords }
  let second: SubtitleLine = { ...cur, start: splitTime, end: cur.end, words: rightWords }
  const caption = editedCaptionOf(cur)
  const pair: CaptionPair | undefined = captions ?? (caption === undefined ? undefined
    : splitCaptionAtSourceBoundary(caption, sourcePieces(words), sourcePieces(leftWords).length))
  if (pair) {
    first = withCaption(first, pair[0])
    second = withCaption(second, pair[1])
  } else {
    first = withCaption(first, undefined)
    second = withCaption(second, undefined)
    if (!first.text) first.text = cur.text
    if (!second.text) second.text = cur.text
  }
  return [...lines.slice(0, index), first, second, ...lines.slice(index + 1)]
}

/**
 * Move the words after a caret into a new row. An edited caption is divided at
 * the matching spot so neither row falls back to the original transcript.
 */
export function splitSubtitleAtWordBoundary(
  lines: readonly SubtitleLine[], index: number, wordIndex: number
): SubtitleLine[] {
  return splitRowAtWord(lines, index, wordIndex) ?? [...lines]
}

/** Index of the word holding the `count`-th visible label, or -1 past the end. */
function wordIndexForPieceBoundary(words: readonly SubtitleWord[], count: number): number {
  let seen = 0
  for (let i = 0; i < words.length; i++) {
    const n = sourcePieces([words[i]!]).length
    if (n > 0 && seen >= count) return i
    seen += n
  }
  return -1
}

/** Join row `index` onto the previous row, keeping any edited caption text of both rows. */
export function mergeSubtitleIntoPrevious(lines: readonly SubtitleLine[], index: number): SubtitleLine[] | null {
  if (index <= 0 || index >= lines.length) return null
  const up = lines[index - 1]!
  const cur = lines[index]!
  const mergedWords = [...(up.words ?? []), ...(cur.words ?? [])]
  if (mergedWords.length === 0) return null
  const caption = mergedCaption(up, cur)
  const base: SubtitleLine = {
    ...up,
    start: Math.min(up.start, mergedWords[0]!.start),
    end: Math.max(mergedWords[mergedWords.length - 1]!.end, up.end),
    words: mergedWords
  }
  const merged = withCaption(base, caption)
  if (caption === undefined && !merged.text) merged.text = `${up.text} ${cur.text}`.trim()
  return [...lines.slice(0, index - 1), merged, ...lines.slice(index + 1)]
}

/**
 * 커서 위치(문자 인덱스)를 줄 안의 **단어 경계**로 스냅해 줄을 나눈다.
 *
 * - 줄 텍스트가 보이는 단어들을 공백으로 이은 문자열과 정확히 같을 때만 동작한다
 *   (사용자가 텍스트를 직접 고쳐 어긋난 줄은 `null` → 기존 시간 비례 방식 사용).
 * - 커서가 맨 앞/맨 뒤에 가까우면 `null`(빈 줄을 만들지 않고 기존 동작 유지).
 * - 나뉜 두 줄의 시간은 각 줄 단어의 실제 시작·끝이며, 줄 사이의 쉼은 그대로 남는다.
 */
export function splitLineAtCaretOnWordBoundary(
  line: SubtitleLine,
  cursorPos: number
): SubtitleLine[] | null {
  const words = line.words
  if (!words || words.length === 0) return null
  const pieces = words
    .filter((w) => !w.isDeleted && !w.isSilence)
    .map((w) => scrubTimelineNoiseFromWordPiece(w.word))
    .filter((p) => p.length > 0)
  if (pieces.length < 2) return null
  if (pieces.join(' ') !== line.text) return null

  // starts[k] = k 번째 단어가 시작하는 문자 오프셋(0 = 맨 앞, 마지막 항목 = 문자열 끝)
  const starts: number[] = [0]
  let acc = 0
  for (let i = 0; i < pieces.length - 1; i += 1) {
    acc += pieces[i]!.length + 1
    starts.push(acc)
  }
  starts.push(line.text.length)

  const cursor = Math.max(0, Math.min(Math.floor(cursorPos), line.text.length))
  let bestK = 0
  let bestDist = Number.POSITIVE_INFINITY
  for (let k = 0; k < starts.length; k += 1) {
    const dist = Math.abs(starts[k]! - cursor)
    if (dist < bestDist) {
      bestDist = dist
      bestK = k
    }
  }
  if (bestK <= 0 || bestK >= pieces.length) return null
  return partitionLineAtSpeechBoundaries(line, [bestK])
}

/**
 * 커서 위치(문자 인덱스)에 비례해 [start, end] 구간을 나눈다.
 * 단어 배열이 있고 텍스트가 단어와 일치하면 **단어 경계에 스냅**해 나눈다.
 * 그렇지 않으면 splitTime 과 각 단어 중점을 비교해 좌·우 배열로 나누고,
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

  const caption = editedCaptionOf(line)
  if (caption !== undefined && line.words?.length) {
    const cursor = Math.max(0, Math.min(Math.floor(cursorPos), caption.length))
    const pair: CaptionPair = [caption.slice(0, cursor).trim(), caption.slice(cursor).trim()]
    const pieces = sourcePieces(line.words)
    const wordIndex = wordIndexForPieceBoundary(line.words, sourceBoundaryForCaptionOffset(caption, pieces, cursor))
    const byWord = splitRowAtWord(lines, index, wordIndex, pair)
    if (byWord) return byWord
    const byRatio = splitSubtitleLine(lines.map((l, i) => i === index ? withCaption(l, undefined) : l), index,
      Math.round(cursor / Math.max(1, caption.length) * displayTextFromSubtitleWords(line.words).length))
    return byRatio.map((l, i) => i === index ? withCaption(l, pair[0]) : i === index + 1 ? withCaption(l, pair[1]) : l)
  }

  const snapped = splitLineAtCaretOnWordBoundary(line, cursorPos)
  if (snapped) return [...lines.slice(0, index), ...snapped, ...lines.slice(index + 1)]

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
      captionText: undefined,
      words: leftWords
    }
    const second: SubtitleLine = {
      ...line,
      start: splitTime,
      end,
      text: displayTextFromSubtitleWords(rightWords) || text.slice(clampedCursor),
      captionText: undefined,
      words: rightWords
    }
    return [...lines.slice(0, index), first, second, ...lines.slice(index + 1)]
  }

  const left = text.slice(0, clampedCursor)
  const right = text.slice(clampedCursor)
  const first: SubtitleLine = { ...line, start, end: splitTime, text: left, captionText: undefined }
  const second: SubtitleLine = { ...line, start: splitTime, end, text: right, captionText: undefined }
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
  let merged: SubtitleLine = {
    start: prevLine.start,
    end: cur.end,
    text,
    ...(mergedWords ? { words: mergedWords } : {}),
    ...(prevLine.isHidden ? { isHidden: true } : {})
  }
  const caption = mergedCaption(prevLine, cur)
  if (caption !== undefined) merged = withCaption(merged, caption)
  return [...lines.slice(0, index - 1), merged, ...lines.slice(index + 1)]
}
