import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { EXPORT_FPS, RAWVIDEO_PIXEL_FORMAT, runSinglePassSubtitleBurnIn } from './ffmpeg-single-pass'
import { clipPlanFromCuts } from '../shared/clipPlan'
import { buildRenderSchedule } from '../shared/exportRenderSchedule'
import { probeMediaTiming } from './mediaTiming'

const bin = process.env.AUTOSUBTITLE_TEST_FFMPEG_DIR
const ffmpeg = bin ? join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : ''
const output = resolve('tools/sync-validation-output')
const ffprobe = bin ? join(bin, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : ''

function run(args: string[]): Buffer {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })
  if (r.error || r.status !== 0) throw new Error(`${r.error?.message ?? ''} ${r.stderr?.toString()}`)
  return r.stdout
}

describe.skipIf(!ffmpeg || !existsSync(ffmpeg))('real FFmpeg source-to-program export', () => {
  it('exports video and audio without captions when every row is hidden', async () => {
    mkdirSync(output, { recursive: true })
    const source = join(output, 'hidden-captions-source.mkv')
    const target = join(output, 'hidden-captions-result.mp4')
    run(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=30:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:v', 'libx264', '-c:a', 'pcm_s16le', source])
    const media = probeMediaTiming(ffprobe, source)
    await runSinglePassSubtitleBurnIn({
      ffmpegPath: ffmpeg, inputVideoPath: source, outputPath: target,
      fullVideoWidth: 64, fullVideoHeight: 64, renderWidth: 64, renderHeight: 64,
      overlayDurationSec: 2, h264Encoder: 'libx264',
      overlayStates: async function* () {},
      clipPlan: clipPlanFromCuts(2, []), sourceDurationSec: 2,
      sourceOriginSec: media.sourceOriginSec, hasAudio: true
    })
    const result = probeMediaTiming(ffprobe, target)
    expect(result.duration).toBeCloseTo(2, 1)
    expect(result.hasAudio).toBe(true)
    const pixel = [...run(['-ss', '1', '-i', target, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])]
    expect(pixel[2]).toBeGreaterThan(200)
    expect(pixel[0]).toBeLessThan(30)
    const audio = run(['-i', target, '-vn', '-f', 's16le', '-ac', '1', '-ar', '48000', '-'])
    expect(audio.length / (48000 * 2)).toBeCloseTo(2, 1)
    expect(audio.some(byte => byte !== 0)).toBe(true)
  }, 30_000)

  it.each([[2, 0], [2, 90], [8/9, 90]])('matches display pixels and overlay placement for SAR=%s and rotation=%s', async (sar, rotation) => {
    mkdirSync(output, { recursive: true })
    const base = join(output, `sar-base-${sar}-${rotation}.mp4`)
    const source = join(output, `sar-source-${sar}-${rotation}.mp4`)
    const target = join(output, `sar-result-${sar}-${rotation}.mp4`)
    run(['-f', 'lavfi', '-i', `color=blue:s=${sar<1?'720x480':'64x32'}:r=30:d=1`, '-vf', `setsar=${sar}`, '-c:v', 'libx264', base])
    run(['-display_rotation:v:0', String(rotation), '-i', base, '-c', 'copy', source])
    const media = probeMediaTiming(ffprobe, source)
    const width = sar<1 ? 540 : rotation ? 32 : 128, height = sar<1 ? 720 : rotation ? 128 : 32
    expect([media.width, media.height]).toEqual([width, height])
    const overlay = Buffer.alloc(width * height * 4)
    // Green upper-right quarter must reach the displayed right edge, without stretching the source.
    for (let y = 0; y < height / 2; y++) for (let x = width * 3 / 4; x < width; x++) {
      overlay[(y * width + x) * 4 + 1] = 255
      overlay[(y * width + x) * 4 + 3] = 255
    }
    await runSinglePassSubtitleBurnIn({
      ffmpegPath: ffmpeg, inputVideoPath: source, outputPath: target,
      fullVideoWidth: media.width, fullVideoHeight: media.height, renderWidth: width, renderHeight: height,
      overlayDurationSec: 1, rawBgraBuffers: [overlay], timing: [{ start: 0, end: 1 }], h264Encoder: 'libx264',
      clipPlan: clipPlanFromCuts(1, []), sourceDurationSec: 1, sourceOriginSec: media.sourceOriginSec, hasAudio: false
    })
    expect(probeMediaTiming(ffprobe, target)).toMatchObject({ width, height })
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', target], { encoding: 'utf8', windowsHide: true })
    expect(JSON.parse(probe.stdout).streams[0].sample_aspect_ratio).toBe('1:1')
    const frame = run(['-ss', '0.5', '-i', target, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    expect(frame.length).toBe(width * height * 3)
    const pixel = (x: number, y: number) => [...frame.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)]
    expect(pixel(width - 4, 4)[1]).toBeGreaterThan(200)
    expect(pixel(4, height - 4)[2]).toBeGreaterThan(200)
  })
  async function burn(source: string, target: string, cuts: Array<{ start: number; end: number }> = []): Promise<void> {
    const media = probeMediaTiming(ffprobe, source)
    const clips = clipPlanFromCuts(media.duration, cuts)
    await runSinglePassSubtitleBurnIn({
      ffmpegPath: ffmpeg, inputVideoPath: source, outputPath: target,
      fullVideoWidth: 64, fullVideoHeight: 64, renderWidth: 64, renderHeight: 64,
      overlayDurationSec: clips.reduce((sum, c) => sum + c.sourceEnd - c.sourceStart, 0),
      rawBgraBuffers: [Buffer.alloc(64 * 64 * 4)], timing: [{ start: 0, end: 0.1 }], h264Encoder: 'libx264',
      clipPlan: clips, sourceDurationSec: media.duration, sourceOriginSec: media.sourceOriginSec, hasAudio: media.hasAudio
    })
  }
  it('cuts the first two seconds in video AND audio, and preserves the subtitle-free tail', async () => {
    mkdirSync(output, { recursive: true })
    const source = join(output, 'source-six-seconds.mkv')
    const target = join(output, 'cut-first-two-seconds.mp4')
    run(['-f', 'lavfi', '-i', 'color=red:s=64x64:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=30:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=4',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]',
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'pcm_s16le', source])
    await runSinglePassSubtitleBurnIn({
      ffmpegPath: ffmpeg, inputVideoPath: source, outputPath: target,
      fullVideoWidth: 64, fullVideoHeight: 64, renderWidth: 64, renderHeight: 64,
      overlayDurationSec: 4, rawBgraBuffers: [Buffer.alloc(64 * 64 * 4)], timing: [{ start: 0, end: 1 }],
      h264Encoder: 'libx264',
      clipPlan: clipPlanFromCuts(6, [{ start: 0, end: 2 }]), sourceDurationSec: 6, hasAudio: true, sourceOriginSec: 0
    })
    const pixel = run(['-ss', '0.5', '-i', target, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    expect(pixel[2]).toBeGreaterThan(200)
    expect(pixel[0]).toBeLessThan(20)
    const pcm = run(['-ss', '0.25', '-i', target, '-t', '0.25', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'])
    let rising = 0
    for (let i = 2; i < pcm.length; i += 2) if (pcm.readInt16LE(i - 2) <= 0 && pcm.readInt16LE(i) > 0) rising++
    expect(rising / (pcm.length / 2 / 48000)).toBeCloseTo(880, -1)
    const tail = run(['-ss', '3.9', '-i', target, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    expect(tail.length).toBe(64 * 64 * 3)
  }, 60_000)

  it.each([false, true])('preserves the video tail with absent/short audio: %s', async (shortAudio) => {
    mkdirSync(output, { recursive: true })
    const source = join(output, `tail-${shortAudio}.mkv`)
    const target = join(output, `tail-${shortAudio}.mp4`)
    run(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=30:d=3',
      ...(shortAudio ? ['-f', 'lavfi', '-i', 'sine=duration=1:sample_rate=48000', '-c:a', 'pcm_s16le'] : []),
      '-c:v', 'libx264', source])
    await burn(source, target)
    expect(probeMediaTiming(ffprobe, target).duration).toBeCloseTo(3, 1)
    expect(run(['-ss', '2.9', '-i', target, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).length).toBe(64 * 64 * 3)
  })

  it('preserves delayed audio against a nonzero video PTS epoch', async () => {
    const source = join(output, 'offset-source.mkv')
    const target = join(output, 'offset-result.mp4')
    run(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=30:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2:sample_rate=48000',
      '-filter_complex', '[0:v]setpts=PTS+5/TB[v];[1:a]asetpts=PTS+5.5/TB[a]',
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'pcm_s16le', '-copyts', source])
    expect(probeMediaTiming(ffprobe, source).sourceOriginSec).toBe(5)
    await burn(source, target)
    const amplitude = (start: string): number => {
      const pcm = run(['-ss', start, '-i', target, '-t', '0.1', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'])
      let total = 0
      for (let i = 0; i < pcm.length; i += 2) total += Math.abs(pcm.readInt16LE(i))
      return total / (pcm.length / 2)
    }
    expect(amplitude('0.2')).toBeLessThan(10)
    expect(amplitude('0.7')).toBeGreaterThan(1000)
  })

  it('rejects spawn failures and timeout without hanging on stdin or losing close', async () => {
    const params = {
      ffmpegPath: join(output, 'missing-ffmpeg'), inputVideoPath: join(output, 'source-six-seconds.mkv'), outputPath: join(output, 'timeout.mp4'),
      fullVideoWidth: 64, fullVideoHeight: 64, renderWidth: 64, renderHeight: 64,
      overlayDurationSec: 6, rawBgraBuffers: [Buffer.alloc(64 * 64 * 4)], timing: [{ start: 0, end: 6 }], h264Encoder: 'libx264',
      clipPlan: clipPlanFromCuts(6, []), sourceDurationSec: 6, sourceOriginSec: 0, hasAudio: true
    }
    await expect(runSinglePassSubtitleBurnIn(params)).rejects.toThrow()
    await expect(runSinglePassSubtitleBurnIn({ ...params, ffmpegPath: ffmpeg, timeoutMs: 1 })).rejects.toThrow('timed out')
    const controller = new AbortController()
    controller.abort()
    await expect(runSinglePassSubtitleBurnIn({ ...params, ffmpegPath: ffmpeg, signal: controller.signal })).rejects.toThrow('canceled')
  })

  it('does not accumulate audio drift when repeating clips shorter than two frames', async () => {
    const source = join(output, 'source-six-seconds.mkv')
    const target = join(output, 'short-repeated-clips.mp4')
    const clips = Array.from({ length: 20 }, (_, i) => ({ occurrenceId: `repeat-${i}`, sourceStart: 2, sourceEnd: 2.05, programStart: i * .05 }))
    await runSinglePassSubtitleBurnIn({
      ffmpegPath: ffmpeg, inputVideoPath: source, outputPath: target,
      fullVideoWidth: 64, fullVideoHeight: 64, renderWidth: 64, renderHeight: 64,
      overlayDurationSec: 1, rawBgraBuffers: [Buffer.alloc(64 * 64 * 4)], timing: [{ start: 0, end: .1 }], h264Encoder: 'libx264',
      clipPlan: clips, sourceDurationSec: 6, sourceOriginSec: 0, hasAudio: true
    })
    expect(probeMediaTiming(ffprobe, target).duration).toBeCloseTo(1, 2)
    const pcm = run(['-i', target, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'])
    let quiet = 0
    for (let i = 0; i < Math.min(48000 * 2, pcm.length); i += 2) if (Math.abs(pcm.readInt16LE(i)) < 10) quiet++
    expect(quiet / 48000).toBeLessThan(.02)
  })

  it('burns per-word highlight states at the right output frames after a cut', async () => {
    mkdirSync(output, { recursive: true })
    const source = join(output, 'word-source.mkv')
    const target = join(output, 'word-highlight.mp4')
    run(['-f', 'lavfi', '-i', 'color=black:s=64x64:r=30:d=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v', 'libx264', '-c:a', 'pcm_s16le', source])
    const media = probeMediaTiming(ffprobe, source)
    const clips = clipPlanFromCuts(media.duration, [{ start: 0, end: 2 }])
    // 원본 [3,5) 줄: a=[3,4) b=[4,5), 그 사이·뒤 무음 없음. 앞 2초 컷 → program [1,3).
    const schedule = buildRenderSchedule({
      cues: [{ start: 3, end: 5, text: 'a b', words: [{ start: 3, end: 4, text: 'a' }, { start: 4, end: 5, text: 'b' }] }],
      clips, fps: EXPORT_FPS, highlightWords: true
    })
    expect(schedule.map((st) => [st.startFrame, st.endFrame, st.activeIndex])).toEqual([[30, 60, 0], [60, 90, 1]])
    const solid = (r: number, g: number, b: number): Buffer => {
      const frame = Buffer.alloc(64 * 64 * 4)
      for (let i = 0; i < frame.length; i += 4) {
        const [c0, c2] = RAWVIDEO_PIXEL_FORMAT === 'bgra' ? [b, r] : [r, b]
        frame[i] = c0; frame[i + 1] = g; frame[i + 2] = c2; frame[i + 3] = 255
      }
      return frame
    }
    const frames = [solid(0, 255, 0), solid(255, 0, 0)]
    await runSinglePassSubtitleBurnIn({
      ffmpegPath: ffmpeg, inputVideoPath: source, outputPath: target,
      fullVideoWidth: 64, fullVideoHeight: 64, renderWidth: 64, renderHeight: 64,
      overlayDurationSec: 4, h264Encoder: 'libx264',
      overlayStates: async function* () {
        for (const st of schedule) yield { startFrame: st.startFrame, endFrame: st.endFrame, buf: frames[st.activeIndex]! }
      },
      clipPlan: clips, sourceDurationSec: media.duration, sourceOriginSec: media.sourceOriginSec, hasAudio: media.hasAudio
    })
    const at = (t: string): number[] =>
      [...run(['-ss', t, '-i', target, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])]
    const before = at('0.5')
    const first = at('1.5')
    const second = at('2.5')
    const after = at('3.5')
    expect(Math.max(...before)).toBeLessThan(60)
    expect(first[1]).toBeGreaterThan(200)
    expect(first[0]).toBeLessThan(60)
    expect(second[0]).toBeGreaterThan(200)
    expect(second[1]).toBeLessThan(60)
    expect(Math.max(...after)).toBeLessThan(60)
    expect(probeMediaTiming(ffprobe, target).duration).toBeCloseTo(4, 1)
  }, 60_000)
})
