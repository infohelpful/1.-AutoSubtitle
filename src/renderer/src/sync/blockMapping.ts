/**
 * 가상 타임라인(ms) ↔ 원본 미디어(ms) 매핑.
 * 모든 시각 인자는 정수 밀리초(number | integer)로 통일한다.
 */

export type VirtualBlockMs = {
  /** 가상 구간 시작 ms (포함) */
  vStartMs: number
  /** 가상 구간 끝 ms (배타적일 수 있음 — 아래 findBlockIndex 규약 참고) */
  vEndMs: number
  /** 원본 미디어 구간 시작 ms */
  oStartMs: number
  /** 원본 미디어 구간 끝 ms */
  oEndMs: number
}

/** 블록이 v 축 기준으로 정렬되어 있는지 검사 */
export function assertSortedByVirtual(blocks: readonly VirtualBlockMs[]): void {
  for (let i = 1; i < blocks.length; i += 1) {
    const a = blocks[i - 1]!
    const b = blocks[i]!
    if (b.vStartMs < a.vStartMs) {
      throw new Error('virtual_blocks must be sorted by vStartMs ascending')
    }
  }
}

/** 블록이 o 축 기준으로 정렬되어 있는지 검사 (mapR2V 이진 탐색용) */
export function assertSortedByOriginal(blocks: readonly VirtualBlockMs[]): void {
  for (let i = 1; i < blocks.length; i += 1) {
    const a = blocks[i - 1]!
    const b = blocks[i]!
    if (b.oStartMs < a.oStartMs) {
      throw new Error('virtual_blocks must be sorted by oStartMs ascending for real-axis binary search')
    }
  }
}

/**
 * `vStartMs <= virtualTimeMs < vEndMs` 인 블록 인덱스. 없으면 -1.
 * 가상 구간은 반열린 구간 [vStart, vEnd) 로 본다.
 */
export function findBlockIndex(virtualTimeMs: number, blocks: readonly VirtualBlockMs[]): number {
  const t = Math.floor(virtualTimeMs)
  let lo = 0
  let hi = blocks.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const b = blocks[mid]!
    if (t < b.vStartMs) {
      hi = mid - 1
    } else if (t >= b.vEndMs) {
      lo = mid + 1
    } else {
      return mid
    }
  }
  return -1
}

/**
 * 원본 미디어 시간이 속한 블록 (반열린 [oStart, oEnd)).
 * `blocks`는 oStartMs 오름차순이어야 한다.
 */
export function findBlockIndexByRealMs(realTimeMs: number, blocks: readonly VirtualBlockMs[]): number {
  const t = Math.floor(realTimeMs)
  let lo = 0
  let hi = blocks.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const b = blocks[mid]!
    if (t < b.oStartMs) {
      hi = mid - 1
    } else if (t >= b.oEndMs) {
      lo = mid + 1
    } else {
      return mid
    }
  }
  return -1
}

/**
 * T_real = o_start + (T_virtual - v_start)
 */
export function mapV2R(virtualTimeMs: number, blocks: readonly VirtualBlockMs[]): number | null {
  const i = findBlockIndex(virtualTimeMs, blocks)
  if (i < 0) return null
  const b = blocks[i]!
  return b.oStartMs + (virtualTimeMs - b.vStartMs)
}

export function mapR2V(realTimeMs: number, blocksByOriginal: readonly VirtualBlockMs[]): number | null {
  const i = findBlockIndexByRealMs(realTimeMs, blocksByOriginal)
  if (i < 0) return null
  const b = blocksByOriginal[i]!
  return b.vStartMs + (realTimeMs - b.oStartMs)
}

/** 재생 순서(가상 타임라인 순)에서 i 다음 블록 인덱스 — blocksSortedByV 기준 */
export function nextBlockIndexInVirtualOrder(
  blocksSortedByV: readonly VirtualBlockMs[],
  currentIndex: number
): number | null {
  if (currentIndex < 0 || currentIndex >= blocksSortedByV.length - 1) return null
  return currentIndex + 1
}
