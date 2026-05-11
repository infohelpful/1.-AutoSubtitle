import {
  assertSortedByOriginal,
  assertSortedByVirtual,
  findBlockIndex,
  findBlockIndexByRealMs,
  mapR2V,
  mapV2R,
  type VirtualBlockMs
} from './blockMapping'
import { checkJumpCutAtRealMs } from './wordJumpCut'

export type SyncPhase = 'playing' | 'seeking'

export type SyncTickContext = {
  virtualTimeMs: number
  realTimeMs: number
  blockIndexVirtual: number
  blockIndexReal: number
  phase: SyncPhase
}

export type SyncEngineOptions = {
  /** 가상 블록 (v 축 정렬 필수, mapR2V용으로 o 축 정렬 복제본 내부 유지) */
  blocks: VirtualBlockMs[]
  /** 매 프레임(playing). seeking 동안에는 호출되지 않을 수 있음 */
  onTick?: (ctx: SyncTickContext) => void
  /** seeked 직후 한 번 — 파동·자막 스냅 */
  onSeekSnap?: (ctx: SyncTickContext) => void
  /** o_end 근처에서 다음 블록 o_start 로 점프 (Jump-Cut) */
  jumpCutEnabled?: boolean
  /** seeking 이벤트 동안 onTick 억제 */
  suppressTickWhileVideoSeeking?: boolean
  /** 미디어 구간 끝 직전(ms) — 디코더 여유 */
  jumpCutTailMs?: number
  /** 점프 목표 o_start 에 더할 초 — 경계 데드락 방지 */
  jumpDeadbandSec?: number
}

const DEFAULT_TAIL_MS = 2
const DEFAULT_JUMP_DEADBAND_SEC = 0.001

function cloneSorted(blocks: readonly VirtualBlockMs[]): {
  byV: VirtualBlockMs[]
  byO: VirtualBlockMs[]
} {
  const byV = [...blocks].sort((a, b) => a.vStartMs - b.vStartMs || a.oStartMs - b.oStartMs)
  const byO = [...blocks].sort((a, b) => a.oStartMs - b.oStartMs || a.vStartMs - b.vStartMs)
  assertSortedByVirtual(byV)
  assertSortedByOriginal(byO)
  return { byV, byO }
}

function realMsFromVideo(video: HTMLVideoElement): number {
  const sec = video.currentTime
  if (!Number.isFinite(sec)) return 0
  return Math.round(sec * 1000)
}

/**
 * 비디오 currentTime 을 마스터로 두고, 파형·단어 UI를 RAF로 하드 싱크한다.
 * 시간 계산은 내부적으로 정수 ms 만 사용하고, video API 경계에서만 초↔ms 변환.
 */
export class SyncEngine {
  private video: HTMLVideoElement
  private blocksByV: VirtualBlockMs[] = []
  private blocksByO: VirtualBlockMs[] = []
  private onTick?: (ctx: SyncTickContext) => void
  private onSeekSnap?: (ctx: SyncTickContext) => void
  private jumpCutEnabled = true
  private suppressTickWhileVideoSeeking = true
  private jumpCutTailMs = DEFAULT_TAIL_MS
  private jumpDeadbandSec = DEFAULT_JUMP_DEADBAND_SEC

  private rafId: number | null = null
  private running = false
  private phase: SyncPhase = 'playing'

  private boundSeeking = (): void => {
    this.phase = 'seeking'
  }

  private boundSeeked = (): void => {
    this.phase = 'playing'
    this.emitSnap()
  }

  constructor(video: HTMLVideoElement, options: SyncEngineOptions) {
    this.video = video
    this.onTick = options.onTick
    this.onSeekSnap = options.onSeekSnap
    if (options.jumpCutEnabled === false) this.jumpCutEnabled = false
    if (options.suppressTickWhileVideoSeeking === false) this.suppressTickWhileVideoSeeking = false
    if (options.jumpCutTailMs != null) this.jumpCutTailMs = Math.max(0, options.jumpCutTailMs)
    if (options.jumpDeadbandSec != null) this.jumpDeadbandSec = Math.max(0, options.jumpDeadbandSec)
    this.setBlocks(options.blocks)
    video.addEventListener('seeking', this.boundSeeking)
    video.addEventListener('seeked', this.boundSeeked)
  }

  setBlocks(blocks: VirtualBlockMs[]): void {
    const { byV, byO } = cloneSorted(blocks)
    this.blocksByV = byV
    this.blocksByO = byO
  }

