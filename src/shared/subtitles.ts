/** Python 사이드카(Faster-Whisper) 및 UI 공통 자막 줄 형식 */
export type SubtitleWord = {
  start: number
  end: number
  word: string
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
      if (!Number.isFinite(ws) || !Number.isFinite(we) || ww.trim().length === 0) continue
      words.push({ start: ws, end: we, word: ww.trim() })
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    out.push({ start, end, text, words })
  }
  return out
}
