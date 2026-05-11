import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { VideoSeekUiController, type VideoSeekUiControllerOptions } from './VideoSeekUiController'

export type UseVideoSeekUiParams = VideoSeekUiControllerOptions & {
  videoRef: RefObject<HTMLVideoElement | null>
  mapVirtualMsToRealSec: (virtualMs: number) => number | null
  /** 비디오 엘리먼트가 붙은 뒤 인스턴스 생성 — 예: `videoPath` 또는 `key` */
  attachToken?: unknown
}

function buildControllerOptions(
  p: UseVideoSeekUiParams,
  setSeekingLocked: (v: boolean) => void,
  optimisticVirtualMsRef: MutableRefObject<number | null>
): VideoSeekUiControllerOptions {
  return {
    throttleMs: p.throttleMs ?? 32,
    onSeekingChange: (locked) => {
      setSeekingLocked(locked)
      p.onSeekingChange?.(locked)
    },
    onSnapRealMs: (realMs) => {
      optimisticVirtualMsRef.current = null
      p.onSnapRealMs?.(realMs)
    },
    onOptimisticVirtualMs: (vMs) => {
      optimisticVirtualMsRef.current = vMs
      p.onOptimisticVirtualMs?.(vMs)
    }
  }
}

/**
 * Task 1 — `isSeekingLocked` + 스크럽 낙관적 가상 시각 ref.
 * 콜백은 ref 로 최신 유지 → 컨트롤러 인스턴스는 비디오 노드당 1회.
 */
export function useVideoSeekUi(params: UseVideoSeekUiParams): {
  isSeekingLocked: boolean
  optimisticVirtualMsRef: MutableRefObject<number | null>
  scrubToVirtualMs: (virtualMs: number) => void
  seekRealSecImmediate: (realSec: number) => void
  controllerRef: MutableRefObject<VideoSeekUiController | null>
} {
  const paramsRef = useRef(params)
  paramsRef.current = params

  const [isSeekingLocked, setSeekingLocked] = useState(false)
  const optimisticVirtualMsRef = useRef<number | null>(null)
  const controllerRef = useRef<VideoSeekUiController | null>(null)

  useEffect(() => {
    const el = paramsRef.current.videoRef.current
    if (!el) return
    const c = new VideoSeekUiController(el, buildControllerOptions(paramsRef.current, setSeekingLocked, optimisticVirtualMsRef))
    controllerRef.current = c
    return () => {
      c.dispose()
      controllerRef.current = null
    }
  }, [params.videoRef, params.attachToken])

  useLayoutEffect(() => {
    controllerRef.current?.updateOptions(buildControllerOptions(paramsRef.current, setSeekingLocked, optimisticVirtualMsRef))
  })

  const scrubToVirtualMs = useCallback((virtualMs: number) => {
    controllerRef.current?.scrubVirtualMs(virtualMs, paramsRef.current.mapVirtualMsToRealSec)
  }, [])

  const seekRealSecImmediate = useCallback((realSec: number) => {
    controllerRef.current?.seekRealSecImmediate(realSec)
  }, [])

  return {
    isSeekingLocked,
    optimisticVirtualMsRef,
    scrubToVirtualMs,
    seekRealSecImmediate,
    controllerRef
  }
}
