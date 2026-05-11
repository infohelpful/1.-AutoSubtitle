import { describe, expect, it } from 'vitest'
import { buildTimelineClips } from '../timeline/mapping'
import type { CutRange } from '../../../shared/ipc'
import { checkJumpCutAtRealMs, playbackWordBlocks, type WordTimelineBlockMs } from './wordJumpCut'

describe('checkJumpCutAtRealMs', () => {
  it('블록 꼬리에서 다음 블록 o_start+데드밴드 로 점프', () => {
    const cuts: CutRange[] = [{ start: 1, end: 2 }]
    const clips = buildTimelineClips(cuts, 10)
    const blocks = clips.map((c) => ({
      vStartMs: Math.round(c.editStart * 1000),
      vEndMs: Math.round(c.editEnd * 1000),
      oStartMs: Math.round(c.mediaStart * 1000),
      oEndMs: Math.round(c.mediaEnd * 1000)
    }))
    const tailMs = 50
    const deadband = 0.001
    const nearEnd = blocks[0]!.oEndMs - tailMs + 1
    const r = checkJumpCutAtRealMs(nearEnd, blocks, blocks, tailMs, deadband)
    expect(r).not.toBeNull()
    expect(r!.targetSec).toBeGreaterThan(blocks[1]!.oStartMs / 1000)
    expect(r!.targetSec).toBeCloseTo(blocks[1]!.oStartMs / 1000 + deadband, 5)
  })

  it('isDeleted 블록 제외 후 재생용 블록만으로 점프', () => {
    const blocks: WordTimelineBlockMs[] = [
      { vStartMs: 0, vEndMs: 1000, oStartMs: 0, oEndMs: 1000, isDeleted: false },
      { vStartMs: 1000, vEndMs: 2000, oStartMs: 1000, oEndMs: 2000, isDeleted: true },
      { vStartMs: 2000, vEndMs: 3000, oStartMs: 2000, oEndMs: 3000, isDeleted: false }
    ]
    const play = playbackWordBlocks(blocks)
    expect(play.length).toBe(2)
    const tailMs = 2
    const deadband = 0.001
    const r = checkJumpCutAtRealMs(play[0]!.oEndMs - 1, play, play, tailMs, deadband)
    expect(r).not.toBeNull()
    expect(r!.targetSec).toBeCloseTo(play[1]!.oStartMs / 1000 + deadband, 5)
  })
})
