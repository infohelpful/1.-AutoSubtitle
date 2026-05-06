import { createPortal } from 'react-dom'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import Peaks, { type PeaksInstance, type SegmentOptions } from 'peaks.js'
import { assignFlatWordsToRows } from './assignFlatWordsToRows'
import { applyAdjacentWordMergesToRows } from './wordMerge'
import { createVrewSegmentMarker } from './createVrewSegmentMarker'
import { wordsFromPeaksSegments } from './wordMerge'
import type { SubtitleRow, Word } from './types'
import { createSilentWavBlob } from './silentWav'
import { safeFitPeaksContainerView } from '../../peaksSafeFit'
import { wfLog } from './waveformDebugLog'

function toSegmentOptions(w: Word): SegmentOptions {
  return {
    id: String(w.id),
    startTime: w.start,
    endTime: w.end,
    editable: true,
    labelText: w.text,
    color: 'rgba(59, 130, 246, 0.25)',
    borderColor: 'rgba(59, 130, 246, 0.6)',
    markers: true,
    overlay: true
  }
}

function flattenWords(rows: SubtitleRow[]): Word[] {
  return rows.flatMap((r) => r.words).sort((a, b) => a.start - b.start)
}

function applyWordsToPeaks(peaks: PeaksInstance, list: Word[]): void {
  peaks.segments.removeAll()
  for (const w of list) {
    peaks.segments.add(toSegmentOptions(w))
  }
}

function lineDisplay(row: SubtitleRow): string {
  if (typeof row.lineText === 'string') return row.lineText
  return row.words.map((w) => w.text).join(' ')
}

/** 줄 편집 시 매 글자마다 onRowsChange → Peaks·부모 전체 리렌더 방지 — blur 시에만 반영 */
const VrewLineTextarea = memo(function VrewLineTextarea({
  rowId,
  committedDisplay,
  onCommitLine
}: {
  rowId: string
  committedDisplay: string
  onCommitLine: (id: string, lineText: string) => void
}): ReactElement {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? committedDisplay

  useEffect(() => {
    if (taRef.current === document.activeElement) {
      setDraft(committedDisplay)
      return
    }
    setDraft(null)
  }, [committedDisplay, rowId])

  return (
    <textarea
      ref={taRef}
      value={value}
      spellCheck={false}
      rows={2}
      className="box-border w-full resize-y rounded-md border border-vrew-border bg-vrew-bg px-3 py-2 text-sm text-vrew-text outline-none ring-vrew-accent/30 placeholder:text-vrew-muted focus:border-vrew-accent focus:ring-2"
      onFocus={() => setDraft(committedDisplay)}
      onBlur={() => {
        const cur = draft !== null ? draft : taRef.current?.value ?? committedDisplay
        if (cur !== committedDisplay) {
          onCommitLine(rowId, cur)
        }
        setDraft(null)
      }}
      onChange={(e) => setDraft(e.target.value)}
    />
  )
})

export type VrewPeaksSubtitleEditorProps = {
  rows: SubtitleRow[]
  onRowsChange: (next: SubtitleRow[]) => void
  /** If omitted, a silent WAV is generated from timeline span of all words. */
  audioUrl?: string
  className?: string
}

/**
 * Vrew-like DOM flow per row: Word blocks → collapsible waveform (grid accordion) → subtitle edit.
 * Single Peaks instance; zoom/overview DOM moves via `createPortal` (waveform shells stay `position: static`).
 */
