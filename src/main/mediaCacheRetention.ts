import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const PREPARED_CACHE_BYTES = 8 * 1024 ** 3
export const WAVEFORM_CACHE_BYTES = 1024 ** 3
export const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60_000
const PARTIAL_MAX_AGE_MS = 24 * 60 * 60_000
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const preparedName = new RegExp(`^([a-f0-9]{64})(?:\\.(${UUID}))?\\.(wav|mp4)$`)
const waveformName = new RegExp(`^([a-f0-9]{32})\\.autosub-peaks\\.json(?:\\.(${UUID})\\.work\\.json)?(\\.part)?$`)

type Entry = { path: string; size: number; mtimeMs: number; atimeMs: number; ctimeMs: number }
type Group = { entries: Entry[]; used: number; partial: boolean; key: string }
export type CacheRetentionResult = { removedFiles: number; removedBytes: number; remainingBytes: number; overBudget: boolean }

/** Run before serving media, with exclusive ownership of the profile.
 * This limits retained caches between sessions, not disk usage during a job.
 * Only generated names are eligible; never follow links or recurse.
 */
export async function pruneMediaCache(options: {
  directory: string
  kind: 'prepared' | 'waveform'
  maxBytes: number
  maxAgeMs?: number
  isProtected?: (key: string) => boolean
}): Promise<CacheRetentionResult> {
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 0) throw new Error('Invalid cache byte budget')
  const maxAge = options.maxAgeMs ?? CACHE_MAX_AGE_MS
  if (!Number.isFinite(maxAge) || maxAge < 0) throw new Error('Invalid cache retention age')
  const now = Date.now(), groups = new Map<string, Group>()
  const result: CacheRetentionResult = { removedFiles: 0, removedBytes: 0, remainingBytes: 0, overBudget: false }
  const directoryInfo = await lstat(options.directory).catch(() => null)
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) return result
  for (const entry of await readdir(options.directory, { withFileTypes: true })) {
    const match = (options.kind === 'prepared' ? preparedName : waveformName).exec(entry.name)
    if (!entry.isFile() || !match) continue
    const path = join(options.directory, entry.name)
    const info = await lstat(path).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink()) continue
    const partial = !!match[2] || (options.kind === 'waveform' && !!match[3])
    const groupKey = partial ? entry.name : match[1]
    const group = groups.get(groupKey) ?? { entries: [], used: 0, partial, key: match[1] }
    group.entries.push({ path, size: info.size, mtimeMs: info.mtimeMs, atimeMs: info.atimeMs, ctimeMs: info.ctimeMs })
    group.used = Math.max(group.used, options.kind === 'prepared' && !partial ? info.atimeMs : info.mtimeMs)
    groups.set(groupKey, group)
    result.remainingBytes += info.size
  }
  const remove = async (group: Group): Promise<void> => {
    if (options.isProtected?.(group.key)) return
    // Recheck the whole pair before deleting either file. An access or rewrite
    // since enumeration means a consumer may be using it; leave it alone.
    for (const entry of group.entries) {
      const info = await lstat(entry.path).catch(() => null)
      if (!info?.isFile() || info.isSymbolicLink() || info.size !== entry.size ||
        info.mtimeMs !== entry.mtimeMs || info.atimeMs !== entry.atimeMs || info.ctimeMs !== entry.ctimeMs) return
    }
    if (options.isProtected?.(group.key)) return
    for (const entry of group.entries) {
      try {
        await unlink(entry.path)
        result.removedFiles++
        result.removedBytes += entry.size
        result.remainingBytes -= entry.size
      } catch { /* Locked files stay accounted for; startup must still succeed. */ }
    }
  }
  const finals: Group[] = []
  for (const group of groups.values()) {
    if (group.partial) {
      if (now - group.used > Math.min(maxAge, PARTIAL_MAX_AGE_MS)) await remove(group)
    } else finals.push(group)
  }
  // Prepared WAV and preview MP4 form one LRU item; the most recent use wins.
  for (const group of finals.sort((a, b) => a.used - b.used || a.key.localeCompare(b.key))) {
    if (now - group.used > maxAge || result.remainingBytes > options.maxBytes) await remove(group)
  }
  result.overBudget = result.remainingBytes > options.maxBytes
  return result
}
