import type { SubtitleLine } from './subtitles'
import { pickActiveSubtitleIndex } from './subtitlePresentation'

export function setSubtitleVisibility(lines: readonly SubtitleLine[], selected: ReadonlySet<number>, hidden: boolean): SubtitleLine[] {
  return lines.map((line, i) => {
    if (!selected.has(i) || line.isDeleted || !!line.isHidden === hidden) return line
    const next = {...line}
    if (hidden) next.isHidden = true
    else delete next.isHidden
    return next
  })
}
export function subtitlePreviewText(lines: readonly SubtitleLine[], time: number): string {
  const index = pickActiveSubtitleIndex(lines, time)
  const line = index === null ? undefined : lines[index]
  return line && !line.isHidden ? line.text : ''
}
