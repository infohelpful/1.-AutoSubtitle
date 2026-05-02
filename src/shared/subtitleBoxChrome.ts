/**
 * 프리뷰·내보내기 자막 박스 크롬 동기화.
 * `paddingPct` — 기본 100% 기준으로 좌우·상하 안쪽 여백을 비례 조절(30~150).
 */
export function getSubtitleBoxChromeInline(
  fontSizePx: number,
  paddingPct: number = 100
): {
  padding: string
  lineHeight: number
  borderRadius: number
  border: string
  boxSizing: 'border-box'
} {
  const scale = Math.max(30, Math.min(150, paddingPct)) / 100
  const baseY = Math.max(4, Math.round((fontSizePx * 5) / 16))
  const baseX = Math.max(8, Math.round((fontSizePx * 9.5) / 16))
  const scaledY = Math.round(baseY * scale)
  const scaledX = Math.round(baseX * scale)
  /** 배경 크기 슬라이더를 최소로 해도 글자·외곽선이 사각형 안에 들어가도록 글자 크기 비례 하한 */
  const padY = Math.max(scaledY, Math.ceil(fontSizePx * 0.13))
  const padX = Math.max(scaledX, Math.ceil(fontSizePx * 0.2))
  return {
    padding: `${padY}px ${padX}px`,
    lineHeight: 1.38,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.1)',
    boxSizing: 'border-box'
  }
}
