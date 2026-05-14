/**
 * 자막 추출 직후: Whisper 단어 [start,end] 안에서 피크 기준 무음 구간을
 * `--`(isSilence) 블록으로 분리한다. 선행·중간 무음 모두 동일 게이트·최소 길이로 탐지한다.
 * 1차로 생긴 `…` 조각도 **다음 패스에서 다시 스캔**한다(최대 12패스/줄). `…`는 픽셀 게이트를
 * `continuationSplitGateRaiseDb`만큼 올리고, 각 **말 런**은 `voiceOnsetDbfs`+연속 픽셀로 선행을 `--`로 잘라
 * 실제로 들리는 구간에만 단어가 붙도록 한다.
 * 파형 툴팁과 동일한 dBFS 스케일(±127 → 20·log10).
 */
import type { JsonWaveformData } from '../../../shared/waveformJson'
import { displayTextFromSubtitleWords, type SubtitleLine, type SubtitleWord } from '../../../shared/subtitles'
import { DEFAULT_GAP_THRESHOLD_SEC, SILENCE_PLACEHOLDER_TEXT } from '../../../shared/wordContract'
import { wfLog } from '../components/vrewPeaksEditor/waveformDebugLog'
import { resolvePeaksTimelineMetrics, mediaSecondsToPeakPixelRange } from '../waveform/peakPixelMapping'

const DBFS_GATE_DEFAULT = -40
/** 분할 말 조각 중 원문을 붙일 때: 이 dBFS(픽셀별 max)를 넘는 첫 구간에 붙인다. 게이트(-40)보다 엄격해 잔향·노이즈 덩어리는 `…`로 둔다. */
const WORD_ANCHOR_DBFS_DEFAULT = -32
const EPS = 1e-5
/** 같은 Whisper 단어 안에서 무음 뒤 이어지는 말 조각 표시 */
const WORD_CONTINUATION_MARKER = '\u2026'
/**
 * `…` 조각은 바닥 잡음이 -40을 살짝 넘어 ‘말’로만 묶이는 경우가 많아,
 * 말/무음 **분류용** 게이트만 기본보다 이 값만큼 올린다(덜 음수 = 말로 인정하려면 더 커야 함).
 */
const CONTINUATION_SPLIT_GATE_RAISE_DB_DEFAULT = 10
/**
 * 말(비무음) 런 안에서 **실제로 들리는** 음성 시작: 이 dBFS를 `minConsecutive`픽셀 연속 초과한
 * 첫 픽셀의 왼쪽 경계 시각. 피크 런(-40 등)만으로는 ‘평평’으로 보이는 구간이 말로 남는 경우를 잘라낸다.
 */
const VOICE_ONSET_DBFS_DEFAULT = -22
const VOICE_ONSET_MIN_CONSECUTIVE_PIXELS_DEFAULT = 2
/** voice onset 분할 후 남는 말 조각이 이보다 짧으면 분할 안 함(꼬리만 원문·앞은 `--`로 무음에 붙는 현상 방지) */
const VOICE_ONSET_MIN_TAIL_SEC = 0.1
const VOICE_ONSET_MIN_TAIL_FRAC_OF_RUN = 0.28

function peakDbfsAtColumn(data: readonly number[], col: number): number {
  const i = col * 2
  const mn = (data[i] ?? 0) / 127
  const mx = (data[i + 1] ?? 0) / 127
  const amp = Math.max(Math.abs(mn), Math.abs(mx))
  if (amp < 1e-8) return -100
  const db = 20 * Math.log10(amp)
  if (!Number.isFinite(db)) return -100
  return Math.max(-120, Math.min(0, db))
}

function timeLeftEdgeOfPixel(p: number, pixelCount: number, durationSec: number): number {
  return (p / pixelCount) * durationSec
}

function isSpeechColumn(data: readonly number[], p: number, dbfsGate: number): boolean {
  return peakDbfsAtColumn(data, p) > dbfsGate
}

