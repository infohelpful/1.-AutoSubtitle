/**
 * 원본 영상 + stdin rawvideo(자막 레이어) 단일 FFmpeg 패스로 합성·인코딩 (중간 MOV 없음).
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { buildClipGraph } from './ffmpegClipGraph'
import { programDuration, validateClipPlan, type ProgramClip } from '../shared/clipPlan'

/** 출력 프레임레이트(CFR). 렌더 스케줄도 이 값으로 프레임을 계산한다. */
export const EXPORT_FPS = 30

/** Electron `toBitmap()` 과 FFmpeg `-pixel_format` 정합 */
export const RAWVIDEO_PIXEL_FORMAT = process.platform === 'darwin' ? 'rgba' : 'bgra'

export function buildH264VideoEncodeArgs(encoder: string): string[] {
  const e = (encoder || 'libx264').trim().toLowerCase()
  if (e === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '23']
  if (e === 'h264_qsv') return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23']
  if (e === 'h264_amf') return ['-c:v', 'h264_amf', '-quality', 'speed']
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']
}

export function ffmpegProgressPercent(line: string, expectedSec: number): number | null {
  // FFmpeg's legacy out_time_ms key also reports MICROseconds.
  const match = /^out_time_(?:us|ms)=(-?\d+)$/.exec(line.trim())
  if (!match || !Number.isFinite(expectedSec) || expectedSec <= 0) return null
  const raw = Number(match[1])
  return Number.isFinite(raw) && raw >= 0 ? Math.max(0, Math.min(99, Math.floor(raw / (expectedSec * 1e6) * 100))) : null
}

function parseProgress(stderr: NodeJS.ReadableStream | null, expectedSec: number, onPercent?: (pct: number) => void): void {
  if (!stderr || !onPercent) return
  let buf = ''
  stderr.setEncoding('utf8')
  stderr.on('data', (chunk: string) => {
    buf += chunk
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      const pct = ffmpegProgressPercent(line, expectedSec)
      if (pct != null) onPercent(pct)
    }
  })
}

