import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { List, useListRef } from 'react-window'
import type { RowComponentProps } from 'react-window'
import type { MouseEvent } from 'react'

import type { SubtitleLine } from '../../shared/subtitles'
import { useSubtitleData } from './subtitleDataContext'

/** 카드(타임코드 + 텍스트) + 행 간격을 포함한 고정 행 높이 */
export const SUBTITLE_LIST_ROW_HEIGHT = 140

export type SubtitleVirtualListProps = {
  subtitles: SubtitleLine[]
  activeSubtitleIndex: number | null
  playheadSec: number
  isPlaying: boolean
  mediaFileUrl: string | null
  onSubtitleCardClick: (e: MouseEvent<HTMLElement>, startSec: number) => void
  onCardNavigate: (startSec: number) => void
  onRequestPausePlayback: () => void
  onWordBlockClick: (startSec: number) => void
  onWaveformSeekAndPlay: (sec: number) => void
  splitSubtitleAtWord: (index: number, wordIndex: number) => void
  backspaceWordAt: (index: number, wordIndex: number) => void
  deleteWordAt: (index: number, wordIndex: number) => void
  deleteWordRangeAt: (index: number, fromWordIndex: number, toWordIndex: number) => void
  onDeleteAudioRange: (startSec: number, endSec: number) => void
  onUndo: () => void
  onRedo: () => void
  updateSubtitleAt: (index: number, text: string) => void
  splitSubtitleAt: (index: number, cursorPos: number) => void
  mergeEmptySubtitleAt: (index: number) => void
  formatTimecode: (sec: number) => string
  /** 일시정지 상태에서 현재 시점부터 재생 재개(위치 유지) */
  onTogglePlayback: () => void
}

/** `List` 의 `rowProps` — `index` / `style` / `ariaAttributes` 는 List가 주입 */
type SubtitleListRowProps = {
  subtitles: SubtitleLine[]
  activeSubtitleIndex: number | null
  playheadSec: number
  isPlaying: boolean
  onSubtitleCardClick: SubtitleVirtualListProps['onSubtitleCardClick']
  onCardNavigate: SubtitleVirtualListProps['onCardNavigate']
  onRequestPausePlayback: SubtitleVirtualListProps['onRequestPausePlayback']
  onWordBlockClick: SubtitleVirtualListProps['onWordBlockClick']
  onWaveformSeekAndPlay: SubtitleVirtualListProps['onWaveformSeekAndPlay']
  splitSubtitleAtWord: SubtitleVirtualListProps['splitSubtitleAtWord']
  backspaceWordAt: SubtitleVirtualListProps['backspaceWordAt']
  deleteWordAt: SubtitleVirtualListProps['deleteWordAt']
  deleteWordRangeAt: SubtitleVirtualListProps['deleteWordRangeAt']
  onDeleteAudioRange: SubtitleVirtualListProps['onDeleteAudioRange']
  onUndo: SubtitleVirtualListProps['onUndo']
  onRedo: SubtitleVirtualListProps['onRedo']
  updateSubtitleAt: SubtitleVirtualListProps['updateSubtitleAt']
  splitSubtitleAt: SubtitleVirtualListProps['splitSubtitleAt']
  mergeEmptySubtitleAt: SubtitleVirtualListProps['mergeEmptySubtitleAt']
  formatTimecode: SubtitleVirtualListProps['formatTimecode']
  onTogglePlayback: SubtitleVirtualListProps['onTogglePlayback']
  requestFocusRow: (index: number, caret: number | 'end') => void
  navigateSubtitleField: (fromIndex: number, delta: number) => void
  requestFocusWord: (cardIndex: number, wordIndex: number) => void
  requestFocusCard: (cardIndex: number) => void
  /**
   * 포커스가 이 카드(또는 자식)에 있을 때의 앵커.
   * 키보드로 다른 카드로 옮길 때만 프리뷰 시크; 삭제 직후 `onCardNavigate`+`requestFocusCaret`는 중복 시크 방지.
   */
  registerCardFocus: (cardIndex: number) => void
}

