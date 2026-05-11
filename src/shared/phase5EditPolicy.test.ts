import { describe, expect, it } from 'vitest'
import { SILENCE_PLACEHOLDER_TEXT } from './wordContract'
import { removeSilenceWordsFromSubtitleLines, shouldFillGapsWhenBuildingVrewRows } from './phase5EditPolicy'

describe('shouldFillGapsWhenBuildingVrewRows', () => {
  it('사용자가 gap-fill 을 켰고 tombstone 이 없으면 true', () => {
    expect(shouldFillGapsWhenBuildingVrewRows(true, false)).toBe(true)
  })

  it('tombstone 이 있으면 사용자 설정과 무관하게 false', () => {
    expect(shouldFillGapsWhenBuildingVrewRows(true, true)).toBe(false)
    expect(shouldFillGapsWhenBuildingVrewRows(false, true)).toBe(false)
  })

  it('gap-fill 플래그가 꺼져 있으면 false', () => {
    expect(shouldFillGapsWhenBuildingVrewRows(false, false)).toBe(false)
  })
})

describe('removeSilenceWordsFromSubtitleLines', () => {
  it('isSilence 단어만 제거하고 보이는 단어 구간·텍스트를 맞춘다', () => {
    const out = removeSilenceWordsFromSubtitleLines([
      {
        start: 0,
        end: 4,
        text: 'a b',
        words: [
          { start: 0, end: 1, word: 'a' },
          { start: 1, end: 2, word: SILENCE_PLACEHOLDER_TEXT, isSilence: true },
          { start: 2, end: 4, word: 'b' }
        ]
      }
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.words).toEqual([
      { start: 0, end: 1, word: 'a' },
      { start: 2, end: 4, word: 'b' }
    ])
    expect(out[0]!.start).toBe(0)
    expect(out[0]!.end).toBe(4)
    expect(out[0]!.text).toBe('a b')
  })

  it('isDeleted tombstone 은 words 에 유지하고 start/end 는 보이는 단어만 반영', () => {
    const out = removeSilenceWordsFromSubtitleLines([
      {
        start: 0,
        end: 10,
        text: 'x',
        words: [
          { start: 0, end: 1, word: 'del', isDeleted: true },
          { start: 1, end: 2, word: SILENCE_PLACEHOLDER_TEXT, isSilence: true },
          { start: 2, end: 4, word: 'hi' }
        ]
      }
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.words).toEqual([
      { start: 0, end: 1, word: 'del', isDeleted: true },
      { start: 2, end: 4, word: 'hi' }
    ])
    expect(out[0]!.start).toBe(2)
    expect(out[0]!.end).toBe(4)
    expect(out[0]!.text).toBe('hi')
  })

  it('무음만 있던 줄은 제외한다', () => {
    const out = removeSilenceWordsFromSubtitleLines([
      {
        start: 0,
        end: 2,
        text: '--',
        words: [{ start: 0, end: 2, word: SILENCE_PLACEHOLDER_TEXT, isSilence: true }]
      }
    ])
    expect(out).toHaveLength(0)
  })
})
