import { describe, expect, it } from 'vitest'
import { createOverlayReadable, ffmpegProgressPercent, framesFromTimedBuffers } from './ffmpeg-single-pass'

describe('FFmpeg progress time units', () => {
  it('reads both legacy ms and us keys as microseconds', () => {
    expect(ffmpegProgressPercent('out_time_ms=2000000', 4)).toBe(50)
    expect(ffmpegProgressPercent('out_time_us=2000000', 4)).toBe(50)
    expect(ffmpegProgressPercent('out_time_us=4000000', 4)).toBe(99)
  })
  it('ignores unavailable and invalid progress', () => {
    expect(ffmpegProgressPercent('out_time_us=N/A', 4)).toBeNull()
    expect(ffmpegProgressPercent('out_time_us=-1', 4)).toBeNull()
    expect(ffmpegProgressPercent('out_time_us=1000', 0)).toBeNull()
  })
})

describe('overlay frame states', () => {
  const frameBytes = 4
  const px = (n: number): Buffer => Buffer.alloc(frameBytes, n)
  const blank = Buffer.alloc(frameBytes, 0)

  async function collect(
    states: ReadonlyArray<{ startFrame: number; endFrame: number; buf: Buffer }>,
    totalFrames: number
  ): Promise<number[]> {
    async function* gen(): AsyncGenerator<{ startFrame: number; endFrame: number; buf: Buffer }> {
      for (const s of states) yield s
    }
    const readable = createOverlayReadable(frameBytes, totalFrames, gen(), blank)
    const out: number[] = []
    for await (const chunk of readable) {
      const buf = chunk as Buffer
      for (let i = 0; i < buf.length; i += frameBytes) out.push(buf[i]!)
    }
    return out
  }

  it('emits one frame per index with blanks outside of states', async () => {
    const frames = await collect(
      [
        { startFrame: 2, endFrame: 4, buf: px(7) },
        { startFrame: 4, endFrame: 5, buf: px(9) }
      ],
      7
    )
    expect(frames).toEqual([0, 0, 7, 7, 9, 0, 0])
  })

  it('stops reading the source once the total frame count is reached', async () => {
    let pulled = 0
    async function* gen(): AsyncGenerator<{ startFrame: number; endFrame: number; buf: Buffer }> {
      for (let i = 0; i < 100; i += 1) {
        pulled += 1
        yield { startFrame: i, endFrame: i + 1, buf: px(1) }
      }
    }
    const readable = createOverlayReadable(frameBytes, 3, gen(), blank)
    const frames: number[] = []
    for await (const chunk of readable) frames.push((chunk as Buffer)[0]!)
    expect(frames).toEqual([1, 1, 1])
    expect(pulled).toBeLessThanOrEqual(4)
  })

  it('closes the source when the stream is destroyed early', async () => {
    let closed = false
    const source: AsyncIterator<{ startFrame: number; endFrame: number; buf: Buffer }> = {
      next: async () => ({ done: false, value: { startFrame: 0, endFrame: 1000, buf: px(5) } }),
      return: async () => {
        closed = true
        return { done: true, value: undefined }
      }
    }
    const readable = createOverlayReadable(frameBytes, 1000, source, blank)
    await new Promise<void>((resolve) => {
      readable.once('data', () => {
        readable.destroy()
        readable.once('close', () => resolve())
      })
    })
    expect(closed).toBe(true)
  })

  it('fails the stream when the source yields a wrongly sized frame', async () => {
    async function* gen(): AsyncGenerator<{ startFrame: number; endFrame: number; buf: Buffer }> {
      yield { startFrame: 0, endFrame: 1, buf: Buffer.alloc(3) }
    }
    const readable = createOverlayReadable(frameBytes, 2, gen(), blank)
    await expect(
      (async () => {
        for await (const chunk of readable) void chunk
      })()
    ).rejects.toThrow('크기 불일치')
  })

  it('maps legacy timed buffers to frames with earliest-start winning overlaps', () => {
    const states = framesFromTimedBuffers(
      [
        { start: 1, end: 2 },
        { start: 1.5, end: 3 },
        { start: 10.005, end: 10.01 }
      ],
      [px(1), px(2), px(3)],
      30
    )
    expect(states.map((s) => [s.startFrame, s.endFrame, s.buf[0]])).toEqual([
      [30, 60, 1],
      [60, 90, 2]
    ])
  })
})
