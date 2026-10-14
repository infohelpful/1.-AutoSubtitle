import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, readdir, readFile, rm, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { probeMediaTimingAsync } from './mediaTiming'
import { prepareSourceMedia } from './preparedMedia'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), statfs: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('./mediaTiming', () => ({ probeMediaTimingAsync: vi.fn() }))

let directory: string
let options: { input: string; ffmpeg: string; ffprobe: string; cacheDir: string }
const capacity = (bytes: bigint) => ({ bavail: bytes, bsize: 1n }) as Awaited<ReturnType<typeof statfs>>

beforeEach(async () => {
  vi.resetAllMocks()
  directory = await mkdtemp(join(tmpdir(), 'prepared-space-'))
  options = { input: join(directory, 'source.mp4'), cacheDir: join(directory, 'cache'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
  await writeFile(options.input, 'source')
  vi.mocked(statfs).mockResolvedValue(capacity(1024n ** 3n))
  vi.mocked(probeMediaTimingAsync).mockResolvedValue({
    duration: 1, sourceOriginSec: 0, hasAudio: true, needsPreviewNormalization: false
  } as Awaited<ReturnType<typeof probeMediaTimingAsync>>)
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() })
    void writeFile(args!.at(-1)!, Buffer.alloc(64)).then(() => child.emit('close', 0), error => child.emit('error', error))
    return child as unknown as ReturnType<typeof spawn>
  })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

it('rejects before spawning/writing on low disk, preserves the source and permits retry', async () => {
  vi.mocked(statfs).mockResolvedValueOnce(capacity(1n))
  await expect(prepareSourceMedia(options)).rejects.toThrow('공간이 부족')
  expect(spawn).not.toHaveBeenCalled()
  expect(await readdir(options.cacheDir)).toEqual([])
  expect(await readFile(options.input, 'utf8')).toBe('source')
  expect((await prepareSourceMedia(options)).duration).toBe(1)
  expect(spawn).toHaveBeenCalledOnce()
})

it('reuses a complete cache even if the disk now has no free space', async () => {
  const first = await prepareSourceMedia(options)
  vi.mocked(statfs).mockClear().mockResolvedValue(capacity(0n))
  expect(await prepareSourceMedia(options)).toEqual(first)
  expect(statfs).not.toHaveBeenCalled()
  expect(spawn).toHaveBeenCalledOnce()
})

it('rechecks before preview creation when free space falls during audio preparation', async () => {
  const timing = await probeMediaTimingAsync('probe', 'fixture')
  vi.mocked(probeMediaTimingAsync).mockResolvedValue({ ...timing, needsPreviewNormalization: true })
  vi.mocked(statfs).mockResolvedValueOnce(capacity(1024n ** 3n))
    .mockResolvedValueOnce(capacity(1024n ** 3n)).mockResolvedValueOnce(capacity(0n))
  await expect(prepareSourceMedia(options)).rejects.toThrow('공간이 부족')
  expect(spawn).toHaveBeenCalledOnce()
  const files = await readdir(options.cacheDir)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/^[a-f0-9]{64}\.wav$/)
  expect(await readFile(options.input, 'utf8')).toBe('source')
})

it('kills an ongoing decode when free space falls and removes partial output before retry', async () => {
  const normalSpawn = vi.mocked(spawn).getMockImplementation()!
  let killed = false
  vi.mocked(spawn).mockImplementationOnce((_command, args) => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn(() => {
      killed = true
      queueMicrotask(() => child.emit('close', null))
      return true
    }) })
    void writeFile(args!.at(-1)!, Buffer.alloc(64))
    return child as unknown as ReturnType<typeof spawn>
  })
  vi.mocked(statfs).mockResolvedValueOnce(capacity(1024n ** 3n)).mockResolvedValue(capacity(0n))
  await expect(prepareSourceMedia(options)).rejects.toThrow('공간이 부족')
  expect(killed).toBe(true)
  expect(await readdir(options.cacheDir)).toEqual([])
  expect(await readFile(options.input, 'utf8')).toBe('source')
  vi.mocked(statfs).mockResolvedValue(capacity(1024n ** 3n))
  vi.mocked(spawn).mockImplementation(normalSpawn)
  expect((await prepareSourceMedia(options)).duration).toBe(1)
})

it('does not promote a completed temporary output if the final capacity check fails', async () => {
  vi.mocked(statfs).mockResolvedValueOnce(capacity(1024n ** 3n)).mockRejectedValue(new Error('drive lost'))
  await expect(prepareSourceMedia(options)).rejects.toThrow('공간을 확인하지 못했습니다')
  expect(await readdir(options.cacheDir)).toEqual([])
  expect(await readFile(options.input, 'utf8')).toBe('source')
})
