/**
 * 펼친 줄 파형 패널 — Peaks.js 의존성을 걷어내고 Canvas 구현(`SubtitleWaveformCanvas.tsx`)으로 일원화.
 *
 * 기존 임포트 경로 (`./SubtitleWaveformPeaks`) 와의 호환을 위해 같은 심볼·타입을 re-export 만 한다.
 * - `SubtitleWaveformPeaks`        — `SubtitleWaveformCanvas` 의 forwardRef 컴포넌트 (동일 props·핸들)
 * - `SubtitleWaveformPeaksHandle`  — 동일 핸들 인터페이스
 * - `SubtitleWaveformPeaksProps`   — 동일 props
 * - `PeaksZoomViewRange`           — 줌 창 발행 콜백 시그니처
 *
 * 단어 편집기(`VrewPeaksSubtitleEditor` 등) 는 여전히 `peaks.js` 패키지를 사용한다 — package.json 의 peaks.js 의존성은 유지.
 */
export {
  SubtitleWaveformPeaks,
  type SubtitleWaveformPeaksHandle,
  type SubtitleWaveformPeaksProps,
  type PeaksZoomViewRange
} from './SubtitleWaveformCanvas'
