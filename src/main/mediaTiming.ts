import { spawnSync } from 'node:child_process'

export type MediaTiming = {
  duration: number
  sourceOriginSec: number
  width: number
  height: number
  hasAudio: boolean
  frameRate: string
}

/** One common source epoch for audio and video, including nonzero stream PTS. */
export function probeMediaTiming(ffprobePath: string, inputPath: string): MediaTiming {
  const result = spawnSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', inputPath], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  })
  if (result.error || result.status !== 0) throw new Error(`Media probe failed: ${result.error?.message ?? result.stderr}`)
  const data = JSON.parse(result.stdout)
  const video = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'video')
  if (!video) throw new Error('Video stream is missing')
  const origin = Number(video.start_time ?? data.format?.start_time ?? 0)
  const streamDuration = Number(video.duration)
  const formatEnd = Number(data.format?.start_time ?? 0) + Number(data.format?.duration)
  // Matroska DURATION is the stream's end timestamp, including a nonzero start.
  const tagged = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(video.tags?.DURATION ?? ''))
  const taggedEnd = tagged ? Number(tagged[1]) * 3600 + Number(tagged[2]) * 60 + Number(tagged[3]) : NaN
  const matroska = String(data.format?.format_name).split(',').some((name) => name === 'matroska' || name === 'webm')
  const fallbackEnd = matroska ? Number(data.format?.duration) : formatEnd
  const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration
    : Number.isFinite(taggedEnd) ? taggedEnd - origin : fallbackEnd - origin
  if (!Number.isFinite(origin) || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid media duration or origin')
  const rotation = Number(video.side_data_list?.find((s: { rotation?: number }) => s.rotation != null)?.rotation ?? video.tags?.rotate ?? 0)
  const rotated = Math.abs(rotation % 180) === 90
  return {
    duration, sourceOriginSec: origin,
    width: Number(rotated ? video.height : video.width),
    height: Number(rotated ? video.width : video.height),
    hasAudio: data.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'),
    frameRate: String(video.avg_frame_rate || video.r_frame_rate || '30/1')
  }
}
