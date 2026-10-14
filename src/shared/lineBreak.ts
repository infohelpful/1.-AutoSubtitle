import { displayTextFromSubtitleWords, type SubtitleLine, type SubtitleWord } from './subtitles'
import { scrubTimelineNoiseFromWordPiece } from './wordContract'

/**
 * 자막 줄 자동 줄바꿈 — 단어 타임스탬프를 기준으로 너무 긴 줄을 여러 줄로 나눈다.
 *
 * - 입력 줄의 단어(`words`)·ID·정렬 메타를 그대로 유지하고 **줄 사이로 재배치만** 한다(시간·텍스트 변경 없음).
 * - 무음/삭제(tombstone) 단어는 직전 줄 끝에 붙는다. 줄의 맨 앞 무음은 첫 줄에 남는다.
 * - 단어가 없는 줄은 건드리지 않는다.
 */

/** 한 줄 최대 표시 폭 기본값(전각 글자 기준). */
export const DEFAULT_MAX_LINE_UNITS = 20

export type LineBreakOptions = {
  /**
   * 한 줄 최대 표시 폭. 전각 문자(한글·한자·가나·전각 기호)=1, 그 외(영문·숫자·공백)=0.5.
   * 즉 한글 기준 "글자 수"와 같고 영문은 두 글자가 한 칸이다.
   */
  maxUnits: number
  /** 문장 끝(. ? ! 。 ？ ！)에서 무조건 줄을 나눈다. 기본 true */
  breakAtSentenceEnd?: boolean
  /** 이 길이(초) 이상 쉬면 무조건 줄을 나눈다. null/미지정이면 사용하지 않는다. */
  hardPauseSec?: number | null
  /** 이 길이(초) 이상 쉬는 곳을 줄바꿈 후보로 선호한다. 기본 0.3 */
  softPauseSec?: number
}

export type LineBreakStats = {
  /** 나뉜 원본 줄 수 */
  brokenLineCount: number
  /** 새로 늘어난 줄 수 */
  addedLineCount: number
}

const BASE_BREAK_COST = 0.25
const COMMA_BONUS = 0.2
const PAUSE_BONUS = 0.2
const MIN_WORD_SEC = 0.01

function charUnits(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp === 0x20) return 0.5
  if (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 기호·문장부호
    (cp >= 0x3040 && cp <= 0x30ff) || // 히라가나·가타카나
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul compat jamo
    (cp >= 0x3400 && cp <= 0x9fff) || // CJK 통합 한자
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 호환 한자
    (cp >= 0xff01 && cp <= 0xff60) || // 전각 형태
    (cp >= 0xffe0 && cp <= 0xffe6)
  ) {
    return 1
  }
  return 0.5
}

/** 표시 폭(전각 1, 반각 0.5). */
export function textDisplayUnits(text: string): number {
  let units = 0
  for (const ch of text) units += charUnits(ch)
  return units
}

