import type { SegmentOptions } from 'peaks.js'
import type { Word } from './components/vrewPeaksEditor/types'

/** 정렬된 flat 리스트에서 id·개수가 같을 때만 Peaks segment.update 증분 갱신 가능 */
export function canIncrementalWordList(prev: Word[] | null, next: Word[]): boolean {
  if (!prev || prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i++) {
    if (prev[i]!.id !== next[i]!.id) return false
  }
  return true
}

/**
 * Peaks.js: segment.update() 는 markers/overlay 를 바꾸지 못함 — 이런 차이는 removeAll+재삽입 필요.
 */
export function segmentOptionsRequireFullRebuild(a: SegmentOptions, b: SegmentOptions): boolean {
  return (a.markers ?? false) !== (b.markers ?? false) || (a.overlay ?? false) !== (b.overlay ?? false)
}

export function segmentOptionsPeaksUpdateEqual(a: SegmentOptions, b: SegmentOptions, eps: number): boolean {
  return (
    Math.abs(a.startTime - b.startTime) < eps &&
    Math.abs(a.endTime - b.endTime) < eps &&
    a.editable === b.editable &&
    a.color === b.color &&
    a.waveformColor === b.waveformColor &&
    a.borderColor === b.borderColor &&
    (a.labelText ?? '') === (b.labelText ?? '')
  )
}

/** markers/overlay 제외 — patchWordSegmentHighlight 과 동일한 제약 */
export function segmentOptionsUpdatePayload(opts: SegmentOptions): Partial<SegmentOptions> {
  return {
    startTime: opts.startTime,
    endTime: opts.endTime,
    editable: opts.editable,
    color: opts.color,
    waveformColor: opts.waveformColor,
    borderColor: opts.borderColor,
    labelText: opts.labelText ?? ''
  }
}
