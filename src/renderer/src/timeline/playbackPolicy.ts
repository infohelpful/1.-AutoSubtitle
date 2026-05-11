/**
 * Phase 2 — 재생 스케줄 소스 전환.
 * `.env` 에 `VITE_WORD_PLAYBACK=1` → 단어 기반(`buildScheduledMediaSegmentsFromSubtitleWords`).
 * 미설정 또는 그 외 값 → 기존 EDL 클립(`buildScheduledMediaSegments`).
 */
export const USE_WORD_BASED_PLAYBACK_SCHEDULE = import.meta.env.VITE_WORD_PLAYBACK === '1'
