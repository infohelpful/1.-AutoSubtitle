/**
 * React `Maximum update depth exceeded` 폭주 시
 *  - React 가 `console.error(format, ...rest)` 로 넘기는 **컴포넌트 스택(=rest 중 마지막 문자열)** 과
 *  - 우리 쪽에서 잡은 JS 호출 스택
 * 을 함께 `waveform.log` (scope: perf) 에 남긴다.
 *
 * - 콘솔 원본 출력은 그대로(`originalError`) — 기존 디버깅 흐름을 깨지 않음.
 * - 캡처는 4초마다 최대 1회 (디버그용으로 여러 샘플 비교 가능).
 * - 본 진단 자체가 동작에 영향 주지 않도록 모든 경로에 try/catch.
 */
let installed = false

const COOLDOWN_MS = 4_000
let lastCapturedAt = 0

function safePostLog(payload: unknown): void {
  try {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (api?.logWaveformDebug) {
      void api.logWaveformDebug('perf', 'react Maximum update depth — 스택', payload)
    }
  } catch {
    /* preload 없으면 무시 */
  }
}

function pickComponentStack(args: readonly unknown[]): string | null {
  for (let i = args.length - 1; i >= 1; i -= 1) {
    const a = args[i]
    if (typeof a !== 'string') continue
    if (a.includes('\n    at ') || a.includes('\n    in ')) return a
  }
  return null
}

function safeStr(a: unknown): string {
  try {
    if (typeof a === 'string') return a
    if (a == null) return String(a)
    if (typeof a === 'number' || typeof a === 'boolean') return String(a)
    return JSON.stringify(a).slice(0, 500)
  } catch {
    return typeof a
  }
}

export function installReactDepthDiagnostic(): void {
  if (installed) return
  installed = true

  const originalError = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    try {
      const head = typeof args[0] === 'string' ? args[0] : ''
      if (head.includes('Maximum update depth exceeded')) {
        const now = Date.now()
        if (now - lastCapturedAt > COOLDOWN_MS) {
          lastCapturedAt = now
          const capture = new Error('react-depth-diag')
          const componentStack = pickComponentStack(args)
          safePostLog({
            ts: new Date().toISOString(),
            consoleHead: head.slice(0, 600),
            extraArgsPreview: args.slice(1, 6).map((a) => safeStr(a).slice(0, 600)),
            reactComponentStack: componentStack ? componentStack.slice(0, 6000) : null,
            jsCaptureStack: capture.stack?.slice(0, 6000) ?? null
          })
        }
      }
    } catch {
      /* 진단 자체가 절대로 앱 동작을 방해하지 않게 */
    }
    originalError(...args)
  }
}