const SENTENCE_END_RE = /[.!?。！？]["'”’)\]」』]*$/u
const SOFT_END_RE = /[,，、;；:：]["'”’)\]」』]*$/u

type SpeechWord = {
  /** `line.words` 저장 인덱스 */
  storageIndex: number
  text: string
  units: number
  start: number
  end: number
}

function speechWordsOf(words: readonly SubtitleWord[]): SpeechWord[] {
  const out: SpeechWord[] = []
  words.forEach((w, storageIndex) => {
    if (w.isDeleted || w.isSilence) return
    const text = scrubTimelineNoiseFromWordPiece(w.word)
    if (text.length === 0) return
    out.push({ storageIndex, text, units: textDisplayUnits(text), start: w.start, end: w.end })
  })
  return out
}

function groupWidth(speech: readonly SpeechWord[], from: number, to: number): number {
  let width = 0
  for (let i = from; i < to; i += 1) width += speech[i]!.units
  return width + 0.5 * Math.max(0, to - from - 1)
}

/**
 * 한 줄을 `boundaries`(발화 단어 인덱스: 그 단어가 새 줄의 첫 단어) 위치에서 나눈다.
 * 경계가 비었거나 범위를 벗어나면 `null`.
 */
export function partitionLineAtSpeechBoundaries(
  line: SubtitleLine,
  boundaries: readonly number[]
): SubtitleLine[] | null {
  const words = line.words
  if (!words || words.length === 0) return null
  const speech = speechWordsOf(words)
  const cuts = [...new Set(boundaries)]
    .filter((b) => Number.isInteger(b) && b > 0 && b < speech.length)
    .sort((a, b) => a - b)
  if (cuts.length === 0) return null

  // 새 줄이 시작하는 저장 인덱스. 경계 사이의 무음·삭제 단어는 직전 줄에 남는다.
  const startsAt = cuts.map((b) => speech[b]!.storageIndex)
  const groups: SubtitleWord[][] = []
  let from = 0
  for (const at of startsAt) {
    groups.push(words.slice(from, at))
    from = at
  }
  groups.push(words.slice(from))

  return groups.map((group, index) => {
    const alive = group.filter((w) => !w.isDeleted)
    let start = alive.length > 0 ? Math.min(...alive.map((w) => w.start)) : line.start
    let end = alive.length > 0 ? Math.max(...alive.map((w) => w.end)) : line.end
    // 원본 줄 경계(앞·뒤 여백)는 첫/마지막 줄이 이어받는다.
    if (index === 0) start = Math.min(start, line.start)
    if (index === groups.length - 1) end = Math.max(end, line.end)
    end = Math.max(end, start + MIN_WORD_SEC)
    return {
      ...line,
      start,
      end,
      text: displayTextFromSubtitleWords(group),
      words: group
    }
  })
}

/** 문장 끝·긴 휴지 등 "반드시 나눌 곳"의 발화 단어 인덱스(그 단어가 새 줄의 첫 단어). */
function mandatoryBoundaries(speech: readonly SpeechWord[], opts: LineBreakOptions): number[] {
  const breakAtSentenceEnd = opts.breakAtSentenceEnd ?? true
  const hardPause = opts.hardPauseSec ?? null
  const out: number[] = []
  for (let i = 1; i < speech.length; i += 1) {
    const prev = speech[i - 1]!
    const cur = speech[i]!
    if (breakAtSentenceEnd && SENTENCE_END_RE.test(prev.text)) {
      out.push(i)
      continue
    }
    if (hardPause !== null && hardPause > 0 && cur.start - prev.end >= hardPause) out.push(i)
  }
  return out
}

/** 구간 `[from, to)` 를 최대 폭 안에서 가장 고르게 나누는 경계(발화 단어 인덱스)를 찾는다. */
function optimalBoundaries(
  speech: readonly SpeechWord[],
  from: number,
  to: number,
  maxUnits: number,
  softPauseSec: number
): number[] {
  const n = to - from
  if (n <= 1 || groupWidth(speech, from, to) <= maxUnits) return []

  // 경계 i(= speech[i] 가 새 줄 첫 단어)에서 나누면 좋은 정도(0 이상, 클수록 자연스럽다).
  const bonusAt = (i: number): number => {
    const prev = speech[i - 1]!
    const cur = speech[i]!
    let bonus = 0
    if (SOFT_END_RE.test(prev.text)) bonus += COMMA_BONUS
    const gap = cur.start - prev.end
    if (gap >= softPauseSec) bonus += PAUSE_BONUS * Math.min(2, gap / Math.max(softPauseSec, 0.05))
    return bonus
  }

  const INF = Number.POSITIVE_INFINITY
  const best = new Array<number>(n + 1).fill(INF)
  const back = new Array<number>(n + 1).fill(-1)
  best[0] = 0
  for (let j = 1; j <= n; j += 1) {
    for (let i = j - 1; i >= 0; i -= 1) {
      const width = groupWidth(speech, from + i, from + j)
      // 단어 하나가 한도를 넘어도 그 단어 혼자 한 줄은 허용한다.
      if (width > maxUnits && j - i > 1) break
      const slack = Math.max(0, (maxUnits - width) / maxUnits)
      const lineCost = slack * slack
      const breakCost = j < n ? Math.max(0, BASE_BREAK_COST - bonusAt(from + j)) : 0
      const total = best[i]! + lineCost + breakCost
      if (total < best[j]!) {
        best[j] = total
        back[j] = i
      }
    }
  }

  const cuts: number[] = []
  let at = n
  while (at > 0) {
    const prev = back[at]!
    if (prev < 0) return [] // 도달 불가(이론상 없음)
    if (prev > 0) cuts.push(from + prev)
    at = prev
  }
  return cuts.sort((a, b) => a - b)
}

/**
 * 한 줄을 최대 폭에 맞게 나눈다. 나눌 필요가 없으면 `[line]`(같은 참조)을 돌려준다.
 */
export function breakSubtitleLine(line: SubtitleLine, options: LineBreakOptions): SubtitleLine[] {
  if (line.isDeleted || !line.words || line.words.length === 0) return [line]
  const maxUnits = Number.isFinite(options.maxUnits) ? Math.max(1, options.maxUnits) : DEFAULT_MAX_LINE_UNITS
  const softPauseSec = options.softPauseSec ?? 0.3
  const speech = speechWordsOf(line.words)
  if (speech.length <= 1) return [line]

  const mandatory = mandatoryBoundaries(speech, options)
  const segmentEdges = [0, ...mandatory, speech.length]
  const cuts: number[] = [...mandatory]
  for (let s = 0; s + 1 < segmentEdges.length; s += 1) {
    cuts.push(...optimalBoundaries(speech, segmentEdges[s]!, segmentEdges[s + 1]!, maxUnits, softPauseSec))
  }
  if (cuts.length === 0) return [line]
  return partitionLineAtSpeechBoundaries(line, cuts) ?? [line]
}

/** 전체 줄에 적용한다. 바뀐 줄이 없으면 입력 배열을 그대로 돌려준다. */
export function breakSubtitleLines(
  lines: readonly SubtitleLine[],
  options: LineBreakOptions
): { lines: SubtitleLine[]; stats: LineBreakStats } {
  const out: SubtitleLine[] = []
  let brokenLineCount = 0
  let addedLineCount = 0
  for (const line of lines) {
    const pieces = breakSubtitleLine(line, options)
    if (pieces.length > 1) {
      brokenLineCount += 1
      addedLineCount += pieces.length - 1
    }
    out.push(...pieces)
  }
  if (brokenLineCount === 0) return { lines: [...lines], stats: { brokenLineCount, addedLineCount } }
  return { lines: out, stats: { brokenLineCount, addedLineCount } }
}
