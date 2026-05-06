import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from 'react'
import { flushSync } from 'react-dom'
import { LayoutGroup, motion } from 'framer-motion'
import { List, useDynamicRowHeight, useListRef } from 'react-window'
import type { RowComponentProps } from 'react-window'
import type { MouseEvent } from 'react'

import type { SubtitleLine } from '../../shared/subtitles'
import type { SubtitleRow } from './components/vrewPeaksEditor/types'
import type { PeaksZoomViewRange } from './SubtitleWaveformPeaks'
import { computeLineZoomWindowFromCardBounds, type LineZoomWindowResult } from './lineZoomWindow'
import { useSubtitleData } from './subtitleDataContext'

const WORD_LAYOUT_SPRING = { type: 'spring' as const, stiffness: 380, damping: 34 }

/** 가상 목록 기본 행 높이(초기 추정) — 이후 `useDynamicRowHeight`+ResizeObserver로 실제 카드 높이로 갱신 */
export const SUBTITLE_LIST_ROW_HEIGHT = 152

/** 단어 레일 — 파형 켜진 줄은 Peaks 와 같은 소스(vrew)로 시간 경계를 맞춘다 */
type WordRailItem = {
  start: number
  end: number
  label: string
  isSilence?: boolean
}

function wordChipSlotStyle(w: { start: number; end: number }, tw: LineZoomWindowResult): CSSProperties {
  let left = ((w.start - tw.windowStart) / tw.span) * 100
  let width = ((w.end - w.start) / tw.span) * 100
  left = Math.max(0, Math.min(100, left))
  width = Math.max(0, Math.min(100 - left, width))
  return {
    position: 'absolute',
    left: `${left}%`,
    width: `${width}%`,
    top: 0,
    bottom: 0,
    minWidth: 0,
    boxSizing: 'border-box'
  }
}

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
  /** 단어별 파동(Peaks) — 자막 카드 안에 단어 아래·텍스트 위로 삽입 */
  waveformEnabled?: boolean
  registerWaveMount?: (lineIndex: number, el: HTMLDivElement | null) => void
  waveformExpandedLineIndex?: number | null
  waveformActiveWordId?: number | null
  onWaveformWordDoubleClick?: (lineIndex: number, wordIndex: number) => void
  vrewRows?: SubtitleRow[]
  /** 파형 마운트를 선택 단어 아래로 정렬한 뒤 body 포털 위치 동기화 */
  onWaveformMountLayout?: () => void
  /** 미디어 길이(초) — 단어 칹·줌 창 상한과 동일하게 맞춤 */
  mediaDurationSec?: number
  /** Peaks zoomview 실제 구간 — 있으면 칹 %는 이 축을 따름(zoomLevels 양자화 일치) */
  peaksZoomViewRange?: PeaksZoomViewRange | null
}

