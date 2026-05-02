import { BrowserWindow, ipcMain, type IpcMainEvent, type NativeImage, type WebContents } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ExportSubtitleStyle,
  ExportSubtitleUpdatePayload,
  SubtitlePngSequencePythonPayload
} from '../shared/ipc'
import { IPC_EXPORT_SUBTITLE_RENDER_READY } from '../shared/ipc'

const UPDATE_CHANNEL = 'update-subtitle' as const

/** 렌더러가 Ready 신호를 안 보낼 때 무한 대기 방지 */
const RENDER_READY_TIMEOUT_MS = 15_000
/** 폰트·합성 안정화용 — 요청 범위 100~200ms */
const POST_READY_SETTLE_MS = 150

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForSubtitleRenderReady(webContents: WebContents, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const targetId = webContents.id
    const onReady = (event: IpcMainEvent) => {
      if (event.sender.id !== targetId) return
      clearTimeout(tid)
      ipcMain.removeListener(IPC_EXPORT_SUBTITLE_RENDER_READY, onReady)
      resolve()
    }
    const tid = setTimeout(() => {
      ipcMain.removeListener(IPC_EXPORT_SUBTITLE_RENDER_READY, onReady)
      reject(new Error(`[EXPORT] 자막 렌더 Ready 타임아웃 (${timeoutMs}ms)`))
    }, timeoutMs)
    ipcMain.on(IPC_EXPORT_SUBTITLE_RENDER_READY, onReady)
  })
}

/** 한 번에 연속 캡처할 자막 개수 — 메모리에 묶어 FFmpeg 로 넘기기 전 단계 */
const CAPTURE_BATCH_SIZE = 20

/** 오프스크린 창 개수 — 자막 인덱스를 라운드로빈으로 나누어 병렬 캡처 */
const PARALLEL_CAPTURE_WINDOWS = 5
/** 1920×1080 초과 시 창 5개 동시에 띄우면 메모리·GPU에 걸려 0%에서 오래 멈출 수 있음 */
const MAX_FULLHD_PIXELS = 1920 * 1080
/** Vite dev 서버에 오프스크린 창 여러 개가 동시에 붙으면 첫 `loadURL`이 수 분~무한 대기되는 경우가 있음 */
const isViteDevRenderer = Boolean(process.env['ELECTRON_RENDERER_URL'])
/** `out/renderer/exportSubtitle.html`(번들) 로 로드할 때 — 보통 수 초 이내 */
const RENDER_LOAD_TIMEOUT_BUNDLED_MS = 90_000
/** Vite URL 로만 열 때 — 첫 번들 컴파일에 시간이 걸릴 수 있음 */
const RENDER_LOAD_TIMEOUT_VITE_MS = 600_000

/**
 * `npm run build` 산출물 `out/renderer/exportSubtitle.html`.
 * dev 에서 `__dirname` 이 프로젝트 루트 기준이 아닐 수 있어 `cwd` 후보도 본다.
 */
