/**
 * `timeline.log` 디스크 IPC 비활성화 — 재생·삭제·동기화 루프 호출이 누적되며
 * `%AppData%/.../logs/timeline.log` 를 초당 수 MB로 부풀려 I/O·디스크 부담을 줬다.
 *
 * 호출부 (`timelineEditLog('word-delete', ...)`) 는 그대로 두고 본 함수만 no-op 처리한다.
 * 임시로 다시 켜야 할 때:
 *   - 한 줄 스코프만 보려면 console.debug 한 줄 추가
 *   - 전체 복구는 git 이전 버전 참고 (메인 프로세스 `logTimelineEdit` IPC 핸들러는 그대로 살아 있음)
 */
export function timelineEditLog(_scope: string, _message: string, ..._details: unknown[]): void {
  // intentionally no-op
}
