/**
 * 단어 블록 시간 구간 안에서 경계 시각에 따라 문자열을 나눈다 (미디어 축 초).
 * 문자 단위 비율 분할 — 한글·라틴 모두 `Array.from` 기준(대부분 음절 단위).
 */
export function splitWordTextAtMediaCut(
  text: string,
  wordStart: number,
  wordEnd: number,
  cutSec: number
): { left: string; right: string } {
  const g = Array.from(text)
  const n = g.length
  if (n === 0) return { left: '', right: '' }
  const lo = Math.min(wordStart, wordEnd)
  const hi = Math.max(wordStart, wordEnd)
  const dur = hi - lo
  if (dur < 1e-9) return { left: '', right: text }
  let t = (cutSec - lo) / dur
  t = Math.max(0, Math.min(1, t))
  const idx = Math.round(t * n)
  const i = Math.max(0, Math.min(n, idx))
  return { left: g.slice(0, i).join(''), right: g.slice(i).join('') }
}
