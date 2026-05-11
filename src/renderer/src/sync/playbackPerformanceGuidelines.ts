/**
 * Task 1–3 및 IPC — 성능·품질 가이드(코드 주석·온보딩용 상수 문자열).
 * UI에 그대로 노출하지 말 것.
 */
export const PLAYBACK_PERFORMANCE_GUIDELINES = {
  jumpCutDeadband:
    '점프 직후 video.currentTime 이 블록 경계에 다시 걸리면 무한 점프할 수 있음 — o_start 에 1~2ms(0.001~0.002s) 데드밴드를 더함.',

  audioPopMitigation:
    '전기적 팝을 줄이려면 HTMLAudio/WebAudio 모두 짧은 페이드(5~20ms) 게인 램프를 걸거나, 점프 직전 gain→0→seek→다음 프레임 gain 복구. Web Audio는 GainNode.gain.setTargetAtTime 사용.',

  waveformVirtualViewport:
    '전체 RMS 배열을 그리지 말고 [T_start,T_end] 인덱스만 slice. 재생 중에는 translate 로 스크롤만 이동해 CPU 절약.',

  wordListVirtualization:
    '단어·문장 카드가 많으면 react-window(VariableSizeList) 또는 동일한 오프셋+패딩 패턴으로 뷰포트 밖 DOM 제거.',

  ipcLargePeaks:
    '수십 MB JSON IPC는 메인 프로세스 블로킹 위험 — Float32Array 바이너리(.bin) + ArrayBuffer 로 로드하거나 스트리밍 청크.',

  pythonDownsample:
    '10ms(초당 100샘플) RMS면 1시간 ≈ 360k float — gzip/바이너리 권장.'
} as const
