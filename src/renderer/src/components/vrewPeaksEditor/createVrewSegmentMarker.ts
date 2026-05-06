import Konva from 'konva'
import type { CreateSegmentMarkerOptions, SegmentMarker } from 'peaks.js'
import { formatVrewTime } from './formatVrewTime'

/**
 * Vrew-style blue edge handles + tooltip time (`MM:SS.mm`).
 * Tooltip follows segment updates during drag via {@link SegmentMarker.update}.
 */
class VrewSegmentMarker implements SegmentMarker {
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

  init(group: Konva.Group): void {
    this.group = group
    const blue = '#3b82f6'
    const stroke = '#1d4ed8'
    /** Peaks 가 draggable:false 로 넘길 때도 구간 경계선은 항상 보여야 함 */
    const showEdgeUi = this.opts.draggable || this.opts.segment?.editable !== false
    const handleW = 10
    const handleH = 22
    const handleX = -handleW / 2 + 0.5

    this.line = new Konva.Line({
      x: 0,
      y: 0,
      points: [0.5, 0, 0.5, 80],
      stroke: blue,
      strokeWidth: 2,
      visible: true
    })

    this.handle = new Konva.Rect({
      x: handleX,
      y: 0,
      width: handleW,
      height: handleH,
      cornerRadius: 4,
      fill: '#4b5563',
      stroke: '#374151',
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
      fill: '#ffffff'
    })

    this.tipBg = new Konva.Rect({
      x: 0,
      y: 0,
      fill: blue,
      stroke,
      strokeWidth: 1,
      cornerRadius: 6,
      opacity: 1
    })

    this.tipGroup = new Konva.Group({ visible: true })
    this.tipGroup.add(this.tipBg)
    this.tipGroup.add(this.tipText)

    group.add(this.line)
    group.add(this.handle)
    group.add(this.tipGroup)

    this.fitTipBoxSize()
    this.fitToView()
    this.bindHandlers()
  }

  private fitTipBoxSize(): void {
    const padX = 10
    const padY = 8
    const tw = this.tipText.width()
    const th = this.tipText.height()
    this.tipBg.width(tw + padX)
    this.tipBg.height(th + padY)
    this.tipText.x(padX / 2)
    this.tipText.y(padY / 2 - 0.5)
  }

  private positionTip(): void {
    const h = this.opts.layer.getHeight()
    const mid = h / 2
    const tipW = this.tipBg.width()
    const offsetX = this.opts.startMarker ? -tipW - 8 : 8
    this.tipGroup.x(offsetX)
    this.tipGroup.y(mid - this.tipGroup.height() - 14)
  }

  private bindHandlers(): void {
    const refreshTip = (): void => {
      this.tipGroup.visible(true)
      this.fitTipBoxSize()
      this.positionTip()
    }

    this.group.on('dragstart', refreshTip)

    this.group.on('dragend', refreshTip)

    this.handle.on('mouseover', refreshTip)
  }

  fitToView(): void {
    const h = this.opts.layer.getHeight()
    const mid = h / 2
    this.handle.y(mid - this.handle.height() / 2)
    this.line.points([0.5, 0, 0.5, h])
    this.fitTipBoxSize()
    this.positionTip()
    this.tipGroup.visible(true)
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
    this.tipGroup.visible(true)

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

export function createVrewSegmentMarker(options: CreateSegmentMarkerOptions): SegmentMarker | null {
  if (options.view !== 'zoomview') return null
  return new VrewSegmentMarker(options)
}
