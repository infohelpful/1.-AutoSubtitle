import { textDisplayUnits } from './lineBreak'
import { displayTextFromSubtitleWords, type SubtitleLine, type SubtitleWord } from './subtitles'
import { scrubTimelineNoiseFromWordPiece } from './wordContract'

/**
 * 대본·SRT 가져오기.
 *
 * - `parseSubtitleCues`: SRT/WebVTT 형태 텍스트를 시간이 있는 큐로 파싱한다.
 * - `srtCuesToSubtitleLines`: 큐를 자막 줄로 바꾸고, 줄 안 단어 시간은 글자 폭에 비례해 추정한다(`estimated`).
 * - `splitScriptText`: 시간이 없는 대본을 줄바꿈·문장부호·슬래시 기준으로 문장 목록으로 나눈다.
 * - `alignScriptToTimedLines`: 이미 추출된(시간이 있는) 단어와 대본을 서열 정렬해 대본 문장에 시간을 입힌다.
 *
 * 대본 단어에 입힌 시간은 음성 인식 결과에서 가져온 추정치다. 정밀 경계는 기존 "싱크 재정렬"로 다듬는다.
 */

// ───────────────────────── 텍스트 인코딩 ─────────────────────────

export type DecodedText = { text: string; encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'euc-kr' }

/** BOM → UTF-8 엄격 디코드 → 실패 시 EUC-KR(CP949) 순으로 시도한다. */
export function decodeTextBuffer(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    try {
      return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'euc-kr' }
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' }
    }
  }
}

// ───────────────────────── SRT / VTT ─────────────────────────

export type ScriptCue = { start: number; end: number; text: string }

const TIMING_RE =
  /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/

function toSeconds(h: string | undefined, m: string, s: string, frac: string): number {
  const ms = Number.parseInt(frac.padEnd(3, '0').slice(0, 3), 10)
  return (h ? Number.parseInt(h, 10) : 0) * 3600 + Number.parseInt(m, 10) * 60 + Number.parseInt(s, 10) + ms / 1000
}

function stripCueMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** SRT/WebVTT 텍스트의 큐를 읽는다. 시간 줄이 없는 블록은 건너뛴다. */
export function parseSubtitleCues(raw: string): { cues: ScriptCue[]; skippedBlocks: number } {
  const normalized = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim()
  if (normalized.length === 0) return { cues: [], skippedBlocks: 0 }
  const cues: ScriptCue[] = []
  let skippedBlocks = 0
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n')
    const timingIndex = lines.findIndex((l) => TIMING_RE.test(l))
    if (timingIndex < 0) {
      const head = (lines[0] ?? '').trim()
      if (head && !/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(head)) skippedBlocks += 1
      continue
    }
    const m = TIMING_RE.exec(lines[timingIndex]!)!
    const start = toSeconds(m[1], m[2]!, m[3]!, m[4]!)
    const end = toSeconds(m[5], m[6]!, m[7]!, m[8]!)
    const text = stripCueMarkup(lines.slice(timingIndex + 1).join(' '))
    if (text.length === 0 || !(end > start)) {
      skippedBlocks += 1
      continue
    }
    cues.push({ start, end, text })
  }
  cues.sort((a, b) => a.start - b.start)
  return { cues, skippedBlocks }
}

const MIN_WORD_SEC = 0.01

function wordsFromTokens(tokens: readonly string[], start: number, end: number, engine: string): SubtitleWord[] {
  const weights = tokens.map((t) => Math.max(0.5, textDisplayUnits(t)))
  const total = weights.reduce((a, b) => a + b, 0)
  const span = end - start
  let cursor = start
  return tokens.map((word, i) => {
    const wordStart = cursor
    const wordEnd = i === tokens.length - 1 ? end : Math.min(end, cursor + (span * weights[i]!) / total)
    cursor = wordEnd
    return {
      start: wordStart,
      end: wordEnd,
      word,
      alignmentStatus: 'estimated' as const,
      engine
    }
  })
}