/** [ws,we] 안에서 `voiceDbfs` 를 `minConsecutive` 픽셀 연속 초과하는 첫 구간의 시작 시각(초) */
function firstSustainedVoiceOnsetSec(
  data: readonly number[],
  pixelCount: number,
  durationSec: number,
  ws: number,
  we: number,
  voiceDbfs: number,
  minConsecutive: number
): number | null {
  if (!(we > ws + EPS) || minConsecutive < 1) return null
  const { startPixel, endPixel } = mediaSecondsToPeakPixelRange(
    { data, pixelCount, durationSec },
    ws,
    we
  )
  let run = 0
  for (let p = startPixel; p < endPixel; p += 1) {
    if (peakDbfsAtColumn(data, p) > voiceDbfs + EPS) {
      run += 1
      if (run >= minConsecutive) {
        const pOnset = p - minConsecutive + 1
        return timeLeftEdgeOfPixel(pOnset, pixelCount, durationSec)
      }
    } else {
      run = 0
    }
  }
  return null
}

/** `…` 조각만 픽셀 말/무음 경계를 더 엄격히(잡음 구간을 무음으로). */
function splitPixelDbfsGateForWord(
  w: SubtitleWord,
  dbfsGate: number,
  continuationGateRaiseDb: number
): number {
  if (w.word !== WORD_CONTINUATION_MARKER) return dbfsGate
  const raised = dbfsGate + continuationGateRaiseDb
  return Math.max(-58, Math.min(-20, raised))
}

function maxDbfsInTimeRange(
  data: readonly number[],
  pixelCount: number,
  durationSec: number,
  t0: number,
  t1: number
): number {
  const { startPixel, endPixel } = mediaSecondsToPeakPixelRange(
    { data, pixelCount, durationSec },
    t0,
    t1
  )
  let m = -150
  for (let p = startPixel; p < endPixel; p += 1) {
    m = Math.max(m, peakDbfsAtColumn(data, p))
  }
  return m
}

/** 말 조각이 2개 이상이면, 원문은 `anchorDbfs`를 넘기는 조각 중 **피크 dBFS 최대**인 구간에 둔다(없으면 최대 dB 구간). */
function assignSpeechWordTextsByAnchor(
  segments: SubtitleWord[],
  w: SubtitleWord,
  data: readonly number[],
  pixelCount: number,
  durationSec: number,
  anchorDbfs: number
): SubtitleWord[] {
  const speechIdxs: number[] = []
  for (let si = 0; si < segments.length; si += 1) {
    if (segments[si]!.isSilence !== true) speechIdxs.push(si)
  }
  if (speechIdxs.length <= 1) return segments

  /** -32 넘는 조각이 여럿이면 ‘첫’이 아니라 에너지 최대인 조각에 원문(중간중간 등)을 둔다 */
  let anchorIdx = -1
  let bestAnchorDb = -200
  for (const si of speechIdxs) {
    const seg = segments[si]!
    const db = maxDbfsInTimeRange(data, pixelCount, durationSec, seg.start, seg.end)
    if (db > anchorDbfs + EPS && db > bestAnchorDb + EPS) {
      bestAnchorDb = db
      anchorIdx = si
    }
  }
  if (anchorIdx < 0) {
    anchorIdx = speechIdxs[0]!
    let bestDb = maxDbfsInTimeRange(data, pixelCount, durationSec, segments[anchorIdx]!.start, segments[anchorIdx]!.end)
    for (const si of speechIdxs.slice(1)) {
      const seg = segments[si]!
      const db = maxDbfsInTimeRange(data, pixelCount, durationSec, seg.start, seg.end)
      if (db > bestDb + EPS) {
        anchorIdx = si
        bestDb = db
      }
    }
  }

  return segments.map((seg, i) => {
    if (seg.isSilence === true) return seg
    const text = i === anchorIdx ? w.word : WORD_CONTINUATION_MARKER
    if (seg.word === text) return seg
    return { ...seg, word: text }
  })
}

function wordsSplitSignature(words: readonly SubtitleWord[]): string {
  return words
    .map((w) => {
      const del = w.isDeleted === true ? 1 : 0
      const sil = w.isSilence === true ? 1 : 0
      return `${w.start.toFixed(6)}|${w.end.toFixed(6)}|${sil}|${del}|${w.word}`
    })
    .join(';')
}

