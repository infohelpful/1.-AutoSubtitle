import type { SubtitleLine } from './subtitles'

const SUBTITLE_ROW_LEAD_SEC = 0.6

export type SubtitlePresentationSpan = { index: number; start: number; end: number }
const cache = new WeakMap<readonly SubtitleLine[], SubtitlePresentationSpan[]>()

/** 살아 있는 단어가 전부 무음 더미(`--`)인 줄 — 추출 후 무음 확인이 만드는 "무음 전용 줄". */
function isSilenceOnlyRow(line: SubtitleLine): boolean {
  const alive = line.words?.filter(word => !word.isDeleted)
  return !!alive?.length && alive.every(word => word.isSilence === true)
}

/** `[start, end)` 에서 `blockers`(정렬·병합된 구간)를 뺀 조각들. */
function subtractIntervals(start: number, end: number, blockers: readonly { start: number; end: number }[]) {
  const pieces: { start: number; end: number }[] = []
  let cursor = start
  for (const b of blockers) {
    if (b.end <= cursor) continue
    if (b.start >= end) break
    if (b.start > cursor) pieces.push({ start: cursor, end: Math.min(b.start, end) })
    cursor = Math.max(cursor, b.end)
    if (cursor >= end) break
  }
  if (cursor < end) pieces.push({ start: cursor, end })
  return pieces.filter(p => p.end - p.start > 1e-6)
}

/** Display boundaries only. Word/audio timestamps remain on the original media axis. */
export function subtitlePresentationSpans(lines: readonly SubtitleLine[]): SubtitlePresentationSpan[] {
  const cached = cache.get(lines)
  if (cached) return cached
  const base = lines.flatMap((line, index) => {
    if (line.isDeleted || (line.words?.length && line.words.every(word => word.isDeleted))) return []
    if (!Number.isFinite(line.start) || !Number.isFinite(line.end)) return []
    const visible = line.words?.filter(word => !word.isDeleted)
    const silenceOnly = isSilenceOnlyRow(line)
    // A trailing unclassified audio chip belongs in the previous editor row,
    // but it must not keep that row's caption visible through the audio gap.
    const lastSpeechEnd = !silenceOnly && visible?.length
      ? [...visible].reverse().find(word => !word.isSilence)?.end
      : undefined
    const captionEnd = lastSpeechEnd !== undefined &&
      visible?.at(-1)?.isSilence && visible.at(-1)?.gapKind === 'unclassified'
      ? Math.min(line.end, lastSpeechEnd)
      : line.end
    // Older projects can keep stale row bounds after a word deletion.
    if (visible?.length && line.words?.some(word => word.isDeleted)) {
      return [{ index, silenceOnly, start: Math.min(...visible.map(word => word.start)),
        end: Math.min(captionEnd, Math.max(...visible.map(word => word.end))) }]
    }
    // 줄 시작(Whisper 구간 시작)이 첫 발화 단어보다 훨씬 앞서면, 말하기 전 침묵 동안 다음 문장 자막이 먼저 떠 있게 된다.
    // 첫 발화 단어 바로 앞(SUBTITLE_ROW_LEAD_SEC)부터 보이게 한다.
    if (!silenceOnly) {
      const speechStarts = line.words
        ?.filter(word => !word.isDeleted && !word.isSilence && word.word.trim() !== '' && word.word.trim() !== '--')
        .map(word => word.start)
        .filter(Number.isFinite)
      if (speechStarts?.length) {
        const first = Math.min(...speechStarts)
        if (line.start < first - SUBTITLE_ROW_LEAD_SEC) {
          return [{ index, silenceOnly, start: first - SUBTITLE_ROW_LEAD_SEC, end: captionEnd }]
        }
      }
    }
    return [{ index, silenceOnly, start: line.start, end: captionEnd }]
  })

  // 무음 전용 줄은 음성 줄과 시간이 겹칠 수 있다(줄 경계가 단어보다 일찍 시작하는 경우).
  // 겹친 구간에서는 음성 줄이 이긴다 — 그렇지 않으면 말하는 도중 자막·하이라이트가 무음 줄로 넘어가 꺼진다.
  const speechBlockers: { start: number; end: number }[] = []
  for (const s of base.filter(row => !row.silenceOnly).sort((a, b) => a.start - b.start)) {
    const last = speechBlockers[speechBlockers.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else speechBlockers.push({ start: s.start, end: s.end })
  }
  const spans: SubtitlePresentationSpan[] = []
  for (const row of base) {
    if (!row.silenceOnly) {
      spans.push({ index: row.index, start: row.start, end: row.end })
      continue
    }
    for (const piece of subtractIntervals(row.start, row.end, speechBlockers)) {
      spans.push({ index: row.index, start: piece.start, end: piece.end })
    }
  }
  spans.sort((a, b) => a.start - b.start || a.index - b.index)
  for (let i = 0; i + 1 < spans.length; i++) {
    const current = spans[i]
    const next = spans[i + 1]
    const importedCue = lines[current.index].words?.some(word => word.engine === 'srt-import')
    const lastWord = lines[current.index].words?.filter(word => !word.isDeleted).at(-1)
    const hasTrailingAudio = lastWord?.isSilence && lastWord.gapKind === 'unclassified'
    // Keep explicit cue ends and real pauses. Only smooth short ASR row gaps;
    // otherwise an intro without captions inherits the preceding sentence.
    if (next.start <= current.end || (!importedCue && !hasTrailingAudio && next.start - current.end <= SUBTITLE_ROW_LEAD_SEC)) {
      current.end = next.start
    }
  }
  cache.set(lines, spans)
  return spans
}

export function pickActiveSubtitleIndex(lines: readonly SubtitleLine[], time: number): number | null {
  if (!Number.isFinite(time)) return null
  const spans = subtitlePresentationSpans(lines)
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid].start <= time) lo = mid + 1
    else hi = mid - 1
  }
  const span = spans[hi]
  return span && time < span.end ? span.index : null
}

export function subtitlePresentationEnd(lines: readonly SubtitleLine[], index: number): number {
  return subtitlePresentationSpans(lines).find(span => span.index === index)?.end ?? lines[index]?.end ?? 0
}

export function subtitlePresentationStart(lines: readonly SubtitleLine[], index: number): number {
  return subtitlePresentationSpans(lines).find(span => span.index === index)?.start ?? lines[index]?.start ?? 0
}
