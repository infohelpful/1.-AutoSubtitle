/**
 * 단어 블록 안정 ID — 그룹(자막 카드/줄) × 줄 안 순번, 자르기 시 부모 ID에 세그먼트 번호를 덧붙임.
 * 예: 그룹 1에 단어 10개 → block_1_1 … block_1_10
 *     block_1_1 을 자르면 → block_1_1_1, block_1_1_2
 */
export function makeRowWordBlockId(group1Based: number, slot1Based: number): string {
  return `block_${group1Based}_${slot1Based}`
}

/** 부모 블록을 자른 조각 — `block_1_2` 의 1번째 조각 → `block_1_2_1` */
export function childBlockId(parentId: string, part1Based: number): string {
  return `${parentId}_${part1Based}`
}

/** 행 안 단어를 시간 순으로 `block_{group}_{1..n}` 으로 다시 매김 (전역 컷 등 이후, 계층 접미사 초기화) */
export function assignSequentialBlockIds<T extends { id: string }>(
  words: T[],
  group1Based: number
): T[] {
  return words.map((w, wi) => ({ ...w, id: makeRowWordBlockId(group1Based, wi + 1) }))
}
