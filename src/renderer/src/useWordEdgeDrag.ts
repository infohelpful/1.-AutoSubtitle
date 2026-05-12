/**

 * 파형(또는 단어 칩) 위 단어 블록 좌·우 엣지를 드래그해 시간 영역을 조절하는 React 훅.

 *

 * 사용처 측이 결정해 주입하는 것:

 *  - `secAtClientX(clientX)` : 마우스 좌표(px) → 편집 축 시각(초). 줌·스크롤 상태를 반영해야 함.

 *  - `onCommit(next)` : 드래그 종료 시 새 `subtitles` 를 부모 상태에 반영.

 *  - (선택) `onPreview(next)` : 드래그 중 실시간 미리보기. 안 넘기면 매 프레임 `onCommit` 호출하지 않고 마우스업 시 한 번만 적용.

 *

 * 드래그 중에는 **시작 시점 스냅샷** 에 대해 매번 `applyWordEdgeDrag` 를 돌린다.

 * (매 프레임 SSOT 를 갱신하면 다음 이동이 이미 부분 병합된 상태를 기준으로 계산되어 깨진다.)

 */

import { useCallback, useRef } from 'react'



import type { SubtitleLine } from '../../shared/subtitles'

import {

  applyWordEdgeDrag,

  MIN_WORD_DURATION_SEC,

  type EdgeDragResult,

  type WordEdge,

  type WordRef

} from '../../shared/subtitleWordEdgeDrag'

import { wfLog } from './components/vrewPeaksEditor/waveformDebugLog'



function cloneSubtitleLines(lines: readonly SubtitleLine[]): SubtitleLine[] {

  return lines.map((line) => ({

    ...line,

    words: line.words?.map((w) => ({ ...w }))

  }))

}



export type WordEdgeDragHandlers = {

  /** 단어 칩(또는 트림 노브) `onPointerDown` 에 그대로 연결 */

  startDrag: (e: React.PointerEvent, target: WordRef, edge: WordEdge) => void

  /** 현재 드래그 중인 단어 참조 (UI 강조용) — 드래그 중이 아니면 `null` */

  isDragging: () => boolean

}



export type UseWordEdgeDragOptions = {

  /** 현재 `subtitles` SSOT 의 즉시값을 돌려주는 getter — `useRef.current` 패턴 권장 */

  getSubtitles: () => readonly SubtitleLine[]

  /**

   * 클라이언트 X → `SubtitleWord.start/end` 와 동일 축(미디어 초).

   * 편집 축 파형이면 `mapEditToMediaSec(pointerToTimeOnStrip(x))` 형태로 조합한다.

   */

  secAtClientX: (clientX: number) => number

  /** 드래그 중 실시간 결과 미리보기. 미지정 시 commit 만 발생. */

  onPreview?: (result: EdgeDragResult) => void

  /** 드래그 종료(commit) — 부모 상태 업데이트 진입점 */

  onCommit: (result: EdgeDragResult) => void

  /** 포인터 업/캔슬 후 한 번 — UI 하이라이트 해제·미리보기 롤백 등 */

  onDragFinish?: (detail: { cancelled: boolean }) => void

  /** 포인터 캔슬 시 스냅샷으로 되돌림 — 미리보기가 SSOT 를 건드렸을 때 */

  onDragRevert?: (snapshot: SubtitleLine[]) => void

  /** 단어 최소 폭 (초). 기본 `MIN_WORD_DURATION_SEC`. */

  minWordWidthSec?: number

}



