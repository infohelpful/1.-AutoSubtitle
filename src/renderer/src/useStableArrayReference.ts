import { useRef } from 'react'

/**
 * 두 배열이 element-wise 같으면 `prev`, 아니면 `next` 를 돌려준다. 순수 함수 — hook 외부에서도 테스트 가능.
 */
export function reuseArrayReferenceIfElementsEqual<T>(
  prev: readonly T[],
  next: readonly T[],
  equals: (a: T, b: T) => boolean = Object.is
): readonly T[] {
  if (prev === next) return prev
  if (prev.length !== next.length) return next
  for (let i = 0; i < next.length; i += 1) {
    if (!equals(prev[i]!, next[i]!)) return next
  }
  return prev
}

/**
 * 매 렌더마다 동일 element 들로 새 배열을 만드는 `useMemo` 결과를 안정 reference 로 고정한다.
 *
 * 동기:
 *  - `vrewRows`, `subtitlesForList`, `mergedWaveformPeaksStitchCuts` 등은 안쪽이 캐시 hit 라
 *    원소(`SubtitleLine` / `SubtitleRow` / `CutRange`) reference 는 안정이지만, 바깥 배열은 매번 새로 만들어진다.
 *  - 그 결과 자식 컴포넌트(`SubtitleVirtualList`, `SubtitleWaveformCanvas`) 가 받는 prop 이 항상 새 reference 로 인식돼
 *    `React.memo` 가 skip 할 수 없고, 자식 안의 `useEffect`/`useMemo` deps 가 매번 재발화한다.
 *
 * 사용:
 * ```ts
 * const raw = useMemo(() => subtitles.map(...), [subtitles])
 * const stable = useStableArrayReference(raw, (a, b) => a === b)
 * ```
 *
 * `equals` 가 모든 원소에 대해 true 면 **이전 배열 reference 를 그대로 반환** — 자식 cascade 차단.
 */
export function useStableArrayReference<T>(
  next: readonly T[],
  equals: (a: T, b: T) => boolean = Object.is
): readonly T[] {
  const ref = useRef<readonly T[]>(next)
  const out = reuseArrayReferenceIfElementsEqual(ref.current, next, equals)
  ref.current = out
  return out
}

/**
 * 두 `CutRange[]` 가 의미상 같은지(start/end 가 모두 같은 순서로) 비교 — `useStableArrayReference` 의 `equals` 콜백 용.
 */
export function cutRangeShallowEqual(
  a: { start: number; end: number },
  b: { start: number; end: number }
): boolean {
  return a === b || (a.start === b.start && a.end === b.end)
}
