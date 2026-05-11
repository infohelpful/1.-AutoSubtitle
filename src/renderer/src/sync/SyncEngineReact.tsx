import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode
} from 'react'
import { SyncEngine, type SyncEngineOptions, type SyncTickContext } from './SyncEngine'
import type { VirtualBlockMs } from './blockMapping'

export type SyncEngineContextValue = {
  seekVirtualMs: (virtualMs: number) => void
}

const SyncEngineCtx = createContext<SyncEngineContextValue | null>(null)

export type SyncEngineProviderProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>
  blocks: VirtualBlockMs[]
  children: ReactNode
  onTick?: (ctx: SyncTickContext) => void
  onSeekSnap?: (ctx: SyncTickContext) => void
} & Pick<SyncEngineOptions, 'jumpCutEnabled' | 'suppressTickWhileVideoSeeking' | 'jumpCutTailMs'>

/**
 * 비디오 엘리먼트가 마운트된 뒤 한 번 SyncEngine 을 붙인다.
 * `blocks` 가 바뀌면 엔진을 재생성하지 않고 `setBlocks` 만 호출한다.
 *
 * 성능: 보이지 않는 파형/단어는 react-window 등으로 viewport 밖 행을 렌더하지 않고,
 * `onTick` 에서 `virtualTimeMs` 만 받아 목록은 고정 행 높이 × 스크롤 오프셋으로 슬라이스한다.
 * 파형은 미리 추출한 피크 JSON(RMS 등)만 두고, 화면 너비에 해당하는 샘플 구간만 Canvas 에 그린다.
 */
export function SyncEngineProvider(props: SyncEngineProviderProps): ReactElement {
  const {
    videoRef,
    blocks,
    children,
    onTick,
    onSeekSnap,
    jumpCutEnabled,
    suppressTickWhileVideoSeeking,
    jumpCutTailMs
  } = props

  const engineRef = useRef<SyncEngine | null>(null)
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks

  const stableOnTick = useCallback(
    (ctx: SyncTickContext) => {
      onTick?.(ctx)
    },
    [onTick]
  )

  const stableOnSeekSnap = useCallback(
    (ctx: SyncTickContext) => {
      onSeekSnap?.(ctx)
    },
    [onSeekSnap]
  )

  useEffect(() => {
    const el = videoRef.current
    if (!el) return

    const engine = new SyncEngine(el, {
      blocks: blocksRef.current,
      onTick: stableOnTick,
      onSeekSnap: stableOnSeekSnap,
      jumpCutEnabled,
      suppressTickWhileVideoSeeking,
      jumpCutTailMs
    })
    engineRef.current = engine
    engine.start()

    return () => {
      engine.dispose()
      engineRef.current = null
    }
  }, [
    videoRef,
    stableOnTick,
    stableOnSeekSnap,
    jumpCutEnabled,
    suppressTickWhileVideoSeeking,
    jumpCutTailMs
  ])

  useEffect(() => {
    engineRef.current?.setBlocks(blocks)
  }, [blocks])

  const seekVirtualMs = useCallback((virtualMs: number) => {
    engineRef.current?.seekVirtualMs(virtualMs)
  }, [])

  const value = useMemo((): SyncEngineContextValue => ({ seekVirtualMs }), [seekVirtualMs])

  return <SyncEngineCtx.Provider value={value}>{children}</SyncEngineCtx.Provider>
}

export function useSyncEngine(): SyncEngineContextValue {
  const v = useContext(SyncEngineCtx)
  if (!v) {
    throw new Error('useSyncEngine must be used within SyncEngineProvider')
  }
  return v
}

/**
 * 예시 — 단어 칩 클릭 시 가상 시작 시각으로 시크:
 *
 * ```tsx
 * function WordChip({ vStartMs }: { vStartMs: number }) {
 *   const { seekVirtualMs } = useSyncEngine()
 *   return (
 *     <button type="button" onClick={() => seekVirtualMs(vStartMs)}>
 *       word
 *     </button>
 *   )
 * }
 * ```
 */
