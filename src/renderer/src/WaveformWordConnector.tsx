import { createPortal } from 'react-dom'
import type { MutableRefObject, ReactPortal } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PeaksInstance } from 'peaks.js'
import { wfLog } from './components/vrewPeaksEditor/waveformDebugLog'

/** Canvas 스텁 등 Peaks 없는 경로에서 ref 타입만 맞출 때 사용 */
export type PeaksConnectorLike = PeaksInstance

export type WaveformWordConnectorProps = {
  activeLineIndex: number | null
  peaksRef: MutableRefObject<PeaksInstance | null>
  zoomRef: MutableRefObject<HTMLDivElement | null>
  peaksReady: boolean
  overlayVisible: boolean
  /** overlay·자막 데이터 동기화 시 선 재계산 */
  layoutKey: string
  /**
   * 편집축 줌 창 [start,end] — Peaks zoomview 준비 전에도 단어 경계를 같은 시간→픽셀 식으로 그린다.
   * 칩 DOM 픽셀 폴백과 기준 충돌을 줄이기 위해 부모가 유지한다. null 이면 칩 폴백으로 떨어진다.
   */
  connectorEditZoomRef?: MutableRefObject<{ start: number; end: number } | null>
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

type WordChipDomMeta = { start: number; end: number; wordId: string | null }

/** 칩 DOM 순서대로 — data-word-start/end; data-word-id 로 Peaks 세그먼트와 매칭 */
function listWordChipMetaFromDom(lineIndex: number): WordChipDomMeta[] {
  const out: WordChipDomMeta[] = []
  const prefix = `subtitle-word-${lineIndex}-`
  for (let i = 0; i < 512; i++) {
    const el = document.getElementById(`${prefix}${i}`) as HTMLElement | null
    if (!el) break
    const ds = el.dataset.wordStart
    const de = el.dataset.wordEnd
    if (ds === undefined || de === undefined) continue
    const s = Number(ds)
    const e = Number(de)
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue
    const idRaw = el.dataset.wordId
    out.push({
      start: s,
      end: e,
      wordId: idRaw !== undefined && idRaw !== '' ? idRaw : null
    })
  }
  return out
}

/**
 * 길이 조절 드래그 중에는 칩 DOM 타임스탬프가 아직 반영 안 됨 — Peaks 세그먼트가 진실값.
 * Peaks 준비 상태에서 wordId 에 해당하는 세그먼트가 없으면 그 칩은 ‘유령’(삭제·스티치 직후
 * DOM 미동기) — 옛 좌표로 폴백하면 잘린 무음 위치에 세로선이 남으므로 그 칩 자체를 건너뛴다.
 */
function resolveWordTimesForConnectorLine(
  lineIndex: number,
  peaks: PeaksInstance | null | undefined,
  peaksReady: boolean
): { start: number; end: number }[] {
  const chips = listWordChipMetaFromDom(lineIndex)
  if (!peaksReady || !peaks) {
    return chips.map(({ start, end }) => ({ start, end }))
  }
  const out: { start: number; end: number }[] = []
  for (const { start, end, wordId } of chips) {
    if (wordId == null) {
      out.push({ start, end })
      continue
    }
    const seg = peaks.segments.getSegment(wordId)
    if (!seg) continue
    out.push({ start: seg.startTime, end: seg.endTime })
  }
  return out
}

function subtitleWordRowBottomPx(lineIndex: number): number {
  let maxB = 0
  const prefix = `subtitle-word-${lineIndex}-`
  for (let i = 0; i < 512; i++) {
    const el = document.getElementById(`${prefix}${i}`) as HTMLElement | null
    if (!el) break
    maxB = Math.max(maxB, el.getBoundingClientRect().bottom)
  }
  return maxB
}

/** Peaks 미준비 시에만 칩 픽셀 경계로 세로선 (로딩 폴백) */
function buildSegmentsFromChipRects(activeLineIndex: number, zr: DOMRect): VSegment[] {
  const segs: VSegment[] = []
  const prefix = `subtitle-word-${activeLineIndex}-`
  for (let i = 0; i < 512; i++) {
    const el = document.getElementById(`${prefix}${i}`) as HTMLElement | null
    if (!el) break
    const cr = el.getBoundingClientRect()
    const y1 = zr.top
    const y2 = Math.max(cr.bottom, zr.bottom)
    segs.push({ x: cr.left, y1, y2 })
    segs.push({ x: cr.right, y1, y2 })
  }
  return segs
}

type VSegment = { x: number; y1: number; y2: number }

/**
 * DOM 단어 순서대로만 경계를 만든다. 전역 시간 정렬+큰 eps 는 짧은 무음 두 경계까지 합칠 수 있음.
 * 인접 단어 end 와 다음 start 만 가깝다면 같은 말줄표로 보고 한 시각으로 묶음.
 */
function wordConnectorBoundaryTimes(words: { start: number; end: number }[], edgeEpsSec = 0.02): number[] {
  if (words.length === 0) return []
  const out: number[] = [words[0]!.start]
  for (let i = 0; i < words.length - 1; i++) {
    const end = words[i]!.end
    const nextStart = words[i + 1]!.start
    if (Math.abs(end - nextStart) <= edgeEpsSec) out.push((end + nextStart) / 2)
    else {
      out.push(end, nextStart)
    }
  }
  out.push(words[words.length - 1]!.end)
  const collapsed: number[] = []
  for (const t of out) {
    if (collapsed.length === 0 || Math.abs(t - collapsed[collapsed.length - 1]!) > 1e-5) collapsed.push(t)
  }
  return collapsed
}

/** 칩 사각형 폴백: 오른쪽 끝(i)=왼쪽 끝(i+1) 동일 픽셀 병합 */
function dedupeSegmentsByX(segs: VSegment[]): VSegment[] {
  const map = new Map<number, VSegment>()
  for (const s of segs) {
    const k = Math.round(s.x * 100) / 100
    if (!map.has(k)) map.set(k, s)
  }
  return Array.from(map.values()).sort((a, b) => a.x - b.x)
}

/** float·줌 매핑 후 1px 이내면 눈에 두 줄 — 한 줄로 합치고 높이는 유지 */
function mergeVerticalSegmentsByPixelProximity(segs: VSegment[], minDxPx = 2): VSegment[] {
  if (segs.length <= 1) return segs
  const sorted = [...segs].sort((a, b) => a.x - b.x)
  const out: VSegment[] = []
  let cur = sorted[0]!
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i]!
    if (Math.abs(s.x - cur.x) < minDxPx) {
      cur = {
        x: (cur.x + s.x) / 2,
        y1: Math.min(cur.y1, s.y1),
        y2: Math.max(cur.y2, s.y2)
      }
    } else {
      out.push(cur)
      cur = s
    }
  }
  out.push(cur)
  return out
}

