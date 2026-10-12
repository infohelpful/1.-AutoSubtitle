import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildAudioClipGraph } from './audioClipGraph'
import { clipPlanFromCuts } from '../shared/clipPlan'
import { exportAudio } from './audioExport'

const bin = process.env.AUTOSUBTITLE_TEST_FFMPEG_DIR
const ffmpeg = bin ? join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : ''
const ffprobe = bin ? join(bin, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : ''
it.skipIf(!ffmpeg || !existsSync(ffmpeg))('exports cuts at exact PCM samples instead of entire decoder frames', () => {
  const output = resolve('tools/sync-validation-output')
  mkdirSync(output, { recursive: true })
  const path = join(output, 'audio-cut-samples.pcm')
  const pcm = Buffer.alloc(48000 * 2)
  for (let i=0; i<48000; i++) pcm.writeInt16LE(i%30000 - 15000, i*2)
  writeFileSync(path, pcm)
  const cuts = [{start:4801/48000,end:9603/48000}, {start:16003/48000,end:19207/48000}]
  const plan = clipPlanFromCuts(1, cuts)
  const result = spawnSync(ffmpeg, ['-v','error','-f','s16le','-ar','48000','-ac','1','-i',path,
    '-filter_complex',buildAudioClipGraph(plan,1),'-map','[aout]','-c:a','pcm_s16le','-f','s16le','-'], {windowsHide:true})
  expect(result.status, result.stderr?.toString()).toBe(0)
  const expected = Buffer.concat([pcm.subarray(0,4801*2),pcm.subarray(9603*2,16003*2),pcm.subarray(19207*2)])
  expect(result.stdout.equals(expected)).toBe(true)
})

it.skipIf(!ffmpeg || !existsSync(ffmpeg))('validates WAV/MP3 and preserves an existing output on failure, timeout or cancellation', async () => {
  const dir=resolve('tools/sync-validation-output')
  mkdirSync(dir,{recursive:true})
  const input=join(dir,'audio-safe-source.wav')
  const made=spawnSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=duration=1:sample_rate=48000','-c:a','pcm_s16le',input],{windowsHide:true})
  expect(made.status).toBe(0)
  const base={ffmpeg,ffprobe,input,duration:1,clips:clipPlanFromCuts(1,[{start:.2,end:.3}])}
  for(const format of ['wav','mp3'] as const) {
    const output=join(dir,`audio-safe-result.${format}`)
    await exportAudio({...base,output,format})
    expect(readFileSync(output).length).toBeGreaterThan(1000)
  }
  const output=join(dir,'audio-preserve.wav')
  writeFileSync(output,'existing user output')
  await expect(exportAudio({...base,output,format:'wav',ffmpeg:join(dir,'missing-ffmpeg')})).rejects.toThrow()
  await expect(exportAudio({...base,output,format:'wav',timeoutMs:1})).rejects.toThrow('timed out')
  const controller=new AbortController()
  const job=exportAudio({...base,output,format:'wav',signal:controller.signal})
  controller.abort()
  await expect(job).rejects.toThrow('canceled')
  expect(readFileSync(output,'utf8')).toBe('existing user output')
  expect(readdirSync(dir).filter(name=>name.startsWith('audio-preserve.wav.') && name.includes('.partial'))).toEqual([])
})
