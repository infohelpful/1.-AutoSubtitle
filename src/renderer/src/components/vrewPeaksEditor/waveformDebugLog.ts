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
 * 디스크(`waveform.log`)에 기록할 scope 화이트리스트 — 오디오·파형 파이프라인만 유지.
 * 외 scope(`seek`/`diag`/`view`/`segments`/`lifecycle`/`playback`/`connector`/`ui` 등)는 호출은 유지하되
 * IPC 송신을 막아 파일 폭증을 차단한다.
 */
const WF_LOG_FILE_SCOPES = new Set<string>(['peaks', 'audio', 'perf'])

/**
 * Renderer → (조건부) main process → `%AppData%/AutoSubtitle/logs/waveform.log`.
 * 콘솔(`console.debug`)은 모든 scope 에 대해 그대로 출력 — 디버깅 가능.
 * 디스크 기록은 `WF_LOG_FILE_SCOPES` 에 속한 scope 만.
 */
export function wfLog(scope: string, message: string, ...details: unknown[]): void {
  let normalized: unknown[]
  try {
    normalized = details.map(toWaveformLogDetail)
  } catch (e) {
    normalized = [{ type: 'Error', message: e instanceof Error ? e.message : String(e) }]
  }
  if (WF_LOG_FILE_SCOPES.has(scope)) {
    try {
      const api = typeof window !== 'undefined' ? window.api : undefined
      if (api?.logWaveformDebug) {
        void api.logWaveformDebug(scope, message, ...normalized)
      }
    } catch {
      /* preload 없음 */
    }
  }
  if (typeof console !== 'undefined' && console.debug) {
    console.debug(`[waveform:${scope}]`, message, ...normalized)
  }
}
