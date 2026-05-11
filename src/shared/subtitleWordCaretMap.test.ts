import { describe, expect, it } from 'vitest'
import {
  nearestValidStorageCaret,
  renderableCaretToStorageCaret,
  storageCaretToRenderableCaret,
  visibleWordStorageIndices
} from './subtitleWordCaretMap'
import type { SubtitleWord } from './subtitles'

describe('subtitleWordCaretMap', () => {
  it('tombstone 연속 구간의 캐럿을 유효 경계로 스냅', () => {
    const words: SubtitleWord[] = [
      { start: 0, end: 1, word: 'a' },
      { start: 1, end: 2, word: 'b', isDeleted: true },
      { start: 2, end: 3, word: 'c', isDeleted: true },
      { start: 3, end: 4, word: 'd' }
    ]
    expect(nearestValidStorageCaret(words, 2)).toBe(1)
    expect(nearestValidStorageCaret(words, 3)).toBe(3)
  })

  it('renderable ↔ storage 라운드트립', () => {
    const words: SubtitleWord[] = [
      { start: 0, end: 1, word: 'a', isDeleted: true },
      { start: 1, end: 2, word: 'b' },
      { start: 2, end: 3, word: 'c' }
    ]
    const vis = visibleWordStorageIndices(words)
    expect(vis).toEqual([1, 2])
    expect(renderableCaretToStorageCaret(words, 0)).toBe(1)
    expect(storageCaretToRenderableCaret(words, 1)).toBe(0)
    expect(storageCaretToRenderableCaret(words, 3)).toBe(2)
  })
})
