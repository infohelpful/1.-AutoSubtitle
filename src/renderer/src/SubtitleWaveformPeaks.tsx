import { createPortal } from 'react-dom'
import type { MutableRefObject } from 'react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import Peaks, {
  type JsonWaveformData,
  type PeaksInstance,
  type Segment,
  type SegmentOptions
} from 'peaks.js'
import { assignFlatWordsToRows } from './components/vrewPeaksEditor/assignFlatWordsToRows'
import { createWaveformSegmentMarker, CUT_PREVIEW_SEGMENT_ID } from './components/vrewPeaksEditor/createCutPreviewSegmentMarker'
import { createCutToolPointMarker, CUT_TOOL_POINT_ID } from './components/vrewPeaksEditor/createCutToolPointMarker'
import type { SubtitleRow, Word } from './components/vrewPeaksEditor/types'
import { createSilentWavBlob } from './components/vrewPeaksEditor/silentWav'
import { wfLog } from './components/vrewPeaksEditor/waveformDebugLog'
import { timelineEditLog } from './timelineEditLog'
import { safeFitPeaksContainerView } from './peaksSafeFit'
import { computeLineZoomWindow, computeLineZoomWindowFromCardBounds } from './lineZoomWindow'
import { applyZoomThenClampEndBeforeOrAt } from './peaksZoomClamp'
import { WaveformWordConnector } from './WaveformWordConnector'
import type { CutRange } from '../../shared/ipc'
import { mergeCutRanges } from '../../shared/timelineCollapse'

type WaveformEditTool = 'cut' | 'adjust' | null

type CutSelectionOverlay =
  | null
  | { kind: 'marker'; time: number }
  | { kind: 'range'; start: number; end: number }

