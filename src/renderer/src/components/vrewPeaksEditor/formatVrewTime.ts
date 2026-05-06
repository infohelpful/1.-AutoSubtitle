/** Format seconds as `MM:SS.mm` (e.g. 00:35.58) — Vrew-style compact cue time */
export function formatVrewTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00.00'
  const clamped = Math.max(0, seconds)
  const m = Math.floor(clamped / 60)
  const s = clamped - m * 60
  const mm = String(m).padStart(2, '0')
  const ss = s.toFixed(2).padStart(5, '0')
  return `${mm}:${ss}`
}
