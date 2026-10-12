import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat, rename, unlink, readdir, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { probeMediaTimingAsync } from './mediaTiming'
import type { PreparedMedia } from '../shared/preparedMedia'

// Bump when the common epoch, decode parameters, or preview container changes.
export const PREPARED_MEDIA_VERSION = 'video-epoch-v1-48k-stereo'
type PreparationJob = { promise: Promise<PreparedMedia>; controller: AbortController; consumers: Set<symbol> }
const pending = new Map<string, PreparationJob>()
export function stopPreparingMedia(): void { for (const job of pending.values()) job.controller.abort() }

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('미디어 준비가 취소됐습니다.')
}

/** One viewer leaving must not cancel an export/alignment using the same decode. */
function consume(job: PreparationJob, signal?: AbortSignal): Promise<PreparedMedia> {
  const token = Symbol()
  job.consumers.add(token)
  return new Promise((resolveJob, reject) => {
    let finished = false
    const finish = (cancelled: boolean, value?: PreparedMedia, error?: unknown) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', abort)
      job.consumers.delete(token)
      if (cancelled && job.consumers.size === 0) job.controller.abort()
      if (cancelled) reject(new Error('미디어 준비가 취소됐습니다.'))
      else if (error) reject(error)
      else resolveJob(value!)
    }
    const abort = () => finish(true)
    signal?.addEventListener('abort', abort, { once: true })
    job.promise.then(value => finish(false, value), error => finish(false, undefined, error))
    if (signal?.aborted) abort()
  })
}

/** Delete only our named, unused cache files; unrelated files and source media are never touched. */
export async function prunePreparedMediaCache(cacheDir: string, maxAgeMs = 30 * 24 * 60 * 60_000): Promise<void> {
  const entries = await readdir(cacheDir, { withFileTypes: true }).catch(() => [])
  const now = Date.now()
  for (const entry of entries) {
    const match = /^([a-f0-9]{64})(\.[a-f0-9-]{36})?\.(wav|mp4)$/.exec(entry.name)
    if (!entry.isFile() || !match || pending.has(join(cacheDir, match[1]))) continue
    const path = join(cacheDir, entry.name)
    try {
      const info = await stat(path)
      if (now - info.atimeMs > (match[2] ? Math.min(maxAgeMs, 24 * 60 * 60_000) : maxAgeMs)) await unlink(path)
    } catch { /* Another app instance may be using or updating this cache. */ }
  }
}

function run(ffmpeg: string, args: string[], signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('미디어 준비가 취소됐습니다.'))
  return new Promise((resolveJob, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let error: Error | undefined, stderr = ''
    const stop = (message: string) => { error = new Error(message); child.kill('SIGKILL') }
    const abort = () => stop('미디어 준비가 취소됐습니다.')
    const timer = setTimeout(() => stop('미디어 준비 시간이 초과됐습니다.'), 30 * 60_000)
    signal.addEventListener('abort', abort, { once: true })
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
    child.on('error', e => { error = e })
    child.on('close', code => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else if (code !== 0) reject(new Error(`미디어 시간축 준비 실패: ${stderr}`))
      else resolveJob()
    })
    if (signal.aborted) abort()
  })
}

async function exists(path: string): Promise<boolean> {
  try { const s = await stat(path); return s.isFile() && s.size > 44 } catch { return false }
}

export async function prepareSourceMedia(options: { input: string; ffmpeg: string; ffprobe: string; cacheDir: string; signal?: AbortSignal }): Promise<PreparedMedia> {
  checkCancelled(options.signal)
  const input = resolve(options.input)
  const before = await stat(input)
  checkCancelled(options.signal)
  if (!before.isFile()) throw new Error('미디어 파일이 아닙니다.')
  const hash = createHash('sha256').update(`${PREPARED_MEDIA_VERSION}|${input}|${before.size}|${before.mtimeMs}|${before.ctimeMs}`).digest('hex')
  const key = join(options.cacheDir, hash)
  const existing = pending.get(key)
  if (existing) {
    // Let an aborted child close and remove its temporary files before a retry.
    if (existing.controller.signal.aborted) {
      await existing.promise.catch(() => {})
      return prepareSourceMedia(options)
    }
    return consume(existing, options.signal)
  }
  const controller = new AbortController()
  const promise = (async () => {
    const timing = await probeMediaTimingAsync(options.ffprobe, input, controller.signal)
    const audioPath = key + '.wav'
    const needsPreview = timing.needsPreviewNormalization
    const previewPath = needsPreview ? key + '.mp4' : input
    await mkdir(options.cacheDir, { recursive: true })
    checkCancelled(controller.signal)
    const tempPaths: string[] = []
    try {
      if (!await exists(audioPath)) {
        const temp = key + `.${randomUUID()}.wav`
        tempPaths.push(temp)
        const filter = `asetpts=PTS-(${timing.sourceOriginSec})/TB,aresample=48000:async=1:first_pts=0,apad,atrim=duration=${timing.duration}`
        await run(options.ffmpeg, timing.hasAudio
          ? ['-copyts', '-i', input, '-map', '0:a:0', '-vn', '-af', filter, '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-rf64', 'auto', temp]
          : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(timing.duration), '-c:a', 'pcm_s16le', '-rf64', 'auto', temp], controller.signal)
        checkCancelled(controller.signal)
        await rename(temp, audioPath)
      }
      if (needsPreview && !await exists(previewPath)) {
        const temp = key + `.${randomUUID()}.mp4`
        tempPaths.push(temp)
        // Stream-copy the video only: Chromium otherwise exposes nonzero container
        // timestamps as currentTime/duration. Audio always comes from the common WAV.
        await run(options.ffmpeg, ['-copyts', '-itsoffset', String(-timing.sourceOriginSec), '-i', input,
          '-map', '0:v:0', '-an', '-c:v', 'copy', '-avoid_negative_ts', 'disabled', '-movflags', '+faststart', temp], controller.signal)
        checkCancelled(controller.signal)
        const prepared = await probeMediaTimingAsync(options.ffprobe, temp, controller.signal)
        if (Math.abs(prepared.sourceOriginSec) > .001 || Math.abs(prepared.duration - timing.duration) > .1) {
          throw new Error('미리보기 시간축을 원본 영상에 맞추지 못했습니다.')
        }
        await rename(temp, previewPath)
      }
      const after = await stat(input)
      checkCancelled(controller.signal)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('준비 중 원본 영상이 변경되었습니다. 다시 열어 주세요.')
      }
      const now = new Date()
      await Promise.all([audioPath, ...(needsPreview ? [previewPath] : [])].map(async path => {
        // Peaks uses mtime for invalidation; an LRU touch must not rebuild valid peaks.
        const info = await stat(path)
        await utimes(path, now, info.mtime)
      }))
      return { audioPath, previewPath, duration: timing.duration, sourceOriginSec: timing.sourceOriginSec, hasAudio: timing.hasAudio }
    } finally { await Promise.all(tempPaths.map(path => unlink(path).catch(() => {}))) }
  })()
  const job = { promise, controller, consumers: new Set<symbol>() }
  pending.set(key, job)
  const cleanup = () => { if (pending.get(key) === job) pending.delete(key) }
  void promise.then(cleanup, cleanup)
  return consume(job, options.signal)
}
