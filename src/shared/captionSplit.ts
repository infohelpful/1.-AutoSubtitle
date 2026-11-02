import {
  displayTextFromSubtitleWords,
  subtitleLineEditDisplayText,
  type SubtitleLine,
  type SubtitleWord
} from './subtitles'

/**
 * Caption text the user typed for a row, or `undefined` while the row still
 * mirrors its source word chips. Rows without words have no separate caption.
 */
export function editedCaptionOf(line: SubtitleLine): string | undefined {
  if (!line.words?.length) return undefined
  if (line.captionText !== undefined && line.captionText === line.text) {
    return line.captionText === displayTextFromSubtitleWords(line.words) ? undefined : line.captionText
  }
  const display = subtitleLineEditDisplayText(line)
  return display !== displayTextFromSubtitleWords(line.words) ? display : undefined
}

/** Apply a caption to a row; a caption equal to its chips clears the override. */
export function withCaption(line: SubtitleLine, caption: string | undefined): SubtitleLine {
  const source = displayTextFromSubtitleWords(line.words)
  if (caption === undefined || caption === source) {
    const next: SubtitleLine = { ...line, text: line.words?.length ? source : line.text }
    delete next.captionText
    return next
  }
  return { ...line, text: caption, captionText: caption }
}

/** Visible chip labels exactly as they appear in `displayTextFromSubtitleWords`. */
export function sourcePieces(words: readonly SubtitleWord[] | undefined): string[] {
  return displayTextFromSubtitleWords(words).split(' ').filter(Boolean)
}

type Token = { text: string; start: number; end: number }

function captionTokens(caption: string): Token[] {
  return Array.from(caption.matchAll(/\S+/g), m => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }))
}

function norm(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[\p{P}\p{S}]/gu, '')
}

/** Longest common subsequence of normalized tokens, as [aIndex, bIndex] pairs. */
function matchPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const an = a.map(norm)
  const bn = b.map(norm)
  const dp = Array.from({ length: an.length + 1 }, () => new Array<number>(bn.length + 1).fill(0))
  for (let i = an.length - 1; i >= 0; i--) {
    for (let j = bn.length - 1; j >= 0; j--) {
      dp[i]![j] = an[i] && an[i] === bn[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: Array<[number, number]> = []
  let i = 0, j = 0
  while (i < an.length && j < bn.length) {
    if (an[i] && an[i] === bn[j]) { out.push([i, j]); i++; j++ }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
    else j++
  }
  return out
}

/**
 * Map a boundary between items of `a` (count of items on the left) to the
 * corresponding boundary between items of `b`, using matched words as anchors
 * and interpolating across unmatched stretches.
 */
export function mapTokenBoundary(a: readonly string[], b: readonly string[], boundary: number): number {
  if (boundary <= 0) return 0
  if (boundary >= a.length) return b.length
  const pairs = matchPairs(a, b)
  const left = pairs.filter(([ai]) => ai < boundary).at(-1)
  const right = pairs.find(([ai]) => ai >= boundary)
  const aLo = left ? left[0] + 1 : 0
  const aHi = right ? right[0] : a.length
  const bLo = left ? left[1] + 1 : 0
  const bHi = right ? right[1] : b.length
  // Words inserted right at the boundary belong to the following row.
  const frac = aHi > aLo ? (boundary - aLo) / (aHi - aLo) : 0
  let k = bLo + Math.round((bHi - bLo) * frac)
  // Without any anchors keep both sides non-empty when possible.
  if (!pairs.length && b.length >= 2) k = Math.max(1, Math.min(b.length - 1, k))
  return Math.max(0, Math.min(b.length, k))
}

/** Split an edited caption where the source chips are split after `leftPieceCount` labels. */
export function splitCaptionAtSourceBoundary(
  caption: string, pieces: readonly string[], leftPieceCount: number
): [string, string] {
  const tokens = captionTokens(caption)
  if (!tokens.length) return ['', '']
  const k = mapTokenBoundary(pieces, tokens.map(t => t.text), leftPieceCount)
  const at = k >= tokens.length ? caption.length : tokens[k]!.start
  return [caption.slice(0, at).trim(), caption.slice(at).trim()]
}

/** Source label count left of a character offset inside an edited caption. */
export function sourceBoundaryForCaptionOffset(
  caption: string, pieces: readonly string[], offset: number
): number {
  const tokens = captionTokens(caption)
  const k = tokens.filter(t => (t.start + t.end) / 2 < offset).length
  return mapTokenBoundary(tokens.map(t => t.text), pieces, k)
}

/** Caption for two rows joined into one; `undefined` when neither row was edited. */
export function mergedCaption(first: SubtitleLine, second: SubtitleLine): string | undefined {
  if (editedCaptionOf(first) === undefined && editedCaptionOf(second) === undefined) return undefined
  return [subtitleLineEditDisplayText(first), subtitleLineEditDisplayText(second)]
    .map(s => s.trim()).filter(Boolean).join(' ')
}
