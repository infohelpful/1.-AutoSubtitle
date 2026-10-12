import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { prepareSourceMedia } from './preparedMedia'
import { probeMediaTiming, probeMediaTimingAsync } from './mediaTiming'

const bin = process.env.AUTOSUBTITLE_TEST_FFMPEG_DIR
const ffmpeg = bin ? join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : ''
const ffprobe = bin ? join(bin, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : ''
const output = resolve('tools/sync-validation-output/source-clock')
function run(args: string[]) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 5 * 1024 * 1024 })
  if (r.error || r.status) throw new Error(String(r.error ?? r.stderr))
  return r.stdout
}
function amplitude(path: string, start: number) {
  const pcm = run(['-ss', String(start), '-i', path, '-t', '0.1', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'])
  let total = 0
  for (let i=0;i<pcm.length;i+=2) total += Math.abs(pcm.readInt16LE(i))
  return total / (pcm.length / 2)
}
describe.skipIf(!ffmpeg || !existsSync(ffmpeg))('source audio and preview share video epoch', () => {
  it.each([.5, -1])('preserves audio offset %ss against video PTS=5 without moving word times', async offset => {
    mkdirSync(output, {recursive:true})
    const input = join(output, `offset-${offset}.mkv`)
    run(['-f','lavfi','-i','testsrc2=s=64x64:r=30:d=3', '-f','lavfi','-i','sine=frequency=880:duration=2:sample_rate=48000',
      '-filter_complex', `[0:v]setpts=PTS+5/TB[v];[1:a]asetpts=PTS+${5+offset}/TB[a]`,
      '-map','[v]','-map','[a]','-c:v','libx264','-c:a','pcm_s16le','-copyts',input])
    const options = {input, ffmpeg, ffprobe, cacheDir: join(output, 'cache')}
    const [a,b] = await Promise.all([prepareSourceMedia(options), prepareSourceMedia(options)])
    expect(a).toEqual(b)
    expect(a.sourceOriginSec).toBe(5)
    expect(await probeMediaTimingAsync(ffprobe,input)).toEqual(probeMediaTiming(ffprobe,input))
    expect(probeMediaTiming(ffprobe,a.previewPath)).toMatchObject({sourceOriginSec:0, duration:3, hasAudio:false})
    expect(a.duration).toBe(3)
    if (offset>0) {
      expect(amplitude(a.audioPath,.2)).toBeLessThan(10)
      expect(amplitude(a.audioPath,.7)).toBeGreaterThan(1000)
    } else {
      expect(amplitude(a.audioPath,.2)).toBeGreaterThan(1000)
      expect(amplitude(a.audioPath,1.5)).toBeLessThan(10)
    }
    expect(amplitude(a.audioPath,2.9)).toBeLessThan(10)
    const previous = readFileSync(a.audioPath)
    expect(await prepareSourceMedia(options)).toEqual(a)
    expect(readFileSync(a.audioPath)).toEqual(previous)
  })
  it('supports silent video and keeps zero-origin preview on the original file', async () => {
    mkdirSync(output,{recursive:true})
    const input=join(output,'silent.mp4')
    run(['-f','lavfi','-i','color=blue:s=64x64:r=30:d=1','-c:v','libx264',input])
    const a=await prepareSourceMedia({input,ffmpeg,ffprobe,cacheDir:join(output,'cache')})
    expect(a.previewPath).toBe(input)
    expect(a.hasAudio).toBe(false)
    expect(amplitude(a.audioPath,.5)).toBe(0)
  })
  it('trims an audio tail that is longer than the zero-origin video', async () => {
    mkdirSync(output,{recursive:true})
    const input=join(output,'audio-tail.mkv')
    run(['-f','lavfi','-i','color=blue:s=64x64:r=30:d=1', '-f','lavfi','-i','sine=duration=2:sample_rate=48000',
      '-c:v','libx264','-c:a','pcm_s16le',input])
    const a=await prepareSourceMedia({input,ffmpeg,ffprobe,cacheDir:join(output,'cache')})
    expect(a.previewPath).not.toBe(input)
    expect(probeMediaTiming(ffprobe,a.previewPath).duration).toBe(1)
    const wav = run(['-i',a.audioPath,'-ac','1','-ar','16000','-f','s16le','-'])
    expect(wav.length).toBe(16000*2)
  })
  it('rejects cancelled probes and malformed media without blocking the caller', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(probeMediaTimingAsync(ffprobe,'missing.mp4',controller.signal)).rejects.toThrow('취소')
    await expect(probeMediaTimingAsync(ffprobe,'missing.mp4')).rejects.toThrow('Media probe failed')
  })
  it('cancels a real ffprobe blocked on media I/O while the event loop remains responsive', async () => {
    let received!: () => void
    const requestReceived = new Promise<void>(resolve => { received = resolve })
    const server = createServer((_req,res) => {
      res.writeHead(200,{'Content-Type':'video/mp4'})
      res.flushHeaders()
      received() // Keep the body open: ffprobe must wait for media bytes.
    })
    server.listen(0,'127.0.0.1')
    await once(server,'listening')
    const address = server.address() as {port:number}
    const controller = new AbortController()
    const watchdog = setTimeout(() => controller.abort(),3000)
    try {
      const probing = probeMediaTimingAsync(ffprobe,`http://127.0.0.1:${address.port}/slow.mp4`,controller.signal)
      const stopped = expect(probing).rejects.toThrow('취소')
      await Promise.race([requestReceived,probing])
      expect(controller.signal.aborted).toBe(false)
      controller.abort()
      await stopped
    } finally {
      clearTimeout(watchdog)
      controller.abort()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
