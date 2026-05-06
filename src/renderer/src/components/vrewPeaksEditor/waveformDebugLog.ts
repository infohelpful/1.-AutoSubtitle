/** IPC 직렬화 후에도 로그에 메시지가 남도록 Error·비직렬화 값을 평문 객체로 바꿉니다. */
export function toWaveformLogDetail(u: unknown): unknown {
  if (u instanceof Error) {
    return {
      type: 'Error',
      name: u.name,
      message: u.message,
      stack: u.stack?.slice(0, 2000)
    }
  }
  if (typeof u === 'function') {
    return `[function ${u.name || 'anonymous'}]`
  }
  if (typeof u === 'symbol') {
    return String(u)
  }
  if (typeof u === 'object' && u !== null) {
    try {
      JSON.stringify(u)
      return u
    } catch {
      return String(u)
    }
  }
  return u
}

/**
 * Renderer → main process → `%AppData%/AutoSubtitle/logs/waveform.log` (실제 경로는 앱 이름에 따름).
 * Electron이 아닌 환경에서는 콘솔만 출력합니다.
 */
export function wfLog(scope: string, message: string, ...details: unknown[]): void {
  let normalized: unknown[]
  try {
    normalized = details.map(toWaveformLogDetail)
  } catch (e) {
    normalized = [{ type: 'Error', message: e instanceof Error ? e.message : String(e) }]
  }
  try {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (api?.logWaveformDebug) {
      void api.logWaveformDebug(scope, message, ...normalized)
    }
  } catch {
    /* preload 없음 */
  }
  if (typeof console !== 'undefined' && console.debug) {
    console.debug(`[waveform:${scope}]`, message, ...normalized)
  }
}
