import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MutableRefObject
} from 'react'
import { flushSync } from 'react-dom'
import { LayoutGroup, motion } from 'framer-motion'
import { List, useDynamicRowHeight, useListRef } from 'react-window'
import type { RowComponentProps } from 'react-window'
import type { MouseEvent } from 'react'

import type { SubtitleLine } from '../../shared/subtitles'
import {
  DISPLAY_CROSS_CARD_GAP_ABSORB_MS,
  DISPLAY_GAP_ABSORB_MS,
  resolveDisplayEndSec
} from '../../shared/subtitleDisplayTime'
import type { JsonWaveformData } from '../../shared/waveformJson'
import {
  nearestValidStorageCaret,
  renderableCaretToStorageCaret,
  stepStorageCaretByRenderable,
  storageCaretToRenderableCaret,
  visibleWordStorageIndices
} from '../../shared/subtitleWordCaretMap'
import type { SubtitleRow } from './components/vrewPeaksEditor/types'
import type { PeaksZoomViewRange } from './SubtitleWaveformPeaks'
import { computeLineZoomWindowFromCardBounds, type LineZoomWindowResult } from './lineZoomWindow'
import { useSubtitleData } from './subtitleDataContext'
import { peaksJsonRawDataLength } from './wordCanvas/peaksSentenceSlice'
import { SentenceLineWaveformCanvas } from './waveform/SentenceLineWaveformCanvas'

const WORD_LAYOUT_SPRING = { type: 'spring' as const, stiffness: 380, damping: 34 }
/** 파형 타임라인 펼침 — 칩 너비·위치 전환을 조금 더 부드럽게 */
const WORD_LAYOUT_SPRING_TIMELINE = { type: 'spring' as const, stiffness: 300, damping: 36, mass: 0.92 }

/** 가상 목록 기본 행 높이(초기 추정) — 이후 `useDynamicRowHeight`+ResizeObserver로 실제 카드 높이로 갱신 */
export const SUBTITLE_LIST_ROW_HEIGHT = 152

/** 단어 레일 — 파형 켜진 줄은 Peaks 와 같은 소스(vrew)로 시간 경계를 맞춘다 */
type WordRailItem = {
  start: number
  end: number
  label: string
  isSilence?: boolean
  /** `row.words` 배열 인덱스 — tombstone(`isDeleted`) 은 렌더에서 제외해도 API·캐럿은 스토리지 인덱스 기준 */
  storageIndex: number
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
  activeSubtitleIndexRef: MutableRefObject<number | null>
  playheadSecRef: MutableRefObject<number>
  isPlaying: boolean
  mediaFileUrl: string | null
  onSubtitleCardClick: (e: MouseEvent<HTMLElement>, startSec: number) => void
  onCardNavigate: (startSec: number) => void
  onRequestPausePlayback: (reason: string) => void
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
  waveformActiveWordId?: string | null
  onWaveformWordDoubleClick?: (lineIndex: number, wordIndex: number) => void
  /** 파형 펼침 줄에서 단어 칩 단일 클릭 — 활성 단어는 접기, 그 외 단어는 포커스만 이동 */
  onWaveformExpandedLineWordClick?: (lineIndex: number, wordIndex: number) => void
  vrewRows?: SubtitleRow[]
  /** 파형 마운트를 선택 단어 아래로 정렬한 뒤 body 포털 위치 동기화 */
  onWaveformMountLayout?: () => void
  /** 미디어 길이(초) — 단어 칹·줌 창 상한과 동일하게 맞춤 */
  mediaDurationSec?: number
  /** Peaks zoomview 실제 구간 — 있으면 칹 %는 이 축을 따름(zoomLevels 양자화 일치) */
  peaksZoomViewRange?: PeaksZoomViewRange | null
  /** 문장 카드 로컬 파형 — 원본 미디어 피크(JSON); 줄 단위 canvas 슬라이스만 그림(전역 스티치 X) */
  waveformPeaksJson?: JsonWaveformData | null
  /** 피크 길이 힌트(초) — App 의 `durationSec` 와 동일 정책 (`exactTimelineDurationSecFromWaveformJson` 보조) */
  waveformMediaDurationHintSec?: number
}

/** `List` 의 `rowProps` — `index` / `style` / `ariaAttributes` 는 List가 주입 */
export type SubtitleListRowProps = {
  subtitles: SubtitleLine[]
  activeSubtitleIndexRef: MutableRefObject<number | null>
  playheadSecRef: MutableRefObject<number>
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
  waveformActiveWordId?: string | null
  onWaveformWordDoubleClick?: (lineIndex: number, wordIndex: number) => void
  onWaveformExpandedLineWordClick?: SubtitleVirtualListProps['onWaveformExpandedLineWordClick']
  vrewRows?: SubtitleRow[]
  onWaveformMountLayout?: SubtitleVirtualListProps['onWaveformMountLayout']
  mediaDurationSec?: number
  peaksZoomViewRange?: PeaksZoomViewRange | null
  waveformPeaksJson?: JsonWaveformData | null
  waveformMediaDurationHintSec?: number
}

const shouldDeleteAudioForWords = (words: Array<{ isSilence?: boolean }> | undefined): boolean =>
  Boolean(words && words.length > 0 && words.every((w) => Boolean(w.isSilence)))