/** SRT 큐 → 자막 줄. 줄 시간은 큐 시간 그대로이고 단어 시간만 추정한다. */
export function srtCuesToSubtitleLines(cues: readonly ScriptCue[]): SubtitleLine[] {
  const lines: SubtitleLine[] = []
  for (const cue of cues) {
    const tokens = cue.text.split(/\s+/).filter((t) => t.length > 0)
    if (tokens.length === 0) continue
    const words = wordsFromTokens(tokens, cue.start, cue.end, 'srt-import')
    lines.push({ start: cue.start, end: cue.end, text: tokens.join(' '), words })
  }
  return lines
}

// ───────────────────────── 대본 분할 ─────────────────────────

export type ScriptSplitOptions = {
  /** 줄바꿈마다 나눈다. false 면 줄바꿈을 공백으로 본다. 기본 true */
  atLinebreak?: boolean
  /** 문장부호(. ? ! 。 ？ ！ …) 뒤에서 나눈다. 기본 false */
  atPunctuation?: boolean
  /** 슬래시(/) 에서 나눈다. 기본 false */
  atSlash?: boolean
}

/** 시간이 없는 대본을 문장(자막 줄 후보) 목록으로 나눈다. */
export function splitScriptText(raw: string, options: ScriptSplitOptions = {}): string[] {
  const atLinebreak = options.atLinebreak ?? true
  const atPunctuation = options.atPunctuation ?? false
  const atSlash = options.atSlash ?? false
  let pieces = [raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')]
  pieces = atLinebreak ? pieces.flatMap((p) => p.split(/\n+/)) : pieces.map((p) => p.replace(/\n+/g, ' '))
  if (atPunctuation) {
    pieces = pieces.flatMap((p) => p.split(/(?<=[.!?。！？…]["'”’)\]」』]*)\s+/u))
  }
  if (atSlash) pieces = pieces.flatMap((p) => p.split(/\s*[/／]\s*/))
  return pieces.map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 0)
}

// ───────────────────────── 대본 ↔ 시간 있는 단어 정렬 ─────────────────────────

export type ScriptAlignStats = {
  scriptTokens: number
  asrTokens: number
  matched: number
  interpolated: number
}

export type ScriptAlignResult =
  | { ok: true; lines: SubtitleLine[]; stats: ScriptAlignStats }
  | {
      ok: false
      reason: 'no_script' | 'no_timing_source' | 'too_long' | 'low_match'
      message: string
      stats?: ScriptAlignStats
    }

/** 서열 정렬 표 크기 상한(셀 수). 약 40MB 의 방향 표를 쓴다. */
const MAX_ALIGN_CELLS = 40_000_000
/** 대본 단어 중 최소 이만큼은 음성 인식 단어와 맞아야 시간을 입힌다. */
const MIN_MATCH_RATIO = 0.2

function normalizeToken(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  while (i < la && i < lb && a[i] === b[i]) i += 1
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1)
  return la > lb ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i)
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return i
}

/** 2 = 일치, 1 = 비슷함(오인식·조사 차이), -1 = 다름 */
function tokenScore(a: string, b: string): number {
  if (a === b) return 2
  if (a.length >= 3 && b.length >= 3 && withinOneEdit(a, b)) return 1
  const prefix = commonPrefixLength(a, b)
  if (prefix >= 2 && prefix / Math.min(a.length, b.length) >= 0.6) return 1
  return -1
}

type TimedToken = { text: string; norm: string; start: number; end: number }
type ScriptToken = { text: string; norm: string; lineIndex: number }

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * 대본 문장 목록에 이미 추출된 줄의 단어 시간을 입힌다.
 * 음성 인식 결과와 대본의 단어를 서열 정렬(일치 2, 유사 1, 불일치 -1, 건너뜀 -1)해 일치한 단어의 시간을 가져오고,
 * 일치하지 않은 대본 단어는 앞뒤 일치 단어 사이를 글자 폭에 비례해 보간한다.
 */
export function alignScriptToTimedLines(
  scriptLines: readonly string[],
  timedLines: readonly SubtitleLine[]
): ScriptAlignResult {
  const script: ScriptToken[] = []
  scriptLines.forEach((line, lineIndex) => {
    for (const text of line.split(/\s+/)) {
      if (text.length > 0) script.push({ text, norm: normalizeToken(text), lineIndex })
    }
  })
  if (script.length === 0) return { ok: false, reason: 'no_script', message: '대본에 내용이 없습니다.' }

  const asr: TimedToken[] = []
  for (const line of timedLines) {
    if (line.isDeleted) continue
    for (const w of line.words ?? []) {
      if (w.isDeleted || w.isSilence) continue
      const text = scrubTimelineNoiseFromWordPiece(w.word)
      const norm = normalizeToken(text)
      if (norm.length === 0) continue
      asr.push({ text, norm, start: w.start, end: w.end })
    }
  }
  if (asr.length === 0) {
    return {
      ok: false,
      reason: 'no_timing_source',
      message: '시간 정보가 있는 자막이 없습니다. 먼저 영상에서 자막을 추출해 주세요.'
    }
  }

  const dpScript = script.map((t, index) => ({ index, norm: t.norm })).filter((t) => t.norm.length > 0)
  const n = asr.length
  const m = dpScript.length
  const baseStats = { scriptTokens: script.length, asrTokens: n, matched: 0, interpolated: 0 }
  if (m === 0) return { ok: false, reason: 'no_script', message: '대본에 글자가 없습니다.', stats: baseStats }
  if ((n + 1) * (m + 1) > MAX_ALIGN_CELLS) {
    return {
      ok: false,
      reason: 'too_long',
      message: '대본과 자막이 너무 길어 한 번에 맞출 수 없습니다. 구간을 나누어 가져와 주세요.',
      stats: baseStats
    }
  }

  // Needleman–Wunsch. dir: 0=대각(짝지음), 1=위(음성 인식 단어 건너뜀), 2=왼쪽(대본 단어 건너뜀)
  const width = m + 1
  const dir = new Uint8Array((n + 1) * width)
  let prev = new Int32Array(width)
  let cur = new Int32Array(width)
  for (let j = 1; j <= m; j += 1) {
    prev[j] = -j
    dir[j] = 2
  }
  for (let i = 1; i <= n; i += 1) {
    cur[0] = -i
    dir[i * width] = 1
    const a = asr[i - 1]!.norm
    for (let j = 1; j <= m; j += 1) {
      const diag = prev[j - 1]! + tokenScore(a, dpScript[j - 1]!.norm)
      const up = prev[j]! - 1
      const left = cur[j - 1]! - 1
      if (diag >= up && diag >= left) {
        cur[j] = diag
        dir[i * width + j] = 0
      } else if (up >= left) {
        cur[j] = up
        dir[i * width + j] = 1
      } else {
        cur[j] = left
        dir[i * width + j] = 2
      }
    }
    const swap = prev
    prev = cur
    cur = swap
  }

  // 역추적 → 일치(점수>0)한 쌍만 시간 기준점으로 쓴다.
  const matchedAsr = new Array<number>(script.length).fill(-1)
  let matched = 0
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const d = dir[i * width + j]!
    if (d === 0 && i > 0 && j > 0) {
      if (tokenScore(asr[i - 1]!.norm, dpScript[j - 1]!.norm) > 0) {
        matchedAsr[dpScript[j - 1]!.index] = i - 1
        matched += 1
      }
      i -= 1
      j -= 1
    } else if (d === 1 && i > 0) {
      i -= 1
    } else {
      j -= 1
    }
  }

  const need = Math.max(m >= 2 ? 2 : 1, Math.ceil(m * MIN_MATCH_RATIO))
  if (matched < need) {
    return {
      ok: false,
      reason: 'low_match',
      message: `대본과 추출된 자막이 너무 달라 시간을 맞출 수 없습니다 (일치 ${matched}/${m} 단어).`,
      stats: { ...baseStats, matched }
    }
  }

  // 시간 배정 — 일치 단어는 음성 인식 시간, 나머지는 보간
  const times: Array<{ start: number; end: number } | null> = script.map((_, i) => {
    const a = matchedAsr[i]!
    return a >= 0 ? { start: asr[a]!.start, end: asr[a]!.end } : null
  })
  const speeds: number[] = []
  script.forEach((t, i) => {
    const tm = times[i]
    if (!tm) return
    const units = Math.max(0.5, textDisplayUnits(t.text))
    const sec = (tm.end - tm.start) / units
    if (Number.isFinite(sec) && sec > 0) speeds.push(sec)
  })
  const secPerUnit = Math.min(0.4, Math.max(0.05, speeds.length > 0 ? median(speeds) : 0.18))

  let interpolated = 0
  const overlapping = new Set<number>()
  for (let i = 0; i < script.length; ) {
    if (times[i]) {
      i += 1
      continue
    }
    let j = i
    while (j < script.length && !times[j]) j += 1
    const weights = script.slice(i, j).map((t) => Math.max(0.5, textDisplayUnits(t.text)))
    const total = weights.reduce((a, b) => a + b, 0)
    const naturalSpan = total * secPerUnit
    const before = i > 0 ? times[i - 1]!.end : null
    const after = j < script.length ? times[j]!.start : null
    let from: number
    let span: number
    if (before !== null && after !== null) {
      // 사이 공간이 충분히 넓으면 자연 속도로 앞 단어 뒤에 붙이고, 좁으면 공간에 맞춰 압축한다.
      const avail = Math.max(0, after - before)
      from = before
      span = Math.min(avail, naturalSpan)
      if (span <= 0) {
        // There is no unclaimed audio for these words. Keep the measured anchors
        // fixed and flag this local estimate for acoustic realignment.
        from = Math.max(0, after - weights.length * MIN_WORD_SEC)
        span = after - from
        for (let k = i; k < j; k += 1) overlapping.add(k)
      }
    } else if (after !== null) {
      from = Math.max(0, after - naturalSpan)
      span = after - from
    } else {
      from = before ?? 0
      span = naturalSpan
    }
    let cursor = from
    for (let k = i; k < j; k += 1) {
      const dur = (span * weights[k - i]!) / total
      // At source time zero a positive estimate must overlap the first anchor.
      // Keep that ambiguity local rather than shifting every subsequent word.
      if (span === 0) overlapping.add(k)
      times[k] = { start: cursor, end: k === j - 1 ? from + span : cursor + dur }
      if (span === 0) times[k] = { start: from, end: from + MIN_WORD_SEC }
      cursor += dur
      interpolated += 1
    }
    i = j
  }

  const byLine = new Map<number, SubtitleWord[]>()
  script.forEach((t, i) => {
    const a = matchedAsr[i]!
    const { start, end } = times[i]!
    const word: SubtitleWord = {
      start,
      end,
      word: t.text,
      alignmentStatus: 'estimated',
      engine: 'script-align'
    }
    if (a >= 0) {
      word.rawStart = asr[a]!.start
      word.rawEnd = asr[a]!.end
    } else {
      word.reviewReasons = ['script_time_interpolated']
      if (overlapping.has(i)) word.reviewReasons.push('script_time_overlap')
    }
    const list = byLine.get(t.lineIndex) ?? []
    list.push(word)
    byLine.set(t.lineIndex, list)
  })

  const lines: SubtitleLine[] = []
  for (const [, words] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push({
      start: Math.min(...words.map(w => w.start)),
      end: Math.max(...words.map(w => w.end)),
      text: displayTextFromSubtitleWords(words),
      words
    })
  }
  return { ok: true, lines, stats: { ...baseStats, matched, interpolated } }
}
