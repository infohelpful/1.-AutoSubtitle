import { afterEach, expect, it, vi } from 'vitest'
import { audioOutputTime, waitForAudioOutput, videoFollowRate } from './audioOutputClock'

afterEach(() => vi.useRealTimers())
it('converges small video drift without changing audio speed or seeking', () => {
  let video = 300.08
  for (let frame = 0; frame < 240; frame++) {
    const audio = 300 + frame / 60
    video += videoFollowRate(audio, video) / 60
  }
  expect(Math.abs(video - 304)).toBeLessThan(.015)
  expect(videoFollowRate(10, 9)).toBe(1.05)
  expect(videoFollowRate(9, 10)).toBe(.95)
  expect(videoFollowRate(10, 10.005)).toBe(1)
})
it('uses the device timestamp with wall-clock interpolation, not the render head', () => {
  const ctx = {currentTime: 301, getOutputTimestamp: () => ({contextTime: 300.9, performanceTime: 1000})} as AudioContext
  expect(audioOutputTime(ctx, 1020)).toBeCloseTo(300.92)
})
it('falls back to reported latency for missing, stale and startup timestamps', () => {
  const ctx = {currentTime: 301, baseLatency: .01, outputLatency: .07,
    getOutputTimestamp: () => ({contextTime: 0, performanceTime: 0})} as AudioContext
  expect(audioOutputTime(ctx, 1000)).toBeCloseTo(300.92)
  ctx.getOutputTimestamp = () => ({contextTime: 300, performanceTime: 100})
  expect(audioOutputTime(ctx, 1000)).toBeCloseTo(300.92)
})
it('finishes only after the last samples reach the device and supports cancellation', async () => {
  vi.useFakeTimers()
  const state = {currentTime: 1, outputLatency: .08}
  const ctx = state as AudioContext
  const done = vi.fn()
  const cancel = waitForAudioOutput(ctx, 1, done)
  await vi.advanceTimersByTimeAsync(50)
  expect(done).not.toHaveBeenCalled()
  state.currentTime = 1.08
  await vi.advanceTimersByTimeAsync(50)
  expect(done).toHaveBeenCalledOnce()
  cancel()
  const other = vi.fn()
  const stop = waitForAudioOutput(ctx, 2, other)
  stop()
  state.currentTime = 3
  await vi.advanceTimersByTimeAsync(100)
  expect(other).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
