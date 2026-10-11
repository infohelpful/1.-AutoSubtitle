import { describe, expect, it } from 'vitest'
import {
  nearestValidStorageCaret,
  renderableCaretToStorageCaret,
  storageCaretForTextOffset,
  storageCaretToRenderableCaret,
  textOffsetForStorageCaret,
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

describe('caret <-> text offset', () => {
  const words = [
    { start: 0, end: 1, word: '--', isSilence: true },
    { start: 1, end: 2, word: '먼저' },
    { start: 2, end: 3, word: '영상을' },
    { start: 3, end: 4, word: '삭제됨', isDeleted: true },
    { start: 4, end: 5, word: '불러오고' }
  ]
  // textarea text: "먼저 영상을 불러오고"
  it('maps a caret to the offset of the word on its right', () => {
    expect(textOffsetForStorageCaret(words, 0)).toBe(0)
    expect(textOffsetForStorageCaret(words, 1)).toBe(0)
    expect(textOffsetForStorageCaret(words, 2)).toBe('먼저 '.length)
    expect(textOffsetForStorageCaret(words, 4)).toBe('먼저 영상을 '.length)
    expect(textOffsetForStorageCaret(words, 5)).toBe('먼저 영상을 불러오고'.length + 1)
  })

  it('maps an offset back to the nearest caret between chips', () => {
    expect(storageCaretForTextOffset(words, 0)).toBe(1)
    expect(storageCaretForTextOffset(words, 3)).toBe(2)
    expect(storageCaretForTextOffset(words, '먼저 영상을 '.length)).toBe(4)
    expect(storageCaretForTextOffset(words, 999)).toBe(5)
  })

  it('round-trips caret slots that sit next to speech', () => {
    for (const caret of [1, 2, 4]) {
      expect(storageCaretForTextOffset(words, textOffsetForStorageCaret(words, caret))).toBe(caret)
    }
  })

  it('handles lines without speech', () => {
    expect(storageCaretForTextOffset([{ start: 0, end: 1, word: '--', isSilence: true }], 5)).toBe(0)
    expect(textOffsetForStorageCaret(undefined, 3)).toBe(0)
  })
})
