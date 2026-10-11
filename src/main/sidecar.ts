import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { delimiter } from 'node:path'
import { pythonSpawnEnv } from './python-resolve'

export type SidecarRequest = {
  id: string
  method: string
  params?: Record<string, unknown>
}

export type SidecarResponse =
  | { id: string; result: unknown }
  | { id: string; error: { message: string; code?: string } }

const DEFAULT_TIMEOUT_MS = 30_000

export class PythonSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private onDownloadProgress: ((percent: number) => void) | null = null
  private onTranscribeProgress: ((percent: number) => void) | null = null
  private onTranscribeDevice: ((device: string, reason?: string) => void) | null = null
  private onExportProgress: ((percent: number, phase?: string) => void) | null = null
  /** 동시에 여러 RPC가 stdin에 쓰면 파이프가 깨져 EPIPE가 난다 — 한 번에 하나만 실행 */
  private callChain: Promise<void> = Promise.resolve()
  private generation = 0
  /** 비정상 종료 시 마지막 Python stderr (진행률 JSON 제외 전 원문 누적) */
  private stderrTailRaw = ''

  constructor(
    /** 개발: `python.exe` / 배포: 고정 `main.exe` 등 */
    private readonly command: string,
    /**
     * 개발: `['-u', '/path/to/main.py']`
     * 배포 번들: `[]` (stdin JSON-RPC만 사용)
     */
    private readonly commandArgs: string[],
    /** userData/bin 등 — PATH 앞에 붙여 FFmpeg를 subprocess에서 찾게 함 */
    private readonly pathExtraPrefix: string | null = null,
    /** Whisper 모델 등 — 하위 프로세스 env에 병합 */
    private readonly extraEnv: Record<string, string> | null = null
  ) {}

  /** Python stderr의 `download_progress` JSON을 렌더러로 넘기기 위한 브리지(메인에서 설정). */
  setDownloadProgressHandler(handler: ((percent: number) => void) | null): void {
    this.onDownloadProgress = handler
  }

  /** Python stderr의 `{"type":"progress","value":…}` (transcribe) — stdout RPC와 분리. */
  setTranscribeProgressHandler(handler: ((percent: number) => void) | null): void {
    this.onTranscribeProgress = handler
  }

  setTranscribeDeviceHandler(handler: ((device: string, reason?: string) => void) | null): void {
    this.onTranscribeDevice = handler
  }

  /** Python `processor` ffmpeg 오버레이 구간의 stderr `export_progress` JSON. */
  setExportProgressHandler(handler: ((percent: number, phase?: string) => void) | null): void {
    this.onExportProgress = handler
  }

  start(): void {
    if (this.proc) return
    this.stderrTailRaw = ''
    const env = pythonSpawnEnv()
    // Windows 로캘(cp949)에서도 stdin/stdout JSON을 UTF-8로 고정해 한글 경로 깨짐 방지.
    env.PYTHONUTF8 = '1'
    env.PYTHONIOENCODING = 'utf-8'
    if (this.extraEnv) {
      for (const [k, v] of Object.entries(this.extraEnv)) {
        env[k] = v
      }
    }
    if (this.pathExtraPrefix) {
      const tail = env.PATH ?? env.Path ?? ''
      env.PATH = `${this.pathExtraPrefix}${delimiter}${tail}`
      env.Path = env.PATH
    }

    // Windows에서 shell: true면 cmd가 한 줄로 합치면서 스크립트 경로의 공백에서 잘림
    // (예: E:\Develop Program\... → E:\Develop). PATH는 pythonSpawnEnv로 보강했으므로 shell 없이 실행.
    this.proc = spawn(this.command, this.commandArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
      shell: false,
      detached: process.platform !== 'win32'
    })
    const proc = this.proc

    this.proc.stdin.on('error', (err) => {
      if (this.proc !== proc) return
      this.rejectAllPending(err instanceof Error ? err : new Error(String(err)))
    })

    const rl = createInterface({ input: this.proc.stdout })
    rl.on('line', (line) => { if (this.proc === proc) this.onLine(line) })

    let stderrBuf = ''
    this.proc.stderr.on('data', (chunk: Buffer) => {
      if (this.proc !== proc) return
      const text = chunk.toString()
      this.stderrTailRaw = (this.stderrTailRaw + text).slice(-14000)
      stderrBuf += text
      let idx: number
      while ((idx = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, idx).trim()
        stderrBuf = stderrBuf.slice(idx + 1)
        if (!line) continue
        try {
          const j = JSON.parse(line) as { type?: string; value?: number; phase?: string; device?: string; reason?: string }
          if (j?.type === 'transcribe_device' && typeof j.device === 'string') {
            this.onTranscribeDevice?.(j.device, j.reason)
            continue
          }
          if (j?.type === 'download_progress' && typeof j.value === 'number') {
            this.onDownloadProgress?.(j.value)
            continue
          }
          if (j?.type === 'progress' && typeof j.value === 'number') {
            this.onTranscribeProgress?.(j.value)
            continue
          }
          if (j?.type === 'export_progress' && typeof j.value === 'number') {
            const phase = typeof j.phase === 'string' ? j.phase : undefined
            this.onExportProgress?.(j.value, phase)
            continue
          }
        } catch {
          /* not JSON */
        }
        console.error('[sidecar stderr]', line)
      }
    })

    this.proc.on('error', (err) => {
      if (this.proc !== proc) return
      this.rejectAllPending(err)
    })

    this.proc.on('close', (code) => {
      if (this.proc !== proc) return
      const tail = this.stderrTailRaw.trim().replace(/\s+$/, '')
      const hint =
        tail.length > 0
          ? `\n\n--- Python stderr (마지막 ${Math.min(tail.length, 6000)}자) ---\n${tail.slice(-6000)}`
          : ''
      this.proc = null
      this.stderrTailRaw = ''
      this.rejectAllPending(new Error(`Python sidecar exited with code ${code}${hint}`))
    })
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  stop(reason = 'Sidecar stopped'): void {
    this.generation += 1
    const proc = this.proc
    this.proc = null
    this.rejectAllPending(new Error(reason))
    if (!proc?.pid) return
    // Stop the alignment worker and FFmpeg descendants too, before reusing the queue.
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 })
      if (result.error || result.status !== 0) proc.kill()
    } else {
      try { process.kill(-proc.pid, 'SIGKILL') } catch { proc.kill('SIGKILL') }
    }
  }

  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const generation = this.generation
    const next = this.callChain.then(() => {
      if (generation !== this.generation) throw new Error('Sidecar queued request canceled')
      return this.dispatchCall<T>(method, params, timeoutMs)
    })
    this.callChain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private dispatchCall<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    this.start()
    if (!this.proc?.stdin) return Promise.reject(new Error('Sidecar stdin not available'))

    const ms = timeoutMs ?? DEFAULT_TIMEOUT_MS
    const id = randomUUID()
    const req: SidecarRequest = { id, method, params }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop(`Sidecar timeout: ${method}`)
      }, ms)

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer
      })

      try {
        this.proc!.stdin.write(`${JSON.stringify(req)}\n`, (err) => {
          if (err) {
            clearTimeout(timer)
            this.pending.delete(id)
            reject(err)
          }
        })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private onLine(line: string): void {
    let msg: SidecarResponse
    try {
      msg = JSON.parse(line) as SidecarResponse
    } catch {
      console.error('[sidecar] invalid JSON line:', line)
      return
    }
    const pending = this.pending.get(msg.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(msg.id)
    if ('error' in msg) {
      pending.reject(new Error(msg.error.message))
    } else {
      pending.resolve(msg.result)
    }
  }
}