export function VrewPeaksSubtitleEditor({
  rows,
  onRowsChange,
  audioUrl,
  className
}: VrewPeaksSubtitleEditorProps): ReactElement {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const zoomRef = useRef<HTMLDivElement | null>(null)
  const overviewRef = useRef<HTMLDivElement | null>(null)

  const peaksRef = useRef<PeaksInstance | null>(null)
  const isDraggingRef = useRef(false)
  const rowsRef = useRef(rows)
  const onRowsChangeRef = useRef(onRowsChange)

  const parkingRef = useRef<HTMLDivElement | null>(null)
  const rowWaveMountRef = useRef<Map<string, HTMLDivElement | null>>(new Map())

  const [activeRowId, setActiveRowId] = useState<string | null>(null)
  const [activeWordId, setActiveWordId] = useState<number | null>(null)
  /** Bumps when parking mounts or row waveform mount nodes change so portal target recomputes */
  const [portalRev, setPortalRev] = useState(0)
  /** 포털 타깃은 렌더 중 useMemo(ref 맵)로 계산하면 활성 행 전환 직후 한 프레임 parking에 붙어 파동이 안 보일 수 있음 → 커밋 후 확정 */
  const [portalHostEl, setPortalHostEl] = useState<HTMLElement | null>(null)
  const [hostReady, setHostReady] = useState(false)
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

  const silentDurationSec = useMemo(() => {
    const maxEnd = flatWords.reduce((m, w) => Math.max(m, w.end), 0)
    return Math.max(60, Math.ceil(maxEnd) + 25)
  }, [flatWords])

  const mountLoggedRef = useRef(false)
  useEffect(() => {
    if (mountLoggedRef.current) return
    mountLoggedRef.current = true
    wfLog(
      'lifecycle',
      'VrewPeaksSubtitleEditor mount',
      {
        rowCount: rows.length,
        flatWordCount: flatWords.length,
        silentDurationSec,
        audioUrl: audioUrl ?? '(silent wav)'
      }
    )
    void window.api
      .logWaveformDebug('lifecycle', 'waveform.log 위치는 userData/logs/waveform.log (아래 path 참고)')
      .then((r) => {
        wfLog('lifecycle', 'logPath', r.path)
      })
      .catch(() => {
        wfLog('lifecycle', 'logWaveformDebug IPC unavailable (비 Electron 환경일 수 있음)')
      })
  }, [rows.length, flatWords.length, silentDurationSec, audioUrl])

  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  useEffect(() => {
    onRowsChangeRef.current = onRowsChange
  }, [onRowsChange])

  const commitRowLineText = useCallback((id: string, lineText: string) => {
    const cur = rowsRef.current
    onRowsChangeRef.current(cur.map((r) => (r.id === id ? { ...r, lineText } : r)))
  }, [])

  useLayoutEffect(() => {
    void portalRev
    const parking = parkingRef.current
    if (!parking) {
      setPortalHostEl(null)
      return
    }
    if (!activeRowId) {
      setPortalHostEl(parking)
      return
    }
    const rowMount = rowWaveMountRef.current.get(activeRowId)
    if (rowMount) {
      setPortalHostEl(rowMount)
    } else {
      wfLog('portal', '활성 행 마운트 ref 없음 — parking 폴백 (activeRowId 변경 시 bumpPortal로 재시도)', {
        activeRowId
      })
      setPortalHostEl(parking)
    }
  }, [activeRowId, portalRev, bumpPortal])

  useEffect(() => {
    bumpPortal()
  }, [activeRowId, bumpPortal])

  const lastPortalLogKey = useRef('')
  useEffect(() => {
    const t = portalHostEl
    const key = `${activeRowId ?? ''}|${t === parkingRef.current}|${t?.tagName ?? ''}`
    if (lastPortalLogKey.current === key) return
    lastPortalLogKey.current = key
    wfLog('portal', 'portalHostEl 변경', {
      activeRowId,
      targetTag: t?.tagName ?? null,
      targetClass: t?.className?.slice?.(0, 120) ?? null,
      fromRowMount: activeRowId ? Boolean(rowWaveMountRef.current.get(activeRowId)) : false,
      parkingIsTarget: t === parkingRef.current
    })
  }, [activeRowId, portalHostEl, portalRev])

  useLayoutEffect(() => {
    const ok = Boolean(zoomRef.current && overviewRef.current)
    setHostReady((prev) => (prev === ok ? prev : ok))
    wfLog('host', 'zoom/overview refs', { refsReady: ok })
    // portalRev에 의존하지 않음 — 행마다 bump 시 수백 번 실행되어 hostReady/Peaks effect가 흔들림
  }, [portalHostEl])

  const setParkingRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (parkingRef.current === el) return
      parkingRef.current = el
      bumpPortal()
    },
    [bumpPortal]
  )

  const setRowWaveMount = useCallback(
    (rowId: string, el: HTMLDivElement | null) => {
      const prev = rowWaveMountRef.current.get(rowId) ?? null
      if (prev === el) return
      if (el) rowWaveMountRef.current.set(rowId, el)
      else rowWaveMountRef.current.delete(rowId)
      // 활성 행의 마운트만 포털 타겟에 영향 — 211행 전부 bump 시 portalRev 폭주·Peaks 컨테이너 0크기 레이스 유발
      if (rowId === activeRowId) bumpPortal()
    },
    [activeRowId, bumpPortal]
  )

  const focusWordAtTime = useCallback((word: Word) => {
    const peaks = peaksRef.current
    const zv = peaks?.views.getView('zoomview')
    if (!peaks || !zv) return

    const list = flattenWords(rowsRef.current).sort((a, b) => a.start - b.start)
    const idx = list.findIndex((w) => w.id === word.id)
    const prev = idx > 0 ? list[idx - 1] : undefined
    const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : undefined

    const dur = peaks.player.getDuration()
    const pad = 0.45
    const windowStart = Math.max(0, (prev?.start ?? word.start) - pad)
    const windowEnd = Math.min(Number.isFinite(dur) ? dur : word.end + 5, (next?.end ?? word.end) + pad)
    const seconds = Math.max(1.5, windowEnd - windowStart)

    peaks.player.seek(word.start)
    zv.setStartTime(windowStart)
    zv.setZoom({ seconds })
    wfLog('seek', 'focusWordAtTime', {
      wordId: word.id,
      seekTo: word.start,
      windowStart,
      windowEnd,
      zoomSeconds: seconds,
      duration: dur
    })
  }, [])

  useLayoutEffect(() => {
    const peaks = peaksRef.current
    if (!peaks || !peaksReady || activeWordId === null || activeRowId === null) return
    const row = rowsRef.current.find((r) => r.id === activeRowId)
    const w = row?.words.find((x) => x.id === activeWordId)
    if (w) {
      wfLog('seek', 'layout: seek after peaksReady/activeWord', { rowId: activeRowId, wordId: activeWordId })
      focusWordAtTime(w)
    } else {
      wfLog('seek', 'layout: word not found for seek', { activeRowId, activeWordId })
    }
  }, [activeRowId, activeWordId, focusWordAtTime, peaksReady, rowsSig])

  useLayoutEffect(() => {
    const peaks = peaksRef.current
    if (!peaks || !peaksReady) return
    try {
      safeFitPeaksContainerView(peaks, 'zoomview', zoomRef.current)
      safeFitPeaksContainerView(peaks, 'overview', overviewRef.current)
      wfLog('view', 'fitToContainer after portal/activeRow change')
    } catch (e) {
      wfLog('view', 'fitToContainer error', e)
    }
  }, [activeRowId, peaksReady, portalRev, portalHostEl])

  const peaksInitGenRef = useRef(0)

  useEffect(() => {
    const audio = audioRef.current
    if (!hostReady || !audio) {
      wfLog('peaks', 'Peaks.init 스킵', {
        hostReady,
        hasAudio: Boolean(audio),
        hasZoom: Boolean(zoomRef.current),
        hasOverview: Boolean(overviewRef.current)
      })
      return
    }

    const silentDur = silentDurationSec
    const initGen = ++peaksInitGenRef.current
    let peaksInstance: PeaksInstance | null = null
    let cancelled = false
    let rafWait = 0

    wfLog('peaks', 'Peaks.init 시작', {
      silentDur,
      segmentCount: flattenWords(rowsRef.current).length,
      audioCtxState: audioContextRef.current?.state
    })

    if (!audioUrl) {
      const prev = audio.dataset.blobUrl
      if (prev) URL.revokeObjectURL(prev)
      const blob = createSilentWavBlob(silentDur)
      const url = URL.createObjectURL(blob)
      audio.dataset.blobUrl = url
      audio.src = url
    } else {
      audio.src = audioUrl
    }

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext()
    }

    const initSegments = flattenWords(rowsRef.current).map(toSegmentOptions)

    const onDragStart = (): void => {
      isDraggingRef.current = true
    }

    const onDragEnd = (): void => {
      isDraggingRef.current = false
      const inst = peaksRef.current
      if (!inst) return
      const flat = wordsFromPeaksSegments(inst.segments.getSegments(), flattenWords(rowsRef.current))
      const nextRows = applyAdjacentWordMergesToRows(assignFlatWordsToRows(flat, rowsRef.current))
      onRowsChangeRef.current(nextRows)
    }

    const runPeaksInit = (): void => {
      if (cancelled || initGen !== peaksInitGenRef.current) return
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
      // peaks.js는 clientWidth/clientHeight > 0 만 검사함 (표시 텍스트는 "visible"이지만 실제로는 크기)
      if (
        zoomEl.clientWidth <= 0 ||
        zoomEl.clientHeight <= 0 ||
        ovEl.clientWidth <= 0 ||
        ovEl.clientHeight <= 0
      ) {
        wfLog('peaks', 'Peaks.init 대기 (컨테이너 0크기)', {
          rafWait,
          zw: zoomEl.clientWidth,
          zh: zoomEl.clientHeight,
          ow: ovEl.clientWidth,
          oh: ovEl.clientHeight
        })
        rafWait++
        if (rafWait > 120) {
          wfLog('peaks', 'Peaks.init 포기 — 컨테이너가 계속 0×0')
          return
        }
        requestAnimationFrame(runPeaksInit)
        return
      }

      wfLog('peaks', 'Peaks.init 호출', {
        zw: zoomEl.clientWidth,
        zh: zoomEl.clientHeight,
        ow: ovEl.clientWidth,
        oh: ovEl.clientHeight
      })

      Peaks.init(
        {
          zoomview: {
            container: zoomEl,
            wheelMode: 'scroll',
            showAxisLabels: true
          },
          overview: { container: ovEl },
          mediaElement: audio,
          webAudio: {
            audioContext: audioContextRef.current!
          },
          zoomLevels: [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384],
          segmentOptions: {
            markers: true,
            overlay: true,
            overlayOpacity: 0.22,
            overlayColor: '#3b82f6',
            overlayBorderColor: '#3b82f6',
            overlayBorderWidth: 1,
            overlayCornerRadius: 4,
            waveformColor: '#6b7280',
            startMarkerColor: '#3b82f6',
            endMarkerColor: '#3b82f6'
          },
          createSegmentMarker: createVrewSegmentMarker,
          segments: initSegments
        },
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
            console.error('[VrewPeaksSubtitleEditor] Peaks.init failed', err)
            wfLog('peaks', 'Peaks.init 실패', { err: err?.message ?? String(err), staleGen: false })
            return
          }
          peaksInstance = peaks
          peaksRef.current = peaks

          applyWordsToPeaks(peaks, flattenWords(rowsRef.current))

          const zv = peaks.views.getView('zoomview')
          zv?.setSegmentDragMode('overlap')

          peaks.on('segments.dragstart', onDragStart)
          peaks.on('segments.dragend', onDragEnd)

          const dur = peaks.player.getDuration()
          wfLog('peaks', 'Peaks.init 완료', {
            duration: dur,
            zoomView: Boolean(peaks.views.getView('zoomview')),
            overviewView: Boolean(peaks.views.getView('overview'))
          })

          setPeaksReady(true)
        }
      )
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(runPeaksInit)
    })

    return () => {
      cancelled = true
      peaksInitGenRef.current++
      wfLog('peaks', 'Peaks 인스턴스 destroy (effect cleanup)')
      setPeaksReady(false)
      if (peaksInstance) {
        try {
          peaksInstance.off('segments.dragstart', onDragStart)
          peaksInstance.off('segments.dragend', onDragEnd)
          peaksInstance.destroy()
        } catch {
          /* ignore */
        }
      }
      peaksRef.current = null
      if (audio.dataset.blobUrl) {
        URL.revokeObjectURL(audio.dataset.blobUrl)
        delete audio.dataset.blobUrl
      }
    }
  }, [audioUrl, silentDurationSec, hostReady])

  useEffect(() => {
    const peaks = peaksRef.current
    if (!peaks || !peaksReady || isDraggingRef.current) return
    applyWordsToPeaks(peaks, flatWords)
    wfLog('segments', 'applyWordsToPeaks', { wordCount: flatWords.length })
  }, [wordsSig, flatWords, peaksReady])

  const onWordDoubleClick = useCallback((rowId: string, w: Word) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext()
    }
    void audioContextRef.current.resume().then(
      () => {
        wfLog('audio', 'AudioContext.resume OK', { state: audioContextRef.current?.state })
      },
      () => {
        wfLog('audio', 'AudioContext.resume rejected')
      }
    )
    wfLog('ui', 'word double-click', {
      rowId,
      wordId: w.id,
      start: w.start,
      end: w.end,
      audioCtxState: audioContextRef.current?.state
    })
    setActiveRowId(rowId)
    setActiveWordId(w.id)
  }, [])

  const waveformPortal =
    portalHostEl &&
    createPortal(
      <div className="flex min-h-[152px] w-full min-w-0 flex-col gap-1 px-2 pb-2 pt-1">
        <div
          ref={zoomRef}
          className="h-28 w-full min-w-0 overflow-hidden rounded-lg border border-vrew-border bg-transparent"
        />
        <div
          ref={overviewRef}
          className="h-20 w-full min-w-0 overflow-hidden rounded-lg border border-vrew-border bg-transparent"
        />
      </div>,
      portalHostEl
    )

  return (
    <div
      className={`flex flex-col gap-2 rounded-xl border border-vrew-border bg-vrew-panel p-4 text-vrew-text shadow-lg ${className ?? ''}`}
    >
      <p className="text-sm text-vrew-muted">
        단어를 <strong className="text-vrew-text">더블클릭</strong>하면 해당 행만 파동 영역이 열리고, 아래 자막 입력칸이 밀려 내려갑니다.
      </p>

      {/*
        Peaks는 zoom 컨테이너가 “표시 가능”이고 width/height > 0 이어야 함.
        opacity-0·화면 밖 translate는 init 실패 → 거의 투명 + z 뒤로만 처리.
      */}
      <div
        ref={setParkingRef}
        className="pointer-events-none fixed left-0 top-0 z-[-1] box-border h-[200px] w-[min(100vw,1200px)] max-w-[1200px] overflow-hidden"
        style={{ opacity: 0.02 }}
        aria-hidden
      />

      <audio ref={audioRef} preload="auto" className="hidden" controls={false} crossOrigin="anonymous" />

      <div className="flex flex-col">
        {rows.map((row) => {
          const isOpen = activeRowId === row.id
          return (
            <div
              key={row.id}
              className="flex flex-col border-b border-vrew-border/80 py-2 last:border-b-0"
            >
              {/* 1) Word blocks */}
              <div className="flex flex-wrap gap-2">
                {row.words.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    title={`${w.start.toFixed(2)}s – ${w.end.toFixed(2)}s`}
                    className={`max-w-[140px] truncate rounded-md border px-2.5 py-1.5 text-left text-sm transition ${
                      isOpen && activeWordId === w.id
                        ? 'border-vrew-accent bg-vrew-panel ring-1 ring-vrew-accent'
                        : 'border-vrew-border bg-vrew-bg hover:border-vrew-accent hover:bg-vrew-panel'
                    }`}
                    onDoubleClick={(e) => {
                      e.preventDefault()
                      onWordDoubleClick(row.id, w)
                    }}
                  >
                    {w.text || '…'}
                  </button>
                ))}
              </div>

              {/* 2) Waveform — grid accordion; flow pushes subtitle edit down */}
              <div
                className="grid w-full transition-[grid-template-rows] duration-300 ease-out"
                style={{
                  // minmax: 열린 행에서 빈 1fr만으로 높이 0이 되어 포털/파동이 안 보이는 경우 방지
                  gridTemplateRows: isOpen ? 'minmax(152px, auto)' : '0fr'
                }}
              >
                <div className="min-h-0 overflow-hidden">
                  <div
                    ref={(el) => setRowWaveMount(row.id, el)}
                    className="relative z-10 w-full min-h-[152px] min-w-0 border-t border-vrew-border/40 bg-transparent"
                  />
                </div>
              </div>

              {/* 3) Subtitle edit */}
              <div className="mt-2">
                <VrewLineTextarea rowId={row.id} committedDisplay={lineDisplay(row)} onCommitLine={commitRowLineText} />
              </div>
            </div>
          )
        })}
      </div>

      {waveformPortal}
    </div>
  )
}
