import type { SubtitleRow, Word } from './components/vrewPeaksEditor/types'

const EPS = 1e-4

/** Scalar-aware trim from start: drop first `n` Unicode scalar values */
function sliceCharsStart(text: string, dropCount: number): string {
  if (dropCount <= 0) return text
  const chars = [...text]
  return chars.slice(dropCount).join('')
}

function sliceCharsEnd(text: string, dropCount: number): string {
  if (dropCount <= 0) return text
  const chars = [...text]
  if (dropCount >= chars.length) return ''
  return chars.slice(0, chars.length - dropCount).join('')
}

/**
 * Apply a single [cutStart, cutEnd) removal on the timeline to one word.
 * Returns 0, 1, or 2 words. Empty / invalid results are filtered by caller.
 */
function cutSingleWord(w: Word, cs: number, ce: number): Word[] {
  const ws = w.start
  const we = w.end
  if (!(ce - cs > EPS) || !(we - ws > EPS)) return [w]
  if (ce <= ws + EPS || cs >= we - EPS) return [w]

  const o0 = Math.max(ws, cs)
  const o1 = Math.min(we, ce)
  if (o1 - o0 < EPS) return [w]

  // Fully inside cut
  if (cs <= ws + EPS && ce >= we - EPS) return []

  const dur = we - ws
  const chars = [...w.text]
  if (chars.length === 0) {
    if (o0 > ws + EPS && o1 < we - EPS) {
      return [
        { ...w, start: ws, end: o0, text: '' },
        { ...w, start: o1, end: we, text: '' }
      ]
    }
    if (o0 <= ws + EPS && o1 < we - EPS) return [{ ...w, start: o1, end: we, text: '' }]
    if (o0 > ws + EPS && o1 >= we - EPS) return [{ ...w, start: ws, end: o0, text: '' }]
    return [w]
  }

  // Prefix / start overlap: keeps [o1, we]
  if (o0 <= ws + EPS && o1 < we - EPS) {
    const removed = o1 - ws
    const ratio = removed / dur
    const n = Math.min(chars.length, Math.max(0, Math.round(chars.length * ratio)))
    const rest = sliceCharsStart(w.text, n).trim()
    if (!rest) return []
    return [{ ...w, start: o1, end: we, text: rest }]
  }

  // Suffix / end overlap: keeps [ws, o0]
  if (o0 > ws + EPS && o1 >= we - EPS) {
    const removed = we - o0
    const ratio = removed / dur
    const n = Math.min(chars.length, Math.max(0, Math.round(chars.length * ratio)))
    const rest = sliceCharsEnd(w.text, n).trim()
    if (!rest) return []
    return [{ ...w, start: ws, end: o0, text: rest }]
  }

  // Strict middle: split into two words
  if (o0 > ws + EPS && o1 < we - EPS) {
    const leftRatio = (o0 - ws) / dur
    const mid = Math.min(chars.length, Math.max(0, Math.round(chars.length * leftRatio)))
    const leftText = chars.slice(0, mid).join('').trim()
    const rightText = chars.slice(mid).join('').trim()
    const out: Word[] = []
    if (leftText && o0 - ws > EPS) out.push({ ...w, start: ws, end: o0, text: leftText })
    if (rightText && we - o1 > EPS) out.push({ ...w, start: o1, end: we, text: rightText })
    return out
  }

  return [w]
}

function renumberRowWords(row: SubtitleRow, lineIndex: number): SubtitleRow {
  const words = row.words.map((w, wi) => ({
    ...w,
    id: lineIndex * 65536 + wi
  }))
  return { ...row, words }
}

/**
 * 모든 줄에 대해 글로벌 타임라인 컷을 적용하고, 줄별 단어 id 를 재부여한다.
 */
export function applyTimeRangeCutToVrewRows(rows: SubtitleRow[], cutStart: number, cutEnd: number): SubtitleRow[] {
  const cs = Math.min(cutStart, cutEnd)
  const ce = Math.max(cutStart, cutEnd)
  const delta = ce - cs
  if (!(delta > EPS)) return rows

  const trimmed = rows.map((row, lineIndex) => {
    const nextWords: Word[] = []
    for (const w of row.words) {
      const parts = cutSingleWord(w, cs, ce)
      for (const p of parts) {
        if (p.end - p.start > EPS && p.text.trim().length > 0) nextWords.push(p)
      }
    }
    const sorted = [...nextWords].sort((a, b) => a.start - b.start)
    const lineText = sorted.map((w) => w.text).join(' ').trim()
    return renumberRowWords({ ...row, words: sorted, lineText }, lineIndex)
  })

  /** 삭제 구간 뒤의 모든 단어를 편집 타임라인에서 앞으로 당김 — 파형·칹과 동일 축 */
  return trimmed.map((row, lineIndex) => {
    const shifted = row.words
      .map((w) => {
        const ns = w.start >= ce - 1e-6 ? w.start - delta : w.start
        const ne = w.end >= ce - 1e-6 ? w.end - delta : w.end
        return { ...w, start: ns, end: ne }
      })
      .filter((w) => w.end - w.start > EPS && w.text.trim().length > 0)
    const sorted = [...shifted].sort((a, b) => a.start - b.start)
    const lineText = sorted.map((w) => w.text).join(' ').trim()
    return renumberRowWords({ ...row, words: sorted, lineText }, lineIndex)
  })
}
