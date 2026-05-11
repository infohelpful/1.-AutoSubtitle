import {
  findBlockIndexByRealMs,
  nextBlockIndexInVirtualOrder,
  type VirtualBlockMs
} from './blockMapping'

/** 단어/문장 블록 — 삭제된 항목은 재생 시 건너뜀 */
export type WordTimelineBlockMs = VirtualBlockMs & {
  isDeleted?: boolean
}

/**
 * `isDeleted !== true` 인 블록만 남긴 뒤 가상 오름차순 정렬.
 * (가상 구간 v는 이미 압축된 편집 타임라인이라고 가정)
 */
export function playbackWordBlocks(blocks: readonly WordTimelineBlockMs[]): VirtualBlockMs[] {
  return [...blocks]
    .filter((b) => b.isDeleted !== true)
    .sort((a, b) => a.vStartMs - b.vStartMs || a.oStartMs - b.oStartMs)
    .map(({ isDeleted: _d, ...rest }) => rest)
}

export type JumpCutCheckResult = {
  /** 점프 후 넣을 값 — 초 단위 (데드밴드 포함) */
  targetSec: number
}

/**
 * 재생 중 원본 미디어 시각이 현재 재생 블록의 o_end 근처면, 가상 순서상 다음 블록의 o_start(+ε)로 점프.
 * ε(`deadbandSec`)는 브라우저 정밀도로 인한 점프→되돌아옴 루프를 줄인다.
 */
export function checkJumpCutAtRealMs(
  realTimeMs: number,
  blocksByV: readonly VirtualBlockMs[],
  blocksByO: readonly VirtualBlockMs[],
  tailMs: number,
  deadbandSec: number
): JumpCutCheckResult | null {
  if (blocksByV.length < 2) return null

  const iv = findBlockIndexByRealMs(realTimeMs, blocksByO)
  if (iv < 0) return null
  const b = blocksByO[iv]!
  if (realTimeMs < b.oEndMs - tailMs) return null

  const curIdx = blocksByV.indexOf(b as VirtualBlockMs)
  if (curIdx < 0) return null
  const nextIdx = nextBlockIndexInVirtualOrder(blocksByV, curIdx)
  if (nextIdx == null) return null
  const nb = blocksByV[nextIdx]!
  const targetSec = Math.max(0, nb.oStartMs / 1000 + deadbandSec)
  return { targetSec }
}
