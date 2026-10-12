/** All prepared media uses zero at the first video PTS, matching stored word times. */
export type PreparedMedia = {
  audioPath: string
  previewPath: string
  duration: number
  sourceOriginSec: number
  hasAudio: boolean
}
export type PreparedMediaResult = { ok: true; media: PreparedMedia } | { ok: false; reason: string }
