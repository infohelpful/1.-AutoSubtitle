import { describe, expect, it } from 'vitest'

import { splitWordTextAtMediaCut } from './subtitleWordTextSplit'

describe('splitWordTextAtMediaCut', () => {
  it('splits Korean syllables by time fraction inside the word span', () => {
    /** "영상을" on [1.0, 2.0] — cut at 1.333 → 앞 1/3 구간 */
    const { left, right } = splitWordTextAtMediaCut('영상을', 1.0, 2.0, 1.333333333)
    expect(left).toBe('영')
    expect(right).toBe('상을')
  })

  it('full span yields empty left or empty right at boundaries', () => {
    expect(splitWordTextAtMediaCut('abc', 0, 1, 0).left).toBe('')
    expect(splitWordTextAtMediaCut('abc', 0, 1, 1).right).toBe('')
  })
})
