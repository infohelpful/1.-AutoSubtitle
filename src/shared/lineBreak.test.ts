import { describe, expect, it } from 'vitest'
import {
  breakSubtitleLine,
  breakSubtitleLines,
  partitionLineAtSpeechBoundaries,
  textDisplayUnits
} from './lineBreak'
import { displayTextFromSubtitleWords, type SubtitleLine, type SubtitleWord } from './subtitles'

/** 각 단어 0.5초, 단어 사이 `gap`초 */
function lineOf(tokens: string[], gap = 0, t0 = 0): SubtitleLine {
  const words: SubtitleWord[] = []
  let t = t0
  for (const [i, word] of tokens.entries()) {
    words.push({ start: t, end: t + 0.5, word, id: `w${i}` })
    t += 0.5 + gap
  }
  return {
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text: displayTextFromSubtitleWords(words),
    words
  }
}

const texts = (lines: SubtitleLine[]): string[] => lines.map((l) => l.text)

describe('textDisplayUnits', () => {
  it('counts Hangul as 1 and ASCII as 0.5', () => {
    expect(textDisplayUnits('안녕')).toBe(2)
    expect(textDisplayUnits('ab')).toBe(1)
    expect(textDisplayUnits('안녕 ab')).toBe(2 + 0.5 + 1)
  })
})

describe('breakSubtitleLine', () => {
  it('keeps a short line as the same reference', () => {
    const line = lineOf(['안녕하세요', '여러분'])
    const out = breakSubtitleLine(line, { maxUnits: 20 })
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(line)
  })

  it('splits a long line into balanced lines within the limit', () => {
    // 6 어절 × 4글자 = 24 + 공백 2.5 = 26.5 → 한도 14 면 2줄(13)씩
    const line = lineOf(['가나다라', '마바사아', '자차카타', '파하가나', '다라마바', '사아자차'])
    const out = breakSubtitleLine(line, { maxUnits: 14 })
    expect(out.length).toBeGreaterThanOrEqual(2)
    for (const piece of out) expect(textDisplayUnits(piece.text)).toBeLessThanOrEqual(14)
    expect(texts(out).join(' ')).toBe(line.text)
  })

  it('does not reorder or alter words and preserves ids', () => {
    const line = lineOf(['가나다라', '마바사아', '자차카타', '파하가나'])
    const out = breakSubtitleLine(line, { maxUnits: 9 })
    const flat = out.flatMap((l) => l.words ?? [])
    expect(flat).toEqual(line.words)
  })

  it('breaks at sentence end even when the line is short', () => {
    const line = lineOf(['안녕하세요.', '반갑습니다'])
    const out = breakSubtitleLine(line, { maxUnits: 40 })
    expect(texts(out)).toEqual(['안녕하세요.', '반갑습니다'])
  })

  it('can disable sentence-end breaks', () => {
    const line = lineOf(['안녕하세요.', '반갑습니다'])
    const out = breakSubtitleLine(line, { maxUnits: 40, breakAtSentenceEnd: false })
    expect(out).toHaveLength(1)
  })

  it('prefers a long pause as the break point', () => {
    // 균형상 어디서 나눠도 비슷한 6 어절 중, 3번째와 4번째 사이만 1초 쉰다.
    const tokens = ['가나다라', '마바사아', '자차카타', '파하가나', '다라마바', '사아자차']
    const words: SubtitleWord[] = []
    let t = 0
    tokens.forEach((word, i) => {
      words.push({ start: t, end: t + 0.5, word })
      t += 0.5 + (i === 2 ? 1 : 0)
    })
    const line: SubtitleLine = {
      start: 0,
      end: words[5]!.end,
      text: displayTextFromSubtitleWords(words),
      words
    }
    const out = breakSubtitleLine(line, { maxUnits: 14 })
    expect(texts(out)).toEqual(['가나다라 마바사아 자차카타', '파하가나 다라마바 사아자차'])
  })

  it('can force a break at a hard pause', () => {
    const line = lineOf(['가', '나', '다', '라'], 0)
    line.words![2] = { ...line.words![2]!, start: 3, end: 3.5 }
    line.words![3] = { ...line.words![3]!, start: 3.5, end: 4 }
    const out = breakSubtitleLine(line, { maxUnits: 40, hardPauseSec: 1 })
    expect(texts(out)).toEqual(['가 나', '다 라'])
  })

  it('keeps a single over-long word on its own line', () => {
    const line = lineOf(['가나다라마바사아자차카타', '하'])
    const out = breakSubtitleLine(line, { maxUnits: 5 })
    expect(texts(out)).toEqual(['가나다라마바사아자차카타', '하'])
  })

  it('attaches silence and deleted words to the preceding line', () => {
    const base = lineOf(['가나다라', '마바사아', '자차카타', '파하가나'])
    const words: SubtitleWord[] = [
      base.words![0]!,
      base.words![1]!,
      { start: 1, end: 1.4, word: '--', isSilence: true },
      { ...base.words![2]!, start: 1.4, end: 1.9 },
      { start: 1.9, end: 2.2, word: '삭제', isDeleted: true },
      { ...base.words![3]!, start: 2.2, end: 2.7 }
    ]
    const line: SubtitleLine = { start: 0, end: 2.7, text: displayTextFromSubtitleWords(words), words }
    const out = breakSubtitleLine(line, { maxUnits: 9 })
    expect(out.flatMap((l) => l.words ?? [])).toEqual(words)
    expect(out.length).toBeGreaterThan(1)
    // 줄 시간은 연속이며 각 줄의 시작은 다음 줄 첫 단어 시작 이하
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.start)
    }
  })

  it('leaves lines without words and deleted lines untouched', () => {
    const noWords: SubtitleLine = { start: 0, end: 1, text: '가나다라마바사아자차카타' }
    const deleted: SubtitleLine = { ...lineOf(['가', '나']), isDeleted: true }
    expect(breakSubtitleLine(noWords, { maxUnits: 3 })).toEqual([noWords])
    expect(breakSubtitleLine(deleted, { maxUnits: 1 })).toEqual([deleted])
  })
})

describe('breakSubtitleLines', () => {
  it('reports stats and flattens results', () => {
    const lines = [
      lineOf(['짧은', '줄']),
      lineOf(['가나다라', '마바사아', '자차카타', '파하가나'], 0, 10)
    ]
    const { lines: out, stats } = breakSubtitleLines(lines, { maxUnits: 9 })
    expect(stats.brokenLineCount).toBe(1)
    expect(stats.addedLineCount).toBe(out.length - 2)
    expect(out[0]).toBe(lines[0])
  })

  it('returns an equal array when nothing needs breaking', () => {
    const lines = [lineOf(['짧은', '줄'])]
    const { lines: out, stats } = breakSubtitleLines(lines, { maxUnits: 20 })
    expect(stats.brokenLineCount).toBe(0)
    expect(out).toEqual(lines)
  })
})

describe('partitionLineAtSpeechBoundaries', () => {
  it('returns null for empty or out-of-range boundaries', () => {
    const line = lineOf(['가', '나', '다'])
    expect(partitionLineAtSpeechBoundaries(line, [])).toBeNull()
    expect(partitionLineAtSpeechBoundaries(line, [0, 3, 9])).toBeNull()
  })

  it('splits at the given speech word', () => {
    const line = lineOf(['가', '나', '다'])
    const parts = partitionLineAtSpeechBoundaries(line, [1])!
    expect(texts(parts)).toEqual(['가', '나 다'])
    expect(parts[0]!.end).toBe(0.5)
    expect(parts[1]!.start).toBe(0.5)
  })
})