function SubtitleVirtualRowImpl(props: RowComponentProps<SubtitleListRowProps>) {
  const {
    index,
    style,
    subtitles,
    activeSubtitleIndexRef,
    playheadSecRef,
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
    onWaveformExpandedLineWordClick,
    vrewRows,
    onWaveformMountLayout,
    mediaDurationSec,
    peaksZoomViewRange,
    waveformPeaksJson,
    waveformMediaDurationHintSec
  } = props
  const requestFocusCaret = requestFocusWord
  const row = subtitles[index]
  if (!row) return null
  /**
   * 모든 단어가 tombstone(`isDeleted`) 된 카드 — UI 에서는 빈 카드로 남지 않도록 0 높이 숨김 행을 렌더.
   * 배열에서 줄을 실제로 제거하지는 않아 인덱스 기반 콜백 / 캐럿 매핑이 그대로 유지된다.
   * `useDynamicRowHeight` 의 ResizeObserver 가 0px 을 측정 → 가상 목록에서 자리가 회수된다.
   */
  if (row.isDeleted === true) {
    return (
      <div
        style={{ ...style, height: 0, padding: 0, margin: 0, overflow: 'hidden', pointerEvents: 'none' }}
        aria-hidden="true"
      />
    )
  }
  const [caretIndex, setCaretIndex] = useState(0)
  const [caretVisible, setCaretVisible] = useState(false)
  const [caretBlink, setCaretBlink] = useState(false)
  const [rowHasFocus, setRowHasFocus] = useState(false)
  const [focusedCaretIndex, setFocusedCaretIndex] = useState<number | null>(null)
  const [hoveredCaretIndex, setHoveredCaretIndex] = useState<number | null>(null)
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null)
  const articleRef = useRef<HTMLElement | null>(null)
  const waveformMountRef = useRef<HTMLDivElement | null>(null)
  /** Space: 의도(wholeLine/caret)가 있으면 해당 지점에서 즉시 재생(seek+play). 그 외는 재생/일시정지 토글 */
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

  /**
   * 렌더링 단위 레일 — **tombstone(`isDeleted`) 제외**, 각 칩은 원본 `row.words` 의 `storageIndex` 보존.
   *
   * - 칩의 visual index `wi` 는 **렌더 가능 캐럿(renderable)** 축.
   * - App 으로 보내는 모든 콜백(`deleteWordAt/Range`, `splitSubtitleAtWord`, `onWaveformWordDoubleClick`, ...) 은
   *   **`rw.storageIndex`** 를 사용 — App.tsx 는 항상 원본 배열 인덱스를 기준으로 동작한다.
   * - 키보드 네비게이션은 visible 슬롯을 따라 이동하지만, 상태로 저장되는 `caretIndex` / `selectionAnchor` 는
   *   `subtitleWordCaretMap` 의 `renderableCaretToStorageCaret` 매핑으로 **storage caret** 으로 정규화한다.
   *
   * vrew 경로(silence gap-fill 더미)는 의도적으로 제거 — gap-fill 은 삭제 시 자동으로 꺼지고
   * (`setGapFillWhenBuildingVrew(false)`), 칩은 자막 SSOT(`row.words`) 와 1:1 로만 그린다.
   */
  const wordRail = useMemo((): WordRailItem[] => {
    const sw = row.words ?? []
    const out: WordRailItem[] = []
    for (let i = 0; i < sw.length; i++) {
      const w = sw[i]!
      if (w.isDeleted === true) continue
      out.push({
        start: w.start,
        end: w.end,
        label: w.isSilence ? (String(w.word).trim() || '??') : w.word,
        isSilence: w.isSilence,
        storageIndex: i
      })
    }
    return out
  }, [row.words])

  /**
   * 카드 헤더와 마지막 단어 툴팁이 **동일한 끝 시각** 을 쓰도록 한 곳에서 계산.
   *
   * - 카드↔카드 사이 짧은 갭(≤ `DISPLAY_CROSS_CARD_GAP_ABSORB_MS`) 은 다음 카드 시작으로 흡수.
   * - 단어↔단어 / 마지막 단어↔카드 끝 사이 짧은 갭(≤ `DISPLAY_GAP_ABSORB_MS`) 은 칩 툴팁에서 흡수.
   * - 데이터(`row.end`, `rw.end`) 자체는 불변 — 본 값은 **표시 전용**.
   */
  const effectiveCardEndSec = resolveDisplayEndSec(
    row.end,
    subtitles[index + 1]?.start ?? null,
    DISPLAY_CROSS_CARD_GAP_ABSORB_MS
  )

  /**
   * row.words 변경 시 캐럿/선택 앵커의 **단일 소유자는 명시적 액션(`requestFocusCaret`)** 이다.
   *  - Backspace/Delete/Split 핸들러가 setTimeout(0) 으로 `requestFocusCaret(index, target)` 을 호출해
   *    의도한 자리에 캐럿을 둔다 — 본 effect 는 그 결과를 덮어쓰면 안 된다.
   *  - 과거에 visible 축 환산(`storageCaret ↔ renderableCaret`) 으로 자동 정렬을 시도하면, 명시 액션과
   *    race 가 나서 캐럿이 끝(또는 엉뚱한 자리) 으로 점프하는 “위치가 병신” 현상이 생겼다.
   *  - 본 effect 는 (a) react-window 가상 리스트가 같은 인스턴스를 다른 `index` 행에 **재활용** 한 경우에만
   *    캐럿을 재계산하고, (b) 그 외에는 단어 수가 줄어 storage 캐럿이 length 를 초과한 경우만 **boundary clamp**
   *    한다. 그 외 valid 범위 내 캐럿은 그대로 유지한다.
   */
  const prevIndexRef = useRef<number>(index)
  useEffect(() => {
    const sw = row.words ?? []
    const prevIndex = prevIndexRef.current
    prevIndexRef.current = index
    if (prevIndex !== index) {
      setCaretIndex((prev) => nearestValidStorageCaret(sw, Math.max(0, Math.min(prev, sw.length))))
      setSelectionAnchor((prev) =>
        prev === null ? prev : nearestValidStorageCaret(sw, Math.max(0, Math.min(prev, sw.length)))
      )
      return
    }
    // boundary clamp 만 — 명시 액션이 valid 위치를 설정했다면 그대로 유지된다.
    setCaretIndex((prev) => (prev > sw.length ? nearestValidStorageCaret(sw, sw.length) : prev))
    setSelectionAnchor((prev) => {
      if (prev === null) return prev
      if (prev > sw.length) return nearestValidStorageCaret(sw, sw.length)
      return prev
    })
  }, [row.words, index])

  /**
   * 파형이 열린 줄: Peaks 실제 zoomview 구간과 줄 구간을 맞춘다.
   * 다만 사전 생성 waveform JSON 의 최소 scale(samples_per_pixel) 때문에 Peaks 가
   * 요청한 초 단위보다 훨씬 넓은 시간을 보여 줄 수 있음 — 그때는 칹 %를 줄(카드) 구간으로 채워
   * 단어 라벨이 잘리지 않게 한다. 좁은 줌에서는 여전히 Peaks 구간을 써 세그먼트와 픽셀을 맞춘다.
   */
  const wordTimeline = useMemo((): LineZoomWindowResult | null => {
    if (wordRail.length === 0) return null
    const lineStart = Math.min(...wordRail.map((w) => w.start))
    const lineEnd = Math.max(...wordRail.map((w) => w.end))
    const lineTw = computeLineZoomWindowFromCardBounds(lineStart, lineEnd, {
      mediaDurationSec:
        mediaDurationSec != null && mediaDurationSec > 0 ? mediaDurationSec : undefined,
      clipTrailingToLineEnd: true
    })
    if (
      peaksZoomViewRange != null &&
      peaksZoomViewRange.lineIndex === index &&
      waveformExpandedLineIndex === index
    ) {
      const ws = peaksZoomViewRange.windowStart
      const we = peaksZoomViewRange.windowEnd
      const peaksSpan = Math.max(we - ws, 1e-6)
      if (peaksSpan <= lineTw.span * 1.14) {
        return {
          lineStart,
          lineEnd,
          windowStart: ws,
          windowEnd: we,
          span: peaksSpan
        }
      }
    }
    return lineTw
  }, [wordRail, mediaDurationSec, peaksZoomViewRange, waveformExpandedLineIndex, index])

  /**
   * 문장 카드 로컬 파형 canvas — **항상 원본 미디어 축** 단어 시간 min/max 로 잘라 그린다.
   * - 단어 삭제(`isDeleted: true`) 토글은 같은 줄의 `row.words` 만 바뀌므로 이 카드의 effect 하나만 다시 돌고
   *   전역 `stitchWaveformJsonByCuts` 호출과는 분리된다 (O(1) 로컬 갱신).
   * - 파형이 펼쳐진 줄(메인 Peaks 인스턴스가 그리는 중) 에서는 시각적 중복을 피해 캔버스를 끄지 않는다 —
   *   캔버스는 `z-0 absolute bottom-0` 로 단어 칩 뒤에 깔리므로 텍스트 가독성을 해치지 않는다.
   */
  const lineWaveformWindow = useMemo((): { start: number; end: number } | null => {
    const ws = row.words ?? []
    if (ws.length === 0) return null
    let s = Number.POSITIVE_INFINITY
    let e = Number.NEGATIVE_INFINITY
    for (const w of ws) {
      const a = Math.min(w.start, w.end)
      const b = Math.max(w.start, w.end)
      if (a < s) s = a
      if (b > e) e = b
    }
    if (!Number.isFinite(s) || !Number.isFinite(e) || !(e > s)) return null
    return { start: s, end: e }
  }, [row.words])

  /** 피크 JSON 동등 비교 지문 — 객체 자체가 안 바뀌어도 길이 바뀌면 강제 redraw */
  const peaksDataSig = useMemo(
    () => peaksJsonRawDataLength(waveformPeaksJson ?? null),
    [waveformPeaksJson]
  )

  /**
   * 이 줄에서 파형이 펼쳐졌는가 — 파형 패널 마운트·활성 칩 매칭·캐럿 오버레이 숨김에만 사용.
   * (단어 칩 레이아웃에는 영향 주지 않음 — 더블클릭 전후로 칩 크기·줄바꿈은 그대로 유지)
   */
  const waveformExpandedThisRow = Boolean(
    waveformEnabled && waveformExpandedLineIndex === index
  )
  /**
   * 단어 줄을 시간축 비율(%) 레이아웃으로 둘 것인가 — 항상 false.
   * 파형이 열려도 칩은 compact(줄바꿈) 모드를 그대로 유지해, 단어 블록 크기가 파형 패널 폭에
   * 끌려 커지지 않도록 한다. (예전에는 `waveformEnabled && waveformExpandedLineIndex === index`
   * 일 때 true 였고, 그게 단어 칩이 시간 비율로 넓어지는 원인이었음.)
   */
  const timelineLayoutThisRow = false

  const wordRowOuterRef = useRef<HTMLDivElement>(null)
  const wordRowInnerRef = useRef<HTMLDivElement>(null)
  /** 활성 단어 칩 단일 클릭 접기는 지연 — 더블클릭(포커스 이동)이 성립하면 타이머 취소 */
  const activeChipCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (activeChipCloseTimerRef.current != null) {
        clearTimeout(activeChipCloseTimerRef.current)
        activeChipCloseTimerRef.current = null
      }
    }
  }, [])
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
    /**
     * `wi` 는 visible(wordRail) 인덱스. 칩 DOM id 는 `storageIndex` 로 만들어지므로(tombstone 이 있는 카드는
     * `wi !== storageIndex`), visible 인덱스로 `getElementById` 하면 null 또는 **다른 칩**을 잡아 caret 좌표가
     * tombstone 영역(다음 칩 안쪽)으로 잘못 계산된다. 반드시 `wordRail[wi].storageIndex` 로 룩업한다.
     */
    const chipEl = (wi: number) => {
      const si = words[wi]?.storageIndex
      if (si == null) return null
      return document.getElementById(`subtitle-word-${index}-${si}`)
    }
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

  /** 캐럿 측정 invalidation 키 — tombstone 토글 시에도 변하도록 row.words 전부를 포함 */
  const wordTimeSig = useMemo(() => {
    const sw = row.words ?? []
    return sw
      .map((w) => `${w.start}|${w.end}|${w.isDeleted === true ? 'd' : 'a'}`)
      .join(';')
  }, [row.words])

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

  /**
   * 활성 단어 칩 중앙에 파형 패널을 정렬한다.
   * - 더블클릭한 칩의 가로 중앙 좌표를 기준으로 패널이 가운데 정렬되도록 `--subwave-panel-left-px` CSS 변수를
   *   파형 마운트(`subtitle-waveform-mount`)에 기록한다.
   * - 카드 좌/우 경계를 벗어나면 가능한 만큼 좌·우 가까이 붙도록 `[0, mountW - panelW]` 로 클램프한다.
   * - 활성 칩을 찾을 수 없으면 변수 제거 → 패널은 기본 `margin: auto` 로 가운데 정렬된다.
   */
  useLayoutEffect(() => {
    if (!(waveformEnabled && waveformExpandedLineIndex === index)) return
    const mount = waveformMountRef.current
    const card = articleRef.current
    if (!mount || !card) return

    const PANEL_MAX_PX = 336

    const applyOffset = (): void => {
      const mountRect = mount.getBoundingClientRect()
      if (mountRect.width <= 0) return

      let chipEl: HTMLElement | null = null
      if (waveformActiveWordId != null) {
        try {
          chipEl = card.querySelector(
            `[data-word-id="${CSS.escape(String(waveformActiveWordId))}"]`
          ) as HTMLElement | null
        } catch {
          chipEl = null
        }
      }
      if (!chipEl) {
        chipEl = card.querySelector(
          '[data-waveform-active-word-chip="1"]'
        ) as HTMLElement | null
      }
      if (!chipEl) {
        mount.style.removeProperty('--subwave-panel-left-px')
        return
      }

      const chipRect = chipEl.getBoundingClientRect()
      const chipCenterPx = (chipRect.left + chipRect.right) / 2 - mountRect.left
      const panelWidth = Math.min(mountRect.width, PANEL_MAX_PX)
      const ideal = chipCenterPx - panelWidth / 2
      const maxLeft = Math.max(0, mountRect.width - panelWidth)
      const clamped = Math.max(0, Math.min(maxLeft, ideal))
      mount.style.setProperty('--subwave-panel-left-px', `${Math.round(clamped)}px`)
    }

    applyOffset()

    const ro = new ResizeObserver(() => applyOffset())
    ro.observe(mount)
    ro.observe(card)
    const onWin = (): void => applyOffset()
    window.addEventListener('resize', onWin)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
      mount.style.removeProperty('--subwave-panel-left-px')
    }
  }, [
    waveformEnabled,
    waveformExpandedLineIndex,
    index,
    waveformActiveWordId,
    wordRail
  ])

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

  useLayoutEffect(() => {
    const t = playheadSecRef.current
    const playing = isPlaying
    const mount = articleRef.current
    if (!mount) return
    mount.querySelectorAll<HTMLElement>('.subtitle-word-chip').forEach((el) => {
      const s = parseFloat(el.dataset.wordStart ?? el.getAttribute('data-word-start') ?? 'NaN')
      const e = parseFloat(el.dataset.wordEnd ?? el.getAttribute('data-word-end') ?? 'NaN')
      if (!Number.isFinite(s) || !Number.isFinite(e)) return
      el.classList.toggle('subtitle-word-chip--active', playing && t >= s && t < e)
    })
  }, [wordRail, index, playheadSecRef])

  useEffect(() => {
    if (!isPlaying || keyboardPauseCaret) return
    const id = window.setInterval(() => {
      const playheadSec = playheadSecRef.current
      const words = wordRail
      const wi = words.findIndex((w) => playheadSec >= w.start && playheadSec < w.end)

      const root = articleRef.current
      const focused = document.activeElement as HTMLElement | null
      if (root && focused && root.contains(focused)) {
        if (focused.closest('[data-subtitle-edit]')) return
        if (focused.closest('.subtitle-word-row')) return
      }

      setCaretVisible(false)
      setCaretBlink(false)
      if (wi >= 0) setCaretIndex(wi)
      const activeEl = document.activeElement as HTMLElement | null
      if (activeEl?.id?.startsWith(`subtitle-caret-${index}-`)) activeEl.blur()
    }, 32)
    return () => window.clearInterval(id)
  }, [index, isPlaying, wordRail, keyboardPauseCaret, playheadSecRef])

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

  /**
   * `storageCaret` 을 활성화한다.
   * - 상태로 저장하는 `caretIndex` 는 storage 축(`row.words` 인덱스).
   * - DOM caret 버튼은 visible 슬롯마다 하나씩 그려지므로(id=`subtitle-caret-${row}-${renderableCaret}`),
   *   포커스는 visible 슬롯 인덱스(renderable)로 한다.
   * - 빈 줄(보이는 단어 없음) 이거나 storage 가 유효 경계가 아니면 `nearestValidStorageCaret` 로 스냅.
   */
  const activateCaretAt = (storageCaret: number, blink: boolean, armSpaceSeek = true) => {
    const subs = row.words ?? []
    const safe = nearestValidStorageCaret(subs, storageCaret)
    const rc = storageCaretToRenderableCaret(subs, safe)
    if (armSpaceSeek) spaceSeekIntentRef.current = 'caret'
    setCaretIndex(safe)
    setCaretVisible(true)
    setCaretBlink(blink)
    setRowHasFocus(true)
    setFocusedCaretIndex(rc)
    setHoveredCaretIndex(null)
    window.requestAnimationFrame(() => {
      const el = document.getElementById(`subtitle-caret-${index}-${rc}`) as HTMLButtonElement | null
      const active = document.activeElement as HTMLElement | null
      if (el && active?.id !== el.id) el.focus({ preventScroll: true })
    })
  }
  /** caret 버튼이 직접 포커스되면 → visible 슬롯(`renderableCaret`)로부터 storage caret 동기화 */
  const syncCaretFromFocus = (renderableCaret: number) => {
    const subs = row.words ?? []
    const storage = renderableCaretToStorageCaret(subs, renderableCaret)
    spaceSeekIntentRef.current = 'caret'
    setCaretIndex(storage)
    setCaretVisible(true)
    setCaretBlink(true)
    setRowHasFocus(true)
    setFocusedCaretIndex(renderableCaret)
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

  /** `storageCaret`: row.words 인덱스 기준. 0..row.words.length. 가장 가까운 보이는 단어부터 재생. */
  const playAtCaret = (storageCaret: number) => {
    const subs = row.words ?? []
    if (subs.length === 0) {
      onWaveformSeekAndPlay(row.start)
      return
    }
    // 보이는 단어가 하나도 없으면 줄 시작에서 시작
    const visIdx = visibleWordStorageIndices(subs)
    if (visIdx.length === 0) {
      onWaveformSeekAndPlay(row.start)
      return
    }
    const c = Math.max(0, Math.min(storageCaret, subs.length))
    // storage caret c → 보이는 단어 중 c 이상 첫 번째(즉, 캐럿 오른쪽의 단어). 없으면 마지막 보이는 단어.
    let pick = visIdx.find((i) => i >= c)
    if (pick == null) pick = visIdx[visIdx.length - 1]!
    onWaveformSeekAndPlay(subs[pick]!.start)
  }

  /** playhead가 속한 (보이는) 단어 블록의 **앞** 경계 storage caret — 재생 중 방향키 기준점 */
  const caretIndexBeforePlayheadWord = (): number => {
    const subs = row.words ?? []
    if (subs.length === 0) return 0
    const playheadSec = playheadSecRef.current
    // 보이는 단어 안에 playhead 가 있으면 그 단어 앞 storage 캐럿
    for (let i = 0; i < subs.length; i++) {
      const w = subs[i]!
      if (w.isDeleted === true) continue
      if (playheadSec >= w.start && playheadSec < w.end) return i
    }
    // 그 외 — playhead 앞에 처음 오는 보이는 단어
    for (let i = 0; i < subs.length; i++) {
      const w = subs[i]!
      if (w.isDeleted === true) continue
      if (playheadSec < w.start) return i
    }
    return subs.length
  }

  const prevIsPlayingRef = useRef(isPlaying)
  useEffect(() => {
    const justPaused = prevIsPlayingRef.current && !isPlaying
    prevIsPlayingRef.current = isPlaying
    if (!justPaused) return
    if (activeSubtitleIndexRef.current !== index) return
    if (skipPlayheadCaretSyncOnPauseRef.current) {
      skipPlayheadCaretSyncOnPauseRef.current = false
      return
    }

    const root = articleRef.current
    const ae = document.activeElement as HTMLElement | null
    if (ae && root?.contains(ae) && ae.closest('[data-subtitle-edit]')) return

    const subs = row.words ?? []
    if (subs.length === 0) return

    // storage caret = playhead 가 속한 보이는 단어 앞 (== `caretIndexBeforePlayheadWord` 동일 정책)
    const playheadSec = playheadSecRef.current
    let snap = subs.length
    for (let i = 0; i < subs.length; i++) {
      const w = subs[i]!
      if (w.isDeleted === true) continue
      if (playheadSec >= w.start && playheadSec < w.end) {
        snap = i
        break
      }
      if (playheadSec < w.start) {
        snap = i
        break
      }
    }
    snap = nearestValidStorageCaret(subs, snap)
    const focusRc = storageCaretToRenderableCaret(subs, snap)

    setCaretIndex(snap)
    setFocusedCaretIndex(focusRc)
    setRowHasFocus(true)
    setCaretVisible(true)
    setCaretBlink(true)
    spaceSeekIntentRef.current = 'caret'
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        // DOM id 는 visible 슬롯(renderable) 축
        const el = document.getElementById(`subtitle-caret-${index}-${focusRc}`) as HTMLElement | null
        el?.focus({ preventScroll: true })
      })
    })
  }, [activeSubtitleIndexRef, index, isPlaying, row.words, playheadSecRef])

  /**
   * `renderableCi`: 캐럿 버튼이 위치한 visible 슬롯 인덱스 (0..visible.length).
   * 상태로 저장하는 caret 은 storage 축이며, 이동은 visible 단어 경계를 따른다.
   */
  const onCaretKeyDown = (e: KeyboardEvent<HTMLButtonElement>, renderableCi: number) => {
    /**
     * **Ctrl+Z / Ctrl+Y (또는 Ctrl+Shift+Z) 는 stopPropagation 하지 않는다.**
     * caret 에 포커스가 있는 상태에서 단어 삭제 후 Ctrl+Z 를 누르면, 이전 코드는 무조건 stopPropagation 으로
     * App-level window keydown 핸들러가 받지 못해 undo 가 묻혀 있었다. caret 핸들러는 'z'/'y' 를 처리하지 않으므로
     * 이벤트가 window 까지 buble 하도록 그대로 둔다.
     */
    const isCtrlModifier = e.ctrlKey || e.metaKey
    const lowerKey = e.key.toLowerCase()
    const isUndoRedoHotkey = isCtrlModifier && (lowerKey === 'z' || lowerKey === 'y')
    if (!isUndoRedoHotkey) {
      e.stopPropagation()
    }
    const subs = row.words ?? []
    const ci = renderableCaretToStorageCaret(subs, renderableCi)
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault()
      if (isPlaying) {
        onTogglePlayback()
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
        onRequestPausePlayback('row-caret-arrow-nav')
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
      clearSelection()
      showKeyboardCaret()
      activateCaretAt(subs.length, true)
      seekAtCaret(0)
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
      const visN = wordRail.length
      if (isPlaying) {
        clearSelection()
        const snapStorage = caretIndexBeforePlayheadWord()
        const snapRc = storageCaretToRenderableCaret(subs, snapStorage)
        if (snapRc < visN) {
          activateCaretAt(snapStorage, true)
          seekAtCaret(0)
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
      if (renderableCi < visN) {
        const nextStorage = stepStorageCaretByRenderable(subs, ci, 1)
        activateCaretAt(nextStorage, true)
        seekAtCaret(0)
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
        const snapStorage = stepStorageCaretByRenderable(subs, caretIndexBeforePlayheadWord(), -1)
        activateCaretAt(snapStorage, true)
        seekAtCaret(0)
        return
      }
      if (e.shiftKey) {
        setSelectionAnchor((prev) => (prev === null ? ci : prev))
      } else {
        clearSelection()
      }
      if (renderableCi > 0) {
        const prevStorage = stepStorageCaretByRenderable(subs, ci, -1)
        activateCaretAt(prevStorage, true)
        seekAtCaret(0)
      } else {
        const prevWords = subtitles[index - 1]?.words ?? []
        if (index > 0) {
          // 이전 줄의 끝 caret(renderable) = 그 줄의 보이는 단어 개수
          const prevVisN = visibleWordStorageIndices(prevWords).length
          requestFocusCaret(index - 1, prevVisN)
        }
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      clearSelection()
      showKeyboardCaret()
      // `ci` 가 storage 축이라 그대로 `splitSubtitleAtWord` 분리 지점으로 사용
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
        if (to > from && words[from] && words[to - 1] && shouldDeleteAudioForWords(words.slice(from, to))) {
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
      // 캐럿 왼쪽에서 가장 가까운 **보이는** 단어를 찾아 삭제 (tombstone 은 건너뜀)
      let leftIdx = ci - 1
      while (leftIdx >= 0 && words[leftIdx]?.isDeleted === true) leftIdx -= 1
      const seekSec = words[Math.max(0, leftIdx)]?.start ?? row.start
      if (leftIdx >= 0) {
        const leftWord = words[leftIdx]
        if (leftWord?.isSilence) onDeleteAudioRange(leftWord.start, leftWord.end)
        backspaceWordAt(index, leftIdx + 1)
        onCardNavigate(seekSec)
        registerCardFocus(index)
        window.setTimeout(() => requestFocusCaret(index, leftIdx), 0)
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
        if (to > from && words[from] && words[to - 1] && shouldDeleteAudioForWords(words.slice(from, to))) {
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
      // 캐럿 오른쪽에서 가장 가까운 **보이는** 단어를 찾아 삭제 (tombstone 은 건너뜀)
      let rightIdx = ci
      while (rightIdx < words.length && words[rightIdx]?.isDeleted === true) rightIdx += 1
      const seekSec = words[Math.min(rightIdx, Math.max(0, words.length - 1))]?.start ?? row.start
      if (rightIdx < words.length) {
        const targetWord = words[rightIdx]
        if (targetWord?.isSilence) onDeleteAudioRange(targetWord.start, targetWord.end)
        deleteWordAt(index, rightIdx)
        onCardNavigate(seekSec)
        registerCardFocus(index)
        window.setTimeout(() => requestFocusCaret(index, rightIdx), 0)
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
        onTogglePlayback()
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
        onRequestPausePlayback('row-card-arrow-nav')
      }
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      const subs = row.words ?? []
      const visN = wordRail.length
      if (isPlaying) {
        const snapStorage = caretIndexBeforePlayheadWord()
        const snapRc = storageCaretToRenderableCaret(subs, snapStorage)
        if (visN === 0 || snapRc >= visN) {
          setCaretVisible(false)
          setCaretBlink(false)
          requestFocusRow(index, 0)
        } else {
          setCaretIndex(snapStorage)
          setFocusedCaretIndex(snapRc)
          showKeyboardCaret()
          requestFocusCaret(index, snapStorage)
          seekAtCaret(0)
        }
        return
      }
      const curRc = storageCaretToRenderableCaret(subs, caretIndex)
      if (visN === 0 || curRc >= visN) {
        setCaretVisible(false)
        setCaretBlink(false)
        requestFocusRow(index, 0)
      } else {
        const nextStorage = stepStorageCaretByRenderable(subs, caretIndex, 1)
        setCaretIndex(nextStorage)
        setFocusedCaretIndex(storageCaretToRenderableCaret(subs, nextStorage))
        showKeyboardCaret()
        requestFocusCaret(index, nextStorage)
        seekAtCaret(0)
      }
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const subs = row.words ?? []
      if (isPlaying) {
        const snapStorage = stepStorageCaretByRenderable(subs, caretIndexBeforePlayheadWord(), -1)
        setCaretIndex(snapStorage)
        setFocusedCaretIndex(storageCaretToRenderableCaret(subs, snapStorage))
        showKeyboardCaret()
        requestFocusCaret(index, snapStorage)
        seekAtCaret(0)
        return
      }
      const curRc = storageCaretToRenderableCaret(subs, caretIndex)
      if (curRc > 0) {
        const prevStorage = stepStorageCaretByRenderable(subs, caretIndex, -1)
        setCaretIndex(prevStorage)
        setFocusedCaretIndex(storageCaretToRenderableCaret(subs, prevStorage))
        showKeyboardCaret()
        requestFocusCaret(index, prevStorage)
        seekAtCaret(0)
      } else if (index > 0) {
        const prevWords = subtitles[index - 1]?.words ?? []
        const prevEndStorage = prevWords.length
        showKeyboardCaret()
        requestFocusCaret(index - 1, prevEndStorage)
      }
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setCaretIndex(0)
      setFocusedCaretIndex(0)
      showKeyboardCaret()
      requestFocusCaret(index, 0)
      seekAtCaret(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      const subs = row.words ?? []
      const endStorage = subs.length
      setCaretIndex(endStorage)
      setFocusedCaretIndex(wordRail.length)
      showKeyboardCaret()
      requestFocusCaret(index, endStorage)
      seekAtCaret(0)
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
        className="subtitle-card subtitle-card--virtual"
        tabIndex={0}
        onMouseDownCapture={(e) => {
          const t = e.target as HTMLElement
          if (t.closest('textarea') || t.closest('[data-subtitle-edit]')) return
          if (t.closest('.subtitle-waveform-mount')) return
          if (t.closest('.subtitle-word-chip') || t.closest('.subtitle-word-caret')) return

          const tryActivateFirstCaret = (): boolean => {
            if (wordRail.length === 0) return false
            e.preventDefault()
            if (isPlaying) onRequestPausePlayback('row-mousedown-caret-activate')
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
          // setTimeout 으로 미루면 React SyntheticEvent 의 currentTarget 이 비워질 수 있으므로
          // 클로저로 캡처해 두고 unmount 등 분리된 경우엔 articleRef 폴백을 본다.
          const targetEl: HTMLElement | null = (e.currentTarget as HTMLElement) ?? null
          window.setTimeout(() => {
            const active = document.activeElement as Node | null
            const rootEl = targetEl ?? articleRef.current
            const stillInside = !!active && !!rootEl && rootEl.contains(active)
            if (!stillInside) {
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
            <span className="subtitle-time">{formatTimecode(effectiveCardEndSec)}</span>
          </div>
        </div>
        {wordRail.length > 0 ? (
          <div className="subtitle-card-media-rail flex w-full min-w-0 flex-col">
          <div
            ref={wordRowOuterRef}
            className={`relative subtitle-word-row subtitle-word-row--wave-seamless ${
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
            {/*
              줄 카드 뒤 미니 파형(canvas) — 사용자 요청으로 숨김.
              `SentenceLineWaveformCanvas` 컴포넌트와 매핑 유틸은 그대로 유지(언제든 복귀 가능).
              `waveformPeaksJson` · `lineWaveformWindow` · `peaksDataSig` 메모도 유지: 추후 토글 추가 시 재사용.
            */}
            <LayoutGroup id={`subtitle-word-line-${index}`}>
            <div
              ref={wordRowInnerRef}
              className={`relative z-[1] subtitle-word-row-scale-inner ${
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
                // `wi` = renderable(visible) 인덱스, `rw.storageIndex` = `row.words` 원본 인덱스
                // vrew rows 는 동일하게 visible-only 로 빌드되므로 `wi` 로 매칭(1:1)
                const chipWordId = vrewRows?.[index]?.words?.[wi]?.id
                const storageWi = rw.storageIndex
                const wordMotionKey =
                  chipWordId != null
                    ? `wid-${chipWordId}`
                    : `w-${index}-${storageWi}-${rw.start}-${rw.end}`
                const isActiveWaveformChip =
                  waveformExpandedThisRow &&
                  waveformActiveWordId != null &&
                  chipWordId === waveformActiveWordId
                return (
                  <motion.div
                    key={wordMotionKey}
                    layout={timelineLayoutThisRow}
                    initial={false}
                    transition={timelineLayoutThisRow ? WORD_LAYOUT_SPRING_TIMELINE : WORD_LAYOUT_SPRING}
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
                      transition={timelineLayoutThisRow ? WORD_LAYOUT_SPRING_TIMELINE : WORD_LAYOUT_SPRING}
                      id={`subtitle-word-${index}-${storageWi}`}
                      type="button"
                      tabIndex={-1}
                      data-start={rw.start}
                      data-end={rw.end}
                      data-word-start={rw.start}
                      data-word-end={rw.end}
                      {...(chipWordId != null ? ({ 'data-word-id': String(chipWordId) } as const) : {})}
                      data-waveform-active-word-chip={isActiveWaveformChip ? '1' : undefined}
                      data-waveform-expanded-row-chip={waveformExpandedThisRow ? '1' : undefined}
                      className={`subtitle-word-chip subtitle-word-chip--proportional${rw.isSilence ? ' subtitle-word-chip--silence' : ''}`}
                      onMouseEnter={() => {
                        // 칩 앞 caret 슬롯 — storage 축 = storageWi
                        setCaretIndex(storageWi)
                        showStaticCaret()
                        setHoveredCaretIndex(wi)
                      }}
                      onClick={(e: MouseEvent<HTMLButtonElement>) => {
                        if (
                          waveformEnabled &&
                          waveformExpandedLineIndex === index &&
                          onWaveformExpandedLineWordClick
                        ) {
                          const isWaveActiveChip =
                            chipWordId != null &&
                            waveformActiveWordId != null &&
                            chipWordId === waveformActiveWordId

                          if (activeChipCloseTimerRef.current != null) {
                            clearTimeout(activeChipCloseTimerRef.current)
                            activeChipCloseTimerRef.current = null
                          }

                          /**
                           * **`wi` (visible 인덱스) 를 넘겨야** 한다 — `focusWaveformWord` 는 `vrewRows[].words`
                           * (visible 필터링) 를 인덱싱한다. 과거에 `storageWi` 를 넘기면 tombstone 이 생긴 직후
                           * `storageWi !== wi` 라서 `w` 가 undefined → early return → 파형이 안 열렸다.
                           */
                          /** detail>=2 는 더블클릭의 두 번째 click — 접기 타이머를 걸면 안 됨 */
                          if (isWaveActiveChip && e.detail === 1) {
                            activeChipCloseTimerRef.current = setTimeout(() => {
                              onWaveformExpandedLineWordClick(index, wi)
                              activeChipCloseTimerRef.current = null
                            }, 280)
                          } else if (!isWaveActiveChip) {
                            onWaveformExpandedLineWordClick(index, wi)
                          }

                          if (isPlaying) {
                            onRequestPausePlayback('word-chip-click-wave-active')
                          }
                          clearSelection()
                          activateCaretAt(storageWi, true)
                          return
                        }
                        onWordBlockClick(rw.start)
                        if (isPlaying) {
                          onRequestPausePlayback('word-chip-click')
                        }
                        clearSelection()
                        activateCaretAt(storageWi, true)
                      }}
                      onMouseDown={(e) => {
                        // 클릭하면 해당 단어 "앞" 위치로 커서를 고정한다.
                        // 더블클릭의 두 번째 mousedown(detail>1)에서 preventDefault 하면 dblclick이 막힐 수 있음
                        if (e.detail > 1) return
                        e.preventDefault()
                        // intent 단일화: pause/seek/caret 활성은 onClick 경로에서만 처리
                      }}
                      onDoubleClick={(e) => {
                        if (activeChipCloseTimerRef.current != null) {
                          clearTimeout(activeChipCloseTimerRef.current)
                          activeChipCloseTimerRef.current = null
                        }
                        if (!waveformEnabled || !onWaveformWordDoubleClick) return
                        e.preventDefault()
                        e.stopPropagation()
                        /** visible 인덱스(`wi`) — focusWaveformWord 가 vrewRows.words(visible-filtered) 인덱싱 */
                        onWaveformWordDoubleClick(index, wi)
                      }}
                      title={(() => {
                        const isLastChip = wi === wordRail.length - 1
                        const nextStart = wordRail[wi + 1]?.start ?? null
                        /**
                         * 마지막 칩은 **카드 헤더 끝 시각과 항상 동치**가 되어야 한다 — 헤더가 120ms 까지 흡수하므로
                         * 마지막 칩도 같은 임계로 `effectiveCardEndSec` 까지 흡수해서 표시값을 맞춘다.
                         * 중간 칩은 단어↔단어 자연 침묵을 보존해야 하므로 50ms 그대로.
                         */
                        const nextBoundary = isLastChip ? effectiveCardEndSec : nextStart
                        const absorbMs = isLastChip
                          ? DISPLAY_CROSS_CARD_GAP_ABSORB_MS
                          : DISPLAY_GAP_ABSORB_MS
                        return `${formatTimecode(rw.start)} ~ ${formatTimecode(
                          resolveDisplayEndSec(rw.end, nextBoundary, absorbMs)
                        )}`
                      })()}
                    >
                      <span
                        className={
                          hasSelection && storageWi >= selStart && storageWi < selEnd
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
            {!waveformExpandedThisRow ? (
            <div className="subtitle-word-carets-overlay" aria-hidden={false}>
              {Array.from({ length: wordRail.length + 1 }, (_, k) => {
                // `k` = renderable(visible) 슬롯 인덱스. 0..wordRail.length
                // 클릭/포커스/Caret 상태는 storage caret 으로 변환해 SSOT 유지
                const subs = row.words ?? []
                const storageK = renderableCaretToStorageCaret(subs, k)
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
                      activateCaretAt(storageK, true)
                    }}
                    onFocus={() => {
                      syncCaretFromFocus(k)
                    }}
                    onMouseEnter={() => {
                      setCaretVisible(true)
                      setCaretBlink(false)
                      setHoveredCaretIndex(k)
                      setCaretIndex(storageK)
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
          data-waveform-no-dismiss="1"
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

/**
 * Incremental adapter 가 line/row reference 를 안정시켜도, react-window 의 `rowComponent` 는 매번
 * `RowComponentProps` 새 객체를 받기 때문에 React.memo 없이는 모든 visible row 가 reconciliation 된다.
 * 한 카드만 변경되어도 1473 word 의 약 30 행이 다 재렌더 → 약 850ms longtask.
 *
 * 다음 규칙으로 row 별 skip 한다:
 *  1. **자기 row data 가 같으면 skip** — `subtitles[index]` / `vrewRows[index]` 가 reference 동일.
 *  2. **펼침 상태가 안 바뀌면 skip** — 다른 줄의 펼침/접힘은 무관.
 *  3. **펼친 줄에서만 `waveformActiveWordId` 비교** — 접힌 줄은 그 prop 무시.
 *  4. **나머지 prop 은 reference 비교** — callbacks 는 useCallback 으로 안정되어 있으면 OK.
 *
 *  callbacks/플래그가 변경되는 드문 케이스(재생 토글, 무음 일괄 삭제 등) 에서는 모든 row 가 다시 그려지므로
 *  정확성은 보장되며, 단순 단어 삭제 같은 hot path 에서만 큰 효과를 본다.
 */
const subtitleVirtualRowAreEqual = (
  prev: RowComponentProps<SubtitleListRowProps>,
  next: RowComponentProps<SubtitleListRowProps>
): boolean => {
  if (prev.index !== next.index) return false
  if (prev.style !== next.style) return false
  // 자기 row 의 핵심 데이터 비교
  if (prev.subtitles[prev.index] !== next.subtitles[next.index]) return false
  const prevVrew = prev.vrewRows?.[prev.index]
  const nextVrew = next.vrewRows?.[next.index]
  if (prevVrew !== nextVrew) return false
  // 펼침 상태(자기 row 한정)
  const wasExpanded = prev.waveformExpandedLineIndex === prev.index
  const isExpanded = next.waveformExpandedLineIndex === next.index
  if (wasExpanded !== isExpanded) return false
  if (isExpanded && prev.waveformActiveWordId !== next.waveformActiveWordId) return false
  // 나머지 prop 은 reference 비교 (subtitles/vrewRows/펼침 관련은 위에서 처리)
  for (const key of Object.keys(next) as Array<keyof typeof next>) {
    if (
      key === 'subtitles' ||
      key === 'vrewRows' ||
      key === 'index' ||
      key === 'style' ||
      key === 'waveformExpandedLineIndex' ||
      key === 'waveformActiveWordId'
    )
      continue
    if ((prev as unknown as Record<string, unknown>)[key as string] !==
        (next as unknown as Record<string, unknown>)[key as string]) {
      return false
    }
  }
  return true
}

const SubtitleVirtualRow = memo(SubtitleVirtualRowImpl, subtitleVirtualRowAreEqual)

export function SubtitleVirtualList(props: SubtitleVirtualListProps) {
  const { subtitles: subtitlesFromContext } = useSubtitleData()
  const subtitles = subtitlesFromContext.length > 0 ? subtitlesFromContext : props.subtitles
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

  /**
   * `storageCaret`: 대상 카드의 `row.words` 인덱스(0..length).
   * DOM caret 버튼은 visible 슬롯만 그리므로(`subtitle-caret-${row}-${renderableCaret}`),
   * storage → renderable 매핑 후 그 id 를 포커스한다.
   */
  const requestFocusCaret = useCallback((cardIndex: number, storageCaret: number) => {
    if (cardIndex < 0 || storageCaret < 0) return
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
    const targetWords = row?.words ?? []
    const safe = nearestValidStorageCaret(targetWords, storageCaret)
    const rc = storageCaretToRenderableCaret(targetWords, safe)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const el = document.getElementById(`subtitle-caret-${cardIndex}-${rc}`) as HTMLButtonElement | null
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
      if (props.isPlaying) props.onRequestPausePlayback('global-arrow-nav')
      const ai = props.activeSubtitleIndexRef.current
      const ph = props.playheadSecRef.current
      if (ai !== null && ai >= 0 && ai < subtitles.length) {
        const words = subtitles[ai]?.words ?? []
        const wi = words.findIndex((w) => ph >= w.start && ph < w.end)
        const caret = wi >= 0 ? wi : 0
        requestFocusCaret(ai, caret)
        return
      }
      requestFocusCaret(0, 0)
    }
    window.addEventListener('keydown', onGlobalArrow)
    return () => window.removeEventListener('keydown', onGlobalArrow)
  }, [props.activeSubtitleIndexRef, props.playheadSecRef, props.isPlaying, props.onRequestPausePlayback, requestFocusCaret, subtitles])

  const rowProps = useMemo(
    () => ({
      subtitles,
      activeSubtitleIndexRef: props.activeSubtitleIndexRef,
      playheadSecRef: props.playheadSecRef,
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
      onWaveformExpandedLineWordClick: props.onWaveformExpandedLineWordClick,
      vrewRows: props.vrewRows,
      onWaveformMountLayout: props.onWaveformMountLayout,
      mediaDurationSec: props.mediaDurationSec,
      peaksZoomViewRange: props.peaksZoomViewRange,
      waveformPeaksJson: props.waveformPeaksJson,
      waveformMediaDurationHintSec: props.waveformMediaDurationHintSec
    }),
    [
      subtitles,
      props.activeSubtitleIndexRef,
      props.playheadSecRef,
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
      props.onWaveformExpandedLineWordClick,
      props.vrewRows,
      props.onWaveformMountLayout,
      props.mediaDurationSec,
      props.peaksZoomViewRange,
      props.waveformPeaksJson,
      props.waveformMediaDurationHintSec,
      requestFocusRow,
      navigateSubtitleField,
      requestFocusCaret,
      requestFocusCard,
      registerCardFocus
    ]
  )

  /** 고정 행 높이 대신 실제 카드 DOM 높이 측정 — 파형 펼침/접힘에 따라 행마다 빈 슬롯이 생기던 문제 완화 */
  const tombstoneSig = useMemo(() => {
    let s = ''
    for (let i = 0; i < subtitles.length; i++) {
      if (subtitles[i]?.isDeleted) s += `${i},`
    }
    return s
  }, [subtitles])
  const dynamicRowHeightKey = useMemo(
    /**
     * tombstoneSig 를 key 에 합쳐 isDeleted 변화 시 `useDynamicRowHeight` 캐시가 무효화되도록 한다.
     * — isDeleted 행이 0-height 로 변했는데 캐시된 152px 이 살아 있어 빈 공간이 남던 문제 차단.
     */
    () => `${subtitles.length}-${props.waveformExpandedLineIndex ?? 'x'}-${tombstoneSig}`,
    [subtitles.length, props.waveformExpandedLineIndex, tombstoneSig]
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
