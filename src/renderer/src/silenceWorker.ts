/// <reference lib="webworker" />

type WorkerWord = {
  start: number
  end: number
  word: string
  isSilence?: boolean
}

type WorkerLine = {
  start: number
  end: number
  text: string
  words?: WorkerWord[]
}

type SilenceWorkerRequest = {
  lines: WorkerLine[]
  waveformData: number[]
  sampleRate: number
}

type SilenceWorkerResponse = {
  lines: WorkerLine[]
  stats?: {
    avgAmp: number
    threshold: number
    splitWordCount: number
    createdSilenceBlocks: number
    scannedWordCount: number
    longWordCount: number
  }
}

const HARD_MIN_THRESHOLD = 0.0316 // ~= -30dB
const MIN_SILENCE_SEC = 0.3
const PADDING_SEC = 0.1
const EPS = 1e-6
function isSilenceText(text: string | undefined): boolean {
  if (!text) return true
  const trimmed = text.trim()
  return trimmed === '' || trimmed === '-' || trimmed === '[무음]'
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function splitWordBySilenceRuns(
  w: WorkerWord,
  waveformData: number[],
  sampleRate: number,
  threshold: number
): WorkerWord[] {
  if (!(w.end > w.start + EPS)) return [w]
  if (!Number.isFinite(sampleRate) || sampleRate <= 1) return [w]

  const startIdx = clamp(Math.floor(w.start * sampleRate), 0, waveformData.length - 1)
  const endIdx = clamp(Math.ceil(w.end * sampleRate), 0, waveformData.length - 1)
  if (endIdx <= startIdx) return [w]

  const minSilentSamples = Math.max(1, Math.floor(MIN_SILENCE_SEC * sampleRate))
  const runs: Array<{ s: number; e: number }> = []

  let runStart = -1
  for (let i = startIdx; i <= endIdx; i += 1) {
    const amp = Math.abs(waveformData[i] ?? 0)
    if (amp < threshold) {
      if (runStart < 0) runStart = i
      continue
    }
    if (runStart >= 0) {
      const runEnd = i - 1
      if (runEnd - runStart + 1 >= minSilentSamples) runs.push({ s: runStart, e: runEnd })
      runStart = -1
    }
  }
  if (runStart >= 0) {
    const runEnd = endIdx
    if (runEnd - runStart + 1 >= minSilentSamples) runs.push({ s: runStart, e: runEnd })
  }

  if (runs.length === 0) return [w]

  const parts: WorkerWord[] = []
  let cursor = w.start
  for (const run of runs) {
    const rawStart = run.s / sampleRate
    const rawEnd = (run.e + 1) / sampleRate
    const silentStart = clamp(rawStart + PADDING_SEC, w.start, w.end)
    const silentEnd = clamp(rawEnd - PADDING_SEC, w.start, w.end)
    if (!(silentEnd > silentStart + EPS)) continue

    if (silentStart > cursor + EPS) {
      parts.push({
        start: cursor,
        end: silentStart,
        word: w.word,
        ...(w.isSilence ? { isSilence: true } : {})
      })
    }
    parts.push({
      start: silentStart,
      end: silentEnd,
      word: '',
      isSilence: true
    })
    cursor = silentEnd
  }

  if (cursor < w.end - EPS) {
    parts.push({
      start: cursor,
      end: w.end,
      word: w.word,
      ...(w.isSilence ? { isSilence: true } : {})
    })
  }

  return parts.length > 0 ? parts : [w]
}

self.onmessage = (event: MessageEvent<SilenceWorkerRequest>): void => {
  const { lines, waveformData, sampleRate } = event.data
  if (!Array.isArray(lines) || !Array.isArray(waveformData) || waveformData.length === 0) {
    ;(self as DedicatedWorkerGlobalScope).postMessage({ lines } satisfies SilenceWorkerResponse)
    return
  }

  const avgAmp =
    waveformData.reduce((acc, v) => acc + Math.abs(v), 0) / Math.max(1, waveformData.length)
  const threshold = Math.max(avgAmp * 1.2, HARD_MIN_THRESHOLD)
  let splitWordCount = 0
  let createdSilenceBlocks = 0
  let scannedWordCount = 0
  let longWordCount = 0

  const nextLines = lines.map((line) => {
    const ws = Array.isArray(line.words) ? line.words : []
    if (ws.length === 0) return line
    const outWords: WorkerWord[] = []
    for (const w of ws) {
      if (w.isSilence || isSilenceText(w.word)) {
        outWords.push({
          ...w,
          word: '',
          isSilence: true
        })
        continue
      }
      scannedWordCount += 1
      if (w.end - w.start >= MIN_SILENCE_SEC) longWordCount += 1
      const split = splitWordBySilenceRuns(w, waveformData, sampleRate, threshold)
      if (split.length > 1) {
        splitWordCount += 1
        createdSilenceBlocks += split.filter((x) => x.isSilence).length
      }
      outWords.push(...split)
    }
    return {
      ...line,
      words: outWords
    }
  })

  ;(self as DedicatedWorkerGlobalScope).postMessage({
    lines: nextLines,
    stats: {
      avgAmp,
      threshold,
      splitWordCount,
      createdSilenceBlocks,
      scannedWordCount,
      longWordCount
    }
  } satisfies SilenceWorkerResponse)
}

