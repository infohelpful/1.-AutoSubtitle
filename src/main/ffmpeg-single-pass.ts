/**
 * 원본 영상 + stdin rawvideo(자막 레이어) 단일 FFmpeg 패스로 합성·인코딩 (중간 MOV 없음).
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const EXPORT_FPS = 30
const STDIN_FRAME_CHUNK = 20

/** Electron `toBitmap()` 과 FFmpeg `-pixel_format` 정합 */
export const RAWVIDEO_PIXEL_FORMAT = process.platform === 'darwin' ? 'rgba' : 'bgra'

export function buildH264VideoEncodeArgs(encoder: string): string[] {
  const e = (encoder || 'libx264').trim().toLowerCase()
  if (e === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '23']
  if (e === 'h264_qsv') return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23']
  if (e === 'h264_amf') return ['-c:v', 'h264_amf', '-quality', 'speed']
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']
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
      if (line.startsWith('out_time_ms=')) {
        try {
          const raw = parseInt(line.split('=', 2)[1]!.trim(), 10)
          if (raw >= 0) {
            const expectedMs = Math.max(1, Math.floor(expectedSec * 1000))
            const pct = Math.max(0, Math.min(99, Math.floor((raw / expectedMs) * 100)))
            onPercent(pct)
          }
        } catch {
          /* ignore */
        }
      }
    }
  })
}

function waitFfmpegExit(proc: ChildProcess, stderr: NodeJS.ReadableStream | null): Promise<void> {
  return new Promise((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 실패 (exit ${code ?? -1})`))
    })
    stderr?.on('error', () => {
      /* ignore */
    })
  })
}

type TimeCue = { start: number; end: number; buf: Buffer }

function pickFrameBuffer(t: number, sorted: TimeCue[], blank: Buffer): Buffer {
  for (const c of sorted) {
    if (t >= c.start && t < c.end - 1e-9) return c.buf
  }
  return blank
}

function buildRawVideoReadable(
  rw: number,
  rh: number,
  overlayDur: number,
  fps: number,
  sortedCues: TimeCue[],
  blank: Buffer
): Readable {
  const frameBytes = rw * rh * 4
  if (blank.length !== frameBytes) {
    throw new Error(`blank buffer size mismatch (${blank.length} vs ${frameBytes})`)
  }
  const totalFrames = Math.max(1, Math.ceil(overlayDur * fps - 1e-9))
  let frameIndex = 0

  return new Readable({
    read() {
      if (frameIndex >= totalFrames) {
        this.push(null)
        return
      }
      const chunkParts: Buffer[] = []
      let chunkBytes = 0
      const maxChunkBytes = STDIN_FRAME_CHUNK * frameBytes

      while (frameIndex < totalFrames && chunkBytes < maxChunkBytes) {
        const t = (frameIndex + 0.5) / fps
        chunkParts.push(pickFrameBuffer(t, sortedCues, blank))
        frameIndex += 1
        chunkBytes += frameBytes
      }
      this.push(chunkParts.length === 1 ? chunkParts[0]! : Buffer.concat(chunkParts))
    }
  })
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
  rawBgraBuffers: Buffer[]
  timing: Array<{ start: number; end: number }>
  h264Encoder: string
  onProgress?: (percent: number) => void
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
    rawBgraBuffers,
    timing,
    h264Encoder,
    onProgress
  } = params

  const n = rawBgraBuffers.length
  if (n === 0) throw new Error('rawBgraBuffers 가 비어 있습니다.')
  if (timing.length !== n) throw new Error('timing 길이가 rawBgraBuffers 와 일치해야 합니다.')

  const overlayDur = Math.max(0.1, overlayDurationSec)
  const rw = renderWidth
  const rh = renderHeight
  const frameBytes = rw * rh * 4

  for (let i = 0; i < n; i += 1) {
    const len = rawBgraBuffers[i]!.length
    if (len !== frameBytes) {
      throw new Error(`raw 프레임 ${i} 크기 불일치: ${len} (기대 ${frameBytes})`)
    }
  }

  const pairs: TimeCue[] = timing.map((t, i) => ({
    start: t.start,
    end: t.end,
    buf: rawBgraBuffers[i]!
  }))
  pairs.sort((a, b) => a.start - b.start || a.end - b.end)

  const blank = Buffer.alloc(frameBytes, 0)
  const readable = buildRawVideoReadable(rw, rh, overlayDur, EXPORT_FPS, pairs, blank)

  const W = Math.max(1, Math.round(fullVideoWidth))
  const H = Math.max(1, Math.round(fullVideoHeight))

  /** 오버레이: stdin 자막 레이어를 `fullVideoWidth×fullVideoHeight`로 스케일 — export 창·캡처 해상도와 동일해야 좌우·줄바꿈 정렬이 맞음 */
  const filterComplex = `[0:v]setpts=PTS-STARTPTS[vmain];[1:v]format=rgba,scale=${W}:${H}:flags=bilinear[sub];[vmain][sub]overlay=0:0:shortest=1[vout]`

  /** 첫 번째 입력 전용: 데이터·자막 스트림 무시 — `-sn`은 해당 `-i` 바로 앞에 두는 편이 매핑에 유리한 경우가 있음 */
  const argv: string[] = [
    '-y',
    '-hide_banner',
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
    '-map',
    '0:a?',
    '-map',
    '-0:s',
    ...buildH264VideoEncodeArgs(h264Encoder),
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    '-shortest',
    '-progress',
    'pipe:2',
    '-nostats',
    outputPath
  ]

  const proc = spawn(ffmpegPath, argv, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  parseProgress(proc.stderr, overlayDur, onProgress)

  if (!proc.stdin) throw new Error('ffmpeg stdin 을 열 수 없습니다.')

  try {
    await pipeline(readable, proc.stdin)
  } catch (e) {
    proc.kill('SIGKILL')
    throw e
  }

  await waitFfmpegExit(proc, proc.stderr)
  onProgress?.(100)
}
