/**
 * EDL skip 좌표 변환 헬퍼 — viewWin(미디어 축 [start,end]) 안의 *skipRanges* 를 시각적으로 건너뛴
 * **compressed(activeSpan) 좌표계** 와 원본 **미디어 축** 사이의 piecewise-linear 매핑.
 *
 * 정책
 *  - **데이터/재생/SSOT 은 미디어 축 그대로** 유지. 이 모듈은 *오직 strip 의 픽셀↔초 표시 변환만* 담당.
 *  - `playbackSkipRanges` 는 App 단의 `mergedWaveformPeaksStitchCuts` (하드컷 + tombstone + 가상삭제) 를 그대로 받는다.
 *  - viewWin 밖에 있는 skip 은 무시. viewWin 안만 클램프해 누적 컷 길이를 계산.
 *
 * 좌표계
 *  - **mediaSec** : 원본 미디어 축 초 (word.start, line.end, 재생기와 동일)
 *  - **activeSec** : viewWin 안에서 skip 을 건너뛴 누적 활성 시간 — 항상 `[0, activeSpanSec]` 범위
 *  - **pixel** : `wPx` 픽셀폭에 대한 X 좌표. `pixel = (activeSec / activeSpanSec) * wPx`
 *
 * 정합성
 *  - `mediaSecToActiveSec(t)` 는 t 가 skip 안이면 *그 skip 의 시작 시각의 activeSec 으로 클램프* (양쪽 끝 어느쪽이든 동일).
 *    이건 픽셀↔초 round-trip 이 항상 closed 가 되도록 만드는 *clip to nearest active* 정의.
 *  - 따라서 `activeSecToMediaSec(mediaSecToActiveSec(t))` 는 t 가 활성이면 t, skip 안이면 skip.start 를 반환.
 */
export type EdlSkipRange = { start: number; end: number }

export type EdlSkipMapping = {
  /** 원래 viewWin (미디어 축) — 변환 정의역의 외곽 */
  readonly winStart: number
  readonly winEnd: number
  /** winStart..winEnd 안으로 클램프 + 정규화된 skip 리스트 (start 오름차순, 비겹침, 0-length 제거) */
  readonly skipsClipped: ReadonlyArray<EdlSkipRange>
  /** (winEnd - winStart) - Σ skipsClipped — 표시상 strip 이 실제로 차지하는 시간폭 */
  readonly activeSpanSec: number
  /** viewSpan 전체 (= winEnd - winStart) — 호출부 호환용 */
  readonly viewSpanSec: number
  /**
   * media 축 시각 `t` (초) → strip 안의 activeSec.
   *  - t ≤ winStart        →  0
   *  - t ≥ winEnd          →  activeSpanSec
   *  - t 가 skip 안에 있으면 → 그 skip 의 *시작 시각* 에 대한 activeSec (양 끝 어디든 같은 값)
   *  - 그 외               →  winStart 부터 t 까지의 활성 시간 누적
   */
  mediaSecToActiveSec(t: number): number
  /**
   * strip 안의 activeSec → media 축 시각.
   *  - 0 ≤ a ≤ activeSpanSec
   *  - skip 경계는 *skip.end 쪽* 으로 통과 — 즉 skip 의 시작 activeSec 와 다음 활성 구간의 시작 activeSec 이 같은 픽셀이면
   *    그 픽셀은 skip 의 다음 활성 시작 mediaSec 을 가리킨다 (시각적으로 "이어붙은" 첫 픽셀).
   */
  activeSecToMediaSec(a: number): number
  /** activeSec → 픽셀 (`wPx` 폭 기준). activeSpanSec 0 인 경우 항상 0 */
  activeSecToPixel(a: number, wPx: number): number
  /** 픽셀 → activeSec (`wPx` 폭 기준). wPx ≤ 0 인 경우 항상 0 */
  pixelToActiveSec(x: number, wPx: number): number
  /** media 축 시각 → 픽셀 (합성 — 둘을 합친 편의 함수) */
  mediaSecToPixel(t: number, wPx: number): number
  /** 픽셀 → media 축 시각 (합성) */
  pixelToMediaSec(x: number, wPx: number): number
}

