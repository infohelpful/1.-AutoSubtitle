function normalizeDetails(details: readonly unknown[]): unknown[] {
  return details.map((d) => {
    if (typeof d === 'bigint') return d.toString()
    return d
  })
}

/** `userData/logs/timeline.log` — 타임라인 CUT·삭제 구간 등(메인 IPC) */
export function timelineEditLog(scope: string, message: string, ...details: unknown[]): void {
  try {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (api?.logTimelineEdit) {
      void api.logTimelineEdit(scope, message, ...normalizeDetails(details))
    }
  } catch {
    /* ignore */
  }
}
