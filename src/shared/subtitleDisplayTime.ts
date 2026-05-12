/**
 * 자막카드·단어 칩의 **시간 라벨 표시** 정규화 — 데이터(`SubtitleLine.start/end`, `SubtitleWord.start/end`) 는 ASR 원본 그대로 보존하고,
 * UI 에 그릴 때만 "다음 단위의 start 와 50ms 이내로 붙은 작은 갭" 을 흡수해 카드/단어가 연속처럼 보이게 한다.
 *
 * 정책:
 *  - 정규화 방향: **현재 단위의 end 를 다음 단위의 start 로 늘림** (gap 을 이전 단위에 흡수).
 *  - 임계: `DISPLAY_GAP_ABSORB_MS` (기본, 단어↔단어) / `DISPLAY_CROSS_CARD_GAP_ABSORB_MS` (줄↔줄) 이내 양의 갭만 흡수.
 *  - 데이터 무손실: 시각·정렬·seek 등 동작은 모두 원본 `start/end` 기준. 본 함수의 반환값은 `formatTimecode` 등 **표시 전용**.
 */
/** 인접 단어·줄 끝과의 소프트 갭 흡수 (Whisper 프레임 단위 잔차 등) */
export const DISPLAY_GAP_ABSORB_MS = 50

/**
 * 인접 **자막 카드**(문장 줄) 사이 갭 — 문장 경계에 낀 짧은 침묵(70ms 등) 까지 표시상 연속으로 보이게 할 때 사용.
 * 단어 간 50ms 와 별도로 두어, 진짜 긴 무음 구간만 카드 경계로 남긴다.
 */
export const DISPLAY_CROSS_CARD_GAP_ABSORB_MS = 120

/**
 * 표시용 end 시각을 결정한다.
 *
 * @param ownEndSec 현재 단위(단어/문장)의 실제 end (초)
 * @param nextStartSec 다음 단위의 실제 start (초). 다음 단위가 없으면 `null`/`undefined`.
 * @param maxGapMs 양의 갭이 이 값(ms) 이하일 때만 `nextStartSec` 로 흡수
 * @returns 표시에 사용할 end 시각 (초). 흡수 조건 충족 시 `nextStartSec`, 아니면 `ownEndSec`.
 */
export function resolveDisplayEndSec(
  ownEndSec: number,
  nextStartSec: number | null | undefined,
  maxGapMs: number = DISPLAY_GAP_ABSORB_MS
): number {
  if (nextStartSec == null) return ownEndSec
  if (!Number.isFinite(ownEndSec) || !Number.isFinite(nextStartSec)) return ownEndSec
  const gapMs = (nextStartSec - ownEndSec) * 1000
  if (gapMs > 0 && gapMs <= maxGapMs) return nextStartSec
  return ownEndSec
}
