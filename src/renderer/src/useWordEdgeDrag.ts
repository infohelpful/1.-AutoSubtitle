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

  } | null>(null)

  const dragSnapshotRef = useRef<SubtitleLine[] | null>(null)

  const lastResultRef = useRef<EdgeDragResult | null>(null)



  const onMove = useCallback(

    (e: PointerEvent) => {

      const drag = draggingRef.current

      const snap = dragSnapshotRef.current

      if (!drag || drag.pointerId !== e.pointerId || !snap) return

      const sec = opts.secAtClientX(e.clientX)

      const result = applyWordEdgeDrag({

        subtitles: snap,

        target: drag.target,

        edge: drag.edge,

        newSec: sec,

        minWordWidthSec: opts.minWordWidthSec ?? MIN_WORD_DURATION_SEC

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

      if (!cancelled && lastResultRef.current) {

        opts.onCommit(lastResultRef.current)

      }

      lastResultRef.current = null

      opts.onDragFinish?.({ cancelled })

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

      dragSnapshotRef.current = cloneSubtitleLines(opts.getSubtitles())

      draggingRef.current = {

        target,

        edge,

        pointerId: e.pointerId,

        el

      }

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


