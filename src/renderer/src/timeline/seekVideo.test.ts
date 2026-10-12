import { expect, it, vi } from 'vitest'
import { seekVideoElementTo } from './seekVideo'

it('waits for the decoded seek even when currentTime already reports the target', async () => {
  vi.useFakeTimers()
  try {
    const video = Object.assign(new EventTarget(), { currentTime: 2, seeking: true })
    let completed = false
    const job = seekVideoElementTo(video as HTMLVideoElement, 2).then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    video.seeking = false
    video.dispatchEvent(new Event('seeked'))
    await job
    expect(completed).toBe(true)
  } finally { vi.useRealTimers() }
})

it('does not seek again when the requested frame is already ready', async () => {
  let assignments = 0
  const video = Object.assign(new EventTarget(), { seeking: false })
  Object.defineProperty(video, 'currentTime', { get: () => 2, set: () => { assignments++ } })
  await seekVideoElementTo(video as HTMLVideoElement, 2)
  expect(assignments).toBe(0)
})

it('rejects a seek that never finishes instead of starting audio against a stuck frame', async () => {
  vi.useFakeTimers()
  try {
    const video = Object.assign(new EventTarget(), { currentTime: 0, seeking: true })
    const assertion = expect(seekVideoElementTo(video as HTMLVideoElement, 2)).rejects.toThrow('탐색')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  } finally { vi.useRealTimers() }
})