/** `List` 의 `rowProps` — `index` / `style` / `ariaAttributes` 는 List가 주입 */
export type SubtitleListRowProps = {
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
  waveformEnabled?: boolean
  registerWaveMount?: (lineIndex: number, el: HTMLDivElement | null) => void
  waveformExpandedLineIndex?: number | null
  waveformActiveWordId?: number | null
  onWaveformWordDoubleClick?: (lineIndex: number, wordIndex: number) => void
  vrewRows?: SubtitleRow[]
  onWaveformMountLayout?: SubtitleVirtualListProps['onWaveformMountLayout']
  mediaDurationSec?: number
  peaksZoomViewRange?: PeaksZoomViewRange | null
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
    registerCardFocus,
    waveformEnabled,
    registerWaveMount,
    waveformExpandedLineIndex,
    waveformActiveWordId,
    onWaveformWordDoubleClick,
    vrewRows,
    onWaveformMountLayout,
    mediaDurationSec,
    peaksZoomViewRange
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
  const waveformMountRef = useRef<HTMLDivElement | null>(null)
  /** 마우스로 단어/캐럿 또는 카드 빈 곳을 눌렀을 때만 Space로 시크+재생. 그 외 Space는 재생/일시정지 토글 */
  const spaceSeekIntentRef = useRef<'none' | 'caret' | 'wholeLine'>('none')
  /** 방향키로 재생을 멈추며 이미 캐럿을 옮긴 경우, pause 직후 playhead 동기화를 하지 않음 */
  const skipPlayheadCaretSyncOnPauseRef = useRef(false)
  /** 재생 중 방향키로 일시정지하며 캐럿 편집 UI를 잠깐 허용할 때 true */
  const [keyboardPauseCaret, setKeyboardPauseCaret] = useState(false)
  /** 부모 subtitles 갱신 없이 타이핑 — blur 시에만 commit (전체 vrewRows·리스트 재계산 방지) */
  const subtitleTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [subtitleTextDraft, setSubtitleTextDraft] = useState<string | null>(null)
  const subtitleTextDisplay = subtitleTextDraft ?? row.text

  useEffect(() => {
    if (subtitleTextareaRef.current === document.activeElement) {
      setSubtitleTextDraft(row.text)
      return
    }
    setSubtitleTextDraft(null)
  }, [row.text, row.start, row.end, index])

  const wordRail = useMemo((): WordRailItem[] => {
    const sw = row.words ?? []
    const vr = vrewRows?.[index]?.words
    if (waveformEnabled && vr && vr.length > 0) {
      return vr.map((w) => ({
        start: w.start,
        end: w.end,
        label: w.isSilence ? '·' : w.text,
        isSilence: w.isSilence
      }))
    }
    return sw.map((w) => ({
      start: w.start,
      end: w.end,
      label: w.word,
      isSilence: w.isSilence
    }))
  }, [waveformEnabled, vrewRows, index, row.words])

  /** vrew 레일 캐럿 ci → 자막 줄에서 splitSubtitleAtWord 에 넘길 인덱스 */
  const subtitleSplitIndexFromRailCaret = useCallback(
    (ci: number): number => {
      const subs = row.words ?? []
      if (subs.length === 0 || ci <= 0) return 0
      if (ci >= wordRail.length) return subs.length
      const bt = (wordRail[ci - 1]!.end + wordRail[ci]!.start) / 2
      for (let j = 1; j < subs.length; j++) {
        const mid = (subs[j - 1]!.end + subs[j]!.start) / 2
        if (bt <= mid) return j
      }
      return subs.length
    },
    [row.words, wordRail]
  )

  useEffect(() => {
    const n = wordRail.length
    setCaretIndex((prev) => Math.max(0, Math.min(prev, n)))
  }, [wordRail])

  /**
   * 파형이 열린 줄이면 Peaks 가 보고한 실제 zoomview 구간(windowStart/End)으로 %를 맞춘다.
   * 이론상 computeLineZoomWindow 만 쓰면 zoomLevels 스냅 때문에 세그먼트·흰선과 칹 경계가 어긋난다.
   */
  const wordTimeline = useMemo((): LineZoomWindowResult | null => {
    if (wordRail.length === 0) return null
    const lineStart = Math.min(...wordRail.map((w) => w.start))
    const lineEnd = Math.max(...wordRail.map((w) => w.end))
    if (
      peaksZoomViewRange != null &&
      peaksZoomViewRange.lineIndex === index &&
      waveformExpandedLineIndex === index
    ) {
      const ws = peaksZoomViewRange.windowStart
      const we = peaksZoomViewRange.windowEnd
      const span = Math.max(we - ws, 1e-6)
      return {
        lineStart,
        lineEnd,
        windowStart: ws,
        windowEnd: we,
        span
      }
    }
    return computeLineZoomWindowFromCardBounds(lineStart, lineEnd, {
      mediaDurationSec:
        mediaDurationSec != null && mediaDurationSec > 0 ? mediaDurationSec : undefined,
      clipTrailingToLineEnd: true
    })
  }, [wordRail, mediaDurationSec, peaksZoomViewRange, waveformExpandedLineIndex, index])

  /** 파형이 열린 줄만 시간축(%)·가로 스크롤 — 그 외는 줄바꿈 읽기 모드 */
  const timelineLayoutThisRow = Boolean(
    waveformEnabled && waveformExpandedLineIndex === index
  )

  const wordRowOuterRef = useRef<HTMLDivElement>(null)
  const wordRowInnerRef = useRef<HTMLDivElement>(null)
  /** 단어 칩 실제 픽셀 경계 — 비율(%)만 쓰면 -1px 이웃 겹침 때문에 세로 구분선과 어긋남 */
  const [measuredCaretLeftPx, setMeasuredCaretLeftPx] = useState<number[] | null>(null)
  /** 캐럿마다 인접 칩·줄바꿈 기준 세로 중앙(px) — 창 리사이즈·줄바꿈 후에도 맞추려면 전역 mid-y 가 아님 */
  const [measuredCaretTopPx, setMeasuredCaretTopPx] = useState<number[] | null>(null)

  const measureCaretEdges = useCallback(() => {
    /** 타임라인(파형 열림) 줄은 단어 사이 캐럿 UI를 쓰지 않음 */
    if (waveformEnabled && waveformExpandedLineIndex === index) {
      wordRowInnerRef.current?.style.removeProperty('--subtitle-caret-bar-height')
      setMeasuredCaretLeftPx(null)
      setMeasuredCaretTopPx(null)
      return
    }
    const inner = wordRowInnerRef.current
    const words = wordRail
    const n = words.length
    const tw = wordTimeline
    if (!inner || n === 0 || !tw) {
      inner?.style.removeProperty('--subtitle-caret-bar-height')
      setMeasuredCaretLeftPx(null)
      setMeasuredCaretTopPx(null)
      return
    }
    const innerRect = inner.getBoundingClientRect()
    if (innerRect.width < 0.5) {
      inner.style.removeProperty('--subtitle-caret-bar-height')
      setMeasuredCaretLeftPx(null)
      setMeasuredCaretTopPx(null)
      return
    }
    const timeToPx = (t: number) => ((t - tw.windowStart) / tw.span) * innerRect.width
    const chipEl = (wi: number) => document.getElementById(`subtitle-word-${index}-${wi}`)
    /** 칩 경계 사이 공백의 가로 중앙(px, inner 기준) — 캐럿은 translateX(-50%)로 이 점에 맞춤 */
    const centers: number[] = new Array(n + 1)
    const innerW = innerRect.width
    for (let k = 0; k <= n; k++) {
      if (k === 0) {
        const r0 = chipEl(0)?.getBoundingClientRect()
        if (r0) {
          const left0 = r0.left - innerRect.left
          centers[0] = left0 * 0.5
        } else {
          centers[0] = timeToPx((tw.windowStart + words[0]!.start) * 0.5)
        }
      } else if (k === n) {
        const rLast = chipEl(n - 1)?.getBoundingClientRect()
        if (rLast) {
          const rightLast = rLast.right - innerRect.left
          /** 카드 전체 너비까지 중앙 잡지 않음 — 마지막 칩 직후 좁은 구간(빈 여백 방지) */
          const tailPx = 8
          centers[n] = Math.min(rightLast + tailPx, innerW - 4)
        } else {
          const nearEndPx = timeToPx(words[n - 1]!.end) + 8
          centers[n] = Math.min(nearEndPx, innerW - 4)
        }
      } else {
        const rPrev = chipEl(k - 1)?.getBoundingClientRect()
        const rCurr = chipEl(k)?.getBoundingClientRect()
        if (rPrev && rCurr) {
          const a = rPrev.right - innerRect.left
          const b = rCurr.left - innerRect.left
          centers[k] = (a + b) * 0.5
        } else {
          const tMid = (words[k - 1]!.end + words[k]!.start) * 0.5
          centers[k] = timeToPx(tMid)
        }
      }
    }
    /** 막대 높이 + 캐럿별 세로: 줄바꿈 시 전체 블록 중앙이 아니라 각 간격(이전·다음 칩)의 세로 중앙 */
    let maxChipH = 0
    for (let wi = 0; wi < n; wi++) {
      const cr = chipEl(wi)?.getBoundingClientRect()
      if (cr) maxChipH = Math.max(maxChipH, cr.height)
    }
    const innerH = innerRect.height
    const barPx =
      maxChipH > 4
        ? Math.round(Math.min(Math.max(maxChipH * 0.94, 18), Math.max(innerH, maxChipH)))
        : Math.round(Math.min(Math.max(innerH * 0.85, 20), 48))
    inner.style.setProperty('--subtitle-caret-bar-height', `${barPx}px`)

    const tops: number[] = new Array(n + 1)
    const fallbackMid = innerH > 0.5 ? innerH * 0.5 : 22
    for (let k = 0; k <= n; k++) {
      if (k === 0) {
        const r0 = chipEl(0)?.getBoundingClientRect()
        tops[k] = r0 ? r0.top + r0.height / 2 - innerRect.top : fallbackMid
      } else if (k === n) {
        const rl = chipEl(n - 1)?.getBoundingClientRect()
        tops[k] = rl ? rl.top + rl.height / 2 - innerRect.top : fallbackMid
      } else {
        const ra = chipEl(k - 1)?.getBoundingClientRect()
        const rb = chipEl(k)?.getBoundingClientRect()
        if (ra && rb) {
          tops[k] = (ra.bottom + rb.top) / 2 - innerRect.top
        } else {
          tops[k] = fallbackMid
        }
      }
    }
    setMeasuredCaretTopPx((prev) => {
      if (
        prev &&
        prev.length === tops.length &&
        prev.every((p, i) => Math.abs(p - tops[i]!) < 0.5)
      ) {
        return prev
      }
      return tops
    })

    setMeasuredCaretLeftPx((prev) => {
      if (
        prev &&
        prev.length === centers.length &&
        prev.every((p, i) => Math.abs(p - centers[i]!) < 0.35)
      ) {
        return prev
      }
      return centers
    })
  }, [index, wordRail, wordTimeline, waveformEnabled, waveformExpandedLineIndex])

  const getWordCaretEdgeStyle = useCallback(
    (k: number, n: number): CSSProperties => {
      const m = measuredCaretLeftPx
      const tw = wordTimeline
      const words = wordRail
      if (m && m.length === n + 1 && m.every((x) => Number.isFinite(x))) {
        const leftPx = m[k]!
        return { left: leftPx }
      }
      if (!tw || words.length === 0) {
        return k === 0
          ? { left: 0 }
          : k === n
            ? { left: '100%' }
            : { left: '50%' }
      }
      const tMid =
        k === 0
          ? (tw.windowStart + words[0]!.start) * 0.5
          : k === n
            ? Math.min(
                words[n - 1]!.end + tw.span * 0.004,
                tw.windowEnd - tw.span * 1e-6
              )
            : (words[k - 1]!.end + words[k]!.start) * 0.5
      const pctRaw = ((tMid - tw.windowStart) / tw.span) * 100
      const pct = Math.max(0, Math.min(100, pctRaw))
      return { left: `${pct}%` }
    },
    [measuredCaretLeftPx, wordTimeline, wordRail]
  )

  useLayoutEffect(() => {
    measureCaretEdges()
  }, [measureCaretEdges])

  /** 파형 열림/닫힘·줄 전환 후 Framer 레이아웃이 끝난 뒤 좌표·칩 높이 재측정 */
  useEffect(() => {
    const t = window.setTimeout(() => measureCaretEdges(), 450)
    return () => window.clearTimeout(t)
  }, [waveformExpandedLineIndex, measureCaretEdges])

  useEffect(() => {
    if (waveformEnabled && waveformExpandedLineIndex === index) return
    const outer = wordRowOuterRef.current
    const inner = wordRowInnerRef.current
    if (!outer || !inner) return
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => measureCaretEdges())
      })
    })
    ro.observe(outer)
    ro.observe(inner)
    const onWin = (): void => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => measureCaretEdges())
      })
    }
    window.addEventListener('resize', onWin)
    void document.fonts.ready.then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => measureCaretEdges())
      })
    })
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
    }
  }, [measureCaretEdges, index, wordTimeline, waveformEnabled, waveformExpandedLineIndex])

  useEffect(() => {
    setSelectionAnchor(null)
  }, [index, wordRail])

  const setWaveformMountEl = useCallback(
    (el: HTMLDivElement | null) => {
      waveformMountRef.current = el
      if (!waveformEnabled || !(row.words && row.words.length > 0)) {
        registerWaveMount?.(index, null)
        return
      }
      if (waveformExpandedLineIndex === index) {
        registerWaveMount?.(index, el)
      } else {
        registerWaveMount?.(index, null)
      }
    },
    [waveformEnabled, waveformExpandedLineIndex, index, registerWaveMount, row.words?.length]
  )

  const wordTimeSig = useMemo(
    () => wordRail.map((w) => `${w.start}|${w.end}`).join(';'),
    [wordRail]
  )

  /** 파형 마운트는 단어 행과 동일 부모 폭(w-full). 타임라인·미디어 길이 바뀔 때 Peaks fit 동기화 */
  useLayoutEffect(() => {
    if (!waveformEnabled || waveformExpandedLineIndex !== index) return
    onWaveformMountLayout?.()
  }, [
    waveformEnabled,
    waveformExpandedLineIndex,
    index,
    wordTimeSig,
    mediaDurationSec,
    onWaveformMountLayout
  ])

  useEffect(() => {
    if (!waveformEnabled || waveformExpandedLineIndex !== index) return
    const art = articleRef.current
    if (!art) return
    const ro = new ResizeObserver(() => {
      onWaveformMountLayout?.()
    })
    ro.observe(art)
    const onWin = (): void => {
      onWaveformMountLayout?.()
    }
    window.addEventListener('resize', onWin)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
    }
  }, [waveformEnabled, waveformExpandedLineIndex, index, onWaveformMountLayout])

  useLayoutEffect(() => {
    return () => {
      registerWaveMount?.(index, null)
    }
  }, [index, registerWaveMount])

  useEffect(() => {
    setCaretVisible(false)
    setCaretBlink(false)
    setRowHasFocus(false)
    setFocusedCaretIndex(null)
    setHoveredCaretIndex(null)
    spaceSeekIntentRef.current = 'none'
    setKeyboardPauseCaret(false)
  }, [index, wordRail])

  useEffect(() => {
    if (!isPlaying) setKeyboardPauseCaret(false)
  }, [isPlaying])

  useEffect(() => {
    const words = wordRail
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
  }, [index, isPlaying, playheadSec, wordRail, keyboardPauseCaret])

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

    /** Enter 줄바꿈 · Ctrl+Enter 자막 분할(커서 위치) */
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      e.stopPropagation()
      const ta = e.currentTarget
      const live = subtitleTextDraft !== null ? subtitleTextDraft : ta.value
      if (live !== row.text) {
        flushSync(() => {
          updateSubtitleAt(index, live)
        })
      }
      const pos = ta.selectionStart
      splitSubtitleAt(index, pos)
      window.setTimeout(() => requestFocusRow(index + 1, 0), 0)
      return
    }
    if (e.key === 'Enter') {
      e.stopPropagation()
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
    const words = wordRail
    if (words.length === 0) {
      onWaveformSeekAndPlay(row.start)
      return
    }
    const wi = Math.max(0, Math.min(nextCaret, words.length - 1))
    onWaveformSeekAndPlay(words[wi].start)
  }

  /** playhead가 속한 단어 블록 바로 앞의 캐럿 인덱스(재생 중 방향키 기준점) */
  const caretIndexBeforePlayheadWord = (): number => {
    const words = wordRail
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

    const words = wordRail
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
  }, [activeSubtitleIndex, index, isPlaying, playheadSec, wordRail])

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
      const n = wordRail.length
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
      const n = wordRail.length
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
      splitSubtitleAtWord(index, subtitleSplitIndexFromRailCaret(ci))
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
      const n = wordRail.length
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
      const n = wordRail.length
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
          if (t.closest('.subtitle-waveform-mount')) return
          if (t.closest('.subtitle-word-chip') || t.closest('.subtitle-word-caret')) return

          const tryActivateFirstCaret = (): boolean => {
            if (wordRail.length === 0) return false
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
        {wordRail.length > 0 ? (
          <div className="subtitle-card-media-rail flex w-full min-w-0 flex-col">
          <div
            ref={wordRowOuterRef}
            className={`subtitle-word-row subtitle-word-row--wave-seamless ${
              timelineLayoutThisRow
                ? 'subtitle-word-row--time-proportional subtitle-word-row--wave-fit subtitle-word-row--timeline'
                : 'subtitle-word-row--compact'
            }`}
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
            <LayoutGroup id={`subtitle-word-line-${index}`}>
            <div
              ref={wordRowInnerRef}
              className={`subtitle-word-row-scale-inner ${
                timelineLayoutThisRow
                  ? 'subtitle-word-row-scale-inner--timeline'
                  : 'subtitle-word-row-scale-inner--compact'
              }`}
            >
            <div
              className={`subtitle-word-row-tracks ${
                timelineLayoutThisRow
                  ? 'subtitle-word-row-tracks--timeline'
                  : 'subtitle-word-row-tracks--compact'
              }`}
            >
              {wordRail.map((rw, wi) => {
                const isWordActive = isPlaying && playheadSec >= rw.start && playheadSec < rw.end
                const chipWordId = vrewRows?.[index]?.words?.[wi]?.id
                const wordMotionKey =
                  chipWordId != null ? `wid-${chipWordId}` : `w-${index}-${rw.start}-${rw.end}`
                const isActiveWaveformChip =
                  timelineLayoutThisRow &&
                  waveformActiveWordId != null &&
                  chipWordId === waveformActiveWordId
                return (
                  <motion.div
                    key={wordMotionKey}
                    layout={timelineLayoutThisRow}
                    initial={false}
                    transition={WORD_LAYOUT_SPRING}
                    className={`subtitle-word-slot${timelineLayoutThisRow ? '' : ' subtitle-word-slot--compact'}`}
                    style={
                      timelineLayoutThisRow && wordTimeline
                        ? wordChipSlotStyle(rw, wordTimeline)
                        : undefined
                    }
                  >
                    <motion.button
                      layout={timelineLayoutThisRow}
                      initial={false}
                      transition={WORD_LAYOUT_SPRING}
                      id={`subtitle-word-${index}-${wi}`}
                      type="button"
                      tabIndex={-1}
                      data-word-start={rw.start}
                      data-word-end={rw.end}
                      data-waveform-active-word-chip={isActiveWaveformChip ? '1' : undefined}
                      className={`subtitle-word-chip subtitle-word-chip--proportional${isWordActive ? ' subtitle-word-chip--active' : ''}${rw.isSilence ? ' subtitle-word-chip--silence' : ''}`}
                      onMouseEnter={() => {
                        setCaretIndex(wi)
                        showStaticCaret()
                        setHoveredCaretIndex(wi)
                      }}
                      onClick={() => {
                        onWordBlockClick(rw.start)
                        if (isPlaying) {
                          onRequestPausePlayback()
                        }
                        clearSelection()
                        activateCaretAt(wi, true)
                      }}
                      onMouseDown={(e) => {
                        // 클릭하면 해당 단어 "앞" 위치로 커서를 고정한다.
                        // 더블클릭의 두 번째 mousedown(detail>1)에서 preventDefault 하면 dblclick이 막힐 수 있음
                        if (e.detail > 1) return
                        e.preventDefault()
                        if (isPlaying) {
                          onRequestPausePlayback()
                        }
                        clearSelection()
                        activateCaretAt(wi, true)
                      }}
                      onDoubleClick={(e) => {
                        if (!waveformEnabled || !onWaveformWordDoubleClick) return
                        e.preventDefault()
                        e.stopPropagation()
                        onWaveformWordDoubleClick(index, wi)
                      }}
                      title={`${formatTimecode(rw.start)} ~ ${formatTimecode(rw.end)}`}
                    >
                      <span
                        className={
                          hasSelection && wi >= selStart && wi < selEnd
                            ? 'subtitle-word-chip-text subtitle-word-chip-text--selected'
                            : 'subtitle-word-chip-text'
                        }
                      >
                        {rw.label}
                      </span>
                    </motion.button>
                  </motion.div>
                )
              })}
            </div>
            {!timelineLayoutThisRow ? (
            <div className="subtitle-word-carets-overlay" aria-hidden={false}>
              {Array.from({ length: wordRail.length + 1 }, (_, k) => {
                const n = wordRail.length
                const edgeStyle = getWordCaretEdgeStyle(k, n)
                const ty = measuredCaretTopPx?.[k]
                const caretCls = `subtitle-word-caret subtitle-word-caret--overlay${playbackHidesCaret ? ' subtitle-word-caret--hidden' : ''}${isCaretShownAt(k) ? ' subtitle-word-caret--visible' : ''}${!playbackHidesCaret && rowHasFocus && focusedCaretIndex === k ? ' subtitle-word-caret--active' : ''}${!playbackHidesCaret && caretBlink && rowHasFocus && focusedCaretIndex === k ? ' subtitle-word-caret--blink' : ''}`
                return (
                  <button
                    key={`caret-${index}-${k}`}
                    id={`subtitle-caret-${index}-${k}`}
                    type="button"
                    style={
                      ty != null && Number.isFinite(ty)
                        ? { ...edgeStyle, top: ty }
                        : edgeStyle
                    }
                    className={caretCls}
                    tabIndex={0}
                    onClick={() => {
                      if (k > 0) clearSelection()
                      activateCaretAt(k, true)
                    }}
                    onFocus={() => {
                      syncCaretFromFocus(k)
                    }}
                    onMouseEnter={() => {
                      setCaretVisible(true)
                      setCaretBlink(false)
                      setHoveredCaretIndex(k)
                      setCaretIndex(k)
                    }}
                    onKeyDown={(e) => onCaretKeyDown(e, k)}
                    aria-label={`단어 사이 커서 ${k}`}
                  />
                )
              })}
            </div>
            ) : null}
            </div>
            </LayoutGroup>
          </div>
        {waveformEnabled ? (
          <div
            className={`subtitle-waveform-accordion min-h-0 w-full overflow-hidden transition-[max-height] duration-100 ease-out ${
              waveformExpandedLineIndex === index
                ? 'max-h-[min(760px,78vh)]'
                : 'max-h-0 min-h-0'
            }`}
          >
            <div
              ref={setWaveformMountEl}
              data-waveform-mount-for-open-line={waveformExpandedLineIndex === index ? '1' : undefined}
              className="subtitle-waveform-mount relative z-10 w-full min-h-0 min-w-0 border-t border-white/[0.08] bg-transparent"
            />
          </div>
        ) : null}
          </div>
        ) : null}
        <textarea
          id={`subtitle-v-${index}`}
          ref={subtitleTextareaRef}
          className="subtitle-card-textarea subtitle-card-textarea--virtual"
          data-subtitle-edit
          aria-label="자막 텍스트"
          value={subtitleTextDisplay}
          onChange={(e) => {
            setSubtitleTextDraft(e.target.value)
          }}
          onFocus={() => {
            setSubtitleTextDraft(row.text)
            setCaretVisible(false)
            setCaretBlink(false)
          }}
          onBlur={() => {
            const el = subtitleTextareaRef.current
            const cur = subtitleTextDraft !== null ? subtitleTextDraft : el?.value ?? row.text
            if (cur !== row.text) {
              updateSubtitleAt(index, cur)
            }
            setSubtitleTextDraft(null)
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

  /** 파동 펼침 줄은 가상 목록 밖으로 나가면 마운트가 사라져 포털이 보이지 않음 → 즉시 스크롤 + 짧은 재시도 */
  useEffect(() => {
    const idx = props.waveformExpandedLineIndex
    if (idx === null || idx === undefined || idx < 0) return
    const scroll = () => {
      try {
        listRef.current?.scrollToRow({
          index: idx,
          align: 'center',
          behavior: 'instant'
        })
      } catch {
        /* ignore */
      }
    }
    scroll()
    const t1 = window.setTimeout(scroll, 40)
    const t2 = window.setTimeout(scroll, 120)
    const t3 = window.setTimeout(scroll, 220)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.clearTimeout(t3)
    }
  }, [props.waveformExpandedLineIndex, size.h, size.w])

  const requestFocusRow = useCallback((index: number, caret: number | 'end') => {
    if (index < 0) return
    const row = subtitles[index]
    const crossedIntoOtherCard = lastCardFocusRef.current !== index
    if (row && crossedIntoOtherCard) {
      props.onCardNavigate(row.start)
    }
    lastCardFocusRef.current = index
    if (crossedIntoOtherCard) {
      try {
        listRef.current?.scrollToRow({
          index,
          align: 'center',
          behavior: 'instant'
        })
      } catch {
        return
      }
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const ta = document.getElementById(`subtitle-v-${index}`) as HTMLTextAreaElement | null
        if (!ta) return
        ta.focus({ preventScroll: true })
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
    const crossedIntoOtherCard = lastCardFocusRef.current !== cardIndex
    if (row && crossedIntoOtherCard) {
      props.onCardNavigate(row.start)
    }
    lastCardFocusRef.current = cardIndex
    if (crossedIntoOtherCard) {
      try {
        listRef.current?.scrollToRow({
          index: cardIndex,
          align: 'center',
          behavior: 'instant'
        })
      } catch {
        return
      }
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const el = document.getElementById(`subtitle-caret-${cardIndex}-${caretIndex}`) as HTMLButtonElement | null
        if (!el) return
        el.focus({ preventScroll: true })
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
      registerCardFocus,
      waveformEnabled: props.waveformEnabled,
      registerWaveMount: props.registerWaveMount,
      waveformExpandedLineIndex: props.waveformExpandedLineIndex,
      waveformActiveWordId: props.waveformActiveWordId,
      onWaveformWordDoubleClick: props.onWaveformWordDoubleClick,
      vrewRows: props.vrewRows,
      onWaveformMountLayout: props.onWaveformMountLayout,
      mediaDurationSec: props.mediaDurationSec,
      peaksZoomViewRange: props.peaksZoomViewRange
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
      props.waveformEnabled,
      props.registerWaveMount,
      props.waveformExpandedLineIndex,
      props.waveformActiveWordId,
      props.onWaveformWordDoubleClick,
      props.vrewRows,
      props.onWaveformMountLayout,
      props.mediaDurationSec,
      props.peaksZoomViewRange,
      requestFocusRow,
      navigateSubtitleField,
      requestFocusCaret,
      requestFocusCard,
      registerCardFocus
    ]
  )

  /** 고정 행 높이 대신 실제 카드 DOM 높이 측정 — 파형 펼침/접힘에 따라 행마다 빈 슬롯이 생기던 문제 완화 */
  const dynamicRowHeightKey = useMemo(
    () => `${subtitles.length}-${props.waveformExpandedLineIndex ?? 'x'}`,
    [subtitles.length, props.waveformExpandedLineIndex]
  )
  const dynamicRowHeight = useDynamicRowHeight({
    defaultRowHeight: SUBTITLE_LIST_ROW_HEIGHT,
    key: dynamicRowHeightKey
  })

  const waveExpanded =
    props.waveformExpandedLineIndex !== null &&
    props.waveformExpandedLineIndex !== undefined &&
    props.waveformExpandedLineIndex >= 0

  return (
    <div ref={containerRef} className="subtitle-virtual-root">
      {size.h > 0 && size.w > 0 && subtitles.length > 0 ? (
        <List
          listRef={listRef}
          className="subtitle-virtual-list"
          style={{ height: size.h, width: size.w }}
          rowCount={subtitles.length}
          rowHeight={dynamicRowHeight}
          rowComponent={SubtitleVirtualRow}
          rowProps={rowProps}
          /** 160 은 스크롤 밖까지 수백 행을 마운트해 타이핑 시 전체가 버벅였음 — 파형 줄도 소량 overscan 으로 충분 */
          overscanCount={waveExpanded ? 10 : 6}
        />
      ) : null}
    </div>
  )
}