/** 한 줄의 단어 배열에 대해 비무음 단어만 한 번씩 피크 분할을 적용한다. */
function expandWordsOnePeakSilencePass(
  words: readonly SubtitleWord[],
  data: readonly number[],
  pixelCount: number,
  durationSec: number,
  dbfsGate: number,
  minLead: number,
  wordAnchorDbfs: number,
  continuationGateRaiseDb: number,
  voiceOnsetDbfs: number,
  voiceOnsetMinConsecutivePixels: number
): SubtitleWord[] {
  const next: SubtitleWord[] = []
  for (const w of words) {
    if (w.isDeleted === true) {
      next.push({ ...w })
      continue
    }
    if (w.isSilence === true) {
      next.push({ ...w })
      continue
    }

    const pieces = splitSingleWordByPeakSilenceRuns(
      w,
      data,
      pixelCount,
      durationSec,
      dbfsGate,
      minLead,
      wordAnchorDbfs,
      continuationGateRaiseDb,
      voiceOnsetDbfs,
      voiceOnsetMinConsecutivePixels
    )
    if (pieces == null) {
      const ws = Math.min(w.start, w.end)
      const we = Math.max(w.start, w.end)
      next.push({ ...w, start: ws, end: we })
    } else {
      next.push(...pieces)
    }
  }
  return next
}

/**
 * 단어 [ws,we] 구간을 피크로 분해한다.
 * - 무음 연속 구간이 `minLead` 미만이면 말 구간에 흡수(짧은 쉼은 자르지 않음).
 * - 남은 무음은 `--`.
 * - 말 조각이 여러 개면 원문은 `wordAnchorDbfs`를 넘는 첫 구간에만 두고, 나머지 말 조각은 `…`.
 * 말 런마다 `voiceOnsetDbfs`·연속 픽셀 기준으로 선행을 `--`로 한 번 더 잘라 실제 목소리 시작에 맞춘다.
 * @returns null 이면 원본 단어 한 덩어리 유지
 */