function SubtitleVirtualRow(props: RowComponentProps<SubtitleListRowProps>) {
  const {
    index,
    style,
    subtitles,
    activeSubtitleIndex,
    playheadSec,
    isPlaying,
    onSubtitleCardClick,
    onCardNavigate,
    onRequestPausePlayback,
    onWordBlockClick,
    onWaveformSeekAndPlay,
    splitSubtitleAtWord,
    backspaceWordAt,
    deleteWordAt,
    deleteWordRangeAt,
    onDeleteAudioRange,
    onUndo,
    onRedo,
    updateSubtitleAt,
    splitSubtitleAt,
    mergeEmptySubtitleAt,
    formatTimecode,
    onTogglePlayback,
    requestFocusRow,
    navigateSubtitleField,
    requestFocusWord,
    requestFocusCard,
    registerCardFocus
  } = props
  const requestFocusCaret = requestFocusWord
  const row = subtitles[index]
  if (!row) return null
  const isActive = activeSubtitleIndex === index
  const [caretIndex, setCaretIndex] = useState(0)
  const [caretVisible, setCaretVisible] = useState(false)
  const [caretBlink, setCaretBlink] = useState(false)
  const [rowHasFocus, setRowHasFocus] = useState(false)
  const [focusedCaretIndex, setFocusedCaretIndex] = useState<number | null>(null)
  const [hoveredCaretIndex, setHoveredCaretIndex] = useState<number | null>(null)
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null)
  const articleRef = useRef<HTMLElement | null>(null)
  /** 마우스로 단어/캐럿 또는 카드 빈 곳을 눌렀을 때만 Space로 시크+재생. 그 외 Space는 재생/일시정지 토글 */
  const spaceSeekIntentRef = useRef<'none' | 'caret' | 'wholeLine'>('none')
  /** 방향키로 재생을 멈추며 이미 캐럿을 옮긴 경우, pause 직후 playhead 동기화를 하지 않음 */
  const skipPlayheadCaretSyncOnPauseRef = useRef(false)
  /** 재생 중 방향키로 일시정지하며 캐럿 편집 UI를 잠깐 허용할 때 true */
  const [keyboardPauseCaret, setKeyboardPauseCaret] = useState(false)
  useEffect(() => {
    const n = row.words?.length ?? 0
    setCaretIndex((prev) => Math.max(0, Math.min(prev, n)))
  }, [row.words])

  useEffect(() => {
    setSelectionAnchor(null)
  }, [index, row.words])
  useEffect(() => {
    setCaretVisible(false)
    setCaretBlink(false)
    setRowHasFocus(false)
    setFocusedCaretIndex(null)
    setHoveredCaretIndex(null)
    spaceSeekIntentRef.current = 'none'
    setKeyboardPauseCaret(false)
  }, [index, row.words])

  useEffect(() => {
    if (!isPlaying) setKeyboardPauseCaret(false)
  }, [isPlaying])

  useEffect(() => {
    const words = row.words ?? []
    const wi = words.findIndex((w) => playheadSec >= w.start && playheadSec < w.end)
    if (!isPlaying) return
    if (keyboardPauseCaret) return

    const root = articleRef.current
    const focused = document.activeElement as HTMLElement | null
    if (root && focused && root.contains(focused)) {
      // 재생 헤드 동기화가 textarea caretIndex·포커스를 매 프레임 덮어쓰면 방향키/편집 증상이 그대로 남음
      if (focused.closest('[data-subtitle-edit]')) return
      if (focused.closest('.subtitle-word-row')) return
    }

    setCaretVisible(false)
    setCaretBlink(false)
    if (wi >= 0) setCaretIndex(wi)
    const activeEl = document.activeElement as HTMLElement | null
    if (activeEl?.id?.startsWith(`subtitle-caret-${index}-`)) activeEl.blur()
  }, [index, isPlaying, playheadSec, row.words, keyboardPauseCaret])

  const clearSelection = () => setSelectionAnchor(null)
  const clearRowCaretState = useCallback(
    (keepHover: boolean) => {
      setRowHasFocus(false)
      setFocusedCaretIndex(null)
      setCaretBlink(false)
      if (!keepHover) setCaretVisible(false)
    },
    []
  )

  useEffect(() => {
    const onDocumentFocusIn = () => {
      const root = articleRef.current
      if (!root) return
      const active = document.activeElement as Node | null
      if (!active || !root.contains(active)) {
        clearRowCaretState(hoveredCaretIndex !== null)
        spaceSeekIntentRef.current = 'none'
      }
    }
    document.addEventListener('focusin', onDocumentFocusIn)
    return () => document.removeEventListener('focusin', onDocumentFocusIn)
  }, [clearRowCaretState, hoveredCaretIndex])

  const dismissSpaceSeekIntentAndCaretUi = () => {
    spaceSeekIntentRef.current = 'none'
    const root = articleRef.current
    if (root) {
      root.querySelectorAll<HTMLElement>(`button[id^="subtitle-caret-${index}-"]`).forEach((el) => el.blur())
    }
    clearRowCaretState(false)
    window.requestAnimationFrame(() => articleRef.current?.focus())
  }

  const activateCaretAt = (ci: number, blink: boolean, armSpaceSeek = true) => {
    if (armSpaceSeek) spaceSeekIntentRef.current = 'caret'
    setCaretIndex(ci)
    setCaretVisible(true)
    setCaretBlink(blink)
    setRowHasFocus(true)
    setFocusedCaretIndex(ci)
    setHoveredCaretIndex(null)
    window.requestAnimationFrame(() => {
      const el = document.getElementById(`subtitle-caret-${index}-${ci}`) as HTMLButtonElement | null
      const active = document.activeElement as HTMLElement | null
      if (el && active?.id !== el.id) el.focus({ preventScroll: true })
    })
  }
  const syncCaretFromFocus = (ci: number) => {
    spaceSeekIntentRef.current = 'caret'
    setCaretIndex(ci)
    setCaretVisible(true)
    setCaretBlink(true)
    setRowHasFocus(true)
    setFocusedCaretIndex(ci)
    setHoveredCaretIndex(null)
  }
  const showKeyboardCaret = () => {
    setCaretVisible(true)
    setCaretBlink(true)
  }
  const showStaticCaret = () => {
    setCaretVisible(true)
    setCaretBlink(false)
  }
  const isCaretShownAt = (ci: number) => {
    if (!caretVisible) return false
    if (isPlaying && !keyboardPauseCaret) return false
    // hover 중에는 회색 커서를 우선 표시한다.
    if (hoveredCaretIndex !== null) return hoveredCaretIndex === ci
    if (rowHasFocus && focusedCaretIndex !== null) return focusedCaretIndex === ci
    return false
  }
  const hasSelection = selectionAnchor !== null && selectionAnchor !== caretIndex
  const selStart = hasSelection ? Math.min(selectionAnchor, caretIndex) : -1
  const selEnd = hasSelection ? Math.max(selectionAnchor, caretIndex) : -1
  const playbackHidesCaret = isPlaying && !keyboardPauseCaret

  const onTextareaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    const mod = e.ctrlKey || e.metaKey
    if (mod) {
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        onUndo()
        return
      }
      if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault()
        onRedo()
        return
      }
      if (k === 'c' || k === 'v' || k === 'x' || k === 'a') {
        // 편집 영역의 기본 복사/붙여넣기/잘라내기/전체선택 동작 유지
        e.stopPropagation()
        return
      }
    }

    // 텍스트 편집 중 좌/우는 끝에서만 단어칩 줄로 나감(ArrowRight와 대칭: 왼쪽 끝 → 이전 줄 마지막 캐럿 또는 현재 줄 0번).
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      if (e.key === 'ArrowLeft' && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
        e.preventDefault()
        e.stopPropagation()
        showKeyboardCaret()
        clearSelection()
        if (index > 0) {
          const prevLen = subtitles[index - 1]?.words?.length ?? 0
          requestFocusCaret(index - 1, prevLen)
        } else {
          requestFocusCaret(index, 0)
        }
      }
      if (
        e.key === 'ArrowRight' &&
        e.currentTarget.selectionStart === e.currentTarget.value.length &&
        e.currentTarget.selectionEnd === e.currentTarget.value.length
      ) {
        e.preventDefault()
        e.stopPropagation()
        showKeyboardCaret()
        clearSelection()
        const to = Math.min(index + 1, subtitles.length - 1)
        requestFocusCaret(to, 0)
      }
      e.stopPropagation()
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      const to = Math.min(index + 1, subtitles.length - 1)
      showKeyboardCaret()
      requestFocusCaret(to, 0)
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      showKeyboardCaret()
      requestFocusCaret(index, 0)
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const pos = e.currentTarget.selectionStart
      splitSubtitleAt(index, pos)
      window.setTimeout(() => requestFocusRow(index + 1, 0), 0)
      return
    }

    if (e.key === 'Tab') {
      e.preventDefault()
      navigateSubtitleField(index, e.shiftKey ? -1 : 1)
      return
    }

    if (e.key === 'Backspace' && row.text.length === 0 && index > 0) {
      e.preventDefault()
      mergeEmptySubtitleAt(index)
      window.setTimeout(() => requestFocusRow(index - 1, 'end'), 0)
    }
  }

  const seekAtCaret = (nextCaret: number) => {
    // 커서 이동 시에는 재생 위치를 변경하지 않는다.
    void nextCaret
  }

  const playAtCaret = (nextCaret: number) => {
    const words = row.words ?? []
    if (words.length === 0) {
      onWaveformSeekAndPlay(row.start)
      return
    }
    const wi = Math.max(0, Math.min(nextCaret, words.length - 1))
    onWaveformSeekAndPlay(words[wi].start)
  }

  /** playhead가 속한 단어 블록 바로 앞의 캐럿 인덱스(재생 중 방향키 기준점) */
  const caretIndexBeforePlayheadWord = (): number => {
    const words = row.words ?? []
    if (words.length === 0) return 0
    const inside = words.findIndex((w) => playheadSec >= w.start && playheadSec < w.end)
    if (inside >= 0) return inside
    const beforeNext = words.findIndex((w) => playheadSec < w.start)
    if (beforeNext >= 0) return beforeNext
    return words.length
  }

  const prevIsPlayingRef = useRef(isPlaying)
  useEffect(() => {
    const justPaused = prevIsPlayingRef.current && !isPlaying
    prevIsPlayingRef.current = isPlaying
    if (!justPaused) return
    if (activeSubtitleIndex !== index) return
    if (skipPlayheadCaretSyncOnPauseRef.current) {
      skipPlayheadCaretSyncOnPauseRef.current = false
      return
    }

    const root = articleRef.current
    const ae = document.activeElement as HTMLElement | null
    if (ae && root?.contains(ae) && ae.closest('[data-subtitle-edit]')) return

    const words = row.words ?? []
    if (words.length === 0) return

    const inside = words.findIndex((w) => playheadSec >= w.start && playheadSec < w.end)
    let snap: number
    if (inside >= 0) snap = inside
    else {
      const beforeNext = words.findIndex((w) => playheadSec < w.start)
      if (beforeNext >= 0) snap = beforeNext
      else snap = words.length
    }

    setCaretIndex(snap)
    setFocusedCaretIndex(snap)
    setRowHasFocus(true)
    setCaretVisible(true)
    setCaretBlink(true)
    spaceSeekIntentRef.current = 'caret'
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const el = document.getElementById(`subtitle-caret-${index}-${snap}`) as HTMLElement | null
        el?.focus({ preventScroll: true })
      })
    })
  }, [activeSubtitleIndex, index, isPlaying, playheadSec, row.words])

  const onCaretKeyDown = (e: KeyboardEvent<HTMLButtonElement>, ci: number) => {
    e.stopPropagation()
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault()
      if (isPlaying) {
        onRequestPausePlayback()
        return
      }
      if (spaceSeekIntentRef.current === 'caret') {
        showKeyboardCaret()
        playAtCaret(ci)
        dismissSpaceSeekIntentAndCaretUi()
        return
      }
      onTogglePlayback()
      return
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      setHoveredCaretIndex(null)
      if (isPlaying) {
        skipPlayheadCaretSyncOnPauseRef.current = true
        setKeyboardPauseCaret(true)
        onRequestPausePlayback()
      }
    }
    if (e.key === 'Home') {
      e.preventDefault()
      clearSelection()
      showKeyboardCaret()
      activateCaretAt(0, true)
      seekAtCaret(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      const n = row.words?.length ?? 0
      clearSelection()
      showKeyboardCaret()
      activateCaretAt(n, true)
      seekAtCaret(n)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      clearSelection()
      showKeyboardCaret()
      setCaretVisible(false)
      setCaretBlink(false)
      requestFocusRow(index, 0)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      clearSelection()
      showKeyboardCaret()
      if (index > 0) {
        setCaretVisible(false)
        setCaretBlink(false)
        requestFocusRow(index - 1, 0)
      }
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      showKeyboardCaret()
      const n = row.words?.length ?? 0
      if (isPlaying) {
        clearSelection()
        const snap = caretIndexBeforePlayheadWord()
        if (snap < n) {
          activateCaretAt(snap, true)
          seekAtCaret(snap)
        } else {
          setCaretVisible(false)
          setCaretBlink(false)
          requestFocusRow(index, 0)
        }
        return
      }
      if (e.shiftKey) {
        setSelectionAnchor((prev) => (prev === null ? ci : prev))
      } else {
        clearSelection()
      }
      if (ci < n) {
        activateCaretAt(ci + 1, true)
        seekAtCaret(ci + 1)
      } else {
        setCaretVisible(false)
        setCaretBlink(false)
        requestFocusRow(index, 0)
      }
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      showKeyboardCaret()
      if (isPlaying) {
        clearSelection()
        const snap = Math.max(0, caretIndexBeforePlayheadWord() - 1)
        activateCaretAt(snap, true)
        seekAtCaret(snap)
        return
      }
      if (e.shiftKey) {
        setSelectionAnchor((prev) => (prev === null ? ci : prev))
      } else {
        clearSelection()
      }
      if (ci > 0) {
        activateCaretAt(ci - 1, true)
        seekAtCaret(ci - 1)
      } else {
        const prevWords = subtitles[index - 1]?.words ?? []
        if (index > 0) {
          requestFocusCaret(index - 1, prevWords.length)
        }
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      clearSelection()
      showKeyboardCaret()
      splitSubtitleAtWord(index, ci)
      window.setTimeout(() => requestFocusCaret(index + 1, 0), 0)
      return
    }
    if (e.key === 'Backspace') {
      e.preventDefault()
      if (hasSelection) {
        const from = Math.min(selStart, selEnd)
        const to = Math.max(selStart, selEnd)
        const words = row.words ?? []
        const seekSec = words[Math.max(0, Math.min(from, words.length - 1))]?.start ?? row.start
        if (to > from && words[from] && words[to - 1]) {
          onDeleteAudioRange(words[from].start, words[to - 1].end)
        }
        deleteWordRangeAt(index, from, to)
        clearSelection()
        showKeyboardCaret()
        onCardNavigate(seekSec)
        registerCardFocus(index)
        window.setTimeout(() => requestFocusCaret(index, from), 0)
        return
      }
      clearSelection()
      showKeyboardCaret()
      const words = row.words ?? []
      const seekSec = words[Math.max(0, Math.min(ci - 1, words.length - 1))]?.start ?? row.start
      if (ci > 0) {
        const leftWord = words[ci - 1]
        if (leftWord) onDeleteAudioRange(leftWord.start, leftWord.end)
        backspaceWordAt(index, ci)
        onCardNavigate(seekSec)
        registerCardFocus(index)
        window.setTimeout(() => requestFocusCaret(index, ci - 1), 0)
      } else if (index > 0) {
        const prevWordLen = subtitles[index - 1]?.words?.length ?? 0
        backspaceWordAt(index, ci)
        onCardNavigate(seekSec)
        registerCardFocus(index - 1)
        window.setTimeout(() => requestFocusCaret(index - 1, prevWordLen), 0)
      }
      return
    }
    if (e.key === 'Delete') {
      e.preventDefault()
      if (hasSelection) {
        const from = Math.min(selStart, selEnd)
        const to = Math.max(selStart, selEnd)
        const words = row.words ?? []
        const seekSec = words[Math.max(0, Math.min(from, words.length - 1))]?.start ?? row.start
        if (to > from && words[from] && words[to - 1]) {
          onDeleteAudioRange(words[from].start, words[to - 1].end)
        }
        deleteWordRangeAt(index, from, to)
        clearSelection()
        showKeyboardCaret()
        onCardNavigate(seekSec)
        registerCardFocus(index)
        window.setTimeout(() => requestFocusCaret(index, from), 0)
        return
      }
      clearSelection()
      showKeyboardCaret()
      const words = row.words ?? []
      const seekSec = words[Math.min(ci, Math.max(0, words.length - 1))]?.start ?? row.start
      if (ci < words.length) {
        const targetWord = words[ci]
        if (targetWord) onDeleteAudioRange(targetWord.start, targetWord.end)
        deleteWordAt(index, ci)
        onCardNavigate(seekSec)
        registerCardFocus(index)
        window.setTimeout(() => requestFocusCaret(index, Math.min(ci, Math.max(0, words.length - 1))), 0)
      } else if (index < subtitles.length - 1) {
        deleteWordAt(index, ci)
        onCardNavigate(subtitles[index + 1]?.start ?? seekSec)
        registerCardFocus(index)
        window.setTimeout(() => requestFocusCaret(index, words.length), 0)
      } else if (subtitles.length > 1) {
        const prevLen = subtitles[index - 1]?.words?.length ?? 0
        deleteWordAt(index, ci)
        onCardNavigate(subtitles[index - 1]?.start ?? seekSec)
        registerCardFocus(index - 1)
        window.setTimeout(() => {
          requestFocusCaret(index - 1, prevLen)
        }, 0)
      }
    }
  }

  const onCardKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement | null
    if (target?.closest('textarea,input,[contenteditable="true"]')) {
      return
    }
    if (target?.id?.startsWith(`subtitle-caret-${index}-`)) {
      return
    }
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault()
      if (isPlaying) {
        onRequestPausePlayback()
        return
      }
      const intent = spaceSeekIntentRef.current
      if (intent === 'wholeLine') {
        onWaveformSeekAndPlay(row.start)
        dismissSpaceSeekIntentAndCaretUi()
        return
      }
      if (intent === 'caret') {
        showKeyboardCaret()
        playAtCaret(caretIndex)
        dismissSpaceSeekIntentAndCaretUi()
        return
      }
      onTogglePlayback()
      return
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      setHoveredCaretIndex(null)
      if (isPlaying) {
        skipPlayheadCaretSyncOnPauseRef.current = true
        setKeyboardPauseCaret(true)
        onRequestPausePlayback()
      }
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      const n = row.words?.length ?? 0
      if (isPlaying) {
        const snap = caretIndexBeforePlayheadWord()
        if (n === 0 || snap >= n) {
          setCaretVisible(false)
          setCaretBlink(false)
          requestFocusRow(index, 0)
        } else {
          setCaretIndex(snap)
          showKeyboardCaret()
          requestFocusCaret(index, snap)
          seekAtCaret(snap)
        }
        return
      }
      if (n === 0 || caretIndex >= n) {
        setCaretVisible(false)
        setCaretBlink(false)
        requestFocusRow(index, 0)
      } else {
        const next = Math.min(caretIndex + 1, n)
        setCaretIndex(next)
        showKeyboardCaret()
        requestFocusCaret(index, next)
        seekAtCaret(next)
      }
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (isPlaying) {
        const snap = Math.max(0, caretIndexBeforePlayheadWord() - 1)
        setCaretIndex(snap)
        showKeyboardCaret()
        requestFocusCaret(index, snap)
        seekAtCaret(snap)
        return
      }
      if (caretIndex > 0) {
        const prev = caretIndex - 1
        setCaretIndex(prev)
        showKeyboardCaret()
        requestFocusCaret(index, prev)
        seekAtCaret(prev)
      } else if (index > 0) {
        const prevLen = subtitles[index - 1]?.words?.length ?? 0
        showKeyboardCaret()
        requestFocusCaret(index - 1, prevLen)
      }
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setCaretIndex(0)
      showKeyboardCaret()
      requestFocusCaret(index, 0)
      seekAtCaret(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      const n = row.words?.length ?? 0
      setCaretIndex(n)
      showKeyboardCaret()
      requestFocusCaret(index, n)
      seekAtCaret(n)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCaretVisible(false)
      setCaretBlink(false)
      requestFocusRow(index, 0)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (index > 0) {
        setCaretVisible(false)
        setCaretBlink(false)
        requestFocusRow(index - 1, 0)
      }
    }
  }

  return (
    <div style={style} className="subtitle-virtual-row">
      <article
        ref={articleRef}
        id={`subtitle-card-${index}`}
        className={`subtitle-card subtitle-card--virtual${isActive ? ' subtitle-card--active' : ''}`}
        tabIndex={0}
        onMouseDownCapture={(e) => {
          const t = e.target as HTMLElement
          if (t.closest('textarea') || t.closest('[data-subtitle-edit]')) return
          if (t.closest('.subtitle-card-editor-label')) return
          if (t.closest('.subtitle-word-chip') || t.closest('.subtitle-word-caret')) return

          const tryActivateFirstCaret = (): boolean => {
            if (!(row.words && row.words.length > 0)) return false
            e.preventDefault()
            if (isPlaying) onRequestPausePlayback()
            clearSelection()
            activateCaretAt(0, true)
            return true
          }

          // 로그상 사용자는 타임코드 영역(subtitle-card-times)을 누르는 경우가 많음 — word-row 밖이라 기존 분기에 안 걸렸음
          if (t.closest('.subtitle-card-head')) {
            if (tryActivateFirstCaret()) return
          }

          const wordRow = t.closest('.subtitle-word-row') as HTMLElement | null
          // 첫 캐럿이 줄 맨 왼쪽에 붙으면 leadEdge/clientX 비교만으로는 빈 칸 클릭이 절대 안 잡힘 → 칩·캐럿 제외한 줄 안 어디든 맨 앞 캐럿
          if (wordRow) {
            if (tryActivateFirstCaret()) return
          }

          spaceSeekIntentRef.current = 'wholeLine'
          const root = articleRef.current
          if (root) {
            root.querySelectorAll<HTMLElement>(`button[id^="subtitle-caret-${index}-"]`).forEach((el) => el.blur())
          }
          clearRowCaretState(false)
          window.requestAnimationFrame(() => {
            articleRef.current?.focus()
          })
        }}
        onClick={(e) => onSubtitleCardClick(e, row.start)}
        onKeyDown={onCardKeyDown}
        onFocusCapture={() => {
          registerCardFocus(index)
          setRowHasFocus(true)
          setHoveredCaretIndex(null)
          if (focusedCaretIndex !== null) setCaretVisible(true)
        }}
        onBlurCapture={(e) => {
          // 클릭 전환 타이밍에서는 relatedTarget이 null일 수 있어 한 틱 뒤 실제 포커스 위치를 확인한다.
          window.setTimeout(() => {
            const active = document.activeElement as Node | null
            if (!active || !e.currentTarget.contains(active)) {
              clearRowCaretState(hoveredCaretIndex !== null)
              spaceSeekIntentRef.current = 'none'
            }
          }, 0)
        }}
      >
        <div className="subtitle-card-head">
          <div className="subtitle-card-times" aria-label="자막 구간">
            <span className="subtitle-time">{formatTimecode(row.start)}</span>
            <span className="subtitle-time-sep">→</span>
            <span className="subtitle-time">{formatTimecode(row.end)}</span>
          </div>
        </div>
        {row.words && row.words.length > 0 ? (
          <div
            className="subtitle-word-row"
            onClick={(e) => e.stopPropagation()}
            onMouseLeave={() => {
              setHoveredCaretIndex(null)
              if (rowHasFocus && focusedCaretIndex !== null) {
                setCaretVisible(true)
                setCaretBlink(true)
              } else {
                setCaretVisible(false)
                setCaretBlink(false)
              }
            }}
          >
            <button
              key={`caret-${index}-0`}
              id={`subtitle-caret-${index}-0`}
              type="button"
              className={`subtitle-word-caret${playbackHidesCaret ? ' subtitle-word-caret--hidden' : ''}${isCaretShownAt(0) ? ' subtitle-word-caret--visible' : ''}${!playbackHidesCaret && rowHasFocus && focusedCaretIndex === 0 ? ' subtitle-word-caret--active' : ''}${!playbackHidesCaret && caretBlink && rowHasFocus && focusedCaretIndex === 0 ? ' subtitle-word-caret--blink' : ''}`}
              tabIndex={0}
              onClick={() => {
                activateCaretAt(0, true)
              }}
              onFocus={() => {
                syncCaretFromFocus(0)
              }}
              onMouseEnter={() => {
                setCaretVisible(true)
                setCaretBlink(false)
                setHoveredCaretIndex(0)
                setCaretIndex(0)
              }}
              onKeyDown={(e) => onCaretKeyDown(e, 0)}
              aria-label="단어 사이 커서 0"
            />
            {row.words.map((w, wi) => {
              const isWordActive = isPlaying && playheadSec >= w.start && playheadSec < w.end
              return (
                <div key={`${index}-${wi}-${w.start}`} className="subtitle-word-slot">
                  <button
                    id={`subtitle-word-${index}-${wi}`}
                    type="button"
                    tabIndex={-1}
                    className={`subtitle-word-chip${isWordActive ? ' subtitle-word-chip--active' : ''}`}
                    onMouseEnter={() => {
                      setCaretIndex(wi)
                      showStaticCaret()
                      setHoveredCaretIndex(wi)
                    }}
                    onClick={() => {
                      if (isPlaying) {
                        onRequestPausePlayback()
                      }
                      clearSelection()
                      activateCaretAt(wi, true)
                    }}
                    onMouseDown={(e) => {
                      // 클릭하면 해당 단어 "앞" 위치로 커서를 고정한다.
                      e.preventDefault()
                      if (isPlaying) {
                        onRequestPausePlayback()
                      }
                      clearSelection()
                      activateCaretAt(wi, true)
                    }}
                    title={`${formatTimecode(w.start)} ~ ${formatTimecode(w.end)}`}
                  >
                    <span
                      className={
                        hasSelection && wi >= selStart && wi < selEnd
                          ? 'subtitle-word-chip-text subtitle-word-chip-text--selected'
                          : 'subtitle-word-chip-text'
                      }
                    >
                      {w.word}
                    </span>
                  </button>
                  <button
                    key={`caret-${index}-${wi + 1}`}
                    id={`subtitle-caret-${index}-${wi + 1}`}
                    type="button"
                    className={`subtitle-word-caret${playbackHidesCaret ? ' subtitle-word-caret--hidden' : ''}${isCaretShownAt(wi + 1) ? ' subtitle-word-caret--visible' : ''}${!playbackHidesCaret && rowHasFocus && focusedCaretIndex === wi + 1 ? ' subtitle-word-caret--active' : ''}${!playbackHidesCaret && caretBlink && rowHasFocus && focusedCaretIndex === wi + 1 ? ' subtitle-word-caret--blink' : ''}`}
                    tabIndex={0}
                    onClick={() => {
                      clearSelection()
                      activateCaretAt(wi + 1, true)
                    }}
                    onFocus={() => {
                      syncCaretFromFocus(wi + 1)
                    }}
                    onMouseEnter={() => {
                      setCaretVisible(true)
                      setCaretBlink(false)
                      setHoveredCaretIndex(wi + 1)
                      setCaretIndex(wi + 1)
                    }}
                    onKeyDown={(e) => onCaretKeyDown(e, wi + 1)}
                    aria-label={`단어 사이 커서 ${wi + 1}`}
                  />
                </div>
              )
            })}
          </div>
        ) : null}
        <label className="subtitle-card-editor-label" htmlFor={`subtitle-v-${index}`}>
          자막 텍스트
        </label>
        <textarea
          id={`subtitle-v-${index}`}
          className="subtitle-card-textarea subtitle-card-textarea--virtual"
          data-subtitle-edit
          value={row.text}
          onChange={(e) => updateSubtitleAt(index, e.target.value)}
          onFocus={() => {
            setCaretVisible(false)
            setCaretBlink(false)
          }}
          onKeyDown={onTextareaKeyDown}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
      </article>
    </div>
  )
}

