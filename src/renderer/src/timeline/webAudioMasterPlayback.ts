import type { ScheduledMediaSegment } from './playbackSchedule'
import type { PcmAudioBlock, PcmReader } from '../../../shared/pcmAudio'
import { PcmStreamPlayback } from './pcmStreamPlayback'
import { audioOutputTime, waitForAudioOutput } from './audioOutputClock'

const EPS = 1e-4
const SCHEDULE_LOOKAHEAD_SEC = 0.02

export type WebAudioSchedulePiece = {
  ctxStart: number
  mediaStartSec: number
  durationSec: number
}

/**
 * 원본 미디어 파일을 한 번 디코딩한 뒤, EDL 구간에 맞춰 BufferSource 를 연쇄 스케줄한다.
 * HTMLAudioElement 재생 대신 실제 소리는 여기서만 낸다.
 */
export class WebAudioMasterPlayback {
  constructor(private pcmReader?: PcmReader) {}
  private pcmInfo: PcmAudioBlock | null = null
  private stream: PcmStreamPlayback | null = null
  private onPlaybackError: ((error: Error) => void) | null = null
  setOnPlaybackError(callback: ((error: Error) => void) | null): void { this.onPlaybackError=callback }
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private buffer: AudioBuffer | null = null
  private loadedFromUrl: string | null = null
  private activeSources: AudioBufferSourceNode[] = []
  private timeline: WebAudioSchedulePiece[] = []
  private playingFlag = false
  private cancelDrain: (() => void) | null = null
  private scheduleSeq = 0
  private playbackRequest = 0
  private loadRequest = 0
  private pendingLoad: {url: string; controller: AbortController; promise: Promise<void>} | null = null
  /**
   * 현재 스케줄(scheduleFromEdl 호출)의 모든 BufferSource 가 자연 종료될 때 한 번만 호출되는 콜백.
   * 외부(예: oneShotSession 정리)는 이 콜백으로 자연 종료를 통지받아야 한다 — `isPlaying()=false` 만으로는
   * RAF 만 의지하기에는 타이밍 경합이 있다(짧은 슬라이스 + startup verify 180ms 충돌).
   */
  private onScheduleEnded: ((scheduleId: number, reason: 'natural' | 'stopped') => void) | null = null

  get context(): AudioContext | null {
    return this.ctx
  }

  get decodedBuffer(): AudioBuffer | null {
    return this.buffer
  }

  isLoadedForUrl(url: string): boolean {
    return (this.buffer != null || this.pcmInfo != null) && this.loadedFromUrl === url
  }

  isPlaying(): boolean {
    return this.stream?.isPlaying() ?? this.playingFlag
  }

  /** 현재 스케줄 식별자(scheduleFromEdl 호출 단위). 자연 종료 콜백 비교용. */
  get currentScheduleId(): number {
    return this.scheduleSeq
  }