function normalizeSkips(
  raw: ReadonlyArray<EdlSkipRange>,
  winStart: number,
  winEnd: number
): EdlSkipRange[] {
  const out: EdlSkipRange[] = []
  for (const r of raw) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) continue
    const a = Math.max(winStart, Math.min(r.start, r.end))
    const b = Math.min(winEnd, Math.max(r.start, r.end))
    if (b > a + 1e-9) out.push({ start: a, end: b })
  }
  out.sort((p, q) => p.start - q.start)
  const merged: EdlSkipRange[] = []
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + 1e-9) {
      last.end = Math.max(last.end, r.end)
    } else {
      merged.push({ start: r.start, end: r.end })
    }
  }
  return merged
}

export function buildEdlSkipMapping(
  viewWin: { start: number; end: number },
  skips: ReadonlyArray<EdlSkipRange>
): EdlSkipMapping {
  const winStart = Math.min(viewWin.start, viewWin.end)
  const winEnd = Math.max(viewWin.start, viewWin.end)
  const viewSpanSec = Math.max(0, winEnd - winStart)
  const skipsClipped = normalizeSkips(skips, winStart, winEnd)

  let totalSkipSec = 0
  for (const r of skipsClipped) totalSkipSec += r.end - r.start
  const activeSpanSec = Math.max(0, viewSpanSec - totalSkipSec)

  /**
   * **media → active** — `winStart` 부터 t 까지의 활성 시간을 직접 누적.
   *  - t 가 skip 안이면 그 skip 의 시작에서 클램프 (= skip 시작 시각의 activeSec)
   *  - viewWin 안 skip 은 보통 0~2 개라 선형 스캔이 가장 단순/빠름
   */
  function mediaSecToActiveSec(t: number): number {
    if (activeSpanSec <= 0) return 0
    if (!Number.isFinite(t)) return 0
    if (t <= winStart) return 0
    if (t >= winEnd) return activeSpanSec
    let active = 0
    let cursor = winStart
    for (const s of skipsClipped) {
      if (t < s.start) {
        return active + (t - cursor)
      }
      if (t <= s.end) {
        // skip 내부 → 시작 시각으로 클램프
        return active + (s.start - cursor)
      }
      active += s.start - cursor
      cursor = s.end
    }
    return active + (t - cursor)
  }

  /**
   * **active → media** — `a` 만큼의 활성 시간을 소비하면서 cursor 를 전진.
   *  - 활성 구간 길이를 정확히 다 쓰는 시점(`remaining === segLen`)에서는 **skip 의 끝**(다음 활성 시작) 으로 통과
   *    → 픽셀 N 의 시각이 "skip 직후 첫 미디어 시각" 이 되어 시각적으로 자연스럽게 이어붙음.
   */
  function activeSecToMediaSec(a: number): number {
    if (activeSpanSec <= 0) return winStart
    if (!Number.isFinite(a)) return winStart
    if (a <= 0) return winStart
    if (a >= activeSpanSec) return winEnd
    let cursor = winStart
    let remaining = a
    for (const s of skipsClipped) {
      const segLen = Math.max(0, s.start - cursor)
      if (remaining < segLen) {
        return cursor + remaining
      }
      if (remaining === segLen) {
        // 경계 위 — skip.end 로 통과 (이어붙은 첫 픽셀)
        return s.end
      }
      remaining -= segLen
      cursor = s.end
    }
    return cursor + remaining
  }

  function activeSecToPixel(a: number, wPx: number): number {
    if (wPx <= 0 || activeSpanSec <= 0) return 0
    const ratio = Math.max(0, Math.min(1, a / activeSpanSec))
    return ratio * wPx
  }

  function pixelToActiveSec(x: number, wPx: number): number {
    if (wPx <= 0 || activeSpanSec <= 0) return 0
    const ratio = Math.max(0, Math.min(1, x / wPx))
    return ratio * activeSpanSec
  }

  function mediaSecToPixel(t: number, wPx: number): number {
    return activeSecToPixel(mediaSecToActiveSec(t), wPx)
  }

  function pixelToMediaSec(x: number, wPx: number): number {
    return activeSecToMediaSec(pixelToActiveSec(x, wPx))
  }

  return {
    winStart,
    winEnd,
    skipsClipped,
    activeSpanSec,
    viewSpanSec,
    mediaSecToActiveSec,
    activeSecToMediaSec,
    activeSecToPixel,
    pixelToActiveSec,
    mediaSecToPixel,
    pixelToMediaSec
  }
}
