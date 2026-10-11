/** Delete one visible character (including emoji and composed Hangul). */
export function deleteTextGrapheme(text: string, offset: number, key: 'Backspace' | 'Delete') {
  const caret = Math.max(0, Math.min(text.length, offset))
  const pieces = [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(text)]
  const piece = key === 'Backspace'
    ? pieces.filter(p => p.index < caret).at(-1)
    : pieces.find(p => p.index + p.segment.length > caret)
  if (!piece) return { text, caret }
  return {
    text: text.slice(0, piece.index) + text.slice(piece.index + piece.segment.length),
    caret: piece.index
  }
}
