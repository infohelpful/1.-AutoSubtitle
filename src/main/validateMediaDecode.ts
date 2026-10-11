import { spawn } from 'node:child_process'

/** Decode every selected video/audio frame before promoting a temporary export. */
export function validateMediaDecode(ffmpeg: string, path: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  if (options.signal?.aborted) return Promise.reject(new Error('Export canceled'))
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-v', 'error', '-xerror', '-i', path, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = '', failure: Error | undefined
    const stop = (message: string) => { failure = new Error(message); proc.kill('SIGKILL') }
    const abort = () => stop('Export canceled')
    const timer = setTimeout(() => stop('Output decode validation timed out'), options.timeoutMs ?? 30 * 60_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000) })
    proc.on('error', error => { failure = error })
    proc.on('close', code => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`출력 전체 디코드 검증 실패: ${stderr}`))
      else resolve()
    })
    if (options.signal?.aborted) abort()
  })
}
