/**
 * Task 1 — seeking 동안 UI 재생 헤드 고정, seeked 에서만 스냅.
 * 타임라인 스크럽 시 낙관적 UI + 비디오 currentTime 스로틀.
 */

export type VideoSeekUiControllerOptions = {
  /** 비디오에 할당할 currentTime 스로틀 (연속 드래그) */
  throttleMs?: number
  onSeekingChange?: (locked: boolean) => void
  /** seeked 직후 실제 미디어 ms — 최종 보정(Snap) */
  onSnapRealMs?: (realMs: number) => void
  /** 스크럽 중 즉시 반영할 가상 ms (낙관적) */
  onOptimisticVirtualMs?: (virtualMs: number) => void
}

export class VideoSeekUiController {
  private video: HTMLVideoElement
  private opts: VideoSeekUiControllerOptions
  private throttleMs: number
  private throttleTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRealSec: number | null = null
  private optimisticVirtualMs: number | null = null

  private boundSeeking = (): void => {
    this.opts.onSeekingChange?.(true)
  }

  private boundSeeked = (): void => {
    this.opts.onSeekingChange?.(false)
    const rMs = Math.round(this.video.currentTime * 1000)
    this.optimisticVirtualMs = null
    this.opts.onSnapRealMs?.(rMs)
  }

  constructor(video: HTMLVideoElement, options: VideoSeekUiControllerOptions = {}) {
    this.video = video
    this.opts = options
    this.throttleMs = options.throttleMs ?? 32
    video.addEventListener('seeking', this.boundSeeking)
    video.addEventListener('seeked', this.boundSeeked)
  }

  /** RAF 등에서 재생 헤드 커밋을 건너뛸지 — seeking 중 잠금 */
  get isPlayheadCommitLocked(): boolean {
    return this.video.seeking
  }

  get lastOptimisticVirtualMs(): number | null {
    return this.optimisticVirtualMs
  }

  updateOptions(patch: Partial<VideoSeekUiControllerOptions>): void {
    this.opts = { ...this.opts, ...patch }
    if (patch.throttleMs != null) this.throttleMs = Math.max(0, patch.throttleMs)
  }

  /**
   * 타임라인 드래그: 가상 시각은 즉시 낙관적 반영, `video.currentTime` 은 스로틀.
   * `mapVirtualToRealSec` 가 null 이면 비디오 시크 생략(UI만).
   */
  scrubVirtualMs(virtualMs: number, mapVirtualToRealSec: (vMs: number) => number | null): void {
    this.optimisticVirtualMs = virtualMs
    this.opts.onOptimisticVirtualMs?.(virtualMs)
    const realSec = mapVirtualToRealSec(virtualMs)
    if (realSec == null || !Number.isFinite(realSec)) return
    this.pendingRealSec = realSec

    if (this.throttleMs <= 0) {
      this.video.currentTime = Math.max(0, realSec)
      return
    }
    if (this.throttleTimer != null) {
      window.clearTimeout(this.throttleTimer)
    }
    this.throttleTimer = window.setTimeout(() => {
      this.throttleTimer = null
      if (this.pendingRealSec != null) {
        this.video.currentTime = Math.max(0, this.pendingRealSec)
      }
    }, this.throttleMs)
  }

  /** 즉시 시크(재생 위치 클릭 등) — 스로틀 없음, seeked 에서 스냅 */
  seekRealSecImmediate(realSec: number): void {
    if (this.throttleTimer != null) {
      window.clearTimeout(this.throttleTimer)
      this.throttleTimer = null
    }
    this.pendingRealSec = realSec
    this.video.currentTime = Math.max(0, realSec)
  }

  dispose(): void {
    if (this.throttleTimer != null) {
      window.clearTimeout(this.throttleTimer)
      this.throttleTimer = null
    }
    this.video.removeEventListener('seeking', this.boundSeeking)
    this.video.removeEventListener('seeked', this.boundSeeked)
  }
}
