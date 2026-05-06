import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readdir, stat, unlink, utimes } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { app } from 'electron'

const CACHE_SUBDIR = 'WaveformCache'
const CACHE_FILE_SUFFIX = '.autosub-peaks.json'
/** 30일 미사용(mtime 기준) 캐시 삭제 — 읽을 때마다 mtime 갱신으로 LRU에 가깝게 */
const DEFAULT_MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function getWaveformCacheDir(): string {
  return join(app.getPath('userData'), CACHE_SUBDIR)
}

export function ensureWaveformCacheDir(): void {
  try {
    mkdirSync(getWaveformCacheDir(), { recursive: true })
  } catch {
    /* ignore */
  }
}

export function computeWaveformCacheHash(absPath: string, size: number, mtimeMs: number): string {
  const key = `${absPath}|${size}|${mtimeMs}`
  return createHash('md5').update(key, 'utf8').digest('hex')
}

export type WaveformCachePathResult =
  | { ok: true; cachePath: string; hash: string }
  | { ok: false; reason: string }

/**
 * 영상 절대 경로(이미 normalize 된 값) + fs.stat 의 size/mtime 으로 캐시 JSON 경로 결정.
 */
export async function getWaveformCacheJsonPathForMedia(absPath: string): Promise<WaveformCachePathResult> {
  const abs = normalize(absPath.trim())
  try {
    const st = await stat(abs)
    if (!st.isFile()) {
      return { ok: false, reason: 'not_a_file' }
    }
    const mtimeMs = Math.trunc(st.mtimeMs)
    const hash = computeWaveformCacheHash(abs, st.size, mtimeMs)
    ensureWaveformCacheDir()
    const cachePath = join(getWaveformCacheDir(), `${hash}${CACHE_FILE_SUFFIX}`)
    return { ok: true, cachePath, hash }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export function isPathUnderWaveformCache(absoluteFilePath: string): boolean {
  try {
    const dir = normalize(getWaveformCacheDir())
    const p = normalize(absoluteFilePath.trim())
    const prefix = dir.endsWith(sep) ? dir : dir + sep
    return p.startsWith(prefix) || p.toLowerCase() === dir.toLowerCase()
  } catch {
    return false
  }
}

export async function touchWaveformCacheFile(absoluteFilePath: string): Promise<void> {
  if (!isPathUnderWaveformCache(absoluteFilePath)) return
  try {
    const now = new Date()
    await utimes(absoluteFilePath, now, now)
  } catch {
    /* ignore */
  }
}

export async function pruneStaleWaveformCacheEntries(maxAgeMs = DEFAULT_MAX_CACHE_AGE_MS): Promise<void> {
  const dir = getWaveformCacheDir()
  try {
    if (!existsSync(dir)) return
    const now = Date.now()
    const names = await readdir(dir)
    for (const name of names) {
      if (!name.endsWith(CACHE_FILE_SUFFIX)) continue
      const full = join(dir, name)
      try {
        const st = await stat(full)
        if (!st.isFile()) continue
        if (now - st.mtimeMs > maxAgeMs) {
          await unlink(full)
        }
      } catch {
        /* per-file */
      }
    }
  } catch {
    /* ignore */
  }
}
