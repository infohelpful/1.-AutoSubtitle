import type { ScheduledMediaSegment } from './playbackSchedule'

const EPS = 1e-4
const SCHEDULE_LOOKAHEAD_SEC = 0.06

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
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private buffer: AudioBuffer | null = null
  private loadedFromUrl: string | null = null
  private activeSources: AudioBufferSourceNode[] = []
  private timeline: WebAudioSchedulePiece[] = []
  private playingFlag = false

  get context(): AudioContext | null {
    return this.ctx
  }

  get decodedBuffer(): AudioBuffer | null {
    return this.buffer
  }

  isLoadedForUrl(url: string): boolean {
    return this.buffer != null && this.loadedFromUrl === url
  }

  isPlaying(): boolean {
    return this.playingFlag
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
    if (this.loadedFromUrl === url && this.buffer) return
    this.stopPlayback()
    const ctx = this.ensureContext()
    const res = await fetch(url)
    if (!res.ok) throw new Error(`WebAudio load failed: ${res.status}`)
    const arr = await res.arrayBuffer()
    const buf = await ctx.decodeAudioData(arr.slice(0))
    this.buffer = buf
    this.loadedFromUrl = url
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
    await ctx.resume().catch(() => undefined)
    this.stopPlayback()
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

    for (const p of pieces) {
      const dur = Math.min(p.durationSec, Math.max(0, bufDur - p.mediaStartSec))
      if (dur <= EPS) continue
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(this.gain!)
      this.timeline.push({ ctxStart: wall, mediaStartSec: p.mediaStartSec, durationSec: dur })
      src.start(wall, p.mediaStartSec, dur)
      this.activeSources.push(src)
      src.onended = () => {
        const idx = this.activeSources.indexOf(src)
        if (idx >= 0) this.activeSources.splice(idx, 1)
        if (this.activeSources.length === 0) {
          this.playingFlag = false
        }
      }
      wall += dur
    }
    if (this.activeSources.length > 0) this.playingFlag = true
  }

  /** AudioContext 현재 시각 기준 재생 중이면 해당 미디어 타임(sec), 아니면 null */
  getCurrentMediaSec(ctxNow?: number): number | null {
    const ctx = this.ctx
    if (!ctx || !this.playingFlag || this.timeline.length === 0) return null
    const now = ctxNow ?? ctx.currentTime
    for (const frag of this.timeline) {
      const fragEnd = frag.ctxStart + frag.durationSec
      if (now + 1e-4 < frag.ctxStart) return null
      if (now < fragEnd + 1e-4) return frag.mediaStartSec + Math.max(0, now - frag.ctxStart)
    }
    const last = this.timeline[this.timeline.length - 1]!
    return last.mediaStartSec + last.durationSec
  }

  stopPlayback(): void {
    for (const n of this.activeSources) {
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
  }

  dispose(): void {
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
  }
}
