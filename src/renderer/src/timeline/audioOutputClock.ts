/** AudioContext.currentTime is the render head, ahead of the sound at the device. */
export function audioOutputTime(ctx: AudioContext, wallMs = performance.now()): number {
  const renderTime = ctx.currentTime
  const stamp = ctx.getOutputTimestamp?.()
  if (stamp && Number.isFinite(stamp.contextTime) && Number.isFinite(stamp.performanceTime) &&
      stamp.performanceTime! > 0 && stamp.contextTime! >= 0) {
    const age = (wallMs - stamp.performanceTime!) / 1000
    const time = stamp.contextTime! + age
    if (age >= -.05 && age <= .25 && time >= 0 && time <= renderTime + .01) {
      return Math.min(renderTime, time)
    }
  }
  const latency = [ctx.baseLatency, ctx.outputLatency]
    .reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0)
  return Math.max(0, renderTime - latency)
}

/** Muted video follows audible audio gently between discontinuities. */
export function videoFollowRate(audioSec: number, videoSec: number): number {
  const delta = audioSec - videoSec
  if (!Number.isFinite(delta) || Math.abs(delta) <= .012) return 1
  return 1 + Math.max(-.05, Math.min(.05, delta * .5))
}

/** Keep natural completion alive until the device has played the final samples. */
export function waitForAudioOutput(ctx: AudioContext, end: number, done: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const check = () => {
    if (cancelled) return
    const remaining = end - audioOutputTime(ctx)
    if (remaining <= .001) done()
    else timer = setTimeout(check, Math.max(4, Math.min(50, remaining * 1000)))
  }
  check()
  return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer) }
}