export function WaveformWordConnector({
  activeLineIndex,
  peaksRef,
  zoomRef,
  peaksReady,
  overlayVisible,
  layoutKey,
  connectorEditZoomRef
}: WaveformWordConnectorProps): ReactPortal | null {
  const connectorLogSigRef = useRef<string>('')
  const [wordBoundarySegments, setWordBoundarySegments] = useState<VSegment[]>([])
  const [vp, setVp] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 0,
    h: typeof window !== 'undefined' ? window.innerHeight : 0
  }))

  const refresh = useCallback(() => {
    if (!overlayVisible || activeLineIndex === null) {
      setWordBoundarySegments([])
      return
    }

    const zoomEl = zoomRef.current
    if (!zoomEl) {
      setWordBoundarySegments([])
      return
    }
    const zr = zoomEl.getBoundingClientRect()
    if (zr.width <= 0 || zr.height <= 0) {
      setWordBoundarySegments([])
      return
    }

    const plotLeft = zr.left
    const plotW = zr.width
    const peaks = peaksRef.current
    const words = resolveWordTimesForConnectorLine(activeLineIndex, peaks, peaksReady)
    const r4 = (x: number): number => Math.round(x * 10000) / 10000

    const paintTimeMap = (
      t0: number,
      t1: number,
      logKind: 'edit-axis zoom window' | 'Peaks zoomview'
    ): VSegment[] | null => {
      const span = t1 - t0
      if (!(span > 1e-9) || words.length === 0) return null
      const xAt = (t: number) => plotLeft + ((t - t0) / span) * plotW
      const y1 = zr.top
      const rowBottom = subtitleWordRowBottomPx(activeLineIndex)
      const y2 = Math.max(rowBottom > 0 ? rowBottom : zr.bottom, zr.bottom)
      const segs: VSegment[] = []
      const boundaryTs = wordConnectorBoundaryTimes(words)
      for (const t of boundaryTs) {
        segs.push({
          x: clamp(xAt(t), plotLeft, plotLeft + plotW),
          y1,
          y2
        })
      }
      const sig = `${logKind}|${activeLineIndex}|${words.length}|${boundaryTs.length}|${r4(t0)}|${r4(t1)}|${boundaryTs.map(r4).join(',')}`
      if (sig !== connectorLogSigRef.current) {
        connectorLogSigRef.current = sig
        wfLog('connector', `word boundary vertical lines (${logKind})`, {
          activeLineIndex,
          wordCount: words.length,
          wordTimesFromSegments: words.map((w) => ({
            start: r4(w.start),
            end: r4(w.end)
          })),
          boundaryTimesSec: boundaryTs.map(r4),
          segmentCount: segs.length,
          zoomviewVisibleSec: { start: r4(t0), end: r4(t1), span: r4(span) }
        })
      }
      return mergeVerticalSegmentsByPixelProximity(segs)
    }

    /** 1순위: 부모(편집축) 줌 창 — Peaks 준비 전에도 동일 시간→픽셀 식 */
    const editWin = connectorEditZoomRef?.current ?? null
    if (editWin && editWin.end > editWin.start + 1e-9) {
      const built = paintTimeMap(editWin.start, editWin.end, 'edit-axis zoom window')
      if (built) {
        setWordBoundarySegments(built)
        return
      }
    }

    /** 2순위: Peaks zoomview — 부모 ref 가 아직 비어 있고 Peaks가 준비된 경우 */
    if (peaksReady && words.length > 0) {
      const zv = peaks?.views.getView('zoomview')
      if (zv) {
        const t0 = zv.getStartTime()
        const t1 = zv.getEndTime()
        const built = paintTimeMap(t0, t1, 'Peaks zoomview')
        if (built) {
          setWordBoundarySegments(built)
          return
        }
      }
    }

    /** 3순위: 칩 DOM 픽셀 폴백 — 시간 매핑 둘 다 못 잡힐 때만 */
    const fallbackSegs = mergeVerticalSegmentsByPixelProximity(
      dedupeSegmentsByX(buildSegmentsFromChipRects(activeLineIndex, zr))
    )
    const sigFallback = `chips|${activeLineIndex}|${fallbackSegs.length}|${peaksReady ? '1' : '0'}|${words.length}`
    if (sigFallback !== connectorLogSigRef.current) {
      connectorLogSigRef.current = sigFallback
      wfLog('connector', 'word boundary vertical lines (chip DOM fallback)', {
        activeLineIndex,
        peaksReady,
        wordCountFromResolver: words.length,
        segmentCount: fallbackSegs.length,
        zoomRectPx: {
          left: Math.round(zr.left),
          right: Math.round(zr.right),
          width: Math.round(zr.width)
        }
      })
    }
    setWordBoundarySegments(fallbackSegs)
  }, [overlayVisible, activeLineIndex, peaksReady, peaksRef, zoomRef, connectorEditZoomRef])

  useLayoutEffect(() => {
    refresh()
  }, [refresh, layoutKey])

  useEffect(() => {
    const onWin = (): void => {
      setVp({ w: window.innerWidth, h: window.innerHeight })
      requestAnimationFrame(refresh)
    }
    window.addEventListener('resize', onWin)
    window.addEventListener('scroll', onWin, true)
    onWin()
    return () => {
      window.removeEventListener('resize', onWin)
      window.removeEventListener('scroll', onWin, true)
    }
  }, [refresh])

  useEffect(() => {
    const peaks = peaksRef.current
    if (!peaks || !peaksReady) {
      return
    }
    let rafPending = 0
    const onZ = (): void => {
      if (rafPending) return
      rafPending = requestAnimationFrame(() => {
        rafPending = 0
        refresh()
      })
    }
    /** segments.update 는 연속 다발 — 커넥터만 trailing 48ms 묶음(dragged/zoom 는 기존 rAF 합류) */
    let updateThrottle: ReturnType<typeof setTimeout> | null = null
    const onSegUpdateThrottled = (): void => {
      if (updateThrottle !== null) return
      updateThrottle = window.setTimeout(() => {
        updateThrottle = null
        refresh()
      }, 48)
    }
    peaks.on('zoomview.update', onZ)
    peaks.on('segments.dragend', onZ)
    peaks.on('segments.dragged', onZ)
    peaks.on('segments.dragstart', onZ)
    peaks.on('segments.update', onSegUpdateThrottled)
    return () => {
      if (rafPending) cancelAnimationFrame(rafPending)
      if (updateThrottle !== null) window.clearTimeout(updateThrottle)
      peaks.off('zoomview.update', onZ)
      peaks.off('segments.dragend', onZ)
      peaks.off('segments.dragged', onZ)
      peaks.off('segments.dragstart', onZ)
      peaks.off('segments.update', onSegUpdateThrottled)
    }
  }, [peaksReady, refresh, peaksRef])

  useEffect(() => {
    if (!overlayVisible || activeLineIndex === null) return

    let ro: ResizeObserver | null = null
    const observedChips = new Set<Element>()

    const setup = (): void => {
      const zoomEl = zoomRef.current
      if (!zoomEl) return

      if (!ro) {
        ro = new ResizeObserver(() => requestAnimationFrame(refresh))
      }
      ro.observe(zoomEl)
      for (let i = 0; i < 512; i++) {
        const chip = document.getElementById(`subtitle-word-${activeLineIndex}-${i}`)
        if (!chip) break
        if (!observedChips.has(chip)) {
          ro.observe(chip)
          observedChips.add(chip)
        }
      }
      requestAnimationFrame(refresh)
    }

    setup()

    let attempts = 0
    let raf = 0
    const retry = (): void => {
      const peaks = peaksRef.current
      const times = resolveWordTimesForConnectorLine(activeLineIndex, peaks, peaksReady && !!peaks)
      if (times.length === 0 && attempts < 90) {
        attempts++
        raf = requestAnimationFrame(retry)
        return
      }
      setup()
    }
    raf = requestAnimationFrame(retry)

    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [overlayVisible, activeLineIndex, refresh, zoomRef])

  if (typeof document === 'undefined') return null

  /**
   * 단어 경계 세로선 — 사용자 요청으로 제거.
   * 컴포넌트(레이아웃 계산·이벤트 구독) 자체는 유지하되 SVG 렌더만 비워둔다 (추후 토글로 복귀 가능).
   * `wordBoundarySegments` 계산은 그대로 두어도 paint 부담은 사실상 0.
   */
  void wordBoundarySegments
  return null

  /* legacy SVG (보관용):
  const strokeBoundary = 'rgba(82, 89, 102, 0.92)'

  return createPortal(
    <svg
      className="subtitle-waveform-word-connector pointer-events-none"
      width={vp.w}
      height={vp.h}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        zIndex: 46,
        overflow: 'visible'
      }}
      aria-hidden
    >
      {wordBoundarySegments.map((s, i) => (
        <line
          key={`wb-${i}-${Number.isFinite(s.x) ? s.x.toFixed(1) : i}`}
          x1={s.x}
          y1={s.y1}
          x2={s.x}
          y2={s.y2}
          stroke={strokeBoundary}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>,
    document.body
  )
  */
}