  updateOptions(patch: Partial<Pick<SyncEngineOptions, 'onTick' | 'onSeekSnap' | 'jumpCutEnabled'>>): void {
    if (patch.onTick !== undefined) this.onTick = patch.onTick
    if (patch.onSeekSnap !== undefined) this.onSeekSnap = patch.onSeekSnap
    if (patch.jumpCutEnabled !== undefined) this.jumpCutEnabled = patch.jumpCutEnabled
  }

  /** @internal 테스트용 */
  getBlocks(): { byV: VirtualBlockMs[]; byO: VirtualBlockMs[] } {
    return { byV: this.blocksByV, byO: this.blocksByO }
  }

  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      this.rafId = window.requestAnimationFrame(loop)
      this.tickFrame()
    }
    this.rafId = window.requestAnimationFrame(loop)
  }

  stop(): void {
    this.running = false
    if (this.rafId != null) {
      window.cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  dispose(): void {
    this.stop()
    this.video.removeEventListener('seeking', this.boundSeeking)
    this.video.removeEventListener('seeked', this.boundSeeked)
  }

  /**
   * 사용자가 단어 블록 등에서 가상 시각으로 점프할 때:
   * mapV2R → video.currentTime 설정. 파동/자막은 seeked 에서 onSeekSnap.
   */
  seekVirtualMs(virtualTimeMs: number): void {
    const r = mapV2R(virtualTimeMs, this.blocksByV)
    if (r == null) return
    this.video.currentTime = r / 1000
  }

  /** 원본 미디어 ms 로 직접 점프 */
  seekRealMs(realTimeMs: number): void {
    this.video.currentTime = Math.max(0, realTimeMs) / 1000
  }

  mapVirtualToRealMs(vMs: number): number | null {
    return mapV2R(vMs, this.blocksByV)
  }

  mapRealToVirtualMs(rMs: number): number | null {
    return mapR2V(rMs, this.blocksByO)
  }

  private emitSnap(): void {
    const ctx = this.buildContext('playing')
    this.onSeekSnap?.(ctx)
    this.onTick?.(ctx)
  }

  private buildContext(phase: SyncPhase): SyncTickContext {
    const realTimeMs = realMsFromVideo(this.video)
    const virtualTimeMs = mapR2V(realTimeMs, this.blocksByO) ?? 0
    const blockIndexVirtual = findBlockIndex(virtualTimeMs, this.blocksByV)
    const blockIndexReal = findBlockIndexByRealMs(realTimeMs, this.blocksByO)
    return {
      virtualTimeMs,
      realTimeMs,
      blockIndexVirtual,
      blockIndexReal,
      phase
    }
  }

  /**
   * Task 2 — 재생 중 호출: 현재 미디어 시각이 블록 꼬리면 다음 블록 o_start+ε 로 점프.
   * 단어 `isDeleted` 는 `setBlocks(playbackWordBlocks(...))` 로 이미 제외된 배열을 넘길 것.
   */
  checkJumpCut(currentTimeSec: number): boolean {
    const realTimeMs = Math.round(Math.max(0, currentTimeSec) * 1000)
    const cut = checkJumpCutAtRealMs(
      realTimeMs,
      this.blocksByV,
      this.blocksByO,
      this.jumpCutTailMs,
      this.jumpDeadbandSec
    )
    if (!cut) return false
    this.video.currentTime = cut.targetSec
    return true
  }

  private maybeJumpCut(realTimeMs: number): void {
    if (!this.jumpCutEnabled || this.blocksByV.length === 0) return
    if (this.video.paused) return
    const cut = checkJumpCutAtRealMs(
      realTimeMs,
      this.blocksByV,
      this.blocksByO,
      this.jumpCutTailMs,
      this.jumpDeadbandSec
    )
    if (cut) this.video.currentTime = cut.targetSec
  }

  private tickFrame(): void {
    const seeking = this.video.seeking
    if (seeking && this.suppressTickWhileVideoSeeking) {
      return
    }

    const realTimeMs = realMsFromVideo(this.video)
    this.maybeJumpCut(realTimeMs)

    const ctx = this.buildContext(seeking ? 'seeking' : 'playing')
    if (seeking && this.suppressTickWhileVideoSeeking) {
      return
    }
    this.onTick?.(ctx)
  }
}

export { mapV2R, mapR2V, findBlockIndex } from './blockMapping'
