import { useState } from 'react'
import type { SubtitleLine, SubtitleWord } from '../../../shared/subtitles'

function ReadingInput({ word, onApply }: { word: SubtitleWord; onApply: (id: string, value: string) => void }) {
  const [value, setValue] = useState(word.readingOverride ?? '')
  return <form onSubmit={event => { event.preventDefault(); onApply(word.id!, value) }}>
    <label>실제 발음 <input aria-label="실제 발음" value={value} maxLength={256}
      placeholder="예: 3배 → 세배" onChange={event => setValue(event.target.value)} /></label>
    <button type="submit">발음 적용</button>
    <button type="button" disabled={!word.readingOverride} onClick={() => onApply(word.id!, '')}>자동 발음으로 복원</button>
  </form>
}

export function WordReadingEditor({ line, lineIndex, onApply, onClose, onRealign, realignDisabled }: {
  line: SubtitleLine; lineIndex: number; onApply: (id: string, value: string) => void; onClose: () => void
  onRealign: () => void; realignDisabled: boolean
}) {
  const words = (line.words ?? []).filter(w => w.id && !w.isSilence && !w.isDeleted && w.word.trim())
  const [selectedId, setSelectedId] = useState(words.find(w => w.reviewReasons?.length)?.id ?? words[0]?.id)
  const word = words.find(w => w.id === selectedId) ?? words[0]
  return <section className="word-reading-editor" role="dialog" aria-label="단어 발음 편집"
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <div><strong>{lineIndex + 1}번 줄 발음 입력</strong> <button type="button" onClick={onClose}>닫기</button></div>
    <p>자막 표기는 유지하고 정렬에 사용할 발음만 지정합니다. 적용 후 이 줄의 싱크를 재정렬해 주세요.</p>
    {word ? <>
      <label>단어 <select aria-label="발음 입력할 단어" value={word.id} onChange={event => setSelectedId(event.target.value)}>
        {words.map(w => <option key={w.id} value={w.id}>{w.word}{w.reviewReasons?.length ? ' · 검토 필요' : ''}</option>)}
      </select></label>
      <ReadingInput key={`${word.id}:${word.word}:${word.readingOverride ?? ''}`} word={word} onApply={onApply} />
      <button type="button" disabled={realignDisabled} onClick={onRealign}>이 줄 싱크 재정렬</button>
    </> : <p>발음을 입력할 단어가 없습니다.</p>}
  </section>
}