  /**
   * 자연 종료 콜백 등록. 이전 콜백은 덮어쓴다.
   * 한 스케줄에 대해 자연 종료 시 1회만 호출. `stopPlayback` 으로 강제 정지된 경우 `reason='stopped'`.
   */
  setOnScheduleEnded(
    cb: ((scheduleId: number, reason: 'natural' | 'stopped') => void) | null
  ): void {
    this.onScheduleEnded = cb
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
      this.gain.gain.value = 1
    }
    return this.ctx
  }

  async loadFromUrl(url: string): Promise<void> {
    if (this.isLoadedForUrl(url)) return
    if (this.pendingLoad?.url === url) return this.pendingLoad.promise
    this.pendingLoad?.controller.abort()
    const request = ++this.loadRequest
    this.stopPlayback()
    this.buffer = null
    this.pcmInfo = null
    this.loadedFromUrl = null
    const ctx = this.ensureContext()
    const controller = new AbortController()
    const current = () => request === this.loadRequest && ctx === this.ctx && !controller.signal.aborted
    const promise = (async () => {
      if (this.pcmReader) {
        const info=await this.pcmReader(url,[])
        if (!current()) return
        if (info.sampleRate!==48000 || info.channels!==2 || !Number.isSafeInteger(info.totalFrames) || info.totalFrames<=0) throw new Error('유효하지 않은 준비 오디오입니다.')
        this.pcmInfo=info
        this.loadedFromUrl=url
        return
      }
      const res = await fetch(url, {signal: controller.signal})
      if (!current()) return
      if (!res.ok) throw new Error(`WebAudio load failed: ${res.status}`)
      const arr = await res.arrayBuffer()
      if (!current()) return
      // decodeAudioData owns this buffer. A full WAV copy doubles peak memory.
      const buf = await ctx.decodeAudioData(arr)
      if (!current()) return
      this.buffer = buf
      this.loadedFromUrl = url
    })()
    const job = {url, controller, promise}
    this.pendingLoad = job
    try { await promise } finally { if (this.pendingLoad === job) this.pendingLoad = null }
  }

  /**
   * segments: EDL 에서 나온 미디어 파일 상의 재생 조각들(순서대로).
   * startMediaSec: 첫 조각 안에서 실제 시작할 미디어 시각(포함).
   * endMediaSec: one-shot 등에서 상한(미포함에 가깝게 clamp). continuous 는 null.
   */
  async scheduleFromEdl(
    segments: ScheduledMediaSegment[],
    startMediaSec: number,
    endMediaSec: number | null
  ): Promise<void> {
    const ctx = this.ensureContext()
    this.stopPlayback()
    const request = this.playbackRequest
    await ctx.resume()
    if (request !== this.playbackRequest || ctx !== this.ctx) return
    if (ctx.state !== 'running') throw new Error('Audio context is not running')
    if (this.pcmReader && this.pcmInfo && this.loadedFromUrl) {
      const stream=new PcmStreamPlayback(ctx,this.gain!,this.pcmReader)
      this.stream=stream
      const id=++this.scheduleSeq
      await stream.start(this.loadedFromUrl,this.pcmInfo,segments,startMediaSec,endMediaSec,
        ()=>this.onScheduleEnded?.(id,'natural'), error=>this.onPlaybackError?.(error))
      return
    }
    const buf = this.buffer
    if (!buf || segments.length === 0) return

    const bufDur = buf.duration
    const pieces: Array<{ mediaStartSec: number; durationSec: number }> = []
    const endLimit = endMediaSec == null ? Number.POSITIVE_INFINITY : Math.max(0, endMediaSec)
    let startApplied = false
    const startAt = Math.max(0, startMediaSec)

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!
      let s = Math.max(0, seg.startMediaSec)
      let e = Math.min(seg.endMediaSec, bufDur)
      if (endMediaSec != null) e = Math.min(e, endLimit)
      if (!startApplied) {
        if (startAt >= e - EPS) continue
        s = Math.max(s, startAt)
        startApplied = true
      }
      if (e <= s + EPS) continue
      pieces.push({ mediaStartSec: s, durationSec: e - s })
    }

    if (pieces.length === 0) return

    let wall = ctx.currentTime + SCHEDULE_LOOKAHEAD_SEC
    this.timeline = []
    this.activeSources = []
    this.scheduleSeq += 1
    const thisScheduleId = this.scheduleSeq

    try {
      for (const p of pieces) {
        const dur = Math.min(p.durationSec, Math.max(0, bufDur - p.mediaStartSec))
        if (dur <= EPS) continue
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.connect(this.gain!)
        this.timeline.push({ ctxStart: wall, mediaStartSec: p.mediaStartSec, durationSec: dur })
        this.activeSources.push(src)
        src.start(wall, p.mediaStartSec, dur)
        src.onended = () => {
          const idx = this.activeSources.indexOf(src)
          if (idx >= 0) this.activeSources.splice(idx, 1)
          if (this.activeSources.length === 0 && this.scheduleSeq === thisScheduleId) {
            /**
             * 마지막 BufferSource 종료 — 이 스케줄이 자연 종료된 경우(외부 `stopPlayback` 으로 갈아탄
             * 것이 아닌 경우)에만 콜백 1회 통지. `scheduleSeq` 가 그대로면 stop 도 새 스케줄도 안 일어났다.
             */
            const last = this.timeline.at(-1)!
            this.cancelDrain = waitForAudioOutput(ctx, last.ctxStart + last.durationSec, () => {
              if (this.scheduleSeq !== thisScheduleId) return
              this.playingFlag = false
              this.onScheduleEnded?.(thisScheduleId, 'natural')
            })
          }
        }
        wall += dur
      }
      if (this.activeSources.length > 0) this.playingFlag = true
    } catch (error) {
      this.stopPlayback()
      throw error
    }
  }

  /** Output device clock mapped back to source-media seconds. */
  getCurrentMediaSec(ctxNow?: number): number | null {
    if (this.stream) return this.stream.currentMediaSec(ctxNow)
    const ctx = this.ctx
    if (!ctx || !this.playingFlag || this.timeline.length === 0) return null
    const now = ctxNow ?? audioOutputTime(ctx)
    for (const frag of this.timeline) {
      const fragEnd = frag.ctxStart + frag.durationSec
      if (now + 1e-4 < frag.ctxStart) return null
      if (now < fragEnd + 1e-4) return frag.mediaStartSec + Math.max(0, now - frag.ctxStart)
    }
    const last = this.timeline[this.timeline.length - 1]!
    return last.mediaStartSec + last.durationSec
  }

  stopPlayback(): void {
    this.playbackRequest += 1
    this.cancelDrain?.()
    this.cancelDrain = null
    const hadActive = this.playingFlag || this.activeSources.length > 0 || this.stream?.isPlaying() === true
    this.stream?.stop()
    this.stream=null
    const stoppedScheduleId = this.scheduleSeq
    for (const n of this.activeSources) {
      n.onended = null
      try {
        n.stop(0)
      } catch {
        /* already stopped */
      }
      try {
        n.disconnect()
      } catch {
        /* ignore */
      }
    }
    this.activeSources = []
    this.timeline = []
    this.playingFlag = false
    if (hadActive) {
      const cb = this.onScheduleEnded
      if (cb) cb(stoppedScheduleId, 'stopped')
    }
  }

  dispose(): void {
    this.pendingLoad?.controller.abort()
    this.pendingLoad = null
    this.loadRequest += 1
    this.stopPlayback()
    try {
      this.ctx?.close()
    } catch {
      /* ignore */
    }
    this.ctx = null
    this.gain = null
    this.buffer = null
    this.loadedFromUrl = null
    this.pcmInfo=null
  }
}
