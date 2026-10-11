import { validateClipPlan, type ProgramClip } from '../shared/clipPlan'

/** Input uses -copyts; subtract the same epoch from both streams. */
export function buildClipGraph(clips: readonly ProgramClip[], duration: number, origin: number, hasAudio: boolean): string {
  const plan = validateClipPlan(clips, duration)
  if (!Number.isFinite(origin)) throw new Error('Invalid source epoch')
  const f = (value: number): string => value.toFixed(9)
  const filters = [`[0:v:0]setpts=PTS-(${f(origin)})/TB,split=${plan.length}${plan.map((_, i) => `[vs${i}]`).join('')}`]
  if (hasAudio) {
    // first_pts inserts leading silence (or drops negative samples); apad retains short-audio tails.
    filters.push(`[0:a:0]asetpts=PTS-(${f(origin)})/TB,aresample=async=1:first_pts=0,apad,atrim=end=${f(duration)},asplit=${plan.length}${plan.map((_, i) => `[as${i}]`).join('')}`)
  }
  for (const [i, clip] of plan.entries()) {
    // Round cumulative boundaries, never each duration: many short clips must not accumulate drift.
    const startFrame = Math.ceil(clip.programStart * 30 - 1e-9)
    const endFrame = Math.ceil((clip.programStart + clip.sourceEnd - clip.sourceStart) * 30 - 1e-9)
    const frames = endFrame - startFrame
    if (frames > 0) {
      filters.push(`[vs${i}]trim=start=${f(clip.sourceStart)}:end=${f(clip.sourceEnd)},setpts=PTS-(${f(clip.sourceStart)})/TB,fps=30,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames},setpts=N/(30*TB)[v${i}]`)
    } else {
      filters.push(`[vs${i}]nullsink`)
    }
    if (hasAudio) filters.push(`[as${i}]atrim=start=${f(clip.sourceStart)}:end=${f(clip.sourceEnd)},asetpts=PTS-(${f(clip.sourceStart)})/TB[a${i}]`)
  }
  const visible = plan.flatMap((clip, i) => Math.ceil((clip.programStart + clip.sourceEnd - clip.sourceStart) * 30 - 1e-9) > Math.ceil(clip.programStart * 30 - 1e-9) ? [`[v${i}]`] : [])
  if (!visible.length) throw new Error('No output video frames')
  filters.push(`${visible.join('')}concat=n=${visible.length}:v=1:a=0[vjoined];[vjoined]setpts=N/(30*TB)[vmain]`)
  // Audio keeps sample precision; concat must not pad every audio clip to a rounded video duration.
  if (hasAudio) filters.push(`${plan.map((_, i) => `[a${i}]`).join('')}concat=n=${plan.length}:v=0:a=1[amain]`)
  return filters.join(';')
}
