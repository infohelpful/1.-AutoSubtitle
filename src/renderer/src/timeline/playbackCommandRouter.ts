export type PlaybackCommandKind = 'seek' | 'seekAndPlay' | 'playRange' | 'togglePlay'

type PlayRangeLock = {
  startMediaSec: number
  endMediaSec: number
  sessionId: number
}

export type PlaybackCommandDecision =
  | { allowed: true; sessionId: number }
  | { allowed: false; reason: 'mapper-stale' | 'range-locked' }

export type PlaybackRouterSnapshot = {
  sessionId: number
  mappingPendingRevision: number
  mappingCommittedRevision: number
  activeRange: PlayRangeLock | null
}

export class PlaybackCommandRouter {
  private sessionId = 0
  private mappingPendingRevision = 0
  private mappingCommittedRevision = 0
  private activeRange: PlayRangeLock | null = null

  setMappingRevision(pending: number, committed: number): void {
    this.mappingPendingRevision = Math.max(0, pending)
    this.mappingCommittedRevision = Math.max(0, committed)
  }

  isMapperReady(): boolean {
    return this.mappingCommittedRevision >= this.mappingPendingRevision
  }

  beginSeekLike(kind: Exclude<PlaybackCommandKind, 'playRange'>): PlaybackCommandDecision {
    if (!this.isMapperReady()) return { allowed: false, reason: 'mapper-stale' }
    this.sessionId += 1
    // Any direct seek/play invalidates one-shot range lock.
    this.activeRange = null
    return { allowed: true, sessionId: this.sessionId }
  }

  beginPlayRange(startMediaSec: number, endMediaSec: number): PlaybackCommandDecision {
    if (!this.isMapperReady()) return { allowed: false, reason: 'mapper-stale' }
    const cur = this.activeRange
    if (
      cur &&
      Math.abs(cur.startMediaSec - startMediaSec) < 0.01 &&
      Math.abs(cur.endMediaSec - endMediaSec) < 0.01
    ) {
      return { allowed: false, reason: 'range-locked' }
    }
    this.sessionId += 1
    this.activeRange = {
      startMediaSec,
      endMediaSec,
      sessionId: this.sessionId
    }
    return { allowed: true, sessionId: this.sessionId }
  }

  finishRange(sessionId: number): void {
    if (!this.activeRange) return
    if (this.activeRange.sessionId !== sessionId) return
    this.activeRange = null
  }

  cancelSession(sessionId: number): void {
    if (this.sessionId !== sessionId) return
    if (this.activeRange?.sessionId === sessionId) {
      this.activeRange = null
    }
  }

  snapshot(): PlaybackRouterSnapshot {
    return {
      sessionId: this.sessionId,
      mappingPendingRevision: this.mappingPendingRevision,
      mappingCommittedRevision: this.mappingCommittedRevision,
      activeRange: this.activeRange
    }
  }
}

export const createPlaybackCommandRouter = (): PlaybackCommandRouter => new PlaybackCommandRouter()
