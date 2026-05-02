import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(fileURLToPath(import.meta.url))
// CJS 패키지
const ffbinaries = require('ffbinaries') as {
  downloadBinaries: (
    components: string[] | null,
    opts: Record<string, unknown>,
    cb: (err?: Error | null) => void
  ) => void
}

/** 대략적인 바이트 비중(병렬 진행률 가중치용). */
export const FFMPEG_DOWNLOAD_WEIGHT_MB = 70
export const WHISPER_DOWNLOAD_WEIGHT_MB = 1650

const MIN_FFMPEG_BYTES = 18 * 1024 * 1024

export function getFfmpegUserBinDir(): string {
  return join(app.getPath('userData'), 'bin')
}

export function getBundledFfmpegPath(): string {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  return join(getFfmpegUserBinDir(), name)
}

export function systemFfmpegWorks(): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    const r = spawnSync(cmd, ['-hide_banner', '-version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      windowsHide: true
    })
    return r.status === 0
  } catch {
    return false
  }
}

export function isValidBundledFfmpeg(): boolean {
  const p = getBundledFfmpegPath()
  if (!existsSync(p)) return false
  try {
    return statSync(p).size >= MIN_FFMPEG_BYTES
  } catch {
    return false
  }
}

export function verifyBundledFfmpegExecutable(): void {
  const p = getBundledFfmpegPath()
  if (!existsSync(p)) throw new Error('ffmpeg binary missing after download')
  const st = statSync(p)
  if (st.size < MIN_FFMPEG_BYTES) {
    try {
      unlinkSync(p)
    } catch {
      /* ignore */
    }
    throw new Error('ffmpeg binary appears corrupt (too small); retry download')
  }
  const r = spawnSync(p, ['-hide_banner', '-version'], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (r.status !== 0) {
    throw new Error('ffmpeg exists but failed to run -version')
  }
}

/**
 * 시스템 PATH의 ffmpeg가 있으면 스킵.
 * 없으면 userData/bin 에 ffbinaries 로 내려받고 무결성 검사.
 */
export function ensureFfmpegDownloaded(onProgress: (pct: number) => void): Promise<void> {
  if (systemFfmpegWorks()) {
    onProgress(100)
    return Promise.resolve()
  }
  if (isValidBundledFfmpeg()) {
    try {
      verifyBundledFfmpegExecutable()
      onProgress(100)
      return Promise.resolve()
    } catch {
      /* fall through to re-download */
    }
  }

  const dest = getFfmpegUserBinDir()
  mkdirSync(dest, { recursive: true })
  const corruptExisting = existsSync(getBundledFfmpegPath()) && !isValidBundledFfmpeg()
  if (corruptExisting) {
    try {
      unlinkSync(getBundledFfmpegPath())
    } catch {
      /* ignore */
    }
  }

  const tickerFn = (data: { progress?: number } | number) => {
    const raw = typeof data === 'number' ? data : data?.progress
    const pct = raw == null ? 0 : raw <= 1 ? Math.round(raw * 100) : Math.round(raw)
    onProgress(Math.max(0, Math.min(100, pct)))
  }

  return new Promise((resolve, reject) => {
    ffbinaries.downloadBinaries(
      ['ffmpeg'],
      {
        destination: dest,
        quiet: true,
        tickerFn,
        tickerInterval: 250
      },
      (err?: Error | null) => {
        if (err) return reject(err)
        try {
          verifyBundledFfmpegExecutable()
          onProgress(100)
          resolve()
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }
    )
  })
}

export function ffmpegReadyForUse(): boolean {
  return systemFfmpegWorks() || isValidBundledFfmpeg()
}
