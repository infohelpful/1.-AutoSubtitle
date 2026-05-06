import type { PeaksInstance } from 'peaks.js'

import { wfLog } from './components/vrewPeaksEditor/waveformDebugLog'

const MIN_PX = 2

/** peaks.js fitToContainer는 컨테이너가 0×0 근처일 때 Konva 단계에서 예외가 나기 쉬움 */
export function safeFitPeaksContainerView(
  peaks: PeaksInstance,
  which: 'zoomview' | 'overview',
  container: HTMLDivElement | null
): void {
  const v = peaks.views.getView(which)
  if (!v) return
  const w = container?.clientWidth ?? 0
  const h = container?.clientHeight ?? 0
  if (!container || w < MIN_PX || h < MIN_PX) {
    /* 접힌 overview 등 — 스킵은 정상이며 IPC 로그 남발만 유발 */
    return
  }
  try {
    v.fitToContainer()
  } catch (e) {
    wfLog('view', 'fitToContainer threw', e)
  }
}
