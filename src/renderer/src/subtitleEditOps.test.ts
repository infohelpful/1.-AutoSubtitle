import { describe, expect, it } from 'vitest'
import { displayTextFromSubtitleWords, type SubtitleLine, type SubtitleWord } from '../../shared/subtitles'
import { splitLineAtCaretOnWordBoundary, splitSubtitleLine } from './subtitleEditOps'

function lineWithWords(tokens: Array<[string, number, number]>): SubtitleLine {
  const words: SubtitleWord[] = tokens.map(([word, start, end], i) => ({ word, start, end, id: `w${i}` }))
  return {
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text: displayTextFromSubtitleWords(words),
    words
  }
}

const line = lineWithWords([
  ['안녕하세요', 0, 1],
  ['여러분', 1.2, 1.8],
  ['반갑습니다', 2.5, 3.4]
])

describe('splitSubtitleLine — word boundary snapping', () => {
  it('snaps a caret inside a word to the nearest word boundary', () => {
    // "안녕하세요 여러분 반갑습니다": 여러분 은 오프셋 6~9. 캐럿 7(여|러분) → 경계 6 이 가장 가깝다.
    const out = splitSubtitleLine([line], 0, 7)
    expect(out.map((l) => l.text)).toEqual(['안녕하세요', '여러분 반갑습니다'])
    expect(out[0]!.end).toBe(1)
    expect(out[1]!.start).toBe(1.2)
  })

  it('keeps real word times and the natural pause between lines', () => {
    const out = splitSubtitleLine([line], 0, 10) // "여러분" 뒤
    expect(out.map((l) => l.text)).toEqual(['안녕하세요 여러분', '반갑습니다'])
    expect(out[0]!.end).toBe(1.8)
    expect(out[1]!.start).toBe(2.5)
    expect(out[0]!.words).toHaveLength(2)
    expect(out[1]!.words![0]!.id).toBe('w2')
  })

  it('falls back to the ratio split when the caret is at the very start', () => {
    const out = splitSubtitleLine([line], 0, 0)
    expect(out).toHaveLength(2)
    // 기존 동작 유지: 좌측이 비어 있다
    expect(out[0]!.text).toBe('')
  })

  it('falls back to the ratio split when the text was edited away from words', () => {
    const edited: SubtitleLine = { ...line, text: '안녕하세요 여러분 정말 반갑습니다' }
    expect(splitLineAtCaretOnWordBoundary(edited, 6)).toBeNull()
    const out = splitSubtitleLine([edited], 0, 6)
    expect(out).toHaveLength(2)
  })

  it('does not touch other lines', () => {
    const other = lineWithWords([['다음', 5, 6]])
    const out = splitSubtitleLine([other, line, other], 1, 10)
    expect(out).toHaveLength(4)
    expect(out[0]).toBe(other)
    expect(out[3]).toBe(other)
  })
})
