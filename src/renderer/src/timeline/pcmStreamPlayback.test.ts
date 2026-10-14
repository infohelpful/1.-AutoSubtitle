import { afterEach, expect, it, vi } from 'vitest'
import { PcmStreamPlayback } from './pcmStreamPlayback'
import type { PcmAudioBlock, PcmRange } from '../../../shared/pcmAudio'

type Node = {buffer: AudioBuffer|null;onended: (()=>void)|null;connect:()=>void;disconnect:ReturnType<typeof vi.fn>;stop:ReturnType<typeof vi.fn>;start:ReturnType<typeof vi.fn>}
const info:PcmAudioBlock={sampleRate:48000,channels:2,totalFrames:48000*10800,pcm:new ArrayBuffer(0)}
function setup() {
  vi.useFakeTimers()
  const nodes:Node[]=[],buffers:AudioBuffer[]=[]
  const ctx={currentTime:0,createBuffer:(channels:number,length:number,sampleRate:number)=>{
    const data=Array.from({length:channels},()=>new Float32Array(length))
    const buffer={length,sampleRate,duration:length/sampleRate,getChannelData:(i:number)=>data[i]} as AudioBuffer
    buffers.push(buffer);return buffer
  },createBufferSource:()=>{
    const node:Node={buffer:null,onended:null,connect(){},disconnect:vi.fn(),stop:vi.fn(),start:vi.fn()}
    nodes.push(node);return node
  }}
  const reader=vi.fn(async (_url:string,ranges:PcmRange[])=> {
    const pcm=new Int16Array(ranges.reduce((sum,r)=>sum+r.frameCount,0)*2)
    let i=0
    for(const range of ranges)for(let frame=0;frame<range.frameCount;frame++) {
      const v=(range.startFrame+frame)%30000
      pcm[i++]=v;pcm[i++]=-v
    }
    return {...info,pcm:pcm.buffer}
  })
  const stream=new PcmStreamPlayback(ctx as unknown as AudioContext,{} as AudioNode,reader)
  const ended=vi.fn(),error=vi.fn()
  return {stream,ctx,nodes,buffers,reader,ended,error}
}
afterEach(()=>vi.useRealTimers())
it('keeps the audible tail and cut position after the render head releases a buffer', async () => {
  const s=setup()
  Object.assign(s.ctx,{outputLatency:.08})
  await s.stream.start('pcm',info,[{clipId:0,startMediaSec:300,endMediaSec:306},{clipId:1,startMediaSec:310,endMediaSec:311}],300,null,s.ended,s.error)
  await vi.advanceTimersByTimeAsync(0)
  s.ctx.currentTime=6.03
  s.nodes[0].onended!()
  expect(s.nodes[0].buffer).toBeNull()
  expect(s.stream.currentMediaSec()).toBeCloseTo(305.93)
  s.ctx.currentTime=6.11
  expect(s.stream.currentMediaSec()).toBeCloseTo(310.01)
  s.ctx.currentTime=7.02
  s.nodes[1].onended!()
  expect(s.stream.isPlaying()).toBe(true)
  expect(s.stream.currentMediaSec()).toBeCloseTo(310.92)
  expect(s.ended).not.toHaveBeenCalled()
  s.ctx.currentTime=7.10
  await vi.advanceTimersByTimeAsync(100)
  expect(s.ended).toHaveBeenCalledOnce()
  s.stream.stop()
  expect(vi.getTimerCount()).toBe(0)
})
it('concatenates cuts at exact samples while its clock follows source positions',async () => {
  const s=setup()
  await s.stream.start('pcm',info,[{clipId:0,startMediaSec:0,endMediaSec:2},{clipId:1,startMediaSec:4,endMediaSec:20}],.5,9,s.ended,s.error)
  await vi.advanceTimersByTimeAsync(0)
  expect(s.reader.mock.calls.map(c=>c[1])).toEqual([
    [{startFrame:24000,frameCount:72000},{startFrame:192000,frameCount:216000}],
    [{startFrame:408000,frameCount:24000}]
  ])
  const samples=s.buffers[0].getChannelData(0)
  expect(samples[71999]).toBeCloseTo((95999%30000)/32768)
  expect(samples[72000]).toBeCloseTo((192000%30000)/32768)
  s.ctx.currentTime=1.52
  expect(s.stream.currentMediaSec()).toBeCloseTo(4)
  expect(s.nodes[1].start.mock.calls[0][0]).toBeCloseTo(6.02)
  s.ctx.currentTime=6.02;s.nodes[0].onended!()
  s.ctx.currentTime=6.52;s.nodes[1].onended!()
  expect(s.ended).toHaveBeenCalledOnce()
  expect(s.error).not.toHaveBeenCalled()
  expect(s.nodes.every(n=>n.buffer===null)).toBe(true)
  s.stream.stop()
})
it('keeps three-hour playback reads bounded and releases played buffers',async () => {
  const s=setup()
  await s.stream.start('pcm',info,[{clipId:0,startMediaSec:0,endMediaSec:10800}],0,null,s.ended,s.error)
  await vi.advanceTimersByTimeAsync(0)
  expect(s.reader).toHaveBeenCalledTimes(2)
  expect(s.buffers.every(b=>b.length<=48000*6)).toBe(true)
  s.ctx.currentTime=6.03;s.nodes[0].onended!()
  await vi.advanceTimersByTimeAsync(100)
  expect(s.nodes[0].buffer).toBeNull()
  expect(s.nodes.filter(n=>n.buffer).length).toBeLessThanOrEqual(3)
  expect(s.reader.mock.calls.flatMap(c=>c[1]).reduce((sum,r)=>sum+r.frameCount,0)).toBeLessThan(48000*30)
  s.stream.stop()
  expect(vi.getTimerCount()).toBe(0)
})
it('drops an outstanding range read after stop',async () => {
  const s=setup()
  let finish!:(value:PcmAudioBlock)=>void
  s.reader.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const starting=s.stream.start('pcm',info,[{clipId:0,startMediaSec:0,endMediaSec:1}],0,null,s.ended,s.error)
  s.stream.stop()
  finish({...info,pcm:new ArrayBuffer(48000*4)})
  await starting
  expect(s.nodes).toHaveLength(0)
  expect(s.stream.isPlaying()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
it('stops and reports a late read instead of silently moving the audio clock',async () => {
  const s=setup()
  let finish!:(value:PcmAudioBlock)=>void
  s.reader.mockImplementationOnce(async()=>({...info,pcm:new ArrayBuffer(48000*6*4)}))
    .mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  await s.stream.start('pcm',info,[{clipId:0,startMediaSec:0,endMediaSec:100}],0,null,s.ended,s.error)
  s.ctx.currentTime=7
  finish({...info,pcm:new ArrayBuffer(48000*6*4)})
  await vi.advanceTimersByTimeAsync(0)
  expect(s.error).toHaveBeenCalledOnce()
  expect(s.stream.isPlaying()).toBe(false)
  expect(s.nodes[0].stop).toHaveBeenCalledOnce()
  expect(s.nodes[0].buffer).toBeNull()
})
