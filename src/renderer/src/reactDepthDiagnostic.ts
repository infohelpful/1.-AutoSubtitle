/**
 * 예전에는 React depth 진단 시 파일 로그를 남겼으나 제거됨.
 * main.tsx 호출 호환용으로 빈 설치만 유지합니다.
 */
let installed = false

export function installReactDepthDiagnostic(): void {
  if (installed) return
  installed = true
}
