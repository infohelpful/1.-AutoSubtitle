import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { prepareSourceMedia, stopPreparingMedia } from './preparedMedia'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('./mediaTiming', () => ({ probeMediaTimingAsync: async () => ({
  duration: 1, sourceOriginSec: 0, hasAudio: true, needsPreviewNormalization: false
}) }))

let dir: string
let options: {input:string;ffmpeg:string;ffprobe:string;cacheDir:string}
let children: Array<{kill: ReturnType<typeof vi.fn>; complete: () => Promise<void>}>
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'media-cancel-'))
  options = {input:join(dir,'source.mp4'),ffmpeg:'ffmpeg',ffprobe:'ffprobe',cacheDir:join(dir,'cache')}
  await writeFile(options.input, 'source')
  children = []
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const child = Object.assign(new EventEmitter(), {stderr:new EventEmitter(),kill:vi.fn()})
    child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close',null)); return true })
    children.push({kill:child.kill,complete:async () => {
      await writeFile(args!.at(-1)!,Buffer.alloc(64))
      child.emit('close',0)
    }})
    return child as unknown as ReturnType<typeof spawn>
  })
})
afterEach(async () => {
  stopPreparingMedia()
  await vi.waitFor(async () => expect((await readdir(options.cacheDir).catch(() => [])).filter(n=>n.split('.').length>2)).toEqual([]))
  await rm(dir,{recursive:true,force:true})
  vi.clearAllMocks()
})

it('cancels one consumer without killing a decode still used by another', async () => {
  const a = new AbortController(), b = new AbortController()
  const first = prepareSourceMedia({...options,signal:a.signal})
  const firstFailure = expect(first).rejects.toThrow('취소')
  await vi.waitFor(() => expect(children).toHaveLength(1))
  const second = prepareSourceMedia({...options,signal:b.signal})
  // Let the second consumer's source stat finish before cancelling the first.
  await new Promise(resolve => setTimeout(resolve,30))
  a.abort()
  await firstFailure
  expect(children[0].kill).not.toHaveBeenCalled()
  await children[0].complete()
  expect((await second).duration).toBe(1)
  expect(children).toHaveLength(1)
})

it('kills the last consumer job and lets a same-source retry finish', async () => {
  const a = new AbortController()
  const first = prepareSourceMedia({...options,signal:a.signal})
  const failed = expect(first).rejects.toThrow('취소')
  await vi.waitFor(() => expect(children).toHaveLength(1))
  a.abort()
  const retry = prepareSourceMedia(options)
  await failed
  expect(children[0].kill).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(children).toHaveLength(2))
  await children[1].complete()
  expect((await retry).duration).toBe(1)
  expect((await readdir(options.cacheDir)).length).toBe(1)
})

it('does no work for an already cancelled request', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(prepareSourceMedia({...options,signal:controller.signal})).rejects.toThrow('취소')
  expect(spawn).not.toHaveBeenCalled()
})
