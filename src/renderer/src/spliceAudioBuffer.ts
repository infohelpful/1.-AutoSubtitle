import type { CutRange } from '../../shared/ipc'
import { mergeCutRanges, mediaToEditTime } from '../../shared/timelineCollapse'

/**
 * [cutStartSec, cutEndSec) 구간을 잘라낸 새 AudioBuffer (원본은 변경하지 않음).
 */
export function spliceAudioBuffer(buffer: AudioBuffer, cutStartSec: number, cutEndSec: number): AudioBuffer {
  const rate = buffer.sampleRate
  const nS = Math.max(0, Math.min(Math.floor(cutStartSec * rate), buffer.length))
  const nE = Math.max(nS, Math.min(Math.ceil(cutEndSec * rate), buffer.length))
  const remove = nE - nS
  if (remove <= 0) return buffer
  const ch = buffer.numberOfChannels
  const outLen = buffer.length - remove
  const ctx = new AudioContext({ sampleRate: rate })
  try {
    const out = ctx.createBuffer(ch, outLen, rate)
    for (let c = 0; c < ch; c += 1) {
      const src = buffer.getChannelData(c)
      const dst = out.getChannelData(c)
      dst.set(src.subarray(0, nS))
      dst.set(src.subarray(nE), nS)
    }
    return out
  } finally {
    void ctx.close()
  }
}

/**
 * 디코딩이 늦게 끝나 `cutRanges`만 있고 버퍼는 풀 길이일 때 — 미디어 시간 삭제 구간을 순서대로 현재 버퍼(편집 축)에 적용.
 */
export function replayMediaCutsOnDecodedBuffer(buffer: AudioBuffer, cuts: readonly CutRange[]): AudioBuffer {
  const merged = mergeCutRanges([...cuts])
  if (merged.length === 0) return buffer
  let b = buffer
  let applied: CutRange[] = []
  for (const c of merged) {
    const es = mediaToEditTime(c.start, applied)
    const ee = mediaToEditTime(c.end, applied)
    if (ee > es + 1e-5) {
      b = spliceAudioBuffer(b, es, ee)
    }
    applied = mergeCutRanges([...applied, { start: c.start, end: c.end }])
  }
  return b
}
