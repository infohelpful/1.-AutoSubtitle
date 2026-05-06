import Konva from 'konva'
import type { CreatePointMarkerOptions, PointMarker } from 'peaks.js'
import { formatVrewTime } from './formatVrewTime'

/** Must match SubtitleWaveformPeaks CUT first-click point id */
export const CUT_TOOL_POINT_ID = 'autosub-cut-marker'

type LayerWithFormat = { getHeight: () => number; formatTime?: (t: number) => string }

/**
 * CUT 모드 1차 클릭 — 세로선은 주황 계열(흰색 라인 비표시), 시간 라벨은 표시하지 않음.
 */
class CutToolPointMarker implements PointMarker {
  private readonly opts: CreatePointMarkerOptions
  private line!: Konva.Line
  private timeLabel!: Konva.Text
  private labelBg!: Konva.Rect
  private labelGroup!: Konva.Group

  constructor(options: CreatePointMarkerOptions) {
    this.opts = options
  }

  init(group: Konva.Group): void {
    this.line = new Konva.Line({
      x: 0,
      y: 0,
      points: [0.5, 0, 0.5, 80],
      stroke: 'rgba(217, 119, 6, 0.9)',
      strokeWidth: 1.5,
      dash: [5, 4],
      listening: false
    })

    const layer = this.opts.layer as LayerWithFormat
    const fmt =
      typeof layer.formatTime === 'function'
        ? layer.formatTime(this.opts.point.time)
        : formatVrewTime(this.opts.point.time)

    this.timeLabel = new Konva.Text({
      x: 6,
      y: 4,
      text: fmt,
      fontSize: 11,
      fontFamily: this.opts.fontFamily,
      fontStyle: this.opts.fontStyle,
      fill: '#0c1018',
      listening: false
    })

    this.labelBg = new Konva.Rect({
      x: 0,
      y: 0,
      fill: 'rgba(255,255,255,0.92)',
      stroke: 'rgba(255,255,255,0.45)',
      strokeWidth: 1,
      cornerRadius: 5,
      listening: false
    })

    this.labelGroup = new Konva.Group({ listening: false, visible: false })
    this.labelGroup.add(this.labelBg)
    this.labelGroup.add(this.timeLabel)

    group.add(this.line)
    group.add(this.labelGroup)

    this.fitLabelBox()
    this.fitToView()
  }

  private fitLabelBox(): void {
    const padX = 8
    const padY = 5
    const tw = this.timeLabel.width()
    const th = this.timeLabel.height()
    this.labelBg.width(tw + padX)
    this.labelBg.height(th + padY)
    this.timeLabel.x(padX / 2)
    this.timeLabel.y(padY / 2 - 0.5)
  }

  fitToView(): void {
    const h = this.opts.layer.getHeight()
    this.line.points([0.5, 0, 0.5, h])
    const tipW = this.labelBg.width()
    const pad = 6
    this.labelGroup.x(-tipW - 8)
    this.labelGroup.y(pad)
  }

  update(options: Partial<{ time: number }>): void {
    if (options.time !== undefined) {
      const layer = this.opts.layer as LayerWithFormat
      const fmt =
        typeof layer.formatTime === 'function'
          ? layer.formatTime(options.time)
          : formatVrewTime(options.time)
      this.timeLabel.text(fmt)
      this.fitLabelBox()
      this.fitToView()
    }
  }

  destroy(): void {
    this.line?.destroy()
    this.labelGroup?.destroy()
  }
}

export function createCutToolPointMarker(options: CreatePointMarkerOptions): PointMarker | null {
  if (options.view !== 'zoomview') return null
  if (String(options.point.id) !== CUT_TOOL_POINT_ID) return null
  return new CutToolPointMarker(options)
}
