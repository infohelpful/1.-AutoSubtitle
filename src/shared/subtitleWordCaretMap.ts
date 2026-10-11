import type { SubtitleWord } from './subtitles'
import { scrubTimelineNoiseFromWordPiece, shouldOmitFromSubtitleEditLineText } from './wordContract'

/** 스토리지 배열 기준 캐럿 — 경계 `c` 는 단어 `c` 앞 슬롯 (`c === words.length` 이면 마지막 뒤) */
export type StorageCaretIndex = number

/**
 * 삭제(tombstone)만 있는 연속 구간에 캐럿이 끼어 있으면 키보드·DOM 인덱스가 어긋난다.
 * 왼쪽 또는 오른쪽에 보이는 단어가 있는 경계로 스냅한다.
 */
export function nearestValidStorageCaret(
  words: readonly SubtitleWord[] | undefined,
  caret: StorageCaretIndex
): StorageCaretIndex {
  if (!words || words.length === 0) return 0
  const n = words.length
  let c = Math.max(0, Math.min(caret, n))

  const boundaryOk = (pos: number): boolean => {
    if (pos === 0 || pos === n) return true
    const leftAlive = words[pos - 1]?.isDeleted !== true
    const rightAlive = words[pos]?.isDeleted !== true
    return leftAlive || rightAlive
  }

  if (boundaryOk(c)) return c
  for (let d = 1; d <= n; d++) {
    const candidates: number[] = []
    if (c - d >= 0 && boundaryOk(c - d)) candidates.push(c - d)
    if (c + d <= n && boundaryOk(c + d)) candidates.push(c + d)
    if (candidates.length > 0) return Math.min(...candidates)
  }
  return 0
}

/** 보이는 단어 기준 캐럿 슬롯(0…visibleCount) → 스토리지 캐럿 */
export function renderableCaretToStorageCaret(
  words: readonly SubtitleWord[],
  renderableCaret: number
): StorageCaretIndex {
  const n = words.length
  let need = Math.max(0, renderableCaret)
  for (let i = 0; i <= n; i++) {
    if (i === n) return n
    if (words[i]?.isDeleted !== true) {
      if (need === 0) return i
      need -= 1
    }
  }
  return n
}

/** 스토리지 캐럿 → 보이는 단어 줄에서의 캐럿 인덱스(레이아웃·포커스 동기화용) */
export function storageCaretToRenderableCaret(
  words: readonly SubtitleWord[],
  storageCaret: StorageCaretIndex
): number {
  const n = words.length
  const c = Math.max(0, Math.min(storageCaret, n))
  let r = 0
  for (let i = 0; i < c; i++) {
    if (words[i]?.isDeleted !== true) r += 1
  }
  return r
}

/** 단어 칩 렌더용 — tombstone 제외한 스토리지 인덱스 목록 */
export function visibleWordStorageIndices(words: readonly SubtitleWord[] | undefined): number[] {
  if (!words) return []
  const out: number[] = []
  for (let i = 0; i < words.length; i++) {
    if (words[i]?.isDeleted !== true) out.push(i)
  }
  return out
}

/** 보이는 단어 경계만 따라 스토리지 캐럿 이동 (좌/우 키) */
export function stepStorageCaretByRenderable(
  words: readonly SubtitleWord[],
  storageCaret: StorageCaretIndex,
  deltaRenderable: number
): StorageCaretIndex {
  const rc = storageCaretToRenderableCaret(words, storageCaret)
  const m = visibleWordStorageIndices(words).length
  const nextRc = Math.max(0, Math.min(m, rc + deltaRenderable))
  return renderableCaretToStorageCaret(words, nextRc)
}

/**
 * 칩 사이 캐럿(스토리지 축) → 줄 텍스트창의 글자 오프셋.
 * 텍스트창 문자열은 `displayTextFromSubtitleWords` 와 같은 규칙(삭제·무음·장식 제거 후 공백 결합)이다.
 * 캐럿 왼쪽에 말 조각이 있으면 그 뒤 공백 다음(= 오른쪽 단어의 첫 글자 앞)을 가리킨다.
 */
export function textOffsetForStorageCaret(
  words: readonly SubtitleWord[] | undefined,
  caret: StorageCaretIndex
): number {
  if (!words || words.length === 0) return 0
  const c = Math.max(0, Math.min(caret, words.length))
  let pos = 0
  let any = false
  for (let i = 0; i < c; i += 1) {
    const w = words[i]!
    if (w.isDeleted === true || w.isSilence === true) continue
    const piece = scrubTimelineNoiseFromWordPiece(w.word)
    if (piece.length === 0 || shouldOmitFromSubtitleEditLineText(piece)) continue
    pos += (any ? 1 : 0) + piece.length
    any = true
  }
  return any ? pos + 1 : 0
}

/**
 * 줄 텍스트창의 글자 오프셋 → 가장 가까운 칩 사이 캐럿(스토리지 축). `textOffsetForStorageCaret` 의 역.
 * 말 조각이 하나도 없으면 0.
 */
export function storageCaretForTextOffset(
  words: readonly SubtitleWord[] | undefined,
  offset: number
): StorageCaretIndex {
  if (!words || words.length === 0) return 0
  const target = Math.max(0, offset)
  let pos = 0
  let any = false
  let best = -1
  let bestDist = Infinity
  const consider = (textOffset: number, caret: number): void => {
    const d = Math.abs(textOffset - target)
    if (d < bestDist) {
      bestDist = d
      best = caret
    }
  }
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!
    if (w.isDeleted === true || w.isSilence === true) continue
    const piece = scrubTimelineNoiseFromWordPiece(w.word)
    if (piece.length === 0 || shouldOmitFromSubtitleEditLineText(piece)) continue
    const start = any ? pos + 1 : 0
    consider(start, i)
    pos = start + piece.length
    any = true
  }
  if (!any) return 0
  consider(pos, words.length)
  return best < 0 ? 0 : best
}