function resolveBundledExportSubtitleHtmlPath(): string | null {
  const candidates = [
    join(__dirname, '../renderer/exportSubtitle.html'),
    join(process.cwd(), 'out', 'renderer', 'exportSubtitle.html')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/** `npm run build` 후 생기는 번들 HTML — 있으면 Vite 없이 즉시 로드 */
export function hasBundledExportSubtitlePage(): boolean {
  return resolveBundledExportSubtitleHtmlPath() !== null
}

function exportLoadTimeoutMs(): number {
  return hasBundledExportSubtitlePage() ? RENDER_LOAD_TIMEOUT_BUNDLED_MS : RENDER_LOAD_TIMEOUT_VITE_MS
}

/** UI용 — 렌더 창 로드 상한(초) */
export function getExportRendererLoadMaxSecondsForUi(): number {
  return Math.round(exportLoadTimeoutMs() / 1000)
}

/** 4K 등도 자막 캡처는 1920×1080 박스 안에 맞게 다운스케일 — 메모리·캡처 비용 절감 */
const MAX_SUBTITLE_RENDER_W = 1920
const MAX_SUBTITLE_RENDER_H = 1080

export function getSubtitleRenderDimensions(
  fullWidth: number,
  fullHeight: number
): { width: number; height: number } {
  const w = Math.max(1, fullWidth)
  const h = Math.max(1, fullHeight)
  const scale = Math.min(MAX_SUBTITLE_RENDER_W / w, MAX_SUBTITLE_RENDER_H / h, 1)
  return {
    width: Math.max(320, Math.round(w * scale)),
    height: Math.max(240, Math.round(h * scale))
  }
}

export type PoolProgressEvent =
  | { kind: 'loading'; index: number; total: number }
  | { kind: 'done'; completed: number; total: number }

/** `buildMappedSubtitles` 이후와 동일한 한 줄 자막 형태 */
export type MappedSubtitle = { start: number; end: number; text: string }

export type CapturedSubtitleFrame = {
  index: number
  path: string
  start: number
  end: number
  text: string
}

export type CaptureSubtitlePngSequenceResult = {
  outputDir: string
  frames: CapturedSubtitleFrame[]
  pythonPayload: SubtitlePngSequencePythonPayload
  /** Phase 1 FFmpeg rawvideo stdin — cue 당 BGRA 한 장분 (`nativeImage.toBitmap`, 인덱스 순) */
  rawBgraBuffersOrdered: Buffer[]
}

function defaultExportStyle(style: ExportSubtitleStyle | undefined): ExportSubtitleStyle {
  return {
    fontFamily: style?.fontFamily ?? 'Malgun Gothic',
    fontSize: style?.fontSize ?? 26,
    textColor: style?.textColor ?? '#f4f6fb',
    fontWeight: style?.fontWeight ?? 700,
    bgColor: style?.bgColor ?? '#080a10',
    bgOpacity: style?.bgOpacity ?? 62,
    bgPaddingPct: style?.bgPaddingPct ?? 100,
    strokeColor: style?.strokeColor ?? '#000000',
    strokeWidth: style?.strokeWidth ?? 2,
    x: style?.x ?? 50,
    y: style?.y ?? 10,
    videoWidth: style?.videoWidth,
    videoHeight: style?.videoHeight
  }
}

function toUpdatePayload(
  text: string,
  width: number,
  height: number,
  style: ExportSubtitleStyle
): ExportSubtitleUpdatePayload {
  const s = defaultExportStyle(style)
  return {
    text,
    width,
    height,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    textColor: s.textColor,
    fontWeight: s.fontWeight,
    bgColor: s.bgColor,
    bgOpacity: s.bgOpacity,
    bgPaddingPct: s.bgPaddingPct,
    strokeColor: s.strokeColor,
    strokeWidth: s.strokeWidth,
    x: s.x,
    y: s.y
  }
}

/**
 * 투명 · 오프스크린 렌더 창 — React `ExportSubtitle` 페이지 로드용.
 * 크기는 영상 픽셀과 맞추어 캡처 해상도를 고정합니다.
 */
export function createRenderWindow(videoWidth: number, videoHeight: number): BrowserWindow {
  const w = Math.max(1, Math.round(videoWidth))
  const h = Math.max(1, Math.round(videoHeight))
  return new BrowserWindow({
    width: w,
    height: h,
    /** width/height 를 클라이언트(웹뷰) 픽셀 크기로 해석 — DPI와 창 프레임 혼동 방지 */
    useContentSize: true,
    show: false,
    offscreen: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  })
}

async function loadExportSubtitlePage(win: BrowserWindow): Promise<void> {
  const bundled = resolveBundledExportSubtitleHtmlPath()
  if (bundled) {
    await win.loadFile(bundled)
    return
  }
  const base = process.env['ELECTRON_RENDERER_URL']
  if (base) {
    const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
    await win.loadURL(`${trimmed}/exportSubtitle.html`)
    return
  }
  await win.loadFile(join(__dirname, '../renderer/exportSubtitle.html'))
}

async function waitForPaint(webContents: WebContents): Promise<void> {
  await webContents.executeJavaScript(
    `
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
    })
  `,
    true
  )
}

async function prepareCaptureWindow(width: number, height: number): Promise<BrowserWindow> {
  const win = createRenderWindow(width, height)
  // 리스너를 load 보다 먼저 걸어야 한다. loadURL 이 끝난 뒤에 once(did-finish-load)를 걸면
  // 이미 로드가 끝나 이벤트가 영원히 안 와서 0%에서 멈춘다.
  await new Promise<void>((resolve, reject) => {
    win.webContents.once('did-fail-load', (_e, code, desc, url) => {
      reject(new Error(`[EXPORT_RENDER_LOAD_FAILED] ${code} ${desc} (${url})`))
    })
    win.webContents.once('did-finish-load', () => resolve())
    void loadExportSubtitlePage(win).catch(reject)
  })
  win.setContentSize(width, height)
  win.webContents.setZoomFactor(1)
  await waitForPaint(win.webContents)
  return win
}

async function prepareCaptureWindowWithTimeout(width: number, height: number, timeoutMs: number): Promise<BrowserWindow> {
  return await Promise.race([
    prepareCaptureWindow(width, height),
    new Promise<BrowserWindow>((_, reject) => {
      setTimeout(() => {
        const sec = Math.round(timeoutMs / 1000)
        const hint = hasBundledExportSubtitlePage()
          ? ' If this keeps happening, check disk I/O or security software.'
          : ' Dev: ensure Vite is running. Run "npm run build" once so out/renderer/exportSubtitle.html exists (faster than waiting on Vite).'
        reject(
          new Error(
            `[EXPORT_RENDER_TIMEOUT] Subtitle render page did not load within ${sec}s.${hint}`
          )
        )
      }, timeoutMs)
    })
  ])
}

type RawCapturedFrame = {
  index: number
  bgra: Buffer
  start: number
  end: number
  text: string
}

function bgraFromCapture(image: NativeImage, width: number, height: number): Buffer {
  const size = image.getSize()
  let img: NativeImage = image
  if (size.width !== width || size.height !== height) {
    img = image.resize({ width, height })
  }
  const buf = img.toBitmap({ scaleFactor: 1 })
  const expected = width * height * 4
  if (buf.length !== expected) {
    throw new Error(`BGRA 크기 불일치: ${buf.length} (기대 ${expected})`)
  }
  return buf
}

async function captureChunk(
  win: BrowserWindow,
  indices: number[],
  mappedSubtitles: MappedSubtitle[],
  width: number,
  height: number,
  style: ExportSubtitleStyle,
  onFrame: () => void
): Promise<RawCapturedFrame[]> {
  const out: RawCapturedFrame[] = []
  for (let batchStart = 0; batchStart < indices.length; batchStart += CAPTURE_BATCH_SIZE) {
    const batch = indices.slice(batchStart, batchStart + CAPTURE_BATCH_SIZE)
    for (const i of batch) {
      const sub = mappedSubtitles[i]!
      const payload = toUpdatePayload(sub.text, width, height, style)
      const readyP = waitForSubtitleRenderReady(win.webContents, RENDER_READY_TIMEOUT_MS)
      win.webContents.send(UPDATE_CHANNEL, payload)
      await readyP
      await delay(POST_READY_SETTLE_MS)

      const image = await win.webContents.capturePage()
      out.push({
        index: i,
        bgra: bgraFromCapture(image, width, height),
        start: sub.start,
        end: sub.end,
        text: sub.text
      })
      onFrame()
    }
  }
  return out
}

function buildPythonPayload(
  outputDir: string,
  frames: CapturedSubtitleFrame[],
  mappedSubtitles: MappedSubtitle[]
): SubtitlePngSequencePythonPayload {
  return {
    outputDir,
    imagePaths: frames.map((f) => f.path),
    timing: mappedSubtitles.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text
    }))
  }
}

