import { mkdtemp, mkdir, writeFile, utimes, readdir, rm, symlink, readFile } from 'node:fs/promises'
import { utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { pruneMediaCache } from './mediaCacheRetention'

let root: string, directory: string
const uuid = '12345678-1234-1234-1234-123456789abc'
const hash = (letter: string, kind: 'prepared' | 'waveform' = 'prepared') => letter.repeat(kind === 'prepared' ? 64 : 32)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cache-retention-'))
  directory = join(root, 'cache')
  await mkdir(directory)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function file(name: string, bytes: number, age: number, accessAge = age) {
  const path = join(directory, name)
  await writeFile(path, Buffer.alloc(bytes, 42))
  await utimes(path, new Date(Date.now() - accessAge), new Date(Date.now() - age))
  return path
}
const names = async () => (await readdir(directory)).sort()

it('evicts the least recently used prepared pair and retains a recently read WAV regardless of mtime', async () => {
  const old = hash('a'), recent = hash('b')
  await file(old + '.wav', 60, 10_000)
  await file(old + '.mp4', 40, 10_000)
  await file(recent + '.wav', 70, 90_000, 100)
  await file(recent + '.mp4', 20, 20_000)
  const result = await pruneMediaCache({ directory, kind: 'prepared', maxBytes: 100 })
  expect(await names()).toEqual([recent + '.mp4', recent + '.wav'])
  expect(result).toEqual({ removedFiles: 2, removedBytes: 100, remainingBytes: 90, overBudget: false })
})

it('removes crash leftovers after a day, keeping fresh work and unrelated names/directories', async () => {
  const stale = hash('a', 'waveform') + '.autosub-peaks.json'
  const live = hash('b', 'waveform') + '.autosub-peaks.json'
  const oldWork = `${stale}.${uuid}.work.json`
  for (const name of [stale + '.part', oldWork, oldWork + '.part']) await file(name, 7, 2 * 86400_000)
  const keep = [live, `${live}.${uuid}.work.json.part`, 'source.mp4', 'notes.autosub-peaks.json']
  for (const name of keep) await file(name, 7, 100)
  await mkdir(join(directory, hash('c', 'waveform') + '.autosub-peaks.json'))
  const result = await pruneMediaCache({ directory, kind: 'waveform', maxBytes: 100 })
  expect(await names()).toEqual([...keep, hash('c', 'waveform') + '.autosub-peaks.json'].sort())
  expect(result.removedFiles).toBe(3)
  expect(result.remainingBytes).toBe(14)
})

it('uses waveform mtime as last access and evicts oversized items without requiring real gigabytes', async () => {
  const old = hash('a', 'waveform') + '.autosub-peaks.json'
  const recent = hash('b', 'waveform') + '.autosub-peaks.json'
  await file(old, 200, 10_000, 0)
  await file(recent, 20, 100)
  const result = await pruneMediaCache({ directory, kind: 'waveform', maxBytes: 30 })
  expect(await names()).toEqual([recent])
  expect(result.remainingBytes).toBe(20)
})

it('protects a pending key including partials and reports an unmet budget', async () => {
  const key = hash('a')
  const keep = [key + '.wav', `${key}.${uuid}.wav`]
  for (const name of keep) await file(name, 100, 40 * 86400_000)
  const result = await pruneMediaCache({ directory, kind: 'prepared', maxBytes: 0, isProtected: candidate => candidate === key })
  expect(await names()).toEqual(keep.sort())
  expect(result.overBudget).toBe(true)
  expect(result.removedFiles).toBe(0)
})

it('rechecks access before eviction and keeps both files if one was touched', async () => {
  const key = hash('a')
  const path = await file(key + '.wav', 20, 10_000)
  await file(key + '.mp4', 20, 10_000)
  const result = await pruneMediaCache({ directory, kind: 'prepared', maxBytes: 0,
    isProtected: () => { utimesSync(path, new Date(), new Date()); return false } })
  expect(result.removedFiles).toBe(0)
  expect(await names()).toEqual([key + '.mp4', key + '.wav'])
})

it('never traverses a junction used as a cache directory', async () => {
  const outside = join(root, 'outside')
  await mkdir(outside)
  const original = join(outside, hash('a') + '.wav')
  await writeFile(original, 'source content')
  const link = join(root, 'cache-link')
  await symlink(outside, link, 'junction')
  const result = await pruneMediaCache({ directory: link, kind: 'prepared', maxBytes: 0 })
  expect(result.removedFiles).toBe(0)
  expect(await readFile(original, 'utf8')).toBe('source content')
})

it('expires old final caches even below budget and rejects invalid settings', async () => {
  await file(hash('a') + '.wav', 10, 40 * 86400_000)
  const result = await pruneMediaCache({ directory, kind: 'prepared', maxBytes: 100 })
  expect(result.remainingBytes).toBe(0)
  await expect(pruneMediaCache({ directory, kind: 'prepared', maxBytes: NaN })).rejects.toThrow('budget')
  await expect(pruneMediaCache({ directory, kind: 'prepared', maxBytes: 100, maxAgeMs: -1 })).rejects.toThrow('age')
})
