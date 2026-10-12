import { execFile, spawnSync } from 'node:child_process'

export type MediaTiming = {
  duration: number
  sourceOriginSec: number
  width: number
  height: number
  hasAudio: boolean
  frameRate: string
  needsPreviewNormalization: boolean
}

/** One common source epoch for audio and video, including nonzero stream PTS. */
export function probeMediaTiming(ffprobePath: string, inputPath: string): MediaTiming {
  const result = spawnSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', inputPath], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  })
  if (result.error || result.status !== 0) throw new Error(`Media probe failed: ${result.error?.message ?? result.stderr}`)
  return parseMediaTiming(result.stdout)
}

/** Keep the Electron event loop responsive while probing slow/damaged media. */
export function probeMediaTimingAsync(ffprobePath: string, inputPath: string, signal?: AbortSignal): Promise<MediaTiming> {
  if (signal?.aborted) return Promise.reject(new Error('미디어 준비가 취소됐습니다.'))
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', inputPath], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, signal,
      killSignal: 'SIGKILL'
    }, (error, stdout, stderr) => {
      if (signal?.aborted) { reject(new Error('미디어 준비가 취소됐습니다.')); return }
      if (error) { reject(new Error(`Media probe failed: ${error.message || stderr}`)); return }
      try { resolve(parseMediaTiming(stdout)) } catch (error) { reject(error) }
    })
  })
}

function parseMediaTiming(json: string): MediaTiming {
  const data = JSON.parse(json)
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
  const [sarNumerator, sarDenominator] = String(video.sample_aspect_ratio ?? '1:1').split(':').map(Number)
  const sar = sarNumerator > 0 && sarDenominator > 0 ? sarNumerator / sarDenominator : 1
  // Work in display pixels, as HTMLVideoElement does. Normalize to even square
  // pixels for yuv420p before placing the subtitle layer on this same canvas.
  // Chromium expands the short pixel dimension instead of shrinking the other.
  const displayWidth = Number(video.width) * Math.max(1, sar)
  const displayHeight = Number(video.height) / Math.min(1, sar)
  const even = (size: number): number => Math.max(2, Math.round(size / 2) * 2)
  return {
    duration, sourceOriginSec: origin,
    width: even(rotated ? displayHeight : displayWidth),
    height: even(rotated ? displayWidth : displayHeight),
    hasAudio: data.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'),
    frameRate: String(video.avg_frame_rate || video.r_frame_rate || '30/1'),
    needsPreviewNormalization: Math.abs(origin) > .000001 ||
      Number(data.format?.start_time ?? origin) < origin - .001 || fallbackEnd - origin > duration + .1
  }
}
