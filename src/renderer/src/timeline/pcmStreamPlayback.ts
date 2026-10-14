import { PCM_BLOCK_SECONDS, PCM_MAX_RANGES, type PcmAudioBlock, type PcmRange, type PcmReader } from '../../../shared/pcmAudio'
import type { ScheduledMediaSegment } from './playbackSchedule'
import { audioOutputTime, waitForAudioOutput } from './audioOutputClock'

type Fragment = { ctxStart: number; mediaStartSec: number; durationSec: number }
type Piece = PcmRange
/** Six-second program blocks, twelve-second lookahead, at most eight sources. */
export class PcmStreamPlayback {
  private generation = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private timeline: Fragment[] = []
  private playing = false
  private cancelDrain: (() => void) | null = null
  constructor(private ctx: AudioContext, private destination: AudioNode, private reader: PcmReader) {}
  isPlaying(): boolean { return this.playing }
  currentMediaSec(now = audioOutputTime(this.ctx)): number | null {
    if (!this.playing) return null
    for (const piece of this.timeline) {
      if (now<piece.ctxStart) return null
      if (now<piece.ctxStart+piece.durationSec) return piece.mediaStartSec+(now-piece.ctxStart)
    }
    const last=this.timeline.at(-1)
    return last ? last.mediaStartSec+last.durationSec : null
  }
  stop(): void {
    this.generation++
    this.cancelDrain?.()
    this.cancelDrain=null
    if (this.timer) clearInterval(this.timer)
    this.timer=null
    for (const source of this.sources) {
      source.onended=null
      try { source.stop() } catch { /* already stopped */ }
      source.disconnect()
      source.buffer=null
    }
    this.sources.clear()
    this.timeline=[]
    this.playing=false
  }
  async start(url: string, info: PcmAudioBlock, segments: ScheduledMediaSegment[], startSec: number, endSec: number | null,
    onEnd: () => void, onError: (error: Error) => void): Promise<void> {
    this.stop()
    const generation=this.generation, current=()=>generation===this.generation
    const rate=info.sampleRate, pieces: Piece[]=[]
    let started=false
    for (const segment of segments) {
      let start=Math.max(0,Math.round(segment.startMediaSec*rate))
      const end=Math.min(info.totalFrames,Math.round(segment.endMediaSec*rate),endSec==null?Infinity:Math.round(endSec*rate))
      if (!started) {
        const target=Math.max(0,Math.round(startSec*rate))
        if (target>=end) continue
        start=Math.max(start,target)
        started=true
      }
      if (end>start) pieces.push({startFrame:start,frameCount:end-start})
    }
    if (!pieces.length) return
    let index=0, consumed=0, nextTime=0, filling=false
    const hasMore=()=>index<pieces.length
    const take=(): Piece[] => {
      let remaining=rate*PCM_BLOCK_SECONDS
      const ranges: Piece[]=[]
      while (hasMore() && remaining>0 && ranges.length<PCM_MAX_RANGES) {
        const piece=pieces[index], count=Math.min(remaining,piece.frameCount-consumed)
        ranges.push({startFrame:piece.startFrame+consumed,frameCount:count})
        consumed+=count
        remaining-=count
        if (consumed===piece.frameCount) {index++;consumed=0}
      }
      return ranges
    }
    const fail=(error: unknown) => {
      if (!current()) return
      const failure=error instanceof Error?error:new Error(String(error))
      this.stop()
      onError(failure)
    }
    const append=async () => {
      const ranges=take(), count=ranges.reduce((sum,r)=>sum+r.frameCount,0)
      const block=await this.reader(url,ranges)
      if (!current()) return
      if (block.channels!==info.channels || block.sampleRate!==rate || block.totalFrames!==info.totalFrames || block.pcm.byteLength!==count*info.channels*2) throw new Error('오디오 구간 데이터가 변경됐습니다.')
      const buffer=this.ctx.createBuffer(info.channels,count,rate)
      const input=new DataView(block.pcm)
      for (let channel=0;channel<info.channels;channel++) {
        const samples=buffer.getChannelData(channel)
        for (let i=0;i<count;i++) samples[i]=input.getInt16((i*info.channels+channel)*2,true)/32768
      }
      if (nextTime && nextTime<this.ctx.currentTime+.005) throw new Error('오디오 읽기가 재생을 따라가지 못했습니다. 다시 재생해 주세요.')
      if (!nextTime) nextTime=this.ctx.currentTime+.02
      const fragments: Fragment[]=[]
      let offset=0
      for (const range of ranges) {
        fragments.push({ctxStart:nextTime+offset/rate,mediaStartSec:range.startFrame/rate,durationSec:range.frameCount/rate})
        offset+=range.frameCount
      }
      const source=this.ctx.createBufferSource(), end=nextTime+count/rate
      source.buffer=buffer
      source.connect(this.destination)
      // Read-only diagnostics used by playback E2E to inspect source clock/cuts.
      Object.assign(source,{__autosubtitleSourceRanges:fragments})
      this.sources.add(source)
      this.timeline.push(...fragments)
      source.onended=() => {
        if (!current()) return
        this.sources.delete(source)
        source.disconnect()
        source.buffer=null
        if (!this.sources.size && !hasMore() && !filling) {
          if (this.timer) clearInterval(this.timer)
          this.timer=null
          this.cancelDrain=waitForAudioOutput(this.ctx,end,()=>{
            if (!current()) return
            this.playing=false
            onEnd()
          })
        } else if (!this.sources.size && (hasMore() || filling)) {
          fail(new Error('오디오 구간을 읽는 중 재생이 중단됐습니다. 다시 재생해 주세요.'))
        }
        // Released buffers may still be audible in the output device's queue.
        const heard=audioOutputTime(this.ctx)
        this.timeline=this.timeline.filter(piece=>piece.ctxStart+piece.durationSec>heard+1e-7)
      }
      source.start(nextTime,0,count/rate)
      nextTime=end
      this.playing=true
    }
    const fill=async () => {
      if (filling || !current()) return
      filling=true
      try {
        while (current() && hasMore() && this.sources.size<8 && nextTime-this.ctx.currentTime<12) await append()
      } catch (error) { fail(error) }
      finally { filling=false }
    }
    try { await append() } catch (error) { this.stop();throw error }
    if (!current()) return
    this.timer=setInterval(()=>{void fill()},100)
    void fill()
  }
}
