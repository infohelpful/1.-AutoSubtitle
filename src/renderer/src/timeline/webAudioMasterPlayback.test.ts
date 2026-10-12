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
      start: (_when: number, offset: number) => { starts.push(offset) } })
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

it('shares an in-flight load instead of decoding the entire WAV twice', async () => {
  const {engine,ctx} = setup()
  const decode = deferred<{duration:number}>()
  const spy = vi.fn(() => decode.promise)
  ctx.decodeAudioData = spy
  const first = engine.loadFromUrl('same'), second = engine.loadFromUrl('same')
  await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
  decode.resolve({duration:10})
  await Promise.all([first,second])
  expect(fetch).toHaveBeenCalledOnce()
  expect(engine.isLoadedForUrl('same')).toBe(true)
})

it('aborts the previous fetch and never decodes its late response', async () => {
  const {engine,ctx} = setup()
  const oldResponse = deferred<Response>()
  const spy = vi.fn(async () => ({duration:10}))
  ctx.decodeAudioData = spy
  const fetchMock = vi.fn().mockImplementationOnce(() => oldResponse.promise)
    .mockResolvedValue({ok:true,arrayBuffer:async()=>new ArrayBuffer(0)})
  vi.stubGlobal('fetch',fetchMock)
  const old = engine.loadFromUrl('old')
  await engine.loadFromUrl('new')
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  const oldBody = vi.fn()
  oldResponse.resolve({ok:true,arrayBuffer:oldBody} as unknown as Response)
  await old
  expect(oldBody).not.toHaveBeenCalled()
  expect(spy).toHaveBeenCalledOnce()
  expect(engine.isLoadedForUrl('new')).toBe(true)
})

it('aborts a fetch on disposal and avoids decoding a late body', async () => {
  const {engine,ctx} = setup()
  const body = deferred<ArrayBuffer>()
  const spy = vi.fn(async () => ({duration:10}))
  ctx.decodeAudioData = spy
  const fetchMock = vi.fn(async () => ({ok:true,arrayBuffer:()=>body.promise}))
  vi.stubGlobal('fetch',fetchMock)
  const load = engine.loadFromUrl('old')
  await Promise.resolve()
  engine.dispose()
  body.resolve(new ArrayBuffer(0))
  await load
  expect((vi.mocked(fetch).mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true)
  expect(spy).not.toHaveBeenCalled()
})

it('disconnects every source when a later clip fails to start', async () => {
  const { engine, resume, ctx } = setup()
  const nodes: Array<{ connect: () => void; disconnect: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; start: () => void }> = []
  ctx.createBufferSource = () => {
    const index = nodes.length
    const node = { connect() {}, disconnect: vi.fn(), stop: vi.fn(), start() { if (index === 1) throw Error('source failed') } }
    nodes.push(node)
    return node
  }
  await engine.loadFromUrl('audio')
  resume.resolve()
  await expect(engine.scheduleFromEdl([{clipId:1,startMediaSec:0,endMediaSec:1},{clipId:2,startMediaSec:2,endMediaSec:3}],0,null)).rejects.toThrow('source failed')
  expect(nodes).toHaveLength(2)
  expect(nodes.every(node => node.stop.mock.calls.length===1 && node.disconnect.mock.calls.length===1)).toBe(true)
  expect(engine.isPlaying()).toBe(false)
  expect(engine.getCurrentMediaSec()).toBeNull()
})