export function SubtitleVirtualList(props: SubtitleVirtualListProps) {
  const { subtitles: subtitlesFromContext } = useSubtitleData()
  const subtitles = subtitlesFromContext.length > 0 ? subtitlesFromContext : props.subtitles
  const { activeSubtitleIndex } = props
  const listRef = useListRef(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  /** 키보드로 다른 카드로 옮길 때만 프리뷰 시크 — 같은 카드 안(캐럿↔textarea)은 시크하지 않음 */
  const lastCardFocusRef = useRef<number | null>(null)

  const registerCardFocus = useCallback((cardIndex: number) => {
    lastCardFocusRef.current = cardIndex
  }, [])

  const requestFocusRow = useCallback((index: number, caret: number | 'end') => {
    if (index < 0) return
    const row = subtitles[index]
    if (row && lastCardFocusRef.current !== index) {
      props.onCardNavigate(row.start)
    }
    lastCardFocusRef.current = index
    try {
      listRef.current?.scrollToRow({
        index,
        align: 'center',
        behavior: 'instant'
      })
    } catch {
      return
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const ta = document.getElementById(`subtitle-v-${index}`) as HTMLTextAreaElement | null
        if (!ta) return
        ta.focus()
        if (caret === 'end') {
          const len = ta.value.length
          ta.setSelectionRange(len, len)
        } else {
          const c = Math.max(0, Math.min(caret, ta.value.length))
          ta.setSelectionRange(c, c)
        }
      })
    })
  }, [subtitles, props.onCardNavigate])

  const navigateSubtitleField = useCallback(
    (fromIndex: number, delta: number) => {
      const to = fromIndex + delta
      if (to < 0 || to >= subtitles.length) return
      requestFocusRow(to, delta < 0 ? 'end' : 0)
    },
    [subtitles.length, requestFocusRow]
  )

  const requestFocusCaret = useCallback((cardIndex: number, caretIndex: number) => {
    if (cardIndex < 0 || caretIndex < 0) return
    const row = subtitles[cardIndex]
    if (row && lastCardFocusRef.current !== cardIndex) {
      props.onCardNavigate(row.start)
    }
    lastCardFocusRef.current = cardIndex
    try {
      listRef.current?.scrollToRow({
        index: cardIndex,
        align: 'center',
        behavior: 'instant'
      })
    } catch {
      return
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const el = document.getElementById(`subtitle-caret-${cardIndex}-${caretIndex}`) as HTMLButtonElement | null
        if (!el) return
        el.focus()
      })
    })
  }, [subtitles, props.onCardNavigate])

  const requestFocusCard = useCallback((cardIndex: number) => {
    if (cardIndex < 0) return
    const row = subtitles[cardIndex]
    if (row && lastCardFocusRef.current !== cardIndex) {
      props.onCardNavigate(row.start)
    }
    lastCardFocusRef.current = cardIndex
    try {
      listRef.current?.scrollToRow({
        index: cardIndex,
        align: 'center',
        behavior: 'smooth'
      })
    } catch {
      return
    }
    window.requestAnimationFrame(() => {
      const el = document.getElementById(`subtitle-card-${cardIndex}`) as HTMLElement | null
      el?.focus()
    })
  }, [subtitles, props.onCardNavigate])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.max(0, Math.floor(r.width)), h: Math.max(0, Math.floor(r.height)) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const onGlobalArrow = (e: globalThis.KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input,textarea,[contenteditable="true"]')) return
      if (target?.closest('.subtitle-card')) return
      if (subtitles.length === 0) return
      e.preventDefault()
      if (props.isPlaying) props.onRequestPausePlayback()
      const ai = activeSubtitleIndex
      if (ai !== null && ai >= 0 && ai < subtitles.length) {
        const words = subtitles[ai]?.words ?? []
        const wi = words.findIndex((w) => props.playheadSec >= w.start && props.playheadSec < w.end)
        const caret = wi >= 0 ? wi : 0
        requestFocusCaret(ai, caret)
        return
      }
      requestFocusCaret(0, 0)
    }
    window.addEventListener('keydown', onGlobalArrow)
    return () => window.removeEventListener('keydown', onGlobalArrow)
  }, [activeSubtitleIndex, props.isPlaying, props.onRequestPausePlayback, props.playheadSec, requestFocusCaret, subtitles])

  const rowProps = useMemo(
    () => ({
      subtitles,
      activeSubtitleIndex: props.activeSubtitleIndex,
      playheadSec: props.playheadSec,
      isPlaying: props.isPlaying,
      mediaFileUrl: props.mediaFileUrl,
      onSubtitleCardClick: props.onSubtitleCardClick,
      onCardNavigate: props.onCardNavigate,
      onRequestPausePlayback: props.onRequestPausePlayback,
      onWordBlockClick: props.onWordBlockClick,
      onWaveformSeekAndPlay: props.onWaveformSeekAndPlay,
      splitSubtitleAtWord: props.splitSubtitleAtWord,
      backspaceWordAt: props.backspaceWordAt,
      deleteWordAt: props.deleteWordAt,
      deleteWordRangeAt: props.deleteWordRangeAt,
      onDeleteAudioRange: props.onDeleteAudioRange,
      onUndo: props.onUndo,
      onRedo: props.onRedo,
      updateSubtitleAt: props.updateSubtitleAt,
      splitSubtitleAt: props.splitSubtitleAt,
      mergeEmptySubtitleAt: props.mergeEmptySubtitleAt,
      formatTimecode: props.formatTimecode,
      onTogglePlayback: props.onTogglePlayback,
      requestFocusRow,
      navigateSubtitleField,
      requestFocusWord: requestFocusCaret,
      requestFocusCard,
      registerCardFocus
    }),
    [
      subtitles,
      props.activeSubtitleIndex,
      props.playheadSec,
      props.isPlaying,
      props.mediaFileUrl,
      props.onSubtitleCardClick,
      props.onCardNavigate,
      props.onRequestPausePlayback,
      props.onWordBlockClick,
      props.onWaveformSeekAndPlay,
      props.onTogglePlayback,
      props.splitSubtitleAtWord,
      props.backspaceWordAt,
      props.deleteWordAt,
      props.deleteWordRangeAt,
      props.onDeleteAudioRange,
      props.onUndo,
      props.onRedo,
      props.updateSubtitleAt,
      props.splitSubtitleAt,
      props.mergeEmptySubtitleAt,
      props.formatTimecode,
      requestFocusRow,
      navigateSubtitleField,
      requestFocusCaret,
      requestFocusCard,
      registerCardFocus
    ]
  )

  return (
    <div ref={containerRef} className="subtitle-virtual-root">
      {size.h > 0 && size.w > 0 && subtitles.length > 0 ? (
        <List
          listRef={listRef}
          className="subtitle-virtual-list"
          style={{ height: size.h, width: size.w }}
          rowCount={subtitles.length}
          rowHeight={SUBTITLE_LIST_ROW_HEIGHT}
          rowComponent={SubtitleVirtualRow}
          rowProps={rowProps}
          overscanCount={8}
        />
      ) : null}
    </div>
  )
}
