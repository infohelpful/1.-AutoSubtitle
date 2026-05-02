import type { BrowserWindow } from 'electron'
import { FFMPEG_DOWNLOAD_WEIGHT_MB, WHISPER_DOWNLOAD_WEIGHT_MB, ensureFfmpegDownloaded } from './ffmpeg-deps'
import type { PythonSidecar } from './sidecar'

const W_FF = FFMPEG_DOWNLOAD_WEIGHT_MB / (FFMPEG_DOWNLOAD_WEIGHT_MB + WHISPER_DOWNLOAD_WEIGHT_MB)
const W_M = WHISPER_DOWNLOAD_WEIGHT_MB / (FFMPEG_DOWNLOAD_WEIGHT_MB + WHISPER_DOWNLOAD_WEIGHT_MB)

const PREPARE_MODEL_TIMEOUT_MS = 60 * 60 * 1000

function sendProgress(win: BrowserWindow | null | undefined, value: number): void {
  const w = win
  if (!w || w.isDestroyed()) return
  const v = Math.max(0, Math.min(100, value))
  w.webContents.send('model:download-progress', Math.round(v * 100) / 100)
}

/**
 * FFmpeg를 먼저 받은 뒤 Whisper prepare_model 을 실행한다.
 * (병렬 시 디스크·메모리 피크로 Windows에서 Python exit 1 이 나는 경우가 있어 순차로 안정화)
 * 진행률은 가중 합산으로 model:download-progress 에 전달한다.
 */
export async function prepareAllEngines(
  win: BrowserWindow | null | undefined,
  sidecar: PythonSidecar
): Promise<void> {
  let ffPct = 0
  let modelPct = 0

  const emitCombined = (): void => {
    const combined = W_FF * ffPct + W_M * modelPct
    sendProgress(win, combined)
  }

  await ensureFfmpegDownloaded((p) => {
    ffPct = Math.max(ffPct, Math.min(100, p))
    emitCombined()
  })
  ffPct = 100
  modelPct = 0
  emitCombined()

  sidecar.setDownloadProgressHandler((p) => {
    modelPct = Math.max(modelPct, Math.min(100, p))
    emitCombined()
  })
  try {
    await sidecar.call('prepare_model', undefined, PREPARE_MODEL_TIMEOUT_MS)
    modelPct = 100
    emitCombined()
  } finally {
    sidecar.setDownloadProgressHandler(null)
  }

  const w = win
  if (w && !w.isDestroyed()) {
    w.webContents.send('model:ready')
  }
}
