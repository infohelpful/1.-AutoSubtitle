import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { findSubtitleMatches, type SubtitleSearchMatch } from '../../../shared/subtitleSearch'
import { subtitleLineEditDisplayText, type SubtitleLine } from '../../../shared/subtitles'

type Props = {
  subtitles: readonly SubtitleLine[]
  rowNumbers: readonly number[]
  /** Bumped on every Ctrl+F so the find box regains focus while already open. */
  focusSeq: number
  initialQuery: string
  disabled: boolean
  onClose: () => void
  onRevealMatch: (match: SubtitleSearchMatch | null) => void
  onReplace: (match: SubtitleSearchMatch, replacement: string) => void
  onReplaceAll: (query: string, replacement: string, caseSensitive: boolean) => number
}

const CONTEXT = 18

export function SubtitleSearchPanel(props: Props) {
  const { subtitles, rowNumbers, focusSeq, initialQuery, disabled, onClose, onRevealMatch, onReplace, onReplaceAll } = props
  const [query, setQuery] = useState(initialQuery)
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [current, setCurrent] = useState(0)
  const [notice, setNotice] = useState('')
  const findRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (initialQuery) setQuery(initialQuery)
    findRef.current?.focus()
    findRef.current?.select()
  }, [focusSeq, initialQuery])

  const matches = useMemo(() => findSubtitleMatches(subtitles, query, { caseSensitive }), [subtitles, query, caseSensitive])
  const index = matches.length ? Math.min(current, matches.length - 1) : -1
  const match = index >= 0 ? matches[index]! : null

  useEffect(() => { setCurrent(0); setNotice('') }, [query, caseSensitive])
  const matchLine = match?.line ?? null
  const matchStart = match?.start ?? null
  const matchEnd = match?.end ?? null
  useEffect(() => {
    onRevealMatch(matchLine === null || matchStart === null || matchEnd === null
      ? null : { line: matchLine, start: matchStart, end: matchEnd })
  }, [matchLine, matchStart, matchEnd, onRevealMatch])
  useEffect(() => () => onRevealMatch(null), [onRevealMatch])

  const step = (delta: number) => {
    if (!matches.length) return
    setCurrent((index + delta + matches.length) % matches.length)
  }
  const replaceCurrent = () => {
    if (!match || disabled) return
    onReplace(match, replacement)
    setNotice('')
    // The next match slides into the same slot after the edit recomputes matches.
  }
  const replaceAll = () => {
    if (!query || disabled) return
    const count = onReplaceAll(query, replacement, caseSensitive)
    setNotice(count ? `${count}개 바꿈` : '바꿀 항목이 없습니다')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    const inReplace = (e.target as HTMLElement).dataset.searchField === 'replace'
    if (inReplace && (e.ctrlKey || e.metaKey)) replaceAll()
    else if (inReplace) replaceCurrent()
    else step(e.shiftKey ? -1 : 1)
  }

  const snippet = useMemo(() => {
    if (!match) return null
    const text = subtitleLineEditDisplayText(subtitles[match.line]!)
    const from = Math.max(0, match.start - CONTEXT)
    const to = Math.min(text.length, match.end + CONTEXT)
    return {
      before: (from > 0 ? '…' : '') + text.slice(from, match.start),
      hit: text.slice(match.start, match.end),
      after: text.slice(match.end, to) + (to < text.length ? '…' : '')
    }
  }, [match, subtitles])

  return (
    <div className="subtitle-search-panel" role="dialog" aria-label="자막 찾기 및 바꾸기"
      data-waveform-no-dismiss="1" onKeyDown={onKeyDown}>
      <div className="subtitle-search-head">
        <strong>찾기 및 바꾸기</strong>
        <button type="button" className="subtitle-search-close" aria-label="닫기" onClick={onClose}>✕</button>
      </div>
      <div className="subtitle-search-row">
        <input ref={findRef} type="text" data-search-field="find" aria-label="찾을 텍스트" placeholder="찾을 텍스트"
          value={query} onChange={e => setQuery(e.target.value)} spellCheck={false} />
        <span className="subtitle-search-count" aria-live="polite">
          {query ? (matches.length ? `${index + 1} / ${matches.length}` : '0건') : ''}
        </span>
      </div>
      <div className="subtitle-search-row">
        <input type="text" data-search-field="replace" aria-label="바꿀 텍스트" placeholder="바꿀 텍스트"
          value={replacement} onChange={e => setReplacement(e.target.value)} spellCheck={false} />
      </div>
      <div className="subtitle-search-actions">
        <label><input type="checkbox" checked={caseSensitive} onChange={e => setCaseSensitive(e.target.checked)} />대소문자 구분</label>
        <span className="subtitle-search-spacer" />
        <button type="button" disabled={!matches.length} onClick={() => step(-1)} aria-label="이전 결과">↑</button>
        <button type="button" disabled={!matches.length} onClick={() => step(1)} aria-label="다음 결과">↓</button>
      </div>
      <div className="subtitle-search-actions">
        <button type="button" disabled={!match || disabled} onClick={replaceCurrent}>바꾸기</button>
        <button type="button" disabled={!matches.length || disabled} onClick={replaceAll}>모두 바꾸기</button>
      </div>
      {snippet && match ? (
        <p className="subtitle-search-snippet">
          <span className="subtitle-search-row-no">{rowNumbers[match.line] ?? match.line + 1}번</span>
          {snippet.before}<mark>{snippet.hit}</mark>{snippet.after}
        </p>
      ) : null}
      {notice ? <p className="subtitle-search-notice" role="status">{notice}</p> : null}
      <p className="subtitle-search-hint">Enter 다음 · Shift+Enter 이전 · 바꿀 칸에서 Enter 바꾸기, Ctrl+Enter 모두 바꾸기 · Esc 닫기</p>
    </div>
  )
}
