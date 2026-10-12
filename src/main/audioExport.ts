import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rename, unlink } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { buildAudioClipGraph } from './audioClipGraph'
import { programDuration, type ProgramClip } from '../shared/clipPlan'
import { ffmpegProgressPercent } from './ffmpeg-single-pass'
import { validateMediaDecode } from './validateMediaDecode'

export async function exportAudio(options: {
  ffmpeg: string; ffprobe: string; input: string; output: string; format: 'wav' | 'mp3';
  clips: ProgramClip[]; duration: number; signal?: AbortSignal; timeoutMs?: number; onProgress?: (percent: number) => void
}): Promise<void> {
  if (resolve(options.input).toLowerCase() === resolve(options.output).toLowerCase()) throw new Error('원본과 다른 출력 경로가 필요합니다.')
  if (options.signal?.aborted) throw new Error('Export canceled')
  const graph = buildAudioClipGraph(options.clips, options.duration)
  const expected = programDuration(options.clips)
  const pending = `${options.output}.${randomUUID()}.partial${extname(options.output)}`
  try {
    await new Promise<void>((resolveJob, reject) => {
      const child = spawn(options.ffmpeg, ['-nostdin','-v','error','-y','-i',options.input,
        '-filter_complex',graph,'-map','[aout]','-vn',
        ...(options.format === 'mp3' ? ['-c:a','libmp3lame','-q:a','2'] : ['-c:a','pcm_s16le']),
        '-progress','pipe:2','-nostats',pending], {windowsHide:true,stdio:['ignore','ignore','pipe']})
      let failure: Error | undefined, stderr = '', lineBuffer = ''
      const stop = (message: string) => { failure = new Error(message); child.kill('SIGKILL') }
      const abort = () => stop('Export canceled')
      const timer = setTimeout(() => stop('Audio export timed out'), options.timeoutMs ?? 30*60_000)
      options.signal?.addEventListener('abort',abort,{once:true})
      child.stderr?.on('data', chunk => {
        stderr = (stderr+String(chunk)).slice(-4000)
        lineBuffer += String(chunk)
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''
        for (const line of lines) { const pct=ffmpegProgressPercent(line,expected); if(pct!==null) options.onProgress?.(pct) }
      })
      child.on('error',error=>{failure=error})
      child.on('close',code=>{
        clearTimeout(timer); options.signal?.removeEventListener('abort',abort)
        if(failure) reject(failure)
        else if(code!==0) reject(new Error(`오디오 인코딩 실패: ${stderr}`))
        else resolveJob()
      })
      if(options.signal?.aborted) abort()
    })
    if(options.signal?.aborted) throw new Error('Export canceled')
    const probe=spawnSync(options.ffprobe,['-v','error','-show_streams','-show_format','-of','json',pending],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024})
    if(probe.error || probe.status!==0) throw new Error('출력 오디오 정보를 읽지 못했습니다.')
    const data=JSON.parse(probe.stdout)
    const duration=Number(data.format?.duration)
    if(!data.streams?.some((s:{codec_type:string})=>s.codec_type==='audio') || !Number.isFinite(duration) || Math.abs(duration-expected)>.1) throw new Error('출력 오디오 길이 검증 실패')
    await validateMediaDecode(options.ffmpeg,pending,{signal:options.signal,timeoutMs:options.timeoutMs,audioOnly:true})
    if(options.signal?.aborted) throw new Error('Export canceled')
    await rename(pending,options.output)
    options.onProgress?.(100)
  } finally { await unlink(pending).catch(()=>{}) }
}