export function useWordEdgeDrag(opts: UseWordEdgeDragOptions): WordEdgeDragHandlers {

  const draggingRef = useRef<{

    target: WordRef

    edge: WordEdge

    pointerId: number

    el: Element | null

    /** pointerdown 시점의 클릭 sec — anchor + delta 계산용 */

    clickSec: number

    /** pointerdown 시점의 target edge sec (target.start 또는 target.end) — delta 적용 baseline */

    anchorEdgeSec: number

    /** 첫 pointermove 가 임계치(`MOVE_DEAD_ZONE_PX`)를 넘은 이후 true — 그 전까진 edge 를 절대 안 움직임 */

    moveStarted: boolean

    /** clientX dead zone 비교용 */

    clickClientX: number

    /** 가장 멀리 떨어진 픽셀 거리 — commit 시 의도가 아닌 클릭이면 commit 자체를 차단 */

    maxClientXDelta: number

    /** target.start / target.end (pointerdown 시점) */

    snapStartSec: number

    snapEndSec: number

    /** 마지막 onMove 에서 계산한 newSec — finish 시 commitMode=true 로 한 번 더 호출 */

    lastSec: number | null

  } | null>(null)

  const dragSnapshotRef = useRef<SubtitleLine[] | null>(null)

  const lastResultRef = useRef<EdgeDragResult | null>(null)



  /**

   * 클릭 박스(트림 핸들 ~32px) 안에서의 미세 드리프트가 newSec 로 새지 않게 픽셀 dead zone.

   *  - 4 px 면 사용자가 클릭만 하고 마우스를 미세하게 떨어도 핸들이 절대 안 움직임.

   *  - 의도적인 드래그(8~12 px 이상)는 그대로 통과.

   */

  const MOVE_DEAD_ZONE_PX = 4



  /**

   * commit 임계치 — pointerdown 부터 pointerup 까지 한 번도 이 픽셀 거리를 넘은 적이 없으면

   * 의도가 없는 클릭으로 보고 commit 자체를 차단한다. trim 핸들이 “찰칵” 한 번 눌렸다고

   * 단어 폭이 자동으로 변경되어 오른쪽 끝으로 쓸려가는 사고를 막는 1차 안전망.

   */

  const COMMIT_MIN_PX = 6



  const onMove = useCallback(

    (e: PointerEvent) => {

      const drag = draggingRef.current

      const snap = dragSnapshotRef.current

      if (!drag || drag.pointerId !== e.pointerId || !snap) return

      const dx = e.clientX - drag.clickClientX

      if (Math.abs(dx) > drag.maxClientXDelta) drag.maxClientXDelta = Math.abs(dx)

      // 클릭 직후 dead zone 안의 sub-pixel 떨림은 무시 — 클릭 박스 가장자리를 찍어도 핸들이 즉시 점프하지 않음.

      if (!drag.moveStarted) {

        if (Math.abs(dx) < MOVE_DEAD_ZONE_PX) return

        drag.moveStarted = true

      }

      const curSec = opts.secAtClientX(e.clientX)

      const delta = curSec - drag.clickSec

      // anchor + delta — 클릭 박스 내부 어디를 찍었든 첫 commit 위치는 target edge 그대로,

      // 사용자가 이동한 거리만큼만 정확히 반영. 이전엔 절대 newSec 을 그대로 썼기 때문에

      // 핸들 클릭 박스 안 살짝 오른쪽을 찍으면 곧바로 Shrink 분기로 들어가 `ownEnd - minWidth`

      // 까지 단어가 쓸려 오른쪽 끝으로 점프하는 버그가 있었다.

      const sec = drag.anchorEdgeSec + delta

      drag.lastSec = sec

      /**
       * preview — commitMode=false : 이웃 텍스트는 절대 안 바뀜. target 의 edge 만 움직이고
       * 침범된 이웃은 시간만 줄어듦. 흡수는 finish 의 commit 호출에서만 발생.
       */

      const result = applyWordEdgeDrag({

        subtitles: snap,

        target: drag.target,

        edge: drag.edge,

        newSec: sec,

        minWordWidthSec: opts.minWordWidthSec ?? MIN_WORD_DURATION_SEC,

        commitMode: false

      })

      lastResultRef.current = result

      opts.onPreview?.(result)

    },

    [opts]

  )



  const finish = useCallback(

    (cancelled: boolean) => {

      const drag = draggingRef.current

      const snap = dragSnapshotRef.current

      draggingRef.current = null

      dragSnapshotRef.current = null

      window.removeEventListener('pointermove', onMove)

      window.removeEventListener('pointerup', onUp)

      window.removeEventListener('pointercancel', onCancel)

      if (drag?.el && 'releasePointerCapture' in drag.el) {

        try {

          ;(drag.el as Element & { releasePointerCapture: (id: number) => void }).releasePointerCapture(

            drag.pointerId

          )

        } catch {

          /* ignore */

        }

      }

      if (cancelled && snap && opts.onDragRevert) {

        opts.onDragRevert(cloneSubtitleLines(snap))

      }

      /**

       * commit 차단 1차: 사용자가 한 번도 `COMMIT_MIN_PX` 이상 이동한 적이 없으면 의도가 없는 클릭으로

       * 보고 commit 자체를 막는다. 핸들이 “찰칵” 클릭됐을 뿐인데 word 가 오른쪽 끝으로 쓸려가는 사고를

       * 막는 안전망 — 단어 폭이 좁아 1~2 px 만 흘려도 ownEnd-minWidth 까지 갈 수 있기 때문.

       */

      const shouldCommit =

        !cancelled && drag != null && drag.maxClientXDelta >= COMMIT_MIN_PX && lastResultRef.current != null

      wfLog('peaks', 'useWordEdgeDrag finish', {

        cancelled,

        moveStarted: drag?.moveStarted ?? false,

        maxClientXDelta: drag?.maxClientXDelta ?? 0,

        deadZonePx: MOVE_DEAD_ZONE_PX,

        commitMinPx: COMMIT_MIN_PX,

        clickClientX: drag?.clickClientX ?? null,

        clickSec: drag?.clickSec ?? null,

        anchorEdgeSec: drag?.anchorEdgeSec ?? null,

        snapStartSec: drag?.snapStartSec ?? null,

        snapEndSec: drag?.snapEndSec ?? null,

        edge: drag?.edge ?? null,

        target: drag?.target ?? null,

        committed: shouldCommit,

        hadLastResult: lastResultRef.current != null

      })

      if (shouldCommit && drag != null && drag.lastSec != null && snap) {

        /**
         * commit 단계 — 마지막 newSec 로 commitMode=true 호출. 이때만 끝점 흡수가 일어난다.
         * preview 결과를 그대로 commit 하지 않는 이유: preview 는 isDeleted 변경을 하지 않으므로
         * 핸들이 prev.start 까지 끌려가 있어도 tombstone 이 안 들어가 있다.
         */

        const commitResult = applyWordEdgeDrag({

          subtitles: snap,

          target: drag.target,

          edge: drag.edge,

          newSec: drag.lastSec,

          minWordWidthSec: opts.minWordWidthSec ?? MIN_WORD_DURATION_SEC,

          commitMode: true

        })

        opts.onCommit(commitResult)

      } else if (!cancelled && !shouldCommit && snap && opts.onDragRevert) {

        // commit 차단 시 미리보기로 흘린 SSOT/editRange 를 깔끔히 되돌린다 (preview 가 SSOT 를 안 건드린 현재 구현에선

        // editRange 만 영향) — onDragFinish 가 cancelled=true 일 때 처리하는 흐름과 동일하게 맞춰 둔다.

        opts.onDragRevert(cloneSubtitleLines(snap))

      }

      lastResultRef.current = null

      opts.onDragFinish?.({ cancelled: cancelled || !shouldCommit })

    },

    [onMove, opts]

  )



  /** 핸들러 정체성 안정화를 위해 ref 로 우회 — finish 가 onMove 를 참조하지만 onMove 도 의존성을 가짐 */

  function onUp(e: PointerEvent): void {

    if (draggingRef.current?.pointerId !== e.pointerId) return

    finish(false)

  }

  function onCancel(e: PointerEvent): void {

    if (draggingRef.current?.pointerId !== e.pointerId) return

    finish(true)

  }



  const startDrag = useCallback(

    (e: React.PointerEvent, target: WordRef, edge: WordEdge) => {

      if (draggingRef.current) return

      e.preventDefault()

      e.stopPropagation()

      const el = e.currentTarget

      const snap = cloneSubtitleLines(opts.getSubtitles())

      dragSnapshotRef.current = snap

      const wRef = snap[target.lineIndex]?.words?.[target.wordIndex]

      const snapStartSec = wRef ? Math.min(wRef.start, wRef.end) : 0

      const snapEndSec = wRef ? Math.max(wRef.start, wRef.end) : 0

      const anchorEdgeSec = edge === 'start' ? snapStartSec : snapEndSec

      const clickSec = opts.secAtClientX(e.clientX)

      draggingRef.current = {

        target,

        edge,

        pointerId: e.pointerId,

        el,

        clickSec,

        anchorEdgeSec,

        moveStarted: false,

        clickClientX: e.clientX,

        maxClientXDelta: 0,

        snapStartSec,

        snapEndSec,

        lastSec: null

      }

      wfLog('peaks', 'useWordEdgeDrag startDrag', {

        edge,

        target,

        clickClientX: e.clientX,

        clickSec,

        anchorEdgeSec,

        snapStartSec,

        snapEndSec,

        anchorMinusClick: anchorEdgeSec - clickSec,

        hasWordRef: wRef != null,

        wordText: wRef?.word ?? null

      })

      try {

        if ('setPointerCapture' in el) {

          ;(el as Element & { setPointerCapture: (id: number) => void }).setPointerCapture(e.pointerId)

        }

      } catch {

        /* ignore */

      }

      window.addEventListener('pointermove', onMove)

      window.addEventListener('pointerup', onUp)

      window.addEventListener('pointercancel', onCancel)

    },

    [onMove, opts]

  )



  const isDragging = useCallback(() => draggingRef.current != null, [])



  return { startDrag, isDragging }

}


