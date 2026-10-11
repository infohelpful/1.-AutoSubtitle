import type { CutRange } from './ipc'

/** Source times never change when clips are reordered or repeated. */
export type ProgramClip = {
  occurrenceId: string
  sourceStart: number
  sourceEnd: number
  programStart: number
}

export function validateClipPlan(clips: readonly ProgramClip[], sourceDuration: number): ProgramClip[] {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error('Invalid source duration')
  if (!clips.length) throw new Error('No media remains in the clip plan')
  let next = 0
  const ids = new Set<string>()
  return clips.map((clip) => {
    if (!clip.occurrenceId || ids.has(clip.occurrenceId) ||
        !Number.isFinite(clip.sourceStart) || !Number.isFinite(clip.sourceEnd) ||
        !Number.isFinite(clip.programStart) || clip.sourceStart < 0 ||
        clip.sourceEnd > sourceDuration + 1e-6 || clip.sourceEnd <= clip.sourceStart ||
        Math.abs(clip.programStart - next) > 1e-6) throw new Error('Invalid clip plan')
    ids.add(clip.occurrenceId)
    const result = { ...clip, sourceEnd: Math.min(sourceDuration, clip.sourceEnd), programStart: next }
    next += result.sourceEnd - result.sourceStart
    return result
  })
}

export function clipPlanFromCuts(duration: number, cuts: readonly CutRange[]): ProgramClip[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid source duration')
  const ranges = cuts.map((cut) => {
    if (!Number.isFinite(cut.start) || !Number.isFinite(cut.end) || cut.end < cut.start) {
      throw new Error('Invalid cut range')
    }
    return { start: Math.max(0, Math.min(duration, cut.start)), end: Math.max(0, Math.min(duration, cut.end)) }
  }).sort((a, b) => a.start - b.start)
  const result: ProgramClip[] = []
  let cursor = 0
  let programStart = 0
  const append = (start: number, end: number): void => {
    if (end <= start) return
    result.push({ occurrenceId: `clip-${result.length}`, sourceStart: start, sourceEnd: end, programStart })
    programStart += end - start
  }
  for (const cut of ranges) {
    append(cursor, cut.start)
    cursor = Math.max(cursor, cut.end)
  }
  append(cursor, duration)
  return result
}

export function programDuration(clips: readonly ProgramClip[]): number {
  const last = clips[clips.length - 1]
  return last ? last.programStart + last.sourceEnd - last.sourceStart : 0
}

export function mapSourceIntervalToProgram(
  start: number, end: number, clips: readonly ProgramClip[]
): Array<{ start: number; end: number; occurrenceId: string }> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
  return clips.flatMap((clip) => {
    const s = Math.max(start, clip.sourceStart)
    const e = Math.min(end, clip.sourceEnd)
    return e > s ? [{
      start: clip.programStart + s - clip.sourceStart,
      end: clip.programStart + e - clip.sourceStart,
      occurrenceId: clip.occurrenceId
    }] : []
  })
}
