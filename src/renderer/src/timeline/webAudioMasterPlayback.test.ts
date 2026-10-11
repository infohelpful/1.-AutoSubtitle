import { afterEach, expect, it, vi } from 'vitest'
import { WebAudioMasterPlayback } from './webAudioMasterPlayback'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
function setup() {
  const resume = deferred<void>()
  const starts: number[] = []
  const ctx = {
    state: 'running', currentTime: 0, destination: {},
    resume: () => resume.promise, close: vi.fn(),
    createGain: () => ({ connect() {}, gain: { value: 1 } }),
    decodeAudioData: async () => ({ duration: 10 }),
    createBufferSource: () => ({ connect() {}, disconnect() {}, stop() {},
      start: (_when: number, offset: number) => starts.push(offset) })
  }
  vi.stubGlobal('AudioContext', class { constructor() { return ctx } })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })))
  return { engine: new WebAudioMasterPlayback(), resume, starts, ctx }
}
const segments = [{ clipId: 1, startMediaSec: 0, endMediaSec: 10 }]
afterEach(() => vi.unstubAllGlobals())

it('does not restart audio after a stop while context resume is pending', async () => {
  const { engine, resume, starts } = setup()
  await engine.loadFromUrl('audio')
  const pending = engine.scheduleFromEdl(segments, 2, null)
  engine.stopPlayback()
  resume.resolve()
  await pending
  expect(starts).toEqual([])
  expect(engine.isPlaying()).toBe(false)
})
it('only starts the latest request when two resume operations overlap', async () => {
  const { engine, resume, starts } = setup()
  await engine.loadFromUrl('audio')
  const first = engine.scheduleFromEdl(segments, 2, null)
  const second = engine.scheduleFromEdl(segments, 5, null)
  resume.resolve()
  await Promise.all([first, second])
  expect(starts).toEqual([5])
})
it('does not claim playback when the context stays suspended', async () => {
  const { engine, resume, ctx } = setup()
  await engine.loadFromUrl('audio')
  ctx.state = 'suspended'
  resume.resolve()
  await expect(engine.scheduleFromEdl(segments, 2, null)).rejects.toThrow('not running')
  expect(engine.isPlaying()).toBe(false)
})
it('does not install a decoded buffer after disposal', async () => {
  const { engine, ctx } = setup()
  const decode = deferred<{ duration: number }>()
  ctx.decodeAudioData = () => decode.promise
  const pending = engine.loadFromUrl('old')
  await Promise.resolve(); await Promise.resolve()
  engine.dispose()
  decode.resolve({ duration: 10 })
  await pending
  expect(engine.isLoadedForUrl('old')).toBe(false)
})
