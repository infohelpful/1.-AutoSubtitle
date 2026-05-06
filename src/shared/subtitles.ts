import { SILENCE_PLACEHOLDER_TEXT } from './wordContract'

/** Python 사이드카(Faster-Whisper) 및 UI 공통 자막 줄 형식 */
export type SubtitleWord = {
  start: number
  end: number
  word: string
  /** true: gap-fill 등으로 삽입된 무음 구간(표시용 `word`는 보통 `??`) */
  isSilence?: boolean
}

export type SubtitleLine = {
  start: number
  end: number
  text: string
  words?: SubtitleWord[]
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** 사이드카 JSON `subtitles` 배열을 `{ start, end, text }[]` 로 정규화 */
export function parseSubtitleLines(raw: unknown): SubtitleLine[] {
  if (!Array.isArray(raw)) return []
  const out: SubtitleLine[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const start = Number(item.start)
    const end = Number(item.end)
    const text = typeof item.text === 'string' ? item.text : ''
    const wordsRaw = Array.isArray(item.words) ? item.words : []
    const words: SubtitleWord[] = []
    for (const w of wordsRaw) {
      if (!isRecord(w)) continue
      const ws = Number(w.start)
      const we = Number(w.end)
      const ww = typeof w.word === 'string' ? w.word : ''
      const isSilence =
        w.isSilence === true ||
        (typeof (w as { is_silence?: unknown }).is_silence === 'boolean' &&
          (w as { is_silence?: boolean }).is_silence === true)
      if (!Number.isFinite(ws) || !Number.isFinite(we)) continue
      if (ww.trim().length === 0 && !isSilence) continue
      const tw = ww.trim()
      const entry: SubtitleWord = {
        start: ws,
        end: we,
        word: isSilence ? SILENCE_PLACEHOLDER_TEXT : tw.length > 0 ? tw : '??'
      }
      if (isSilence) entry.isSilence = true
      words.push(entry)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    out.push({ start, end, text, words })
  }
  return out
}
