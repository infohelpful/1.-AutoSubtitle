import { describe, expect, it } from 'vitest'
import { adjacentGapContext } from './adjacentGapContext'

describe('adjacent gap waveform context', () => {
  it('reaches a following audio gap past empty absorbed rows, but not speech in another row', () => {
    const rows = [
      { id: 'a', words: [{ id: 'a', start: 0, end: 1, text: '그렇다고' }] },
      { id: 'empty', words: [] },
      { id: 'gap', words: [{ id: 'gap', start: 1, end: 3, text: '오디오', isSilence: true }] },
      { id: 'b', words: [{ id: 'b', start: 3, end: 4, text: '매번' }] }
    ]
    expect(adjacentGapContext(rows, 0, 0)).toEqual({ extendWindowEndToIncludeSec: 3 })
    expect(adjacentGapContext(rows, 3, 0)).toEqual({ extendWindowStartToIncludeSec: 1 })
    expect(adjacentGapContext([rows[0], rows[3]], 0, 0)).toEqual({})
  })
})