function clampPx(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function normalizeCutRange(a: number, b: number): { start: number; end: number } {
  return a <= b ? { start: a, end: b } : { start: b, end: a }
}

/**
 * Peaks.js 가 거부하는 전형적 케이스(display:none 조상 등)만 걸러낸다.
 * `checkVisibility({ checkOpacity })` 는 포털·반투명 레이어에서 오탐이 잦아 init 이 영구 대기한다 — 사용하지 않음.
 * 실제 Peaks 오류는 아래 `Peaks.init` 콜백에서 재시도한다.
 */
function waveformContainersAcceptableForPeaks(zoomEl: HTMLElement, ovEl: HTMLElement): boolean {
  const ok = (el: HTMLElement): boolean => {
    if (el.clientWidth <= 0 || el.clientHeight <= 0) return false
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    let n: HTMLElement | null = el
    while (n) {
      const st = window.getComputedStyle(n)
      if (st.display === 'none') return false
      if (st.visibility === 'hidden') return false
      if (st.contentVisibility === 'hidden') return false
      n = n.parentElement
    }
    return true
  }
  return ok(zoomEl) && ok(ovEl)
}

/** Peaks `zoomview.click` 시간과 clientX→time 변환 차이 흡수(경계에서 바깥 클릭 오판 방지) */
const CUT_TIME_MATCH_EPS_SEC = 0.12

/**
 * Web Audio 버퍼 경로 — 짧은 줄에서 얇은 줌.
 * audiowaveform JSON(`waveformData`) 경로 — waveform-data 가 저해상도 피크만 가질 때
 * 첫 zoom 이 너무 작으면 `WaveformData.resample(): Zoom level … too low, minimum: …` 로 실패함.
 */
const PEAKS_ZOOM_LEVELS_WEBAUDIO = [
  8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384
] as const

/** dataUri만 있고 samples_per_pixel 미상일 때(구 80pps JSON 호환) */
const PEAKS_ZOOM_LEVELS_PRECOMPUTED_FALLBACK = [
  600, 1024, 2048, 4096, 8192, 16384, 32768, 65536
] as const

/** waveform-data 는 scale < samples_per_pixel 이면 리샘플 불가 — zoomLevels 최소가 JSON spp 이상이어야 함 */
function buildZoomLevelsFromSamplesPerPixel(spp: number): number[] {
  const first = Math.max(1, Math.floor(spp))
  const out: number[] = []
  let v = first
  for (let i = 0; i < 14 && v < 262144; i++) {
    out.push(Math.floor(v))
    v *= 2
  }
  return out
}

function zoomLevelsForPrebuiltPeaks(opts: {
  inlineJson: JsonWaveformData | null | undefined
  useDataUriWithoutInline: boolean
}): readonly number[] {
  const spp = opts.inlineJson?.samples_per_pixel
  if (typeof spp === 'number' && Number.isFinite(spp) && spp > 0) {
    return buildZoomLevelsFromSamplesPerPixel(spp)
  }
  if (opts.useDataUriWithoutInline) {
    return PEAKS_ZOOM_LEVELS_PRECOMPUTED_FALLBACK
  }
  return buildZoomLevelsFromSamplesPerPixel(64)
}

/** 길이 조절(ADJUST)일 때만 세그먼트 가장자리·시간 팁 표시. 그 외에는 오버레이만 유지 */
function buildSegmentOptions(
  w: Word,
  rows: SubtitleRow[],
  activeLineIndex: number | null,
  activeWordId: number | null,
  activeTool: WaveformEditTool
): SegmentOptions {
  const allowAdjust = activeTool === 'adjust'
  const base: SegmentOptions = {
    id: String(w.id),
    startTime: w.start,
    endTime: w.end,
    editable: allowAdjust,
    labelText: '',
    waveformColor: '#aeb4b6'
  }

  if (!allowAdjust) {
    if (activeLineIndex === null || activeWordId === null) {
      return {
        ...base,
        color: '#aeb4b6',
        markers: false,
        overlay: false
      }
    }

    const row = rows[activeLineIndex]
    if (!row?.words?.length) {
      return {
        ...base,
        color: '#aeb4b6',
        markers: false,
        overlay: false
      }
    }

    const wi = row.words.findIndex((x) => x.id === activeWordId)
    if (wi < 0) {
      return { ...base, markers: false, overlay: false }
    }

    if (w.id === activeWordId) {
      return {
        ...base,
        markers: false,
        overlay: false,
        color: '#ffd54f',
        waveformColor: '#ffd54f'
      }
    }

    return { ...base, markers: false, overlay: false }
  }

  if (activeLineIndex === null || activeWordId === null) {
    return {
      ...base,
      color: '#aeb4b6',
      markers: true,
      overlay: false
    }
  }

  const row = rows[activeLineIndex]
  if (!row?.words?.length) {
    return {
      ...base,
      color: '#aeb4b6',
      markers: true,
      overlay: false
    }
  }

  const wi = row.words.findIndex((x) => x.id === activeWordId)
  if (wi < 0) {
    return { ...base, markers: false, overlay: false }
  }

  if (w.id === activeWordId) {
    return {
      ...base,
      markers: true,
      overlay: false,
      color: '#ffd54f',
      waveformColor: '#ffd54f'
    }
  }

  return { ...base, color: '#aeb4b6', markers: false, overlay: false }
}

function flattenWords(rows: SubtitleRow[]): Word[] {
  return rows.flatMap((r) => r.words).sort((a, b) => a.start - b.start)
}

function applyWordsToPeaks(
  peaks: PeaksInstance,
  list: Word[],
  rows: SubtitleRow[],
  activeLineIndex: number | null,
  activeWordId: number | null,
  activeTool: WaveformEditTool,
  cutOverlay: CutSelectionOverlay | null,
  mapTime: (sec: number) => number = (sec) => sec
): void {
  peaks.segments.removeAll()
  for (const w of list) {
    peaks.segments.add(
      buildSegmentOptions(
        { ...w, start: mapTime(w.start), end: mapTime(w.end) },
        rows,
        activeLineIndex,
        activeWordId,
        activeTool
      )
    )
  }
  if (cutOverlay) {
    paintCutSelectionOverlay(peaks, cutOverlay, mapTime)
  } else {
    removeCutOverlayGraphics(peaks)
  }
}

/** 활성 단어 칩만 바뀔 때 전체 세그먼트 removeAll 재구축 없이 두 세그먼트만 갱신 */
function patchWordSegmentHighlight(
  peaks: PeaksInstance,
  wordId: number,
  rows: SubtitleRow[],
  activeLineIndex: number | null,
  uiActiveWordId: number | null,
  activeTool: WaveformEditTool,
  mapTime: (sec: number) => number
): boolean {
  const idStr = String(wordId)
  if (!idStr || idStr === CUT_PREVIEW_SEGMENT_ID) return false

  /** getSegment 로 직접 조회 — find 보다 안정적이며, 아래에서는 update 호출 시 this 바인딩 유지 필요 */
  const seg = peaks.segments.getSegment(idStr)
  if (!seg?.update || typeof seg.update !== 'function') return false

  const list = flattenWords(rows)
  const w = list.find((x) => x.id === wordId)
  if (!w) return false

  const mapped: Word = { ...w, start: mapTime(w.start), end: mapTime(w.end) }
  const opts = buildSegmentOptions(mapped, rows, activeLineIndex, uiActiveWordId, activeTool)
  try {
    /**
     * peaks.js: segment.update() 에 markers / overlay 를 넣으면 validateSegmentOptions 가
     * "cannot update markers/overlay attribute" 로 즉시 throw 한다 — 하이라이트만 바꿀 때는 생략.
     */
    ;(seg as Segment).update({
      editable: opts.editable,
      color: opts.color ?? '#aeb4b6',
      waveformColor: opts.waveformColor ?? '#aeb4b6',
      labelText: opts.labelText ?? ''
    } as Partial<SegmentOptions>)
    return true
  } catch {
    return false
  }
}

type SegmentBoundarySnapshot = {
  startTime: number
  endTime: number
}

function applyDirectionalAdjustResplit(args: {
  words: Word[]
  currentIndex: number
  oldSegment: SegmentBoundarySnapshot
  newSegment: SegmentBoundarySnapshot
}): Word[] {
  const { words, currentIndex, oldSegment, newSegment } = args
  const next = words.map((w) => ({ ...w }))

  const isLeftEdgeDragged = newSegment.startTime !== oldSegment.startTime
  const isRightEdgeDragged = newSegment.endTime !== oldSegment.endTime

  let leftWordIndex = -1
  let rightWordIndex = -1
  let newBoundaryTime = 0

  if (isRightEdgeDragged) {
    leftWordIndex = currentIndex
    rightWordIndex = currentIndex + 1
    newBoundaryTime = newSegment.endTime
  } else if (isLeftEdgeDragged) {
    leftWordIndex = currentIndex - 1
    rightWordIndex = currentIndex
    newBoundaryTime = newSegment.startTime
  } else {
    return next
  }

  const leftWord = next[leftWordIndex]
  const rightWord = next[rightWordIndex]
  if (!leftWord || !rightWord) return next

  const totalDuration = rightWord.end - leftWord.start
  if (totalDuration < 0.1) return next

  newBoundaryTime = Math.max(leftWord.start + 0.05, Math.min(newBoundaryTime, rightWord.end - 0.05))

  leftWord.end = newBoundaryTime
  rightWord.start = newBoundaryTime

  const isLeftSilence =
    Boolean(leftWord.isSilence) || leftWord.text === '??' || leftWord.text === '-'
  const isRightSilence =
    Boolean(rightWord.isSilence) || rightWord.text === '??' || rightWord.text === '-'

  if (isLeftSilence || isRightSilence) {
    if (!leftWord.originalText) leftWord.originalText = leftWord.text
    if (!rightWord.originalText) rightWord.originalText = rightWord.text
    leftWord.text = leftWord.originalText ?? leftWord.text
    rightWord.text = rightWord.originalText ?? rightWord.text
    return next
  }

  if (!leftWord.originalText) leftWord.originalText = leftWord.text
  if (!rightWord.originalText) rightWord.originalText = rightWord.text

  const combinedText = `${leftWord.originalText ?? ''}${rightWord.originalText ?? ''}`
  const totalChars = combinedText.length
  if (totalChars === 0) {
    leftWord.text = ''
    rightWord.text = ''
    return next
  }

  const ratio = (newBoundaryTime - leftWord.start) / totalDuration
  const clampedRatio = Math.max(0, Math.min(1, ratio))
  let splitIndex = Math.floor(totalChars * clampedRatio)

  if (splitIndex === 0 && totalChars > 1) {
    splitIndex = 1
  } else if (splitIndex === totalChars && totalChars > 1) {
    splitIndex = totalChars - 1
  }

  leftWord.text = combinedText.slice(0, splitIndex).trim()
  rightWord.text = combinedText.slice(splitIndex).trim()
  return next
}

function splitWordTextByRatio(text: string, ratio: number): { left: string; right: string } {
  const t = text ?? ''
  if (t.length <= 1) return { left: t, right: t }
  const idx = Math.max(1, Math.min(t.length - 1, Math.round(t.length * ratio)))
  return { left: t.slice(0, idx), right: t.slice(idx) }
}

function snapCutTimeToWordEdge(timeSec: number, bounds: { start: number; end: number }, edgeEpsSec = 0.02): number {
  const dStart = Math.abs(timeSec - bounds.start)
  const dEnd = Math.abs(timeSec - bounds.end)
  if (dStart <= edgeEpsSec && dStart <= dEnd) return bounds.start
  if (dEnd <= edgeEpsSec) return bounds.end
  return timeSec
}

/** 화면에 그려진 단어 세그먼트 시간 — 행 데이터와 어긋나면 컷 라인이 칩 밖으로 나간다 */
function getWordCutBoundsSec(
  peaks: PeaksInstance,
  wordId: number,
  rowWord: Word,
  fromPeaksTimeFn: (sec: number, inst: PeaksInstance | null) => number
): { start: number; end: number } {
  const seg = peaks.segments.getSegment(String(wordId))
  if (
    seg &&
    Number.isFinite(seg.startTime) &&
    Number.isFinite(seg.endTime) &&
    seg.endTime > seg.startTime + 1e-9
  ) {
    return {
      start: fromPeaksTimeFn(seg.startTime, peaks),
      end: fromPeaksTimeFn(seg.endTime, peaks)
    }
  }
  return { start: rowWord.start, end: rowWord.end }
}

/** 단어 구간을 줌뷰 가로 % 로 투영 — DOM 컷 라인을 픽셀·단어 안에만 두기 위함 */
function wordCutHorizontalPctRangeInZoom(
  peaks: PeaksInstance,
  bounds: { start: number; end: number },
  fromPeaksTimeFn: (sec: number, inst: PeaksInstance | null) => number
): { loPct: number; hiPct: number } | null {
  const zv = peaks.views.getView('zoomview')
  if (!zv) return null
  const t0 = zv.getStartTime()
  const t1 = zv.getEndTime()
  const span = t1 - t0
  if (!(span > 1e-9)) return null
  const ws = fromPeaksTimeFn(bounds.start, peaks)
  const we = fromPeaksTimeFn(bounds.end, peaks)
  const loPct = clampPx(((Math.min(ws, we) - t0) / span) * 100, 0, 100)
  const hiPct = clampPx(((Math.max(ws, we) - t0) / span) * 100, 0, 100)
  if (hiPct <= loPct + 0.02) return { loPct, hiPct: Math.min(100, loPct + 0.5) }
  return { loPct, hiPct }
}

/** 최소 폭만 늘릴 때 lo 고정이 아니라 구간 중앙 기준 대칭 — 버튼이 파형 중앙에서 오른쪽으로 치우치지 않게 */
function layoutCutMarkerButtonBand(loPct: number, hiPct: number, minWidthPct = 8): { leftPct: number; widthPct: number } {
  const rawW = hiPct - loPct
  const center = (loPct + hiPct) / 2
  const widthPct = Math.min(Math.max(rawW, minWidthPct), 100)
  let leftPct = center - widthPct / 2
  leftPct = Math.max(0, Math.min(leftPct, 100 - widthPct))
  return { leftPct, widthPct }
}

function cutTimeSecFromZoomClientX(
  clientX: number,
  rect: DOMRect,
  peaks: PeaksInstance,
  fromPeaksTimeFn: (sec: number, inst: PeaksInstance | null) => number
): number | null {
  const zv = peaks.views.getView('zoomview')
  if (!zv || rect.width < 2) return null
  const t0 = zv.getStartTime()
  const t1 = zv.getEndTime()
  const span = t1 - t0
  if (!(span > 1e-9)) return null
  const frac = clampPx((clientX - rect.left) / rect.width, 0, 1)
  return fromPeaksTimeFn(t0 + span * frac, peaks)
}

function setZoomViewKonvaPlayheadVisible(zoomView: unknown, visible: boolean): void {
  try {
    const layer = (
      zoomView as {
        _playheadLayer?: { _playheadLayer?: { hide?: () => void; show?: () => void } }
      }
    )._playheadLayer?._playheadLayer
    if (!layer) return
    if (visible) layer.show?.()
    else layer.hide?.()
  } catch {
    /* ignore */
  }
}

function clampMarkerTimeToWordBounds(
  peaks: PeaksInstance,
  wordId: number,
  rowWord: Word,
  timeSec: number,
  fromPeaksTimeFn: (sec: number, inst: PeaksInstance | null) => number
): number {
  const bounds = getWordCutBoundsSec(peaks, wordId, rowWord, fromPeaksTimeFn)
  const minSeg = 0.05
  const lo = bounds.start + minSeg
  const hi = bounds.end - minSeg
  const snapped = snapCutTimeToWordEdge(timeSec, bounds)
  if (!(hi > lo + 1e-6)) return (bounds.start + bounds.end) / 2
  return Math.max(lo, Math.min(snapped, hi))
}

function splitActiveWordAtTime(args: {
  rows: SubtitleRow[]
  activeLineIndex: number
  activeWordId: number
  splitTime: number
}): { rows: SubtitleRow[]; newActiveWordId: number | null; changed: boolean } {
  const { rows, activeLineIndex, activeWordId, splitTime } = args
  const row = rows[activeLineIndex]
  if (!row?.words?.length) return { rows, newActiveWordId: null, changed: false }
  const wi = row.words.findIndex((w) => w.id === activeWordId)
  if (wi < 0) return { rows, newActiveWordId: null, changed: false }
  const w = row.words[wi]!
  const minSeg = 0.05
  const t = Math.max(w.start + minSeg, Math.min(splitTime, w.end - minSeg))
  if (!(t > w.start + 1e-6 && t < w.end - 1e-6)) return { rows, newActiveWordId: null, changed: false }

  const ratio = (t - w.start) / Math.max(1e-6, w.end - w.start)
  const { left, right } = splitWordTextByRatio(w.text ?? '', ratio)
  const maxId = rows.reduce((m, r) => Math.max(m, ...r.words.map((x) => x.id)), -1)
  const leftWord: Word = { ...w, text: left || w.text || ' ', end: t }
  const rightWord: Word = { ...w, id: maxId + 1, text: right || w.text || ' ', start: t }
  const nextRows = rows.map((r, idx) => {
    if (idx !== activeLineIndex) return r
    const words = [...r.words.slice(0, wi), leftWord, rightWord, ...r.words.slice(wi + 1)]
    return {
      ...r,
      words,
      lineText: words.map((x) => x.text).join(' ').replace(/\s+/g, ' ').trim()
    }
  })
  return { rows: nextRows, newActiveWordId: rightWord.id, changed: true }
}

function isTimeOnWordSegment(peaks: PeaksInstance, t: number): boolean {
  for (const seg of peaks.segments.getSegments()) {
    if (String(seg.id) === CUT_PREVIEW_SEGMENT_ID) continue
    if (t + 1e-5 >= seg.startTime && t - 1e-5 <= seg.endTime) return true
  }
  return false
}

function removeCutOverlayGraphics(peaks: PeaksInstance): void {
  try {
    peaks.points.removeById(CUT_TOOL_POINT_ID)
    peaks.segments.removeById(CUT_PREVIEW_SEGMENT_ID)
  } catch {
    /* ignore */
  }
}

/**
 * Peaks zoomview 는 Scroll/InsertSegment MouseDragHandler 가 스테이지 mousedown 을 잡는다.
 * insert-segment 는 빈 곳(_segment 없음)에서도 삽입 세그먼트를 만들고 드래그로 끝을 늘려
 * "컷 라인"처럼 보이게 움직인다. 단어 편집 중엔 이 핸들러를 제거해 스테이지 드래그를 막고,
 * 컷 포인트(Konva point-marker) 드래그만 남긴다.
 */
function applyZoomViewStageDragSuppression(zoomView: unknown, suppress: boolean): void {
  const zv = zoomView as {
    _mouseDragHandler?: { destroy?: () => void; isDragging?: () => boolean }
    setWaveformDragMode?: (m: 'insert-segment' | 'scroll') => void
  }
  if (!zv?.setWaveformDragMode) return
  if (suppress) {
    zv._mouseDragHandler?.destroy?.()
    zv._mouseDragHandler = {
      isDragging: () => false,
      destroy: () => {}
    }
  } else {
    zv.setWaveformDragMode('insert-segment')
  }
}

function paintCutSelectionOverlay(
  peaks: PeaksInstance,
  overlay: CutSelectionOverlay,
  mapTime: (sec: number) => number = (sec) => sec
): void {
  if (!overlay) {
    removeCutOverlayGraphics(peaks)
    return
  }
  removeCutOverlayGraphics(peaks)
  try {
    if (overlay.kind === 'marker') {
      /** 컷 라인은 DOM 오버레이로만 그림 — Peaks point 는 재생 헤드·삽입 세그먼트와 섞여 오동작 */
      return
    } else {
      const { start: a, end: b } = normalizeCutRange(mapTime(overlay.start), mapTime(overlay.end))
      peaks.segments.add({
        id: CUT_PREVIEW_SEGMENT_ID,
        startTime: a,
        endTime: b,
        editable: true,
        labelText: '자르기 영역',
        color: 'rgba(255, 0, 0, 0.4)',
        borderColor: 'rgba(200, 20, 20, 0.9)',
        markers: true,
        overlay: true
      })
    }
  } catch {
    /* ignore */
  }
}

export type SubtitleWaveformPeaksHandle = {
  /** 행에서 wave 마운트 DOM을 App 쪽 맵에 넣은 뒤 포털 타깃을 다시 잡게 할 때 호출 */
  onWaveMountDirty: () => void
}

/** zoomLevels 양자화 뒤 실제 표시 구간 — 단어 칹 %는 반드시 이 값과 같아야 세로선·세그먼트와 픽셀 일치 */
export type PeaksZoomViewRange = {
  lineIndex: number
  windowStart: number
  windowEnd: number
}

export type SubtitleWaveformPeaksProps = {
  rows: SubtitleRow[]
  onRowsChange: (next: SubtitleRow[]) => void
  audioUrl?: string
  /** 로컬 디스크 절대 경로 — Peaks가 http 창에서 file:// 를 XHR로 못 읽을 때 메인에서 읽어 AudioBuffer 생성 */
  localMediaPath?: string | null
  /**
   * Python+audiowaveform이 만든 Peaks.js 호환 JSON — `file://` URL. 있으면 webAudio/decodeAudioData 를 쓰지 않는다.
   */
  precomputedPeaksJsonFileUrl?: string | null
  /**
   * 메인에서 `readLocalPeaksJsonFile`로 읽은 객체 — `waveformData`로 직접 주입(비동기 dataUri/XHR 제거).
   */
  precomputedWaveformJson?: JsonWaveformData | null
  /** App에서 유지 — layout effect 순서 때문에 Peaks ref보다 먼저 행이 등록해야 함 */
  waveMountByLineRef: MutableRefObject<Map<number, HTMLDivElement>>
  /** 자막 줄 인덱스 (SubtitleLine 배열과 동일) — 파동을 그 줄 카드 안에 붙임 */
  activeLineIndex: number | null
  activeWordId: number | null
  /** 카드 헤더 타임코드와 동일 — 줌 창을 단어 min/max 가 아닌 줄 구간으로 맞춘다 */
  waveformCardBounds: { start: number; end: number } | null
  cutRanges: CutRange[]
  /** Peaks zoomview 가 실제로 그리는 시간 구간 — 칹 레일과 동기화 */
  onZoomViewRange?: (range: PeaksZoomViewRange | null) => void
  /**
   * CUT 모드에서 구간 삭제 확정 시 — 재생 스킵 범위 등록 + 자막 단어 동기화(부모).
   */
  onTimeRangeCut?: (startSec: number, endSec: number) => void
  onPlayEditRange?: (startSec: number, endSec: number) => void
  playheadEditSec?: number
  isPlaying?: boolean
}

/**
 * zoom/overview 는 포털로 활성 줄 `.subtitle-waveform-mount`에 붙인다.
 * 줄(activeLineIndex)이 바뀌거나, 같은 줄이라도 가상 리스트로 `.subtitle-waveform-mount` DOM 이 바뀌면(portalHost 참조)
 * Peaks 를 destroy→init 해 새 컨테이너에 다시 묶는다.
 * (포털만 옮기고 인스턴스를 유지하면 Konva 스테이지가 문서 밖 컨테이너를 참조해 빈 파형이 된다.)
 */
export const SubtitleWaveformPeaks = forwardRef<SubtitleWaveformPeaksHandle, SubtitleWaveformPeaksProps>(
  function SubtitleWaveformPeaks(
    {
      rows,
      onRowsChange,
      audioUrl,
      localMediaPath,
      precomputedPeaksJsonFileUrl,
      precomputedWaveformJson,
      waveMountByLineRef,
      activeLineIndex,
      activeWordId,
      waveformCardBounds,
      cutRanges,
      onZoomViewRange,
      onTimeRangeCut,
      onPlayEditRange,
      playheadEditSec,
      isPlaying
    },
    ref
  ) {
    const dummyAudioRef = useRef<HTMLAudioElement | null>(null)
    const audioContextRef = useRef<AudioContext | null>(null)
    const zoomRef = useRef<HTMLDivElement | null>(null)
    /** 줌 Konva 와 같은 크기의 래퍼 — clientX→시간 매핑·DOM 컷 라인 위치에 사용 */
    const waveformZoomOuterRef = useRef<HTMLDivElement | null>(null)
    const overviewRef = useRef<HTMLDivElement | null>(null)

    const peaksRef = useRef<PeaksInstance | null>(null)
    const isDraggingRef = useRef(false)
    const rowsRef = useRef(rows)
    const onRowsChangeRef = useRef(onRowsChange)
    const activeLineIndexRef = useRef(activeLineIndex)
    const activeWordIdRef = useRef(activeWordId)
    /** Peaks.init 비동기 콜백이 useEffect 보다 먼저 돌 수 있음 — ref는 렌더마다 즉시 동기화 */
    activeLineIndexRef.current = activeLineIndex
    activeWordIdRef.current = activeWordId

    const [portalRev, setPortalRev] = useState(0)
    const [playheadLinePct, setPlayheadLinePct] = useState<number | null>(null)
    /** DOM 컷 라인 드래그 중 미리보기 시간 — 떼면 null 로 두고 cutSelection 만 확정 */
    const [cutHandlePreviewSec, setCutHandlePreviewSec] = useState<number | null>(null)
    /** 활성 줄 마운트 DOM — 포털 타깃이 바뀌면 Peaks 컨테이너가 바뀌므로 재바인딩한다 */
    const [portalHost, setPortalHost] = useState<HTMLElement | null>(null)
    const portalHostLiveRef = useRef<HTMLElement | null>(null)
    portalHostLiveRef.current = portalHost
    const [hostReady, setHostReady] = useState(false)
    const hostReadyRef = useRef(hostReady)
    hostReadyRef.current = hostReady
    const [peaksReady, setPeaksReady] = useState(false)

    const bumpPortal = useCallback(() => setPortalRev((n) => n + 1), [])

    const flatWords = useMemo(() => flattenWords(rows), [rows])

    const rowsSig = useMemo(
      () =>
        rows
          .map((r) =>
            [
              r.id,
              r.lineText ?? '',
              ...r.words.map((w) => `${w.id}|${w.start}|${w.end}|${w.text}`)
            ].join(':')
          )
          .join(';'),
      [rows]
    )

    const wordsSig = useMemo(
      () => flatWords.map((w) => `${w.id}|${w.start.toFixed(4)}|${w.end.toFixed(4)}|${w.text}`).join(';'),
      [flatWords]
    )
    /** 파형 객체 참조가 매 렌더 새로 생겨도 내용이 같으면 Peaks 재초기화를 막기 위한 시그니처 */
    const precomputedWaveformSig = useMemo(() => {
      const wf = precomputedWaveformJson
      if (!wf) return 'none'
      return `${wf.length}|${(wf.data ?? []).length}|${wf.sample_rate ?? 0}|${wf.samples_per_pixel ?? 0}`
    }, [precomputedWaveformJson])

    const silentDurationSec = useMemo(() => {
      const maxEnd = flatWords.reduce((m, w) => Math.max(m, w.end), 0)
      return Math.max(60, Math.ceil(maxEnd) + 25)
    }, [flatWords])
    const silentDurationSecRef = useRef(silentDurationSec)
    silentDurationSecRef.current = silentDurationSec

    const mountLoggedRef = useRef(false)
    useEffect(() => {
      if (mountLoggedRef.current) return
      mountLoggedRef.current = true
      wfLog('lifecycle', 'SubtitleWaveformPeaks mount', {
        rowCount: rows.length,
        flatWordCount: flatWords.length,
        silentDurationSec,
        audioUrl: audioUrl ?? '(silent wav)'
      })
      void window.api
        .logWaveformDebug('lifecycle', 'waveform.log 위치는 userData/logs/waveform.log (아래 path 참고)')
        .then((r) => {
          wfLog('lifecycle', 'logPath', r.path)
        })
        .catch(() => {
          wfLog('lifecycle', 'logWaveformDebug IPC unavailable')
        })
    }, [rows.length, flatWords.length, silentDurationSec, audioUrl])

    useEffect(() => {
      rowsRef.current = rows
    }, [rows])

    useEffect(() => {
      onRowsChangeRef.current = onRowsChange
    }, [onRowsChange])

    /** refit 연속 호출 시 동일 seek·줌만 반복되면 Peaks 재적용·로그 스팸 생략 */
    const lastFocusZoomSigRef = useRef<string>('')
    useEffect(() => {
      lastFocusZoomSigRef.current = ''
    }, [activeLineIndex, waveformCardBounds])

    const onZoomViewRangeRef = useRef(onZoomViewRange)
    useEffect(() => {
      onZoomViewRangeRef.current = onZoomViewRange
    }, [onZoomViewRange])

    const onTimeRangeCutRef = useRef(onTimeRangeCut)
    useEffect(() => {
      onTimeRangeCutRef.current = onTimeRangeCut
    }, [onTimeRangeCut])

    const [activeTool, setActiveTool] = useState<WaveformEditTool>('adjust')
    const activeToolRef = useRef(activeTool)
    activeToolRef.current = activeTool
    const [cutSelection, setCutSelection] = useState<CutSelectionOverlay>(null)
    const adjustDragStartSegmentsRef = useRef<Map<string, SegmentBoundarySnapshot>>(new Map())
    const cutSelectionRef = useRef<CutSelectionOverlay>(null)
    /** setState 직후에도 즉시 최신 — Peaks zoomview.click 이 같은 틱에 오면 ref 지연으로 오동작 */
    const syncCutSelection = useCallback((next: CutSelectionOverlay) => {
      cutSelectionRef.current = next
      setCutSelection(next)
    }, [])
    const cutDragAnchorTimeRef = useRef<number | null>(null)
    const cutDraggingRef = useRef(false)
    /** 단일 컷 포인트 드래그 중 — applyWordsToPeaks 가 세그먼트 재구축을 스킵 (DOM 컷 핸들 드래그 포함) */
    const cutMarkerDraggingRef = useRef(false)
    const cutDragRangeCommittedRef = useRef(false)
    const waveformCardBoundsRef = useRef(waveformCardBounds)
    useEffect(() => {
      waveformCardBoundsRef.current = waveformCardBounds
    }, [waveformCardBounds])

    const mergedCutRanges = useMemo(() => mergeCutRanges([...cutRanges]), [cutRanges])
    const toPeaksTime = useCallback((sec: number, _inst: PeaksInstance | null): number => {
      return Math.max(0, sec)
    }, [])

    const fromPeaksTime = useCallback((sec: number, _inst: PeaksInstance | null): number => {
      return Math.max(0, sec)
    }, [])

    const editedWaveformJson = useMemo(() => {
      if (!precomputedWaveformJson) return null
      if (mergedCutRanges.length === 0) return precomputedWaveformJson

      const oldData = precomputedWaveformJson.data || []
      if (oldData.length === 0) return precomputedWaveformJson

      // Peaks.js WaveformData.create()는 루트 data 배열을 무조건 1픽셀=2개로 검증함
      const pointsPerPixel = 2
      const numPixels = Math.floor(oldData.length / pointsPerPixel)

      const sr = precomputedWaveformJson.sample_rate || 44100
      const spp = precomputedWaveformJson.samples_per_pixel || 256

      let pixelsPerSec = 100
      if (typeof sr === 'number' && typeof spp === 'number' && spp > 0) {
        pixelsPerSec = sr / spp
      } else {
        const origDur = precomputedWaveformJson.length
          ? precomputedWaveformJson.length / sr
          : silentDurationSecRef.current
        if (origDur > 0) pixelsPerSec = numPixels / origDur
      }

      const originalDuration = numPixels / pixelsPerSec

      const keepRanges: { start: number; end: number }[] = []
      let cur = 0
      for (const cut of mergedCutRanges) {
        if (cut.start > cur) keepRanges.push({ start: cur, end: cut.start })
        cur = cut.end
      }
      if (cur < originalDuration) keepRanges.push({ start: cur, end: originalDuration })

      const newData: number[] = []
      for (const r of keepRanges) {
        const startPx = Math.floor(r.start * pixelsPerSec)
        const endPx = Math.floor(r.end * pixelsPerSec)
        const startIdx = startPx * pointsPerPixel
        const endIdx = endPx * pointsPerPixel
        for (let i = startIdx; i < endIdx && i < oldData.length; i++) {
          newData.push(oldData[i])
        }
      }

      // 이 JSON 포맷에서 length는 "샘플 수"가 아니라 "픽셀 수"로 동작한다.
      // (원본: length=744095, data.length=1488190=length*2)
      // 따라서 컷 이후에도 length는 남은 픽셀 수(newData.length/2)로 맞춰야 한다.
      const computedLength = Math.floor(newData.length / 2)

      const originalExpectedDataLength = Math.floor(precomputedWaveformJson.length * 2)
      const editedExpectedDataLength = Math.floor(computedLength * 2)
      wfLog('peaks', 'waveform json integrity check', {
        original: {
          length: precomputedWaveformJson.length,
          spp,
          dataLength: oldData.length,
          expectedDataLength: originalExpectedDataLength,
          mismatch: oldData.length !== originalExpectedDataLength
        },
        edited: {
          length: computedLength,
          spp,
          dataLength: newData.length,
          expectedDataLength: editedExpectedDataLength,
          mismatch: newData.length !== editedExpectedDataLength
        },
        keepRangesCount: keepRanges.length
      })

      return {
        ...precomputedWaveformJson,
        length: computedLength,
        data: newData,
        sample_rate: sr,
        samples_per_pixel: spp
      }
    }, [precomputedWaveformJson, mergedCutRanges])
    const editedWaveformSig = useMemo(() => {
      const wf = editedWaveformJson
      if (!wf) return 'none'
      return `${wf.length}|${(wf.data ?? []).length}|${wf.sample_rate ?? 0}|${wf.samples_per_pixel ?? 0}`
    }, [editedWaveformJson])

    /** zoomview 가 줄 끝 이후까지 그릴 때 오른쪽을 덮어 실제로 안 보이게 */
    const [zoomEndClipPx, setZoomEndClipPx] = useState(0)

    /** setZoom({seconds}) 요청과 무관 — peaks 가 zoomLevels 에 맞춘 실제 구간 */
    const publishZoomViewRange = useCallback((): void => {
      const cb = onZoomViewRangeRef.current
      if (!cb) return
      const peaks = peaksRef.current
      const li = activeLineIndexRef.current
      if (!peaks || li === null) {
        cb(null)
        return
      }
      const zv = peaks.views.getView('zoomview')
      if (!zv) {
        cb(null)
        return
      }
      const windowStart = fromPeaksTime(zv.getStartTime(), peaks)
      const windowEnd = fromPeaksTime(zv.getEndTime(), peaks)
      if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart + 1e-9) {
        cb(null)
        return
      }
      cb({ lineIndex: li, windowStart, windowEnd })
    }, [])

    const publishZoomViewRangeRef = useRef(publishZoomViewRange)
    publishZoomViewRangeRef.current = publishZoomViewRange

    useEffect(() => {
      if (activeLineIndex === null) {
        onZoomViewRangeRef.current?.(null)
      }
    }, [activeLineIndex])

    useEffect(() => {
      if (activeLineIndex === null) {
        setActiveTool(null)
        syncCutSelection(null)
      } else if (activeToolRef.current == null) {
        setActiveTool('adjust')
      }
    }, [activeLineIndex])

    useImperativeHandle(ref, () => ({ onWaveMountDirty: bumpPortal }), [bumpPortal])

    useLayoutEffect(() => {
      void portalRev
      if (activeLineIndex === null) {
        setPortalHost(null)
        return
      }
      const el = waveMountByLineRef.current.get(activeLineIndex)
      const next = el && el.isConnected ? el : null
      setPortalHost(next)
      if (!next) {
        wfLog('portal', 'flow: 줄 마운트 없음', { activeLineIndex })
      }
    }, [activeLineIndex, portalRev, waveMountByLineRef])

    useEffect(() => {
      bumpPortal()
    }, [activeLineIndex, bumpPortal])

    /** portalRev 를 deps 에 넣으면: bump → 리렌더 → effect 재실행 → RO 재구독 → bump… 무한 루프 */
    useLayoutEffect(() => {
      if (activeLineIndex === null) return
      const el = waveMountByLineRef.current.get(activeLineIndex)
      if (!el) return
      const ro = new ResizeObserver(() => bumpPortal())
      ro.observe(el)
      return () => ro.disconnect()
    }, [activeLineIndex, bumpPortal, waveMountByLineRef])

    const mountLayoutKey = `${portalRev}|${activeLineIndex}|${portalHost ? '1' : '0'}|${rowsSig}`

    /** 줌 스크롤·리핏 시 단어 구간 % 재계산 — marker DOM 라인이 파형에 붙게 */
    const [zoomViewTick, setZoomViewTick] = useState(0)

    useEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady) return
      let raf = 0
      const publish = (): void => {
        publishZoomViewRange()
      }
      const bumpCutUiLayout = (): void => {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => {
          setZoomViewTick((n) => n + 1)
        })
      }
      peaks.on('zoomview.update', publish)
      peaks.on('zoomview.update', bumpCutUiLayout)
      queueMicrotask(() => {
        queueMicrotask(publish)
      })
      return () => {
        cancelAnimationFrame(raf)
        peaks.off('zoomview.update', publish)
        peaks.off('zoomview.update', bumpCutUiLayout)
      }
    }, [peaksReady, mountLayoutKey, publishZoomViewRange])

    const lastHostRefsLogged = useRef<boolean | null>(null)
    /** 포털·줌 refit 한 프레임 동안만 끊겨 보일 때 hostReady=false 가 되면 Peaks 가 destroy→init 루프에 들어가 CUT UI 가 통째로 날아간다 → 끄기만 지연 */
    const hostReadyFalseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    /**
     * 문서에 안 붙은 컨테이너에 Peaks가 남는 것만 막는다.
     * `contains()` 는 포털 DOM 이동 직후 한 프레임에서 오판할 수 있어 쓰지 않는다.
     * rAF 한 번 더 돌려 ref·연결 상태가 안정된 뒤 hostReady 를 맞춘다.
     */
    useLayoutEffect(() => {
      let innerRaf = 0
      const measure = (): void => {
        const ph = portalHost
        const z = zoomRef.current
        const o = overviewRef.current
        const ok = Boolean(
          ph && ph.isConnected && z && o && z.isConnected && o.isConnected
        )
        if (ok) {
          if (hostReadyFalseTimerRef.current != null) {
            clearTimeout(hostReadyFalseTimerRef.current)
            hostReadyFalseTimerRef.current = null
          }
          setHostReady(true)
        } else {
          if (hostReadyFalseTimerRef.current != null) {
            clearTimeout(hostReadyFalseTimerRef.current)
          }
          hostReadyFalseTimerRef.current = setTimeout(() => {
            hostReadyFalseTimerRef.current = null
            const ph2 = portalHostLiveRef.current
            const z2 = zoomRef.current
            const o2 = overviewRef.current
            const ok2 = Boolean(
              ph2 && ph2.isConnected && z2 && o2 && z2.isConnected && o2.isConnected
            )
            if (!ok2) {
              setHostReady(false)
            }
          }, 180)
        }
        if (lastHostRefsLogged.current !== ok) {
          lastHostRefsLogged.current = ok
          wfLog('host', 'zoom/overview refs', {
            refsReady: ok,
            hasPortal: Boolean(ph),
            phConn: ph ? ph.isConnected : false,
            zConn: z ? z.isConnected : false,
            oConn: o ? o.isConnected : false
          })
        }
      }
      measure()
      const outer = requestAnimationFrame(() => {
        measure()
        innerRaf = requestAnimationFrame(measure)
      })
      return () => {
        cancelAnimationFrame(outer)
        cancelAnimationFrame(innerRaf)
        if (hostReadyFalseTimerRef.current != null) {
          clearTimeout(hostReadyFalseTimerRef.current)
          hostReadyFalseTimerRef.current = null
        }
      }
    }, [mountLayoutKey, portalHost])

    /** Peaks setZoom(seconds) 는 `_getScale` 에 view `_width` 가 들어가므로, 호출 직전에 항상 컨테이너 폭을 동기화한다. */
    const syncZoomContainersFromDom = useCallback((peaks: PeaksInstance) => {
      safeFitPeaksContainerView(peaks, 'zoomview', zoomRef.current)
      safeFitPeaksContainerView(peaks, 'overview', overviewRef.current)
    }, [])

    const applyCardAlignedZoomView = useCallback(
      (peaks: PeaksInstance) => {
        if (activeLineIndex === null) return
        syncZoomContainersFromDom(peaks)
        const row = rowsRef.current[activeLineIndex]
        const dur = peaks.player.getDuration()
        const mediaCap = Number.isFinite(dur) && dur > 0 ? dur : null
        const win =
          waveformCardBounds != null
            ? computeLineZoomWindowFromCardBounds(waveformCardBounds.start, waveformCardBounds.end, {
                mediaDurationSec: mediaCap ?? undefined,
                clipTrailingToLineEnd: true
              })
            : row?.words?.length
              ? computeLineZoomWindow(row.words, {
                  mediaDurationSec: mediaCap ?? undefined,
                  clipTrailingToLineEnd: true
                })
              : null
        if (!win) return
        const maxEnd =
          waveformCardBounds != null
            ? waveformCardBounds.end
            : row?.words?.length
              ? Math.max(...row.words.map((w) => w.end))
              : win.lineEnd
        applyZoomThenClampEndBeforeOrAt(peaks, {
          windowStart: win.windowStart,
          spanSeconds: win.span,
          maxEndTime: maxEnd
        })
        queueMicrotask(() => publishZoomViewRange())
      },
      [activeLineIndex, waveformCardBounds, publishZoomViewRange, syncZoomContainersFromDom]
    )

    /**
     * 줌 뷰 시간축 = 카드 줄 구간(row.start/end) + 패딩 — 단어 칩 가로 비율과 동일.
     * 플레이헤드는 선택 단어의 start 로 이동해 타일 클릭·파형과 동일 시간축을 공유한다.
     */
    const focusWordAtTime = useCallback(
      (word: Word) => {
        const peaks = peaksRef.current
        if (!peaks) return
        if (activeLineIndex === null || activeLineIndex < 0) return

        syncZoomContainersFromDom(peaks)

        const row = rowsRef.current[activeLineIndex]
        if (!row?.words?.length) return

        const dur = peaks.player.getDuration()
        const mediaCap = Number.isFinite(dur) && dur > 0 ? dur : null
        const win =
          waveformCardBounds != null
            ? computeLineZoomWindowFromCardBounds(waveformCardBounds.start, waveformCardBounds.end, {
                mediaDurationSec: mediaCap ?? undefined,
                clipTrailingToLineEnd: true
              })
            : computeLineZoomWindow(row.words, {
                mediaDurationSec: mediaCap ?? undefined,
                clipTrailingToLineEnd: true
              })
        if (!win) return

        const maxEnd =
          waveformCardBounds != null ? waveformCardBounds.end : Math.max(...row.words.map((w) => w.end))

        const zw = zoomRef.current?.clientWidth ?? 0
        const dedupeSig = `${word.id}|${win.windowStart.toFixed(5)}|${win.span.toFixed(5)}|${zw}`
        if (lastFocusZoomSigRef.current === dedupeSig) {
          queueMicrotask(() => publishZoomViewRange())
          return
        }
        lastFocusZoomSigRef.current = dedupeSig

        peaks.player.seek(toPeaksTime(word.start, peaks))
        applyZoomThenClampEndBeforeOrAt(peaks, {
          windowStart: toPeaksTime(win.windowStart, peaks),
          spanSeconds: toPeaksTime(win.windowStart + win.span, peaks) - toPeaksTime(win.windowStart, peaks),
          maxEndTime: toPeaksTime(maxEnd, peaks)
        })
        const zv = peaks.views.getView('zoomview')
        const visibleSpan = zv ? zv.getEndTime() - zv.getStartTime() : -1
        wfLog('seek', 'focusWordAtTime', {
          wordId: word.id,
          seekTo: toPeaksTime(word.start, peaks),
          lineStart: win.lineStart,
          lineEnd: win.lineEnd,
          windowStart: win.windowStart,
          windowEnd: win.windowEnd,
          zoomSeconds: win.span,
          visibleSpanSec: visibleSpan,
          zw,
          duration: dur,
          sentenceZoom: true,
          zoomFromCardBounds: waveformCardBounds != null
        })
        queueMicrotask(() => publishZoomViewRange())
      },
      [activeLineIndex, waveformCardBounds, publishZoomViewRange, syncZoomContainersFromDom]
    )

    /**
     * 줄 끝 클립 오버레이 + 리사이즈 시: Peaks `_getScale(seconds)=seconds*sr/_width` 이므로 **fit 먼저**, 그 다음 `applyZoom`/seek.
     */
    useLayoutEffect(() => {
      const peaks = peaksRef.current
      const el = zoomRef.current
      if (!peaks || !peaksReady || !el) {
        setZoomEndClipPx(0)
        return
      }
      if (activeLineIndex === null) {
        setZoomEndClipPx(0)
        return
      }

      const update = (): void => {
        const p = peaksRef.current
        const zv = p?.views.getView('zoomview')
        const container = zoomRef.current
        if (!p || !zv || !container) {
          setZoomEndClipPx(0)
          return
        }
        const b = waveformCardBoundsRef.current
        const li = activeLineIndexRef.current
        const cap =
          b != null
            ? b.end
            : li != null && rowsRef.current[li]?.words?.length
              ? Math.max(...rowsRef.current[li]!.words.map((w) => w.end))
              : null
        if (cap == null || !Number.isFinite(cap)) {
          setZoomEndClipPx(0)
          return
        }
        const t0 = zv.getStartTime()
        const t1 = zv.getEndTime()
        const cw = container.clientWidth
        const span = t1 - t0
        if (cw < 2 || span < 1e-6) {
          setZoomEndClipPx(0)
          return
        }
        if (cap >= t1 - 0.012) {
          setZoomEndClipPx(0)
          return
        }
        const hideFrac = (t1 - cap) / span
        setZoomEndClipPx(Math.max(0, Math.min(cw, hideFrac * cw)))
      }

      update()
      peaks.on('zoomview.update', update)
      const ro = new ResizeObserver(() => {
        const p = peaksRef.current
        const z = zoomRef.current
        if (p && z && activeLineIndexRef.current !== null) {
          safeFitPeaksContainerView(p, 'zoomview', z)
          safeFitPeaksContainerView(p, 'overview', overviewRef.current)
          const li = activeLineIndexRef.current
          const wid = activeWordIdRef.current
          const editingWord =
            wid != null ? rowsRef.current[li]?.words?.find((x) => x.id === wid) : undefined
          if (editingWord) {
            focusWordAtTime(editingWord)
          } else {
            applyCardAlignedZoomView(p)
          }
          queueMicrotask(() => publishZoomViewRangeRef.current())
        }
        update()
      })
      ro.observe(el)
      return () => {
        peaks.off('zoomview.update', update)
        ro.disconnect()
        setZoomEndClipPx(0)
      }
    }, [
      peaksReady,
      mountLayoutKey,
      activeLineIndex,
      rowsSig,
      focusWordAtTime,
      applyCardAlignedZoomView
    ])

    useLayoutEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady || activeWordId === null || activeLineIndex === null) return
      const row = rowsRef.current[activeLineIndex]
      const w = row?.words.find((x) => x.id === activeWordId)
      if (w) {
        wfLog('seek', 'layout: seek after peaksReady/activeWord', { lineIndex: activeLineIndex, wordId: activeWordId })
        safeFitPeaksContainerView(peaks, 'zoomview', zoomRef.current)
        safeFitPeaksContainerView(peaks, 'overview', overviewRef.current)
        focusWordAtTime(w)
      } else {
        wfLog('seek', 'layout: word not found for seek', { activeLineIndex, activeWordId })
      }
    }, [activeLineIndex, activeWordId, focusWordAtTime, peaksReady, rowsSig])

    useLayoutEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady) return

      const refitZoomSizeOnly = (): void => {
        try {
          const p = peaksRef.current
          if (!p || activeLineIndexRef.current === null) return
          safeFitPeaksContainerView(p, 'zoomview', zoomRef.current)
          safeFitPeaksContainerView(p, 'overview', overviewRef.current)
          const li = activeLineIndexRef.current
          const wid = activeWordIdRef.current
          const ew =
            wid != null ? rowsRef.current[li]?.words?.find((x) => x.id === wid) : undefined
          if (ew) {
            focusWordAtTime(ew)
          } else {
            applyCardAlignedZoomView(p)
          }
          queueMicrotask(() => publishZoomViewRangeRef.current())
          wfLog('view', 'zoom refit (애니메이션 후 폭→줌 재적용)', {
            zw: zoomRef.current?.clientWidth ?? 0,
            zh: zoomRef.current?.clientHeight ?? 0
          })
        } catch (e) {
          wfLog('view', 'refitZoomSizeOnly error', e)
        }
      }

      const runFit = (): void => {
        try {
          const editingWord =
            activeLineIndex !== null && activeWordId !== null
              ? rowsRef.current[activeLineIndex]?.words?.find((x) => x.id === activeWordId)
              : undefined

          /**
           * 반드시 fitToContainer 로 최종 _width 확정 후 setZoom — 순서 바뀌면 왼쪽 1/3만 파형이 있는 현상.
           */
          if (activeLineIndex !== null) {
            safeFitPeaksContainerView(peaks, 'zoomview', zoomRef.current)
            safeFitPeaksContainerView(peaks, 'overview', overviewRef.current)
            if (editingWord) {
              focusWordAtTime(editingWord)
            } else {
              applyCardAlignedZoomView(peaks)
            }
            queueMicrotask(() => publishZoomViewRangeRef.current())
          } else {
            safeFitPeaksContainerView(peaks, 'zoomview', zoomRef.current)
            safeFitPeaksContainerView(peaks, 'overview', overviewRef.current)
          }
          wfLog('view', 'zoom/overview refit', {
            blockZoomOnly: Boolean(editingWord),
            cardZoomOnly: !editingWord && activeLineIndex !== null,
            zw: zoomRef.current?.clientWidth ?? 0,
            zh: zoomRef.current?.clientHeight ?? 0
          })
        } catch (e) {
          wfLog('view', 'fitToContainer error', e)
        }
      }
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(runFit)
      })
      /** 아코디언·레이아웃 안정화용 재적용 — 지연을 키우면 더블클릭 직후 체감이 ~1초까지 늘어남 */
      const t = window.setTimeout(runFit, 48)
      /** 아코디언 전환 후 seek 없이 스테이지만 너비 동기화 */
      const t2 = window.setTimeout(refitZoomSizeOnly, 110)
      const t3 = window.setTimeout(refitZoomSizeOnly, 200)
      const t4 = window.setTimeout(refitZoomSizeOnly, 360)
      return () => {
        cancelAnimationFrame(id)
        window.clearTimeout(t)
        window.clearTimeout(t2)
        window.clearTimeout(t3)
        window.clearTimeout(t4)
      }
    }, [
      activeLineIndex,
      activeWordId,
      peaksReady,
      mountLayoutKey,
      focusWordAtTime,
      applyCardAlignedZoomView
    ])

    const peaksInitGenRef = useRef(0)
    /** applyWordsToPeaks(전량) 직후 Peaks 에 반영된 활성 단어 id — 같은 줄에서 선택만 바뀔 때 증분 갱신에 사용 */
    const appliedSegmentHighlightWordIdRef = useRef<number | null>(null)

    /**
     * 데이터·오디오가 같을 때 다른 자막 줄로만 옮기면 Peaks 를 부수지 않는다.
     * activeLineIndex 를 의존성에 넣으면 Enter·줄 이동마다 destroy→init 이 반복되어 파형이 깨져 보인다.
     */
    const waveformOpen = activeLineIndex !== null

    useEffect(() => {
      const dummyAudio = dummyAudioRef.current
      if (!waveformOpen) {
        return
      }
      if (!dummyAudio) {
        wfLog('peaks', 'Peaks.init 스킵', { reason: 'no-dummy-audio' })
        return
      }

      const silentDur = silentDurationSecRef.current
      const initGen = ++peaksInitGenRef.current
      let peaksInstance: PeaksInstance | null = null
      let cancelled = false
      let rafWait = 0
      /**
       * JSON 파형을 최우선으로 사용한다.
       */
      let useInlineWaveformData = Boolean(precomputedWaveformJson)
      let useDataUri = Boolean(precomputedPeaksJsonFileUrl) && !useInlineWaveformData
      let usePrebuiltPeaks = useInlineWaveformData || useDataUri
      let exactDuration = silentDur
      const finalJson = editedWaveformJson

      if (useInlineWaveformData && finalJson) {
        const pointsPerPixel = 2
        const numPixels = Math.floor((finalJson.data || []).length / pointsPerPixel)
        let pps = 100
        if (finalJson.sample_rate && finalJson.samples_per_pixel) {
          pps = finalJson.sample_rate / finalJson.samples_per_pixel
        } else if (precomputedWaveformJson) {
          const origPixels = Math.floor((precomputedWaveformJson.data || []).length / 2)
          const origDur = precomputedWaveformJson.length
            ? precomputedWaveformJson.length / (precomputedWaveformJson.sample_rate || 44100)
            : silentDur
          if (origDur > 0) pps = origPixels / origDur
        }
        if (pps > 0 && numPixels > 0) {
          exactDuration = numPixels / pps
        }
        const finalExpectedDataLength = Math.floor((finalJson.length || 0) * 2)
        wfLog('peaks', 'Peaks.init payload integrity', {
          finalLength: finalJson.length,
          finalSpp: finalJson.samples_per_pixel,
          finalDataLength: (finalJson.data || []).length,
          finalExpectedDataLength,
          mismatch: (finalJson.data || []).length !== finalExpectedDataLength,
          exactDuration,
          pps
        })
      }

      const prev = dummyAudio.dataset.blobUrl
      if (prev) {
        URL.revokeObjectURL(prev)
        delete dummyAudio.dataset.blobUrl
      }
      // 파형 시간축은 waveform JSON 기준으로 고정한다(외부 미디어 duration 영향 제거).
      const blob = createSilentWavBlob(exactDuration)
      const url = URL.createObjectURL(blob)
      dummyAudio.dataset.blobUrl = url
      dummyAudio.src = url

      if (!usePrebuiltPeaks) {
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContext()
        }
      }

      const ctx = audioContextRef.current

      /**
       * 세그먼트는 콜백에서 applyWordsToPeaks 로 한 번만 넣는다.
       * init 시 수천 개를 넘기면 Peaks/Konva 쪽 초기 비용이 커지고, 어차피 콜백에서 전부 다시 넣는다(중복).
       */
      const onDragStart = (): void => {
        isDraggingRef.current = true
        if (activeToolRef.current !== 'adjust') return
        const inst = peaksRef.current
        if (!inst) return
        const snapshot = new Map<string, SegmentBoundarySnapshot>()
        for (const seg of inst.segments.getSegments()) {
          const id = String(seg.id ?? '')
          if (!id || id === CUT_PREVIEW_SEGMENT_ID) continue
          snapshot.set(id, {
            startTime: fromPeaksTime(seg.startTime, inst),
            endTime: fromPeaksTime(seg.endTime, inst)
          })
        }
        adjustDragStartSegmentsRef.current = snapshot
      }

      /**
       * CUT + insert-segment: 드래그로 생긴 가짜 세그먼트를 dragend 에서 단어로 넣지 않음(process 순서상 dragend 가 insert 이벤트보다 먼저 옴).
       */
      const onDragEnd = (): void => {
        isDraggingRef.current = false
        if (activeToolRef.current === 'cut') {
          const inst = peaksRef.current
          if (!inst) return
          const cutSeg = inst.segments
            .getSegments()
            .find((s) => String(s.id ?? '') === CUT_PREVIEW_SEGMENT_ID)
          if (cutSeg) {
            const { start: a, end: b } = normalizeCutRange(
              fromPeaksTime(cutSeg.startTime, inst),
              fromPeaksTime(cutSeg.endTime, inst)
            )
            syncCutSelection({ kind: 'range', start: a, end: b })
            queueMicrotask(() => {
              const p = peaksRef.current
              if (!p) return
              applyWordsToPeaks(
                p,
                flattenWords(rowsRef.current),
                rowsRef.current,
                activeLineIndexRef.current,
                activeWordIdRef.current,
                activeToolRef.current,
                cutSelectionRef.current,
                (sec) => toPeaksTime(sec, p)
              )
            })
          }
          return
        }
        /** 기본 상태/null + ADJUST 단어 편집/병합 */
        if (activeToolRef.current !== 'adjust') {
          return
        }
        const inst = peaksRef.current
        if (!inst) return
        const wordSegs = inst.segments.getSegments().filter((s) => String(s.id ?? '') !== CUT_PREVIEW_SEGMENT_ID)
        const prevSegMap = adjustDragStartSegmentsRef.current
        const changedSeg = wordSegs.find((seg) => {
          const prev = prevSegMap.get(String(seg.id ?? ''))
          if (!prev) return false
          return (
            prev.startTime !== fromPeaksTime(seg.startTime, inst) ||
            prev.endTime !== fromPeaksTime(seg.endTime, inst)
          )
        })
        if (!changedSeg) return

        const oldSegment = prevSegMap.get(String(changedSeg.id ?? ''))
        if (!oldSegment) return

        const prevFlat = flattenWords(rowsRef.current).sort((a, b) => a.start - b.start)
        const currentIndex = prevFlat.findIndex((w) => String(w.id) === String(changedSeg.id ?? ''))
        if (currentIndex < 0) return
        const flat = applyDirectionalAdjustResplit({
          words: prevFlat,
          currentIndex,
          oldSegment,
          newSegment: {
            startTime: fromPeaksTime(changedSeg.startTime, inst),
            endTime: fromPeaksTime(changedSeg.endTime, inst)
          }
        })
        const nextRows = assignFlatWordsToRows(flat, rowsRef.current)
        onRowsChangeRef.current(nextRows)
        applyWordsToPeaks(
          inst,
          flattenWords(nextRows),
          nextRows,
          activeLineIndexRef.current,
          activeWordIdRef.current,
          activeToolRef.current,
          cutSelectionRef.current,
          (sec) => toPeaksTime(sec, inst)
        )

        const li = activeLineIndexRef.current
        const wid = activeWordIdRef.current
        if (li === null || wid === null) return
        const row = nextRows[li]
        const w = row?.words?.find((x) => x.id === wid)
        if (!row?.words?.length || !w) return
        safeFitPeaksContainerView(inst, 'zoomview', zoomRef.current)
        safeFitPeaksContainerView(inst, 'overview', overviewRef.current)
        const dur = inst.player.getDuration()
        const mediaCap = Number.isFinite(dur) && dur > 0 ? dur : null
        const win = computeLineZoomWindow(row.words, {
          mediaDurationSec: mediaCap ?? undefined,
          clipTrailingToLineEnd: true
        })
        if (!win) return
        const maxEnd = Math.max(...row.words.map((w) => w.end))
        inst.player.seek(toPeaksTime(w.start, inst))
        applyZoomThenClampEndBeforeOrAt(inst, {
          windowStart: toPeaksTime(win.windowStart, inst),
          spanSeconds: toPeaksTime(win.windowStart + win.span, inst) - toPeaksTime(win.windowStart, inst),
          maxEndTime: toPeaksTime(maxEnd, inst)
        })
        queueMicrotask(() => publishZoomViewRangeRef.current())
      }

      /** 빈 파형 드래그(insert-segment)로 구간 확정 시 — 클릭 2번이 아니라 이 경로가 주력 */
      const onSegmentsInsert = (event: { segment: Segment }): void => {
        if (activeToolRef.current !== 'cut') {
          try {
            peaksRef.current?.segments.removeById(String(event.segment.id))
          } catch {
            /* ignore */
          }
          return
        }
        const seg = event.segment
        const { start: a, end: b } = normalizeCutRange(
          fromPeaksTime(seg.startTime, peaksRef.current),
          fromPeaksTime(seg.endTime, peaksRef.current)
        )
        if (b - a < 0.012) return
        syncCutSelection({ kind: 'range', start: a, end: b })
        queueMicrotask(() => {
          const inst = peaksRef.current
          if (!inst) return
          applyWordsToPeaks(
            inst,
            flattenWords(rowsRef.current),
            rowsRef.current,
            activeLineIndexRef.current,
            activeWordIdRef.current,
            activeToolRef.current,
            cutSelectionRef.current,
            (sec) => toPeaksTime(sec, inst)
          )
        })
      }

      const runPeaksInit = (): void => {
        if (cancelled || initGen !== peaksInitGenRef.current) return
        if (!hostReadyRef.current) {
          rafWait++
          if (rafWait > 120) {
            wfLog('peaks', 'Peaks.init 포기 — hostReady 대기 초과')
            return
          }
          requestAnimationFrame(runPeaksInit)
          return
        }
        const zoomEl = zoomRef.current
        const ovEl = overviewRef.current
        if (!zoomEl || !ovEl) {
          wfLog('peaks', 'Peaks.init 대기 (refs)', { rafWait })
          rafWait++
          if (rafWait > 90) {
            wfLog('peaks', 'Peaks.init 포기 — zoom/overview ref 없음')
            return
          }
          requestAnimationFrame(runPeaksInit)
          return
        }
        if (
          zoomEl.clientWidth <= 0 ||
          zoomEl.clientHeight <= 0 ||
          ovEl.clientWidth <= 0 ||
          ovEl.clientHeight <= 0
        ) {
          wfLog('peaks', 'Peaks.init 대기 (zoom/overview 컨테이너 준비 안 됨)', {
            rafWait,
            zw: zoomEl.clientWidth,
            zh: zoomEl.clientHeight,
            ow: ovEl.clientWidth,
            oh: ovEl.clientHeight,
            holdReason:
              zoomEl.clientWidth <= 0 || zoomEl.clientHeight <= 0 ? 'zoom' : 'overview'
          })
          rafWait++
          if (rafWait > 120) {
            wfLog('peaks', 'Peaks.init 포기 — 컨테이너가 계속 0×0')
            return
          }
          requestAnimationFrame(runPeaksInit)
          return
        }
        if (!waveformContainersAcceptableForPeaks(zoomEl, ovEl)) {
          wfLog('peaks', 'Peaks.init 대기 (zoom/overview DOM 가시성)', {
            rafWait,
            zw: zoomEl.clientWidth,
            zh: zoomEl.clientHeight,
            ow: ovEl.clientWidth,
            oh: ovEl.clientHeight
          })
          rafWait++
          if (rafWait > 180) {
            wfLog('peaks', 'Peaks.init 포기 — 가시성 대기 초과')
            return
          }
          requestAnimationFrame(runPeaksInit)
          return
        }

        wfLog('peaks', 'Peaks.init 시작', {
          activeLineIndex,
          portalHostConnected: portalHostLiveRef.current ? portalHostLiveRef.current.isConnected : null,
          silentDur,
          segmentCount: flattenWords(rowsRef.current).length,
          audioCtxState: audioContextRef.current?.state,
          localMediaPath: localMediaPath ?? null,
          usePrebuiltPeaks: usePrebuiltPeaks,
          useInlineWaveformData: useInlineWaveformData,
          hostReady: hostReadyRef.current
        })

        wfLog('peaks', 'Peaks.init 호출', {
          zw: zoomEl.clientWidth,
          zh: zoomEl.clientHeight,
          ow: ovEl.clientWidth,
          oh: ovEl.clientHeight,
          inlineWaveformJson: useInlineWaveformData,
          dataUriJson: useDataUri
        })

        const sharedPeaksOpts = {
          waveformColor: '#aeb4b6',
          playedWaveformColor: '#ffd54f',
          /** 화살표/단축키로 zoomview 가로 스크롤 방지 */
          keyboard: false,
          zoomview: {
            container: zoomEl,
            /** 단어 타임라인과 1:1 유지 — 휠로 줌 시간축 이동 금지 */
            wheelMode: 'none' as const,
            enablePoints: true,
            /** 비활성/활성 파형 색 */
            waveformColor: '#aeb4b6',
            playedWaveformColor: '#ffd54f',
            /** false: 파형이 컨테이너 가로 전체에 시간 선형 매핑 — 자막 타임라인과 픽셀 일치 */
            showAxisLabels: false,
            showPlayheadTime: false,
            axisTopMarkerHeight: 0,
            axisBottomMarkerHeight: 0
          },
          overview: {
            container: ovEl,
            waveformColor: '#aeb4b6',
            playedWaveformColor: '#ffd54f'
          },
          mediaElement: dummyAudio,
          /**
           * 첫 값은 waveform JSON 의 samples_per_pixel(네이티브 scale) 이상이어야 리샘플이 된다.
           * audiowaveform 80pps → spp≈600 이면 짧은 자막 줄을 화면에 펼칠 scale 로 못 내려가 빈 오른쪽만 보임.
           */
          zoomLevels: [
            ...(usePrebuiltPeaks
              ? zoomLevelsForPrebuiltPeaks({
                  inlineJson: finalJson,
                  useDataUriWithoutInline: useDataUri
                })
              : PEAKS_ZOOM_LEVELS_WEBAUDIO)
          ],
          segmentOptions: {
            markers: false,
            overlay: false,
            overlayOpacity: 0,
            overlayColor: '#aeb4b6',
            overlayBorderColor: '#aeb4b6',
            overlayBorderWidth: 1,
            overlayCornerRadius: 4,
            waveformColor: '#aeb4b6',
            playedWaveformColor: '#ffd54f',
            startMarkerColor: '#6b7280',
            endMarkerColor: '#6b7280'
          },
          createSegmentMarker: createWaveformSegmentMarker,
          createPointMarker: createCutToolPointMarker,
          segments: []
        }

        const peaksInitOpts = useInlineWaveformData
          ? {
              ...sharedPeaksOpts,
              waveformData: { json: finalJson as JsonWaveformData }
            }
          : useDataUri
            ? {
                ...sharedPeaksOpts,
                dataUri: { json: precomputedPeaksJsonFileUrl as string }
              }
            : {
                ...sharedPeaksOpts,
                webAudio: { audioContext: ctx! }
              }

        Peaks.init(
          peaksInitOpts as Parameters<typeof Peaks.init>[0],
          (err, peaks) => {
            if (initGen !== peaksInitGenRef.current) {
              if (peaks) {
                try {
                  peaks.destroy()
                } catch {
                  /* ignore */
                }
              }
              return
            }
            if (err || !peaks) {
              const msg = err?.message ?? String(err)
              const visibilityFail = /visible|non-zero width|non-zero height/i.test(msg)
              if (visibilityFail && initGen === peaksInitGenRef.current && !cancelled) {
                rafWait++
                if (rafWait <= 180) {
                  wfLog('peaks', 'Peaks.init 실패(가시성) — rAF 재시도', { err: msg, rafWait })
                  requestAnimationFrame(runPeaksInit)
                  return
                }
              }
              console.error('[SubtitleWaveformPeaks] Peaks.init failed', err)
              wfLog('peaks', 'Peaks.init 실패', { err: msg, staleGen: false })
              return
            }
            peaksInstance = peaks
            peaksRef.current = peaks

            applyWordsToPeaks(
              peaks,
              flattenWords(rowsRef.current),
              rowsRef.current,
              activeLineIndexRef.current,
              activeWordIdRef.current,
              activeToolRef.current,
              cutSelectionRef.current,
              (sec) => toPeaksTime(sec, peaks)
            )
            appliedSegmentHighlightWordIdRef.current = activeWordIdRef.current

            const zv = peaks.views.getView('zoomview')
            zv?.setSegmentDragMode(activeWordIdRef.current !== null ? 'no-overlap' : 'overlap')
            try {
              /** scroll 모드는 드래그 시 파형이 이동하므로 항상 insert-segment 유지 */
              zv?.setWaveformDragMode('insert-segment')
              // 옵션이 내부 기본값에 덮일 수 있어 init 직후 색상을 한 번 더 강제한다.
              zv?.setWaveformColor('#aeb4b6')
              zv?.setPlayedWaveformColor('#ffd54f')
              const ovColorView = peaks.views.getView('overview')
              ovColorView?.setWaveformColor?.('#aeb4b6')
              ovColorView?.setPlayedWaveformColor?.('#ffd54f')
              zv?.setWheelMode('none', { captureVerticalScroll: false })
              zv?.enableAutoScroll(false)
              const allowWaveSeekInit =
                activeToolRef.current === 'adjust' && activeWordIdRef.current === null
              zv?.enableSeek(allowWaveSeekInit)
              zv?.enableMarkerEditing(
                activeToolRef.current === 'adjust' || activeToolRef.current === 'cut'
              )
              zv?.enableSegmentDragging(false)
              const ov = peaks.views.getView('overview') as {
                enableSeek?: (e: boolean) => void
                setWaveformColor?: (color: string) => void
                setPlayedWaveformColor?: (color: string | null) => void
              } | null
              ov?.enableSeek?.(allowWaveSeekInit)
              if (zv) applyZoomViewStageDragSuppression(zv, activeWordIdRef.current !== null)
            } catch {
              /* ignore */
            }

            peaks.on('segments.dragstart', onDragStart)
            peaks.on('segments.dragend', onDragEnd)
            peaks.on('segments.insert', onSegmentsInsert)

            const dur = peaks.player.getDuration()
            wfLog('peaks', 'Peaks.init 완료', {
              duration: dur,
              zoomView: Boolean(peaks.views.getView('zoomview')),
              overviewView: Boolean(peaks.views.getView('overview'))
            })

            lastFocusZoomSigRef.current = ''
            setPeaksReady(true)
            /** setPeaksReady 다음 틱에도 동기화 — layout effect 전에 다른 코드가 스테이지를 건드릴 때 대비 */
            queueMicrotask(() => {
              const inst = peaksRef.current
              const zv = inst?.views.getView('zoomview')
              if (!zv) return
              const suppress = activeWordIdRef.current !== null
              applyZoomViewStageDragSuppression(zv, suppress)
              wfLog('view', 'post-init zoom stage drag guard', { suppress, activeWordId: activeWordIdRef.current })
            })
          }
        )
      }

      const startPipeline = async (): Promise<void> => {
        if (usePrebuiltPeaks) {
          /** CUT 편집본이면 픽셀 수가 줄어든다 — 무편집 소스 length 로 로그하면 integrity 와 불일치 */
          const peakPointsLen = finalJson?.length ?? precomputedWaveformJson?.length ?? 0

          wfLog(
            'peaks',
            useInlineWaveformData
              ? '사전 피크 waveformData(메모리) — 디코딩·XHR 생략'
              : '사전 피크 JSON(dataUri) — 브라우저 디코딩 생략',
            useInlineWaveformData
              ? { peakPoints: peakPointsLen }
              : { jsonUrl: precomputedPeaksJsonFileUrl ?? null }
          )
          if (cancelled || initGen !== peaksInitGenRef.current) return
          runPeaksInit()
          return
        }
        if (!ctx) {
          wfLog('peaks', 'AudioContext 없음 — 파형 초기화 불가')
          return
        }
        if (cancelled || initGen !== peaksInitGenRef.current) return
        runPeaksInit()
      }

      void startPipeline()

      return () => {
        cancelled = true
        peaksInitGenRef.current++
        /** 새 인스턴스 초기화 후에도 이전 dedupe 시그니처가 남으면 focusWordAtTime 이 줌을 생략해 파형이 찌그러짐 */
        lastFocusZoomSigRef.current = ''
        wfLog('peaks', 'Peaks 인스턴스 destroy (effect cleanup)')
        setPeaksReady(false)
        if (peaksInstance) {
          try {
            peaksInstance.off('segments.dragstart', onDragStart)
            peaksInstance.off('segments.dragend', onDragEnd)
            peaksInstance.off('segments.insert', onSegmentsInsert)
            peaksInstance.destroy()
          } catch {
            /* ignore */
          }
        }
        peaksRef.current = null
        if (dummyAudio.dataset.blobUrl) {
          URL.revokeObjectURL(dummyAudio.dataset.blobUrl)
          delete dummyAudio.dataset.blobUrl
        }
      }
    }, [
      audioUrl,
      localMediaPath,
      waveformOpen,
      precomputedPeaksJsonFileUrl,
      precomputedWaveformSig,
      editedWaveformSig
    ])

    /** 포털 타깃(줄) 이동 후 Konva 스테이지가 안 그려지는 경우 — fit + batchDraw */
    useLayoutEffect(() => {
      const p = peaksRef.current
      if (!p || !peaksReady || !portalHost) return
      try {
        safeFitPeaksContainerView(p, 'zoomview', zoomRef.current)
        safeFitPeaksContainerView(p, 'overview', overviewRef.current)
        const zv = p.views.getView('zoomview') as unknown as { getStage?: () => { batchDraw?: () => void } }
        zv?.getStage?.()?.batchDraw?.()
      } catch (e) {
        wfLog('view', 'portalHost 이동 후 refit/batchDraw', e)
      }
      queueMicrotask(() => publishZoomViewRangeRef.current())
    }, [portalHost, peaksReady])

    /** 단어 레일 레이아웃·포털 이동 직후 한 틱 더 refit — Konva/폭 어긋남 완화 */
    useEffect(() => {
      if (!peaksReady || !portalHost) return
      const t = window.setTimeout(() => {
        const p = peaksRef.current
        if (!p) return
        try {
          safeFitPeaksContainerView(p, 'zoomview', zoomRef.current)
          safeFitPeaksContainerView(p, 'overview', overviewRef.current)
          const zv = p.views.getView('zoomview') as unknown as {
            getStage?: () => { batchDraw?: () => void }
          }
          zv?.getStage?.()?.batchDraw?.()
        } catch {
          /* ignore */
        }
        queueMicrotask(() => publishZoomViewRangeRef.current())
      }, 420)
      return () => window.clearTimeout(t)
    }, [portalHost, peaksReady])

    useEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady) return
      /**
       * ADJUST 드래그 중에는 Peaks 가 세그먼트를 직접 옮기므로 여기서 removeAll+재삽입을 스킵한다.
       * CUT(insert-segment) 드래그 중에는 removeAll 이 CUT 프리뷰를 지우므로, 드래그 끝난 뒤에도
       * paintCutSelectionOverlay 가 다시 돌아가야 구간이 유지된다 — 이 경우엔 스킵하면 안 된다.
       */
      if (isDraggingRef.current && activeTool !== 'cut') return
      if (cutMarkerDraggingRef.current) return
      applyWordsToPeaks(
        peaks,
        flatWords,
        rowsRef.current,
        activeLineIndex,
        activeWordId,
        activeTool,
        cutSelectionRef.current,
        (sec) => toPeaksTime(sec, peaks)
      )
      wfLog('segments', 'applyWordsToPeaks', { wordCount: flatWords.length })
      appliedSegmentHighlightWordIdRef.current = activeWordId
    }, [wordsSig, rowsSig, flatWords, peaksReady, activeLineIndex, activeTool, cutSelection])

    useEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady || activeLineIndex === null) return
      if (isDraggingRef.current && activeTool !== 'cut') return
      if (cutMarkerDraggingRef.current) return

      const mapped = (sec: number) => toPeaksTime(sec, peaks)
      const painted = appliedSegmentHighlightWordIdRef.current
      const next = activeWordId
      if (painted === next) return

      const rows = rowsRef.current
      const flat = flattenWords(rows)

      /** adjust 도구는 활성 단어에만 markers=true 인데 Peaks.update 로 markers 를 바꿀 수 없음 → 전체 재구축 */
      if (activeTool === 'adjust') {
        applyWordsToPeaks(
          peaks,
          flat,
          rows,
          activeLineIndex,
          next,
          activeTool,
          cutSelectionRef.current,
          mapped
        )
        appliedSegmentHighlightWordIdRef.current = next
        wfLog('segments', 'applyWordsToPeaks', { wordCount: flat.length, reason: 'adjust-tool-full-segments' })
        return
      }

      const okPrev = painted == null || patchWordSegmentHighlight(peaks, painted, rows, activeLineIndex, next, activeTool, mapped)
      const okNext = next == null || patchWordSegmentHighlight(peaks, next, rows, activeLineIndex, next, activeTool, mapped)

      if (okPrev && okNext) {
        appliedSegmentHighlightWordIdRef.current = next
        wfLog('segments', 'activeWord highlight patch', { fromWordId: painted, toWordId: next })
        return
      }

      applyWordsToPeaks(
        peaks,
        flat,
        rows,
        activeLineIndex,
        next,
        activeTool,
        cutSelectionRef.current,
        mapped
      )
      appliedSegmentHighlightWordIdRef.current = next
      wfLog('segments', 'applyWordsToPeaks', { wordCount: flat.length, reason: 'highlight-patch-fallback' })
    }, [activeWordId, peaksReady, activeLineIndex, activeTool, toPeaksTime])

    useEffect(() => {
      if (!audioContextRef.current) return
      void audioContextRef.current.resume().then(
        () => wfLog('audio', 'AudioContext.resume', { state: audioContextRef.current?.state }),
        () => wfLog('audio', 'AudioContext.resume rejected')
      )
    }, [activeLineIndex, activeWordId])

    const stopOneShotPlayback = useCallback((): void => {
      // App(videoRef) 단일 경로 재생으로 전환되어 내부 one-shot 상태를 유지하지 않는다.
    }, [])

    const playSelectedWordOnce = useCallback((): void => {
      const li = activeLineIndexRef.current
      const wid = activeWordIdRef.current
      if (li === null || wid === null) return
      const row = rowsRef.current[li]
      const w = row?.words?.find((x) => x.id === wid)
      if (!w || !(w.end > w.start + 1e-4)) return

      stopOneShotPlayback()

      wfLog('playback', 'one-shot delegated to app video path', {
        wordId: w.id,
        editStart: w.start,
        editEnd: w.end,
        cutCount: mergedCutRanges.length
      })
      onPlayEditRange?.(w.start, w.end)
    }, [stopOneShotPlayback, mergedCutRanges, onPlayEditRange])

    useEffect(() => {
      const onKey = (e: KeyboardEvent): void => {
        if (e.code !== 'Space' || e.repeat) return
        if (activeLineIndexRef.current === null || activeWordIdRef.current === null) return
        const target = e.target as HTMLElement | null
        if (target?.closest('input,textarea,[contenteditable="true"]')) return
        e.preventDefault()
        e.stopPropagation()
        playSelectedWordOnce()
      }
      window.addEventListener('keydown', onKey, true)
      return () => window.removeEventListener('keydown', onKey, true)
    }, [playSelectedWordOnce])

    useEffect(() => {
      if (activeWordId === null) {
        stopOneShotPlayback()
      }
    }, [activeWordId, stopOneShotPlayback])

    useEffect(
      () => () => {
        stopOneShotPlayback()
      },
      [stopOneShotPlayback]
    )

    useEffect(() => {
      const editT = playheadEditSec
      const peaks = peaksRef.current
      const zv = peaks?.views.getView('zoomview')
      if (typeof editT !== 'number' || !Number.isFinite(editT) || !zv) {
        setPlayheadLinePct(null)
        return
      }
      const t0 = zv.getStartTime()
      const t1 = zv.getEndTime()
      const span = t1 - t0
      if (!(span > 1e-9)) {
        setPlayheadLinePct(null)
        return
      }
      const pct = ((editT - t0) / span) * 100
      if (!Number.isFinite(pct)) {
        setPlayheadLinePct(null)
        return
      }
      setPlayheadLinePct(clampPx(pct, 0, 100))
    }, [playheadEditSec, peaksReady, mountLayoutKey])

    const cutMarkerVisualSec =
      cutHandlePreviewSec ??
      (cutSelection?.kind === 'marker' ? cutSelection.time : null)

    const domCutLineLeftPct = useMemo(() => {
      const peaks = peaksRef.current
      if (!peaks || cutMarkerVisualSec == null || activeWordId === null || activeLineIndex === null) return null
      const row = rowsRef.current[activeLineIndex]
      const w = row?.words?.find((x) => x.id === activeWordId)
      if (!w) return null
      const bounds = getWordCutBoundsSec(peaks, activeWordId, w, fromPeaksTime)
      const tSec = clampMarkerTimeToWordBounds(peaks, activeWordId, w, cutMarkerVisualSec, fromPeaksTime)
      const zv = peaks.views.getView('zoomview')
      if (!zv) return null
      const t0 = zv.getStartTime()
      const t1 = zv.getEndTime()
      const span = t1 - t0
      if (!(span > 1e-9)) return null
      const tp = toPeaksTime(tSec, peaks)
      let pct = ((tp - t0) / span) * 100
      pct = clampPx(pct, 0, 100)
      const rng = wordCutHorizontalPctRangeInZoom(peaks, bounds, fromPeaksTime)
      if (rng) pct = clampPx(pct, rng.loPct, rng.hiPct)
      return pct
    }, [
      cutMarkerVisualSec,
      activeWordId,
      activeLineIndex,
      peaksReady,
      mountLayoutKey,
      zoomViewTick,
      cutHandlePreviewSec,
      cutSelection,
      fromPeaksTime,
      toPeaksTime
    ])

    /** 줌뷰에서 활성 단어 파형이 차지하는 가로 구간 — 버튼을 카드 중앙이 아니라 이 구간 아래에 둠 */
    const markerWordBandPct = useMemo(() => {
      const peaks = peaksRef.current
      if (!peaks || activeWordId === null || activeLineIndex === null) return null
      const row = rowsRef.current[activeLineIndex]
      const w = row?.words?.find((x) => x.id === activeWordId)
      if (!w) return null
      const bounds = getWordCutBoundsSec(peaks, activeWordId, w, fromPeaksTime)
      const rng = wordCutHorizontalPctRangeInZoom(peaks, bounds, fromPeaksTime)
      return rng
    }, [
      activeWordId,
      activeLineIndex,
      peaksReady,
      mountLayoutKey,
      zoomViewTick,
      fromPeaksTime,
      cutSelection?.kind
    ])

    const markerCutButtonBandLayout = useMemo(() => {
      if (!markerWordBandPct) return null
      return layoutCutMarkerButtonBand(markerWordBandPct.loPct, markerWordBandPct.hiPct)
    }, [markerWordBandPct])

    useEffect(() => {
      setCutHandlePreviewSec(null)
    }, [activeWordId, activeLineIndex, cutSelection?.kind])

    /** 통합 편집: 활성 단어 내부 단일 컷 라인(드래그 가능). wordsSig 에 묶이면 데이터 갱신 때마다 라인이 중앙으로 되돌아가 드래그가 무효화된다. */
    useEffect(() => {
      const p = peaksRef.current
      if (!p || !peaksReady) return
      if (activeLineIndex === null || activeWordId === null) {
        syncCutSelection(null)
        paintCutSelectionOverlay(p, null, (sec) => toPeaksTime(sec, p))
        return
      }
      const row = rowsRef.current[activeLineIndex]
      const w = row?.words?.find((x) => x.id === activeWordId)
      if (!w) return
      const mid = (w.start + w.end) / 2
      const marker: CutSelectionOverlay = { kind: 'marker', time: mid }
      syncCutSelection(marker)
      paintCutSelectionOverlay(p, marker, (sec) => toPeaksTime(sec, p))
    }, [activeLineIndex, activeWordId, peaksReady, toPeaksTime, syncCutSelection])

    const confirmPendingCutRef = useRef<() => void>(() => undefined)

    const confirmPendingCut = useCallback(() => {
      const p = peaksRef.current
      const cutSeg = p?.segments
        .getSegments()
        .find((s) => String(s.id ?? '') === CUT_PREVIEW_SEGMENT_ID)
      let a: number
      let b: number
      if (cutSeg) {
        const n = normalizeCutRange(fromPeaksTime(cutSeg.startTime, p ?? null), fromPeaksTime(cutSeg.endTime, p ?? null))
        a = n.start
        b = n.end
      } else {
        const sel = cutSelectionRef.current
        if (!sel || sel.kind !== 'range') {
          timelineEditLog('cut-ui', 'confirmPendingCut 스킵 — range 선택 아님', { sel })
          return
        }
        const n = normalizeCutRange(sel.start, sel.end)
        a = n.start
        b = n.end
      }
      if (!(b - a > 0.001)) {
        timelineEditLog('cut-ui', 'confirmPendingCut 스킵 — 구간 너무 짧음', { a, b })
        return
      }
      const hasCb = typeof onTimeRangeCutRef.current === 'function'
      timelineEditLog('cut-ui', 'confirmPendingCut — 부모에 CUT 전달', {
        startSec: a,
        endSec: b,
        hasOnTimeRangeCut: hasCb
      })
      if (!hasCb) {
        wfLog('cut-ui', 'onTimeRangeCut 미연결 — App applyTimeRangeCut 호출 안 됨')
      }
      onTimeRangeCutRef.current?.(a, b)
      syncCutSelection(null)
      if (p) paintCutSelectionOverlay(p, null, (sec) => toPeaksTime(sec, p))
    }, [fromPeaksTime, toPeaksTime])

    /** 컷 라인 위치에서 단어 분할 — 버튼으로만 확정 */
    const confirmWordCutAtMarker = useCallback((): void => {
      const peaks = peaksRef.current
      const li = activeLineIndexRef.current
      const wid = activeWordIdRef.current
      if (li == null || wid == null) return
      const sel = cutSelectionRef.current
      if (!sel || sel.kind !== 'marker') return
      const row = rowsRef.current[li]
      const w = row?.words?.find((x) => x.id === wid)
      if (!w) return
      const bounds = getWordCutBoundsSec(peaks, wid, w, fromPeaksTime)
      const minSeg = 0.05
      const lo = bounds.start + minSeg
      const hi = bounds.end - minSeg
      const splitRaw = snapCutTimeToWordEdge(sel.time, bounds)
      const splitSec =
        hi > lo + 1e-6 ? Math.max(lo, Math.min(splitRaw, hi)) : (bounds.start + bounds.end) / 2
      const res = splitActiveWordAtTime({
        rows: rowsRef.current,
        activeLineIndex: li,
        activeWordId: wid,
        splitTime: splitSec
      })
      if (!res.changed) {
        wfLog('cut-ui', 'confirmWordCutAtMarker 스킵 — 분할 불가', { splitSec, word: w })
        return
      }
      onRowsChangeRef.current(res.rows)
      const marker: CutSelectionOverlay = { kind: 'marker', time: splitSec }
      syncCutSelection(marker)
      if (peaks) paintCutSelectionOverlay(peaks, marker, (sec) => toPeaksTime(sec, peaks))
    }, [syncCutSelection, toPeaksTime, fromPeaksTime])

    const finalizeDomCutMarkerDrag = useCallback(
      (clientX: number | null): void => {
        if (!cutMarkerDraggingRef.current) return
        cutMarkerDraggingRef.current = false
        setCutHandlePreviewSec(null)
        const peaks = peaksRef.current
        const wrap = waveformZoomOuterRef.current
        const li = activeLineIndexRef.current
        const wid = activeWordIdRef.current
        if (!peaks || !wrap?.isConnected || li == null || wid == null) return
        const row = rowsRef.current[li]
        const w = row?.words?.find((x) => x.id === wid)
        if (!w) return
        let finalT: number
        if (clientX == null) {
          const sel = cutSelectionRef.current
          finalT =
            sel?.kind === 'marker'
              ? sel.time
              : clampMarkerTimeToWordBounds(peaks, wid, w, (w.start + w.end) / 2, fromPeaksTime)
        } else {
          const rect = wrap.getBoundingClientRect()
          const raw = cutTimeSecFromZoomClientX(clientX, rect, peaks, fromPeaksTime)
          finalT =
            raw == null
              ? cutSelectionRef.current?.kind === 'marker'
                ? cutSelectionRef.current.time
                : clampMarkerTimeToWordBounds(peaks, wid, w, (w.start + w.end) / 2, fromPeaksTime)
              : clampMarkerTimeToWordBounds(peaks, wid, w, raw, fromPeaksTime)
        }
        const marker: CutSelectionOverlay = { kind: 'marker', time: finalT }
        syncCutSelection(marker)
      },
      [fromPeaksTime, syncCutSelection]
    )

    const onDomCutPointerDown = useCallback(
      (e: ReactPointerEvent<HTMLDivElement>): void => {
        if (e.button !== 0) return
        e.stopPropagation()
        const peaks = peaksRef.current
        const wrap = waveformZoomOuterRef.current
        const li = activeLineIndex
        const wid = activeWordId
        if (!peaks || !wrap?.isConnected || li == null || wid == null) return
        const row = rowsRef.current[li]
        const w = row?.words?.find((x) => x.id === wid)
        if (!w) return
        cutMarkerDraggingRef.current = true
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        const rect = wrap.getBoundingClientRect()
        const raw = cutTimeSecFromZoomClientX(e.clientX, rect, peaks, fromPeaksTime)
        if (raw == null) return
        const next = clampMarkerTimeToWordBounds(peaks, wid, w, raw, fromPeaksTime)
        cutSelectionRef.current = { kind: 'marker', time: next }
        setCutHandlePreviewSec(next)
      },
      [activeLineIndex, activeWordId, fromPeaksTime]
    )

    const onDomCutLostPointerCapture = useCallback((): void => {
      finalizeDomCutMarkerDrag(null)
    }, [finalizeDomCutMarkerDrag])

    useEffect(() => {
      if (!peaksReady || activeWordId === null || activeLineIndex === null) return
      if (cutSelection?.kind !== 'marker') return

      const onMove = (e: PointerEvent): void => {
        if (!cutMarkerDraggingRef.current) return
        const peaks = peaksRef.current
        const wrap = waveformZoomOuterRef.current
        const li = activeLineIndexRef.current
        const wid = activeWordIdRef.current
        if (!peaks || !wrap?.isConnected || li == null || wid == null) return
        const row = rowsRef.current[li]
        const w = row?.words?.find((x) => x.id === wid)
        if (!w) return
        const rect = wrap.getBoundingClientRect()
        const raw = cutTimeSecFromZoomClientX(e.clientX, rect, peaks, fromPeaksTime)
        if (raw == null) return
        const next = clampMarkerTimeToWordBounds(peaks, wid, w, raw, fromPeaksTime)
        cutSelectionRef.current = { kind: 'marker', time: next }
        setCutHandlePreviewSec(next)
      }

      const onUp = (e: PointerEvent): void => {
        finalizeDomCutMarkerDrag(e.clientX)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)
      return () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onUp, true)
      }
    }, [
      peaksReady,
      activeWordId,
      activeLineIndex,
      cutSelection?.kind,
      finalizeDomCutMarkerDrag,
      fromPeaksTime
    ])

    useEffect(() => {
      confirmPendingCutRef.current = confirmPendingCut
    }, [confirmPendingCut])

    useEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady || activeLineIndex === null) return

      const handler = (evt: { time: number; evt: MouseEvent }): void => {
        if (activeToolRef.current !== 'cut') return
        const selfPeaks = peaksRef.current
        if (!selfPeaks) return

        let t = fromPeaksTime(evt.time, selfPeaks)
        const dur = selfPeaks.player.getDuration()
        if (Number.isFinite(dur) && dur > 0) t = Math.max(0, Math.min(t, fromPeaksTime(dur, selfPeaks)))
        else t = Math.max(0, t)
        if (!Number.isFinite(t)) return

        const sel = cutSelectionRef.current

        /** 1차 클릭만 ‘단어 블록 아닌 곳’ — 2차는 파형 전역에서 끝점 허용(안 그러면 단어로 파형이 가득할 때 구간 완성 불가·삭제 버튼 없음) */
        if (!sel && isTimeOnWordSegment(selfPeaks, evt.time)) return

        if (sel?.kind === 'range') {
          /**
           * range 선택 취소는 pointerdown(바깥) + ESC 만 담당.
           * Peaks `zoomview.click` 의 time 은 드래그 직후 clientX 기반과 어긋나 ‘바깥 클릭’으로 오판해 선택이 즉시 날아가는 경우가 있다.
           */
          if (!evt.evt.shiftKey) return
          syncCutSelection({ kind: 'marker', time: t })
          queueMicrotask(() => {
            const pl = peaksRef.current
            if (pl) paintCutSelectionOverlay(pl, { kind: 'marker', time: t }, (sec) => toPeaksTime(sec, pl))
          })
          return
        }
        if (!sel) {
          syncCutSelection({ kind: 'marker', time: t })
          queueMicrotask(() => {
            const pl = peaksRef.current
            if (pl) paintCutSelectionOverlay(pl, { kind: 'marker', time: t }, (sec) => toPeaksTime(sec, pl))
          })
          return
        }
        if (sel.kind === 'marker') {
          const t0 = sel.time
          const { start, end } = normalizeCutRange(t0, t)
          if (end - start < 0.02) return
          syncCutSelection({ kind: 'range', start, end })
          queueMicrotask(() => {
            const pl = peaksRef.current
            if (pl) paintCutSelectionOverlay(pl, { kind: 'range', start, end }, (sec) => toPeaksTime(sec, pl))
          })
        }
      }

      peaks.on('zoomview.click', handler)
      return () => {
        peaks.off('zoomview.click', handler)
      }
    }, [fromPeaksTime, peaksReady, activeLineIndex, toPeaksTime])

    useEffect(() => {
      const zoomEl = zoomRef.current
      if (!zoomEl) return

      const getTimeFromClientX = (clientX: number): number | null => {
        const p = peaksRef.current
        const zv = p?.views.getView('zoomview')
        if (!zv) return null
        const t0 = zv.getStartTime()
        const t1 = zv.getEndTime()
        if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0 + 1e-9) return null
        const r = zoomEl.getBoundingClientRect()
        const w = r.width
        if (!(w > 1)) return null
        const frac = clampPx((clientX - r.left) / w, 0, 1)
        const t = t0 + (t1 - t0) * frac
        return Number.isFinite(t) ? fromPeaksTime(t, p ?? null) : null
      }

      const onPointerDown = (e: PointerEvent): void => {
        if (activeToolRef.current !== 'cut') return
        if (e.button !== 0) return
        const t = getTimeFromClientX(e.clientX)
        if (t == null) return
        const sel = cutSelectionRef.current
        if (sel?.kind === 'range') {
          const a = Math.min(sel.start, sel.end)
          const b = Math.max(sel.start, sel.end)
          const eps = CUT_TIME_MATCH_EPS_SEC
          if (t < a - eps || t > b + eps) {
            syncCutSelection(null)
            const p = peaksRef.current
            if (p) paintCutSelectionOverlay(p, null, (sec) => toPeaksTime(sec, p))
          }
          return
        }
        cutDraggingRef.current = true
        cutDragRangeCommittedRef.current = false
        cutDragAnchorTimeRef.current = t
        syncCutSelection({ kind: 'marker', time: t })
        queueMicrotask(() => {
          const p = peaksRef.current
          if (p) paintCutSelectionOverlay(p, { kind: 'marker', time: t }, (sec) => toPeaksTime(sec, p))
        })
      }

      const onPointerMove = (e: PointerEvent): void => {
        if (activeToolRef.current !== 'cut') return
        if (!cutDraggingRef.current) return
        const anchor = cutDragAnchorTimeRef.current
        if (anchor == null) return
        const t = getTimeFromClientX(e.clientX)
        if (t == null) return
        const { start, end } = normalizeCutRange(anchor, t)
        if (end - start < 0.005) return
        cutDragRangeCommittedRef.current = true
        syncCutSelection({ kind: 'range', start, end })
        queueMicrotask(() => {
          const p = peaksRef.current
          if (p) paintCutSelectionOverlay(p, { kind: 'range', start, end }, (sec) => toPeaksTime(sec, p))
        })
      }

      const endDrag = (e: PointerEvent): void => {
        const wasDragging = cutDraggingRef.current
        const committedAtStart = cutDragRangeCommittedRef.current
        const anchor = cutDragAnchorTimeRef.current
        let committedRange = committedAtStart
        if (wasDragging && anchor != null && !committedRange) {
          const t = getTimeFromClientX(e.clientX)
          if (t != null) {
            const { start, end } = normalizeCutRange(anchor, t)
            if (end - start >= 0.005) {
              committedRange = true
              syncCutSelection({ kind: 'range', start, end })
              const p = peaksRef.current
              if (p) paintCutSelectionOverlay(p, { kind: 'range', start, end }, (sec) => toPeaksTime(sec, p))
            }
          }
        }
        cutDraggingRef.current = false
        cutDragRangeCommittedRef.current = false
        cutDragAnchorTimeRef.current = null
      }

      zoomEl.addEventListener('pointerdown', onPointerDown)
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', endDrag, true)
      window.addEventListener('pointercancel', endDrag, true)
      return () => {
        zoomEl.removeEventListener('pointerdown', onPointerDown)
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', endDrag, true)
        window.removeEventListener('pointercancel', endDrag, true)
      }
    }, [fromPeaksTime, peaksReady, toPeaksTime])

    useLayoutEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady) return
      const zv = peaks.views.getView('zoomview')
      const ov = peaks.views.getView('overview') as {
        enableSeek?: (e: boolean) => void
        setWaveformColor?: (color: string) => void
        setPlayedWaveformColor?: (color: string | null) => void
      } | null
      if (!zv) return
      try {
        /** scroll 모드 복귀를 막아 파형 드래그 이동을 고정 차단 */
        zv.setWaveformDragMode('insert-segment')
        zv.setWaveformColor('#aeb4b6')
        zv.setPlayedWaveformColor('#ffd54f')
        ov?.setWaveformColor?.('#aeb4b6')
        ov?.setPlayedWaveformColor?.('#ffd54f')
        zv.setWheelMode('none', { captureVerticalScroll: false })
        zv.enableAutoScroll(false)
        /**
         * 활성 단어 편집 중 SeekMouseDragHandler(전역 mousemove)가 재생 헤드를 계속 움직여
         * 컷 라인이 마우스를 따라가는 것처럼 보인다 — 단어 선택 시 줌/오버뷰 스크럽 끔.
         */
        const allowWaveSeek = activeTool === 'adjust' && activeWordId === null
        zv.enableSeek(allowWaveSeek)
        zv.enableMarkerEditing(activeTool === 'adjust' || activeTool === 'cut')
        zv.enableSegmentDragging(false)
        ov?.enableSeek?.(allowWaveSeek)
        /**
         * insert-segment 모드에서는 세그먼트 위 클릭 시 삽입 세그먼트가 생기며 드래그가 이어져
         * 컷 포인트처럼 보이는 선이 마우스를 계속 따라간다 — 단어 편집 중엔 no-overlap 으로 삽입 경로 차단.
         */
        zv.setSegmentDragMode(activeWordId !== null ? 'no-overlap' : 'overlap')
        applyZoomViewStageDragSuppression(zv, activeWordId !== null)
        /** DOM 컷 라인 사용 시 Konva 재생 헤드가 전역 seek 에 묶여 마우스를 따라가 보이는 현상 방지 */
        const hideKonvaPlayhead = activeWordId !== null && cutSelection?.kind === 'marker'
        setZoomViewKonvaPlayheadVisible(zv, !hideKonvaPlayhead)
      } catch {
        /* ignore */
      }
      return () => {
        const p2 = peaksRef.current
        const zv2 = p2?.views.getView('zoomview')
        if (zv2) setZoomViewKonvaPlayheadVisible(zv2, true)
      }
    }, [activeTool, activeWordId, peaksReady, mountLayoutKey, cutSelection])

    /**
     * fitToContainer·줌 변경 등으로 Peaks 내부가 스테이지 핸들러를 다시 붙이는 경우 대비 —
     * 활성 단어 편집 중엔 매 zoomview.update 후 삽입/스크롤 드래그를 다시 끈다.
     */
    useEffect(() => {
      const peaks = peaksRef.current
      if (!peaks || !peaksReady) return
      let raf = 0
      const reassertSuppression = (): void => {
        if (activeWordIdRef.current === null) return
        const zv = peaks.views.getView('zoomview')
        if (zv) {
          applyZoomViewStageDragSuppression(zv, true)
          const hideKonvaPlayhead = cutSelectionRef.current?.kind === 'marker'
          setZoomViewKonvaPlayheadVisible(zv, !hideKonvaPlayhead)
        }
      }
      const onZoomUpdate = (): void => {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(reassertSuppression)
      }
      peaks.on('zoomview.update', onZoomUpdate)
      reassertSuppression()
      return () => {
        cancelAnimationFrame(raf)
        peaks.off('zoomview.update', onZoomUpdate)
      }
    }, [peaksReady, activeWordId])

    /** 줌 refit / batchDraw 직후에도 CUT 미리보기·컷 마커가 스택에서 밀리지 않도록 재적용 (adjust 에서도 단일 마커 사용) */
    useLayoutEffect(() => {
      const p = peaksRef.current
      if (!p || !peaksReady || !cutSelectionRef.current) return
      paintCutSelectionOverlay(p, cutSelectionRef.current, (sec) => toPeaksTime(sec, p))
      try {
        const zv = p.views.getView('zoomview') as unknown as { getStage?: () => { batchDraw?: () => void } }
        zv?.getStage?.()?.batchDraw?.()
      } catch {
        /* ignore */
      }
    }, [peaksReady, cutSelection, mountLayoutKey])

    useEffect(() => {
      if (cutSelection?.kind !== 'range') return
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
          syncCutSelection(null)
          const p = peaksRef.current
          if (p) paintCutSelectionOverlay(p, null, (sec) => toPeaksTime(sec, p))
          return
        }
        if (e.key === 'Delete') {
          e.preventDefault()
          confirmPendingCutRef.current()
        }
      }
      window.addEventListener('keydown', onKey, true)
      return () => window.removeEventListener('keydown', onKey, true)
    }, [cutSelection])

    const [cutDeleteBarLayout, setCutDeleteBarLayout] = useState<{
      top: number
      /** 뷰포트 X — 선택 구간의 화면상 가로 중앙 (줌뷰 시간축과 동일 매핑) */
      centerX: number
    } | null>(null)

    const updateCutDeleteBarLayout = useCallback((): void => {
      const el = zoomRef.current
      const sel = cutSelectionRef.current
      if (!el?.isConnected || !sel || sel.kind !== 'range') {
        setCutDeleteBarLayout(null)
        return
      }
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) {
        setCutDeleteBarLayout(null)
        return
      }
      const top = r.bottom + 8
      const plotLeft = r.left
      const plotRight = r.left + r.width
      const peaks = peaksRef.current
      const cutSeg = peaks?.segments
        .getSegments()
        .find((s) => String(s.id ?? '') === CUT_PREVIEW_SEGMENT_ID)
      const a = cutSeg
        ? Math.min(cutSeg.startTime, cutSeg.endTime)
        : Math.min(sel.start, sel.end)
      const b = cutSeg
        ? Math.max(cutSeg.startTime, cutSeg.endTime)
        : Math.max(sel.start, sel.end)
      const zv = peaks?.views.getView('zoomview')
      let centerX = plotLeft + r.width / 2
      if (zv) {
        const t0 = zv.getStartTime()
        const t1 = zv.getEndTime()
        const span = t1 - t0
        if (span > 1e-9) {
          const xAt = (t: number) => plotLeft + ((t - t0) / span) * r.width
          const xl = clampPx(Math.min(xAt(a), xAt(b)), plotLeft, plotRight)
          const xr = clampPx(Math.max(xAt(a), xAt(b)), plotLeft, plotRight)
          centerX = (xl + xr) / 2
        }
      }
      setCutDeleteBarLayout({ top, centerX })
    }, [])

    useLayoutEffect(() => {
      if (cutSelection?.kind !== 'range') {
        setCutDeleteBarLayout(null)
        return
      }
      updateCutDeleteBarLayout()
      const rafIds: number[] = []
      const chain = (remaining: number): void => {
        updateCutDeleteBarLayout()
        if (remaining > 0) {
          rafIds.push(requestAnimationFrame(() => chain(remaining - 1)))
        }
      }
      rafIds.push(requestAnimationFrame(() => chain(4)))
      const el = zoomRef.current
      const ro =
        el && typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(() => {
              updateCutDeleteBarLayout()
            })
          : null
      if (el && ro) ro.observe(el)
      const onWin = (): void => {
        updateCutDeleteBarLayout()
      }
      window.addEventListener('resize', onWin)
      window.addEventListener('scroll', onWin, true)
      return () => {
        for (const id of rafIds) cancelAnimationFrame(id)
        window.removeEventListener('resize', onWin)
        window.removeEventListener('scroll', onWin, true)
        ro?.disconnect()
      }
    }, [cutSelection, mountLayoutKey, peaksReady, hostReady, updateCutDeleteBarLayout])

    useEffect(() => {
      if (cutSelection?.kind !== 'range') return
      const peaks = peaksRef.current
      if (!peaks || !peaksReady) return
      const onZ = (): void => {
        updateCutDeleteBarLayout()
        if (activeToolRef.current === 'cut') {
          paintCutSelectionOverlay(peaks, cutSelectionRef.current, (sec) => toPeaksTime(sec, peaks))
          try {
            const zv = peaks.views.getView('zoomview') as unknown as {
              getStage?: () => { batchDraw?: () => void }
            }
            zv?.getStage?.()?.batchDraw?.()
          } catch {
            /* ignore */
          }
        }
      }
      peaks.on('zoomview.update', onZ)
      return () => {
        peaks.off('zoomview.update', onZ)
      }
    }, [cutSelection, peaksReady, updateCutDeleteBarLayout])

    const waveformPortal =
      portalHost &&
      createPortal(
        <div className="subtitle-waveform-flow-root relative w-full min-w-0">
          <div className="subtitle-waveform-stack flex w-full min-w-0 flex-col px-0 pb-0 pt-0">
            {activeLineIndex !== null ? (
              <div className="flex w-full items-center gap-2 border-x-0 border-b border-white/[0.08] bg-[#0c1018]/95 px-2 py-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-white/50">
                  통합 편집 — 경계 드래그 · 컷 라인 이동 후 아래 &quot;단어 자르기&quot;로 확정
                </span>
              </div>
            ) : null}
            <div
              ref={waveformZoomOuterRef}
              className="relative isolate h-72 w-full min-w-0 overflow-hidden rounded-lg border-x-0 border-y border-vrew-border bg-[#0c1018]"
            >
              <div
                ref={zoomRef}
                className={`relative z-0 h-72 w-full min-w-0 ${activeWordId !== null ? 'cursor-default' : 'cursor-ew-resize'}`}
              />
              {zoomEndClipPx > 0.5 ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 right-0 z-[5]"
                  style={{
                    width: zoomEndClipPx,
                    backgroundColor: '#0c1018'
                  }}
                />
              ) : null}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-[100] transform-gpu"
                style={{ transform: 'translateZ(0.02px)' }}
              >
                {playheadLinePct != null &&
                (isPlaying || (activeWordId !== null && cutSelection?.kind !== 'marker')) ? (
                  <div
                    className="absolute inset-y-0 w-px bg-yellow-300/95"
                    style={{ left: `${playheadLinePct}%` }}
                  />
                ) : null}
              </div>
              {activeLineIndex !== null &&
              activeWordId !== null &&
              cutSelection?.kind === 'marker' &&
              peaksReady &&
              domCutLineLeftPct != null ? (
                <div data-cut-marker-ui="1" className="pointer-events-none absolute inset-0 z-[110]" aria-hidden>
                  <div
                    className="pointer-events-auto absolute inset-y-0 w-[14px] -translate-x-1/2 cursor-grab touch-none active:cursor-grabbing"
                    style={{ left: `${domCutLineLeftPct}%` }}
                    onPointerDown={onDomCutPointerDown}
                    onLostPointerCapture={onDomCutLostPointerCapture}
                  >
                    <div
                      className="pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 opacity-95"
                      style={{
                        background:
                          'repeating-linear-gradient(to bottom, rgba(34,211,238,0.78) 0px, rgba(34,211,238,0.78) 5px, transparent 5px, transparent 11px)'
                      }}
                    />
                    <div className="absolute bottom-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-cyan-100/95 bg-cyan-500 shadow-md ring-1 ring-cyan-400/55" />
                  </div>
                </div>
              ) : null}
            </div>
            {activeLineIndex !== null && activeWordId !== null && cutSelection?.kind === 'marker' ? (
              <div className="relative w-full min-h-[3.25rem] min-w-0 shrink-0 border-x-0 border-b border-white/[0.08] bg-[#0c1018]/98">
                {markerCutButtonBandLayout ? (
                  <div
                    className="absolute top-0 z-0 flex min-h-[3.25rem] items-center justify-center py-2"
                    style={{
                      left: `${markerCutButtonBandLayout.leftPct}%`,
                      width: `${markerCutButtonBandLayout.widthPct}%`
                    }}
                  >
                    <button
                      type="button"
                      className="pointer-events-auto max-w-full shrink rounded-lg bg-amber-600/95 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-black/30 ring-1 ring-white/25 hover:bg-amber-500"
                      onClick={() => confirmWordCutAtMarker()}
                    >
                      단어 자르기
                    </button>
                  </div>
                ) : (
                  <div className="flex min-h-[3.25rem] items-center justify-center py-2">
                    <button
                      type="button"
                      className="rounded-lg bg-amber-600/95 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-black/30 ring-1 ring-white/25 hover:bg-amber-500"
                      onClick={() => confirmWordCutAtMarker()}
                    >
                      단어 자르기
                    </button>
                  </div>
                )}
              </div>
            ) : null}
            {/**
             * Peaks.init 은 overview 컨테이너에 높이가 있어야 함(h=0 이면 영원히 대기 후 포기).
             * 단어 편집 중에는 보이지 않게만 하고(h 유지) opacity 로 숨긴다.
             */}
            <div
              ref={overviewRef}
              className={`${
                activeLineIndex !== null && activeWordId !== null
                  ? 'h-10 min-h-[2.5rem] pointer-events-none border-y-0 border-x-0 opacity-0'
                  : 'h-24'
              } w-full min-w-0 shrink-0 overflow-hidden rounded-lg border-x-0 border-y border-vrew-border bg-[#0c1018]`}
              aria-hidden={activeLineIndex !== null && activeWordId !== null}
            />
          </div>
        </div>,
        portalHost
      )

    /**
     * 삭제 CTA — body 포털로 overflow 를 피함.
     * 버튼은 전체 파형 중앙이 아니라, CUT 로 고른 시간 구간이 줌뷰에서 차지하는 가로 구간의 중앙 아래에 둔다.
     * 줌 박스 측정 실패 시에만 화면 하단 폴백.
     */
    const cutDeletePortal =
      cutSelection?.kind === 'range' && typeof document !== 'undefined'
        ? createPortal(
            <div
              data-waveform-app-portal="1"
              className="pointer-events-auto flex justify-center px-2"
              style={
                cutDeleteBarLayout
                  ? {
                      position: 'fixed',
                      left: cutDeleteBarLayout.centerX,
                      top: cutDeleteBarLayout.top,
                      transform: 'translateX(-50%)',
                      zIndex: 2147483646
                    }
                  : {
                      position: 'fixed',
                      left: 0,
                      right: 0,
                      bottom: 'max(1.25rem, env(safe-area-inset-bottom, 0px))',
                      zIndex: 2147483646,
                      paddingLeft: 16,
                      paddingRight: 16
                    }
              }
            >
              <button
                type="button"
                className="rounded-lg bg-red-600 px-6 py-2.5 text-sm font-bold text-white shadow-2xl shadow-black/70 ring-2 ring-white/40 hover:bg-red-500"
                onClick={() => confirmPendingCut()}
              >
                선택 구간 삭제
              </button>
            </div>,
            document.body
          )
        : null

    return (
      <>
        <audio ref={dummyAudioRef} preload="auto" className="hidden" controls={false} />
        {waveformPortal}
        {cutDeletePortal}
        <WaveformWordConnector
          activeLineIndex={activeLineIndex}
          peaksRef={peaksRef}
          zoomRef={zoomRef}
          peaksReady={peaksReady}
          overlayVisible={activeLineIndex !== null}
          layoutKey={mountLayoutKey}
        />
      </>
    )
  }
)