function waitFfmpegExit(proc: ChildProcess, stderr: NodeJS.ReadableStream | null): Promise<void> {
  let tail = ''
  stderr?.on('data', (chunk) => { tail = (tail + String(chunk)).slice(-6000) })
  return new Promise((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 실패 (exit ${code ?? -1}): ${tail}`))
    })
    stderr?.on('error', () => {
      /* ignore */
    })
  })
}

/**
 * 오버레이 상태 한 구간 — 출력 프레임 `[startFrame, endFrame)` 동안 `buf` 한 장(BGRA/RGBA 전체 프레임)을 쓴다.
 * 소스는 `startFrame` 오름차순·비겹침이어야 한다.
 */
export type OverlayFrameState = { startFrame: number; endFrame: number; buf: Buffer }

/** 비동기 소스는 한 번 소비하면 재생할 수 없으므로 재시도(CPU 인코더 등)를 위해 팩토리로 받는다. */
export type OverlayStateSourceFactory = () => AsyncIterator<OverlayFrameState>

/** 경계 부동소수 보정(초) — `exportRenderSchedule` 과 같은 값이어야 한다. */
const FRAME_EDGE_EPS_SEC = 1e-6

/**
 * 시간 구간 + 버퍼 배열(레거시 호출) → 프레임 상태 목록.
 * 먼저 시작한 구간이 겹침을 차지하며 프레임에 닿지 않는 구간은 버린다.
 */
export function framesFromTimedBuffers(
  timing: ReadonlyArray<{ start: number; end: number }>,
  buffers: readonly Buffer[],
  fps: number
): OverlayFrameState[] {
  const sorted = timing
    .map((t, i) => ({ start: t.start, end: t.end, buf: buffers[i]! }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const out: OverlayFrameState[] = []
  let cursor = 0
  for (const c of sorted) {
    const startFrame = Math.max(Math.ceil((c.start - FRAME_EDGE_EPS_SEC) * fps), cursor)
    const endFrame = Math.ceil((c.end - FRAME_EDGE_EPS_SEC) * fps)
    if (endFrame <= startFrame) continue
    out.push({ startFrame, endFrame, buf: c.buf })
    cursor = endFrame
  }
  return out
}

async function* iterateStates(states: readonly OverlayFrameState[]): AsyncGenerator<OverlayFrameState> {
  for (const state of states) yield state
}

/**
 * 프레임당 정확히 한 장을 내보내는 rawvideo 스트림.
 * 소스는 필요할 때만 당겨 오므로 캡처가 소비 속도에 맞춰 진행되고 메모리가 제한된다.
 */
export function createOverlayReadable(
  frameBytes: number,
  totalFrames: number,
  source: AsyncIterator<OverlayFrameState>,
  blank: Buffer
): Readable {
  if (blank.length !== frameBytes) {
    throw new Error(`blank buffer size mismatch (${blank.length} vs ${frameBytes})`)
  }
  let frameIndex = 0
  let current: OverlayFrameState | null = null
  let exhausted = false

  const readable = new Readable({
    async read() {
      try {
        if (frameIndex >= totalFrames) {
          this.push(null)
          return
        }
        while (!exhausted && (current === null || current.endFrame <= frameIndex)) {
          const next = await source.next()
          if (next.done) {
            exhausted = true
            current = null
            break
          }
          if (next.value.buf.length !== frameBytes) {
            throw new Error(`raw 프레임 크기 불일치: ${next.value.buf.length} (기대 ${frameBytes})`)
          }
          current = next.value
        }
        const hit = current !== null && current.startFrame <= frameIndex && frameIndex < current.endFrame
        frameIndex += 1
        this.push(hit ? current!.buf : blank)
      } catch (error) {
        this.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    },
    destroy(error, callback) {
      // 소비가 끝나기 전에 닫히면 캡처 소스(창·타이머)도 즉시 정리한다.
      void Promise.resolve(source.return?.()).catch(() => undefined).finally(() => callback(error))
    }
  })
  return readable
}

export type SinglePassBurnInParams = {
  ffmpegPath: string
  inputVideoPath: string
  outputPath: string
  /** 최종 합성 해상도(원본 영상과 동일 — 오버레이 스케일 목표) */
  fullVideoWidth: number
  fullVideoHeight: number
  /** 자막 캡처·raw 스트림 크기(예: 1080p 이하로 다운스케일) */
  renderWidth: number
  renderHeight: number
  overlayDurationSec: number
  /** 레거시: 구간별 전체 프레임 버퍼 — `overlayStates` 가 없을 때만 사용 */
  rawBgraBuffers?: Buffer[]
  timing?: Array<{ start: number; end: number }>
  /** 프레임 단위 상태 소스. 호출마다 새 소스를 만들어야 한다(재시도 대비). */
  overlayStates?: OverlayStateSourceFactory
  h264Encoder: string
  onProgress?: (percent: number) => void
  clipPlan: ProgramClip[]
  sourceDurationSec: number
  sourceOriginSec: number
  hasAudio: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * `-i` 원본 + `-f rawvideo -i -` 자막 레이어 → filter_complex overlay → 단일 인코딩.
 */
export async function runSinglePassSubtitleBurnIn(params: SinglePassBurnInParams): Promise<void> {
  const {
    ffmpegPath,
    inputVideoPath,
    outputPath,
    fullVideoWidth,
    fullVideoHeight,
    renderWidth,
    renderHeight,
    overlayDurationSec,
    h264Encoder,
    onProgress
  } = params

  const clips = validateClipPlan(params.clipPlan, params.sourceDurationSec)
  const overlayDur = programDuration(clips)
  if (Math.abs(overlayDurationSec - overlayDur) > 1e-6) throw new Error('Overlay and media durations must match')
  const rw = renderWidth
  const rh = renderHeight
  const frameBytes = rw * rh * 4

  let source: AsyncIterator<OverlayFrameState>
  if (params.overlayStates) {
    source = params.overlayStates()
  } else {
    const buffers = params.rawBgraBuffers ?? []
    const timing = params.timing ?? []
    if (buffers.length === 0) throw new Error('rawBgraBuffers 가 비어 있습니다.')
    if (timing.length !== buffers.length) throw new Error('timing 길이가 rawBgraBuffers 와 일치해야 합니다.')
    for (let i = 0; i < buffers.length; i += 1) {
      const len = buffers[i]!.length
      if (len !== frameBytes) throw new Error(`raw 프레임 ${i} 크기 불일치: ${len} (기대 ${frameBytes})`)
    }
    source = iterateStates(framesFromTimedBuffers(timing, buffers, EXPORT_FPS))
  }

  const blank = Buffer.alloc(frameBytes, 0)
  const totalFrames = Math.max(1, Math.ceil(overlayDur * EXPORT_FPS - 1e-9))
  const readable = createOverlayReadable(frameBytes, totalFrames, source, blank)

  const W = Math.max(1, Math.round(fullVideoWidth))
  const H = Math.max(1, Math.round(fullVideoHeight))

  /** 오버레이: stdin 자막 레이어를 `fullVideoWidth×fullVideoHeight`로 스케일 — export 창·캡처 해상도와 동일해야 좌우·줄바꿈 정렬이 맞음 */
  const filterComplex = `${buildClipGraph(clips, params.sourceDurationSec, params.sourceOriginSec, params.hasAudio)};[1:v]format=rgba,scale=${W}:${H}:flags=bilinear[sub];[vmain][sub]overlay=0:0:eof_action=pass:repeatlast=0[vout]`

  /** 첫 번째 입력 전용: 데이터·자막 스트림 무시 — `-sn`은 해당 `-i` 바로 앞에 두는 편이 매핑에 유리한 경우가 있음 */
  const argv: string[] = [
    '-y',
    '-hide_banner',
    '-copyts',
    '-dn',
    '-sn',
    '-i',
    inputVideoPath,
    '-f',
    'rawvideo',
    '-pixel_format',
    RAWVIDEO_PIXEL_FORMAT,
    '-video_size',
    `${rw}x${rh}`,
    '-framerate',
    String(EXPORT_FPS),
    '-i',
    '-',
    '-filter_complex',
    filterComplex,
    '-map',
    '[vout]',
    ...(params.hasAudio ? ['-map', '[amain]'] : []),
    ...buildH264VideoEncodeArgs(h264Encoder),
    '-pix_fmt', 'yuv420p',
    '-r', String(EXPORT_FPS),
    ...(params.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
    '-movflags',
    '+faststart',
    '-t', String(overlayDur),
    '-progress',
    'pipe:2',
    '-nostats',
    outputPath
  ]

  if (params.signal?.aborted) throw new Error('Export canceled')
  const proc = spawn(ffmpegPath, argv, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  // Subscribe immediately, before waiting for stdin; spawn errors and early exits cannot be lost.
  const exit = waitFfmpegExit(proc, proc.stderr)
  void exit.catch(() => undefined)
  parseProgress(proc.stderr, overlayDur, onProgress)
  let stopError: Error | undefined
  const stop = (message: string): void => {
    stopError = new Error(message)
    readable.destroy(stopError)
    proc.kill('SIGKILL')
  }
  const abort = (): void => stop('Export canceled')
  params.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop('Export encoding timed out'), params.timeoutMs ?? 30 * 60_000)
  try {
    if (!proc.stdin) throw new Error('ffmpeg stdin 을 열 수 없습니다.')
    await Promise.all([pipeline(readable, proc.stdin), exit])
    if (stopError) throw stopError
  } catch (e) {
    proc.kill('SIGKILL')
    await exit.catch(() => undefined)
    throw stopError ?? e
  } finally {
    clearTimeout(timer)
    params.signal?.removeEventListener('abort', abort)
    readable.destroy()
  }
  onProgress?.(99)
}