function splitSingleWordByPeakSilenceRuns(
  w: SubtitleWord,
  data: readonly number[],
  pixelCount: number,
  durationSec: number,
  dbfsGate: number,
  minLead: number,
  wordAnchorDbfs: number,
  continuationGateRaiseDb: number,
  voiceOnsetDbfs: number,
  voiceOnsetMinConsecutivePixels: number
): SubtitleWord[] | null {
  const ws = Math.min(w.start, w.end)
  const we = Math.max(w.start, w.end)
  if (!(we > ws + EPS)) return null

  const splitPxGate = splitPixelDbfsGateForWord(w, dbfsGate, continuationGateRaiseDb)

  const { startPixel, endPixel } = mediaSecondsToPeakPixelRange(
    { data, pixelCount, durationSec },
    ws,
    we
  )
  const n = endPixel - startPixel
  if (n <= 0) return null

  const sil = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) {
    const p = startPixel + i
    sil[i] = isSpeechColumn(data, p, splitPxGate) ? 0 : 1
  }

  let i = 0
  while (i < n) {
    if (sil[i] !== 1) {
      i += 1
      continue
    }
    const j = i
    while (i < n && sil[i] === 1) i += 1
    const t0 = timeLeftEdgeOfPixel(j + startPixel, pixelCount, durationSec)
    const t1 = timeLeftEdgeOfPixel(i + startPixel, pixelCount, durationSec)
    if (t1 - t0 < minLead - EPS) {
      for (let k = j; k < i; k += 1) sil[k] = 0
    }
  }

  type Run = { silent: boolean; p0: number; p1: number }
  const runs: Run[] = []
  let k = 0
  while (k < n) {
    const bit = sil[k]!
    const k0 = k
    while (k < n && sil[k] === bit) k += 1
    runs.push({ silent: bit === 1, p0: startPixel + k0, p1: startPixel + k })
  }

  const out: SubtitleWord[] = []
  let speechChunkIndex = 0

  for (const run of runs) {
    let t0 = timeLeftEdgeOfPixel(run.p0, pixelCount, durationSec)
    let t1 = timeLeftEdgeOfPixel(run.p1, pixelCount, durationSec)
    t0 = Math.max(ws, Math.min(we, t0))
    t1 = Math.max(ws, Math.min(we, t1))
    if (!(t1 > t0 + EPS)) continue

    if (run.silent) {
      out.push({
        start: t0,
        end: t1,
        word: SILENCE_PLACEHOLDER_TEXT,
        isSilence: true
      })
      continue
    }

    let segStart = speechChunkIndex === 0 && out.length === 0 ? ws : Math.max(ws, t0)
    const segEnd = Math.min(we, t1)

    const voiceOnset = firstSustainedVoiceOnsetSec(
      data,
      pixelCount,
      durationSec,
      segStart,
      segEnd,
      voiceOnsetDbfs,
      voiceOnsetMinConsecutivePixels
    )
    const runDur = segEnd - segStart
    const minTailAfterOnset = Math.max(
      VOICE_ONSET_MIN_TAIL_SEC,
      VOICE_ONSET_MIN_TAIL_FRAC_OF_RUN * runDur
    )
    let onsetSplitAt: number | null = null
    if (
      voiceOnset != null &&
      voiceOnset > segStart + minLead - EPS &&
      voiceOnset < segEnd - EPS
    ) {
      const tailDur = segEnd - voiceOnset
      const headDb = maxDbfsInTimeRange(data, pixelCount, durationSec, segStart, voiceOnset)
      const tailDb = maxDbfsInTimeRange(data, pixelCount, durationSec, voiceOnset, segEnd)
      if (tailDur >= minTailAfterOnset - EPS && tailDb >= headDb - 1.5) {
        onsetSplitAt = voiceOnset
      }
    }
    if (onsetSplitAt != null) {
      out.push({
        start: segStart,
        end: onsetSplitAt,
        word: SILENCE_PLACEHOLDER_TEXT,
        isSilence: true
      })
      segStart = onsetSplitAt
    }

    if (!(segEnd > segStart + EPS)) continue

    const wordText = speechChunkIndex === 0 ? w.word : WORD_CONTINUATION_MARKER
    speechChunkIndex += 1
    out.push({
      ...w,
      start: segStart,
      end: segEnd,
      word: wordText
    })
  }

  if (out.length === 0) return null

  const hasSpeech = out.some((s) => s.isSilence !== true)
  if (!hasSpeech) {
    if (w.word === WORD_CONTINUATION_MARKER && we - ws >= minLead - EPS) {
      return [
        {
          start: ws,
          end: we,
          word: SILENCE_PLACEHOLDER_TEXT,
          isSilence: true
        }
      ]
    }
    return null
  }

  const outAnchored = assignSpeechWordTextsByAnchor(out, w, data, pixelCount, durationSec, wordAnchorDbfs)

  if (
    outAnchored.length === 1 &&
    outAnchored[0]!.isSilence !== true &&
    outAnchored[0]!.word === w.word &&
    Math.abs(outAnchored[0]!.start - ws) < 1e-3 &&
    Math.abs(outAnchored[0]!.end - we) < 1e-3
  ) {
    return null
  }

  return outAnchored
}

function rebuildLineText(words: readonly SubtitleWord[]): string {
  return displayTextFromSubtitleWords(words)
}

export type LeadingSilenceSplitOptions = {
  /** 이 dBFS 이하는 무음으로 본다 (파형 툴팁과 동일 스케일). 기본 -40 */
  dbfsGate?: number
  /** 무음을 단어로 쪼개려면 이 길이(초) 이상이어야 함. 기본 gap-fill 임계와 동일(0.2) */
  minLeadingSilenceSec?: number
  /**
   * 말 조각이 여러 개일 때 원문을 붙일 “실제 말” 구간: `anchorDbfs`를 넘는 조각 중 **에너지 최대**인 말 조각에만 원문을 둔다. 기본 -32 (게이트 -40보다 엄격).
   */
  wordAnchorDbfs?: number
  /**
   * `…` 조각만: `dbfsGate`보다 이 값(dB)만큼 **올린** 임계로 픽셀 말/무음을 나눈다(기본 10 → -30 근처).
   */
  continuationSplitGateRaiseDb?: number
  /**
   * 말(비무음) 런 앞부분을 `--`로 자를 때: 이 dBFS를 `voiceOnsetMinConsecutivePixels`만큼 연속 초과한
   * 첫 시각을 ‘실제 목소리 시작’으로 본다. 기본 -22.
   */
  voiceOnsetDbfs?: number
  /** `voiceOnsetDbfs` 판정 시 연속 픽셀 수. 기본 2 */
  voiceOnsetMinConsecutivePixels?: number
}