export type CaptureSubtitlePngSequenceOptions = {
  mappedSubtitles: MappedSubtitle[]
  subtitleStyle: ExportSubtitleStyle
  /** 임시 폴더 (예: `mkdtempSync` 결과). `sub_0.png`, … 저장 */
  outputDir: string
  onProgress?: (done: number, total: number) => void
  /** 창마다 로드 시작·완료 — 무한 대기 시 UI가 (0/N)에 고정되지 않도록 */
  onPoolProgress?: (event: PoolProgressEvent) => void
}

/**
 * 자막을 워커 풀로 나누어 병렬 캡처한 뒤, PNG 없이 BGRA Raw(`toBitmap`)만 모아
 * FFmpeg rawvideo stdin으로 Phase 1 에 넘깁니다.
 */
export async function captureSubtitlePngSequence(
  options: CaptureSubtitlePngSequenceOptions
): Promise<CaptureSubtitlePngSequenceResult> {
  const { mappedSubtitles, subtitleStyle, outputDir, onProgress, onPoolProgress } = options
  const style = defaultExportStyle(subtitleStyle)
  const width = Math.max(320, Math.round(style.videoWidth ?? 1920))
  const height = Math.max(240, Math.round(style.videoHeight ?? 1080))

  mkdirSync(outputDir, { recursive: true })

  const subs = mappedSubtitles.filter((s) => s.text.trim().length > 0)

  if (subs.length === 0) {
    return {
      outputDir,
      frames: [],
      pythonPayload: buildPythonPayload(outputDir, [], []),
      rawBgraBuffersOrdered: []
    }
  }

  const pixels = width * height
  const maxByResolution = pixels > MAX_FULLHD_PIXELS ? 2 : PARALLEL_CAPTURE_WINDOWS
  const maxWindows =
    isViteDevRenderer && !hasBundledExportSubtitlePage() ? 1 : maxByResolution
  const poolSize = Math.min(maxWindows, subs.length)
  const renderLoadTimeoutMs = exportLoadTimeoutMs()
  const chunks: number[][] = Array.from({ length: poolSize }, () => [])
  for (let i = 0; i < subs.length; i += 1) {
    chunks[i % poolSize]!.push(i)
  }

  const windows: BrowserWindow[] = []
  for (let widx = 0; widx < poolSize; widx += 1) {
    onPoolProgress?.({ kind: 'loading', index: widx + 1, total: poolSize })
    try {
      windows.push(await prepareCaptureWindowWithTimeout(width, height, renderLoadTimeoutMs))
    } catch (e) {
      for (const w of windows) {
        if (!w.isDestroyed()) w.destroy()
      }
      throw e
    }
    onPoolProgress?.({ kind: 'done', completed: widx + 1, total: poolSize })
  }

  let completed = 0
  const total = subs.length

  try {
    const parts = await Promise.all(
      chunks.map((indices, widx) => {
        if (indices.length === 0) return Promise.resolve<RawCapturedFrame[]>([])
        return captureChunk(windows[widx]!, indices, subs, width, height, style, () => {
          completed += 1
          onProgress?.(completed, total)
        })
      })
    )

    const merged = parts.flat().sort((a, b) => a.index - b.index)

    const frames: CapturedSubtitleFrame[] = merged.map((f) => ({
      index: f.index,
      path: '',
      start: f.start,
      end: f.end,
      text: f.text
    }))
    const rawBgraBuffersOrdered = merged.map((f) => f.bgra)

    return {
      outputDir,
      frames,
      pythonPayload: buildPythonPayload(outputDir, frames, subs),
      rawBgraBuffersOrdered
    }
  } finally {
    for (const w of windows) {
      if (!w.isDestroyed()) w.destroy()
    }
  }
}
