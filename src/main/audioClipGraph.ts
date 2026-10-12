import { validateClipPlan, type ProgramClip } from '../shared/clipPlan'

/** Input is the prepared 48 kHz PCM on the common video epoch. */
export function buildAudioClipGraph(clips: readonly ProgramClip[], duration: number): string {
  const plan = validateClipPlan(clips, duration)
  const filters = [`[0:a:0]asplit=${plan.length}${plan.map((_, i) => `[src${i}]`).join('')}`]
  for (const [i, clip] of plan.entries()) {
    filters.push(`[src${i}]atrim=start_sample=${Math.round(clip.sourceStart * 48000)}:end_sample=${Math.round(clip.sourceEnd * 48000)},asetpts=PTS-STARTPTS[a${i}]`)
  }
  filters.push(`${plan.map((_, i) => `[a${i}]`).join('')}concat=n=${plan.length}:v=0:a=1[aout]`)
  return filters.join(';')
}