/**
 * 각 줄의 각 비무음 단어에 대해, 단어 내부의 피크 기준 무음(`minLeadingSilenceSec` 이상)을
 * `--` 로 분리하고, 말 조각이 여러 개면 원문은 `wordAnchorDbfs`를 넘는 첫 구간에만 둔다.
 */
export function splitLeadingSilenceInSubtitleLines(
  lines: readonly SubtitleLine[],
  wf: JsonWaveformData,
  mediaDurationHintSec: number,
  options?: LeadingSilenceSplitOptions
): SubtitleLine[] {
  const metrics = resolvePeaksTimelineMetrics(wf, mediaDurationHintSec)
  if (!metrics) return [...lines]

  const dbfsGate = options?.dbfsGate ?? DBFS_GATE_DEFAULT
  const minLead = options?.minLeadingSilenceSec ?? DEFAULT_GAP_THRESHOLD_SEC
  const wordAnchorDbfs = options?.wordAnchorDbfs ?? WORD_ANCHOR_DBFS_DEFAULT
  const continuationGateRaiseDb =
    options?.continuationSplitGateRaiseDb ?? CONTINUATION_SPLIT_GATE_RAISE_DB_DEFAULT
  const voiceOnsetDbfs = options?.voiceOnsetDbfs ?? VOICE_ONSET_DBFS_DEFAULT
  const voiceOnsetMinConsecutivePixels =
    options?.voiceOnsetMinConsecutivePixels ?? VOICE_ONSET_MIN_CONSECUTIVE_PIXELS_DEFAULT
  const { data, pixelCount, durationSec } = metrics

  let maxExpandRounds = 1

  const outLines = lines.map((line) => {
    if (!line.words || line.words.length === 0) return line

    const sorted = [...line.words].sort((a, b) => a.start - b.start || a.end - b.end)
    let cur = sorted
    let rounds = 0
    for (let r = 0; r < 12; r++) {
      const nxt = expandWordsOnePeakSilencePass(
        cur,
        data,
        pixelCount,
        durationSec,
        dbfsGate,
        minLead,
        wordAnchorDbfs,
        continuationGateRaiseDb,
        voiceOnsetDbfs,
        voiceOnsetMinConsecutivePixels
      )
      rounds = r + 1
      if (wordsSplitSignature(nxt) === wordsSplitSignature(cur)) {
        cur = nxt
        break
      }
      cur = nxt
    }
    maxExpandRounds = Math.max(maxExpandRounds, rounds)

    const next = cur

    if (next.length === sorted.length) {
      const same = next.every((nw, i) => {
        const ow = sorted[i]!
        return nw.start === ow.start && nw.end === ow.end && nw.word === ow.word && nw.isSilence === ow.isSilence
      })
      if (same) return line
    }

    const lo = Math.min(...next.map((x) => x.start))
    const hi = Math.max(...next.map((x) => x.end))
    return {
      ...line,
      start: lo,
      end: hi,
      words: next,
      text: rebuildLineText(next) || line.text
    }
  })

  wfLog('perf', '피크 무음 분할(다패스) 요약', {
    lineCount: lines.length,
    maxExpandRounds,
    continuationGateRaiseDb,
    voiceOnsetDbfs,
    voiceOnsetMinConsecutivePixels,
    note: '말 런 선행은 voiceOnsetDbfs+연속픽셀으로 -- 재절단'
  })

  return outLines
}
