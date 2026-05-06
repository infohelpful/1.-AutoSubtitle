import Konva from 'konva'
import type { CreateSegmentMarkerOptions, SegmentMarker } from 'peaks.js'
import { createVrewSegmentMarker } from './createVrewSegmentMarker'
import { formatVrewTime } from './formatVrewTime'

/** Peaks segments.add(id) — 자르기 미리보기 전용 (DOM 오버레이와 무관하게 캔버스에 유지) */
export const CUT_PREVIEW_SEGMENT_ID = 'temp-cut-segment'

/**
 * CUT 미리보기 구간 가장자리 UI(레거시). 현재는 세그먼트에 markers:false 로 주로 쓰이며,
 * 표시할 때도 흰색 선·시간 팁 없이 주황 계열만 사용.
 */
class CutPreviewEdgeMarker implements SegmentMarker {
  private readonly opts: CreateSegmentMarkerOptions
  private group!: Konva.Group
  private handle!: Konva.Rect
  private line!: Konva.Line
  private tipBg!: Konva.Rect
  private tipText!: Konva.Text
  private tipGroup!: Konva.Group

  constructor(options: CreateSegmentMarkerOptions) {
    this.opts = options
  }

  init(group: object): void {
    this.group = group as Konva.Group
    const stroke = 'rgba(217, 119, 6, 0.88)'
    const fill = 'rgba(251, 191, 36, 0.35)'
    const showEdgeUi = this.opts.draggable || this.opts.segment?.editable !== false
    const handleW = 8
    const handleH = 18
    const handleX = -handleW / 2 + 0.5

    this.line = new Konva.Line({
      x: 0,
      y: 0,
      points: [0.5, 0, 0.5, 80],
      stroke,
      strokeWidth: 2,
      dash: [4, 3],
      visible: true
    })

    this.handle = new Konva.Rect({
      x: handleX,
      y: 0,
      width: handleW,
      height: handleH,
      cornerRadius: 3,
      fill,
      stroke: 'rgba(180, 83, 9, 0.65)',
      strokeWidth: 1,
      visible: showEdgeUi
    })

    const seg = this.opts.segment
    const time = this.opts.startMarker ? seg.startTime : seg.endTime

    this.tipText = new Konva.Text({
      x: 6,
      y: 5,
      text: formatVrewTime(time),
      fontSize: 11,
      fontFamily: this.opts.fontFamily,
      fontStyle: this.opts.fontStyle,
      fill: '#0c1018'
    })

    this.tipBg = new Konva.Rect({
      x: 0,
      y: 0,
      fill: 'rgba(254, 243, 199, 0.95)',
      stroke: 'rgba(217, 119, 6, 0.45)',
      strokeWidth: 1,
      cornerRadius: 5,
      opacity: 1
    })

    this.tipGroup = new Konva.Group({ visible: false })
    this.tipGroup.add(this.tipBg)
    this.tipGroup.add(this.tipText)

    this.group.add(this.line)
    this.group.add(this.handle)
    this.group.add(this.tipGroup)

    this.fitTipBoxSize()
    this.fitToView()
  }

  private fitTipBoxSize(): void {
    const padX = 8
    const padY = 6
    const tw = this.tipText.width()
    const th = this.tipText.height()
    this.tipBg.width(tw + padX)
    this.tipBg.height(th + padY)
    this.tipText.x(padX / 2)
    this.tipText.y(padY / 2 - 0.5)
  }

  private positionTip(): void {
    const h = this.opts.layer.getHeight()
    const tipW = this.tipBg.width()
    const tipH = this.tipBg.height()
    const pad = 6
    const offsetX = this.opts.startMarker ? -tipW - 8 : 8
    this.tipGroup.x(offsetX)
    if (this.opts.startMarker) {
      this.tipGroup.y(pad)
    } else {
      this.tipGroup.y(Math.max(pad, h - tipH - pad))
    }
  }

  fitToView(): void {
    const h = this.opts.layer.getHeight()
    const mid = h / 2
    this.handle.y(mid - this.handle.height() / 2)
    this.line.points([0.5, 0, 0.5, h])
    this.fitTipBoxSize()
    this.positionTip()
    this.tipGroup.visible(false)
  }

  update(options: Partial<{ startTime: number; endTime: number; editable: boolean }>): void {
    const seg = this.opts.segment
    const t = this.opts.startMarker
      ? options.startTime !== undefined
        ? options.startTime
        : seg.startTime
      : options.endTime !== undefined
        ? options.endTime
        : seg.endTime

    this.tipText.text(formatVrewTime(t))
    this.fitTipBoxSize()
    this.positionTip()
    this.tipGroup.visible(false)

    if (options.editable !== undefined) {
      this.handle.visible(options.editable)
    }
  }

  destroy(): void {
    this.group?.off('dragstart')
    this.group?.off('dragend')
    this.handle?.off('mouseover')
  }
}

/** 단어 세그먼트는 Vrew 스타일, CUT 미리보기만 전용 마커 */
export function createWaveformSegmentMarker(options: CreateSegmentMarkerOptions): SegmentMarker | null {
  if (options.view !== 'zoomview') return null
  if (String(options.segment.id) === CUT_PREVIEW_SEGMENT_ID) {
    return new CutPreviewEdgeMarker(options)
  }
  return createVrewSegmentMarker(options)
}
