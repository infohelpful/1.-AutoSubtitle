import { expect, it } from 'vitest'
import { deleteTextGrapheme } from './deleteTextGrapheme'

it('deletes Korean characters and boundary spaces individually', () => {
  expect(deleteTextGrapheme('오늘 날씨', 2, 'Backspace')).toEqual({ text: '오 날씨', caret: 1 })
  expect(deleteTextGrapheme('오늘 날씨', 3, 'Backspace')).toEqual({ text: '오늘날씨', caret: 2 })
  expect(deleteTextGrapheme('오늘 날씨', 3, 'Delete')).toEqual({ text: '오늘 씨', caret: 3 })
})
it('preserves grapheme integrity and handles text boundaries', () => {
  expect(deleteTextGrapheme('가👨‍👩‍👧나', 1, 'Delete')).toEqual({ text: '가나', caret: 1 })
  expect(deleteTextGrapheme('가', 0, 'Backspace')).toEqual({ text: '가', caret: 0 })
  expect(deleteTextGrapheme('가', 1, 'Delete')).toEqual({ text: '가', caret: 1 })
})
