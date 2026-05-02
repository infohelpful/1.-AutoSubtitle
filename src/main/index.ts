import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { delimiter, dirname, extname, join, normalize, parse } from 'node:path'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { PythonSidecar } from './sidecar'
import { ffmpegReadyForUse, getBundledFfmpegPath, getFfmpegUserBinDir, systemFfmpegWorks } from './ffmpeg-deps'
import { getGpuRuntimeDir, installGpuRuntime, isGpuRuntimeInstalled } from './gpu-runtime'
import { prepareAllEngines } from './deps-prepare'
import { resolvePythonInterpreter } from './python-resolve'
import { ensureSidecarPipDeps } from './pip-sidecar-deps'
import { captureSubtitlePngSequence, getExportRendererLoadMaxSecondsForUi, getSubtitleRenderDimensions } from './exportLogic'
import { runSinglePassSubtitleBurnIn } from './ffmpeg-single-pass'
import type {
  CutRange,
  ExportFormat,
  ExportRequest,
  ExportResult,
  ExportSubtitleStyle,
  FfmpegCapabilities
} from '../shared/ipc'

let mainWindow: BrowserWindow | null = null
let sidecar: PythonSidecar | null = null
let depsPrepareLocked = false
let gpuInstallLocked = false

function dialogParentWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  const fromSender = BrowserWindow.fromWebContents(event.sender)
  if (fromSender && !fromSender.isDestroyed()) return fromSender
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return undefined
}

/** 저장/열기 대화상자가 다른 창 뒤에 가리거나 부모가 없을 때 Windows에서 뜨지 않는 경우 완화 */
function prepareDialogParent(win: BrowserWindow | undefined): void {
  if (!win || win.isDestroyed()) return
  try {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } catch {
    /* ignore */
  }
}

/** Windows 메모장·일부 뷰어가 UTF-8로 열도록 선행 바이트(EF BB BF) */
const UTF8_BOM = '\uFEFF'

function writeUtf8TextFile(path: string, content: string): void {
  writeFileSync(path, UTF8_BOM + content, 'utf8')
}

function loadEnvFromDotenv(): void {
  const envPath = join(process.cwd(), '.env')
  if (!existsSync(envPath)) return
  try {
    const text = readFileSync(envPath, 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const idx = line.indexOf('=')
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      if (!key || process.env[key] != null) continue
      let value = line.slice(idx + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      process.env[key] = value
    }
  } catch {
    /* ignore dotenv parse errors */
  }
}

loadEnvFromDotenv()

/** 고해상도 DPI 배율로 capturePage 해상도가 어긋나 잘리는 현상 완화 — 창 생성 전에 적용 */
app.commandLine.appendSwitch('force-device-scale-factor', '1')

function getSidecarScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'python_sidecar', 'main.py')
  }
  return join(__dirname, '../../python_sidecar/main.py')
}

function resolvePythonExecutable(): string {
  return resolvePythonInterpreter()
}

function attachSidecarProgressToWindow(): void {
  if (!sidecar) return
  sidecar.setDownloadProgressHandler((percent) => {
    const w = mainWindow
    if (w && !w.isDestroyed()) {
      w.webContents.send('model:download-progress', percent)
    }
  })
}

function ensureSidecar(): PythonSidecar {
  const script = getSidecarScriptPath()
  if (!existsSync(script)) {
    throw new Error(`Sidecar script not found: ${script}`)
  }
  if (!sidecar) {
    const binDir = getFfmpegUserBinDir()
    const gpuDir = getGpuRuntimeDir()
    const pathPrefix = isGpuRuntimeInstalled() ? `${binDir}${delimiter}${gpuDir}` : binDir
    try {
      mkdirSync(binDir, { recursive: true })
    } catch {
      /* ignore */
    }
    const modelsDir = join(app.getPath('appData'), 'AutoSubtitle', 'models')
    try {
      mkdirSync(modelsDir, { recursive: true })
    } catch {
      /* ignore */
    }
    sidecar = new PythonSidecar(resolvePythonExecutable(), script, pathPrefix, {
      AUTOSUBTITLE_MODELS_DIR: modelsDir
    })
    attachSidecarProgressToWindow()
  }
  return sidecar
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // renderer(http://localhost)에서도 file:// 로컬 미디어(<video>) 로드를 허용
      webSecurity: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  attachSidecarProgressToWindow()
}

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'avi'] as const

const PREPARE_MODEL_TIMEOUT_MS = 60 * 60 * 1000
const TRANSCRIBE_TIMEOUT_MS = 2 * 60 * 60 * 1000
const EXPORT_VIDEO_TIMEOUT_MS = 2 * 60 * 60 * 1000
const DEFAULT_GPU_DLL_ZIP_URL =
  'https://github.com/infohelpful/1.-AutoSubtitle/releases/download/v1.0.0/runtime_dlls.zip'

function isVideoFilePath(absPath: string): boolean {
  const lower = absPath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  const ext = lower.slice(dot + 1)
  return (VIDEO_EXTENSIONS as readonly string[]).includes(ext)
}

function normalizeDroppedPath(rawPath: string): string {
  let p = rawPath.trim()
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim()
  }
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(p.replace('file://', ''))
    } catch {
      // keep original p
    }
  }
  // Some Windows environments can surface slash-like currency symbols.
  p = p.replace(/[¥₩]/g, '\\')
  // file:///D:/... or /D:/... from URL-ish payloads
  p = p.replace(/^[/\\]+([A-Za-z]:[\\/])/, '$1')
  // Broken Windows drive form: "D\foo" -> "D:\foo"
  p = p.replace(/^([A-Za-z])[\\/](?![\\/])/, '$1:\\')
  return normalize(p)
}

function mapDeviceToMode(device: unknown): 'cpu' | 'gpu' {
  const d = String(device ?? '').toLowerCase()
  return d === 'cuda' ? 'gpu' : 'cpu'
}

function modeLabelFromDevice(device: unknown): string {
  return mapDeviceToMode(device) === 'gpu' ? 'GPU' : 'CPU'
}

function getUsableFfmpegExecutable(): string {
  const fromEnv = process.env.AUTOSUBTITLE_FFMPEG_PATH?.trim() || process.env.FFMPEG_PATH?.trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  if (systemFfmpegWorks()) return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const bundled = getBundledFfmpegPath()
  if (existsSync(bundled)) return bundled
  throw new Error('ffmpeg 실행 파일을 찾지 못했습니다. 먼저 엔진 다운로드를 실행해 주세요.')
}

let cachedFfmpegEncodersText: { ffmpegPath: string; text: string } | null = null

/** `ffmpeg -encoders` 전체 출력 — 프로브 캐시로 한 번만 실행 */
const FFPROBE_TIMEOUT_MS = 60_000
const FFMPEG_ENCODERS_TIMEOUT_MS = 30_000

function getFfmpegEncodersListing(ffmpegPath: string): string {
  if (cachedFfmpegEncodersText?.ffmpegPath === ffmpegPath) {
    return cachedFfmpegEncodersText.text
  }
  try {
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: FFMPEG_ENCODERS_TIMEOUT_MS
    })
    if (r.error) {
      return ''
    }
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    cachedFfmpegEncodersText = { ffmpegPath, text }
    return text
  } catch {
    return ''
  }
}

/** `ffmpeg -encoders` 출력으로 인코더 존재 여부 판별 */
function probeFfmpegEncoderFlags(ffmpegPath: string): { isProResAvailable: boolean; isQtrleAvailable: boolean } {
  const out = getFfmpegEncodersListing(ffmpegPath)
  return {
    isProResAvailable: /\bprores_ks\b/.test(out),
    isQtrleAvailable: /\bqtrle\b/.test(out)
  }
}

/** 단일 패스 최종 H.264 — NVENC → QSV → AMF → libx264(ultrafast) */
function selectHardwareH264Encoder(ffmpegPath: string): 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264' {
  const out = getFfmpegEncodersListing(ffmpegPath)
  if (/\bh264_nvenc\b/.test(out)) return 'h264_nvenc'
  if (/\bh264_qsv\b/.test(out)) return 'h264_qsv'
  if (/\bh264_amf\b/.test(out)) return 'h264_amf'
  return 'libx264'
}

function formatEncoderDisplayName(enc: 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264'): string {
  switch (enc) {
    case 'h264_nvenc':
      return 'NVIDIA NVENC (h264_nvenc)'
    case 'h264_qsv':
      return 'Intel Quick Sync (h264_qsv)'
    case 'h264_amf':
      return 'AMD AMF (h264_amf)'
    case 'libx264':
      return 'x264 (CPU, ultrafast · CRF 23)'
  }
}

let cachedFfmpegCaps: { ffmpegPath: string; caps: FfmpegCapabilities } | null = null

function getFfmpegCapabilities(ffmpegPath: string, forceRefresh = false): FfmpegCapabilities {
  if (!forceRefresh && cachedFfmpegCaps?.ffmpegPath === ffmpegPath) {
    return cachedFfmpegCaps.caps
  }
  const flags = probeFfmpegEncoderFlags(ffmpegPath)
  const caps = { ffmpegPath, ...flags }
  cachedFfmpegCaps = { ffmpegPath, caps }
  return caps
}

function getFfprobePath(ffmpegExecutable: string): string {
  return join(dirname(ffmpegExecutable), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
}

function probeVideoDurationSec(mediaPath: string, ffmpegPath: string): number | null {
  const ffprobe = getFfprobePath(ffmpegPath)
  if (!existsSync(ffprobe)) return null
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mediaPath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: FFPROBE_TIMEOUT_MS
  })
  if (r.error) {
    return null
  }
  const v = Number.parseFloat(String(r.stdout ?? '').trim())
  return Number.isFinite(v) && v > 0 ? v : null
}

function estimateOverlayDurationSec(inputDur: number | null, cuts: CutRange[], mappedEndMax: number): number {
  const cutSum = cuts.reduce((s, c) => s + Math.max(0, c.end - c.start), 0)
  const trimmed = inputDur != null ? Math.max(0.1, inputDur - cutSum) : mappedEndMax
  return Math.max(trimmed, mappedEndMax, 1)
}

function clearSubtitlePngsInDir(dir: string): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (/^sub_\d+\.png$/i.test(name)) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        /* ignore */
      }
    }
  }
}

function sendExportProgress(win: BrowserWindow, payload: { percent: number; label?: string; encoderName?: string }): void {
  if (!win.isDestroyed()) win.webContents.send('export:progress', payload)
}

function detectVideoResolution(inputPath: string, ffmpegPath: string): { width: number; height: number } | null {
  const ffprobe = getFfprobePath(ffmpegPath)
  if (existsSync(ffprobe)) {
    try {
      const r = spawnSync(
        ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height',
          '-of',
          'csv=p=0',
          inputPath
        ],
        { encoding: 'utf8', windowsHide: true, timeout: FFPROBE_TIMEOUT_MS }
      )
      if (!r.error) {
        const line = String(r.stdout ?? '')
          .trim()
          .split(/\r?\n/)[0]
        if (line) {
          const [ws, hs] = line.split(',')
          const width = Number(ws)
          const height = Number(hs)
          if (
            Number.isFinite(width) &&
            Number.isFinite(height) &&
            width >= 160 &&
            height >= 90 &&
            width <= 8192 &&
            height <= 8192 &&
            width / height <= 4
          ) {
            return { width, height }
          }
        }
      }
    } catch {
      /* ffmpeg 폴백 */
    }
  }
  try {
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-i', inputPath, '-f', 'null', '-'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: FFPROBE_TIMEOUT_MS
    })
    if (r.error) {
      return null
    }
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    const videoLine = out
      .split(/\r?\n/)
      .find((line) => line.toLowerCase().includes(' video:') || line.toLowerCase().includes(' stream #'))
    if (!videoLine) return null
    const matches = Array.from(videoLine.matchAll(/(?:,\s*|\s)(\d{2,5})x(\d{2,5})(?=[,\s])/g))
      .map((m) => ({ width: Number(m[1]), height: Number(m[2]) }))
      .filter(
        (v) =>
          Number.isFinite(v.width) &&
          Number.isFinite(v.height) &&
          v.width >= 160 &&
          v.height >= 90 &&
          v.width <= 8192 &&
          v.height <= 8192 &&
          v.width / v.height <= 4
      )
      .sort((a, b) => b.width * b.height - a.width * a.height)
    if (!matches.length) return null
    return matches[0]
  } catch {
    return null
  }
}

function normalizeCutRanges(ranges: CutRange[]): CutRange[] {
  const sorted = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => ({ start: Math.max(0, r.start), end: Math.max(0, r.end) }))
    .sort((a, b) => a.start - b.start)
  if (sorted.length <= 1) return sorted
  const out: CutRange[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]
    const last = out[out.length - 1]
    if (cur.start <= last.end + 0.001) last.end = Math.max(last.end, cur.end)
    else out.push({ ...cur })
  }
  return out
}

function remapTimeByCuts(sec: number, cuts: CutRange[]): number {
  let shift = 0
  for (const c of cuts) {
    if (sec >= c.end) shift += c.end - c.start
    else if (sec > c.start) shift += sec - c.start
    else break
  }
  return Math.max(0, sec - shift)
}

function toSrtTimestamp(sec: number): string {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ms = Math.floor((s - Math.floor(s)) * 1000)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

type MappedSubtitle = { start: number; end: number; text: string }

function buildMappedSubtitles(
  subtitles: Array<{ start: number; end: number; text: string }>,
  cuts: CutRange[]
): MappedSubtitle[] {
  const out: MappedSubtitle[] = []
  for (const item of subtitles) {
    const mappedStart = remapTimeByCuts(Number(item.start), cuts)
    const mappedEnd = remapTimeByCuts(Number(item.end), cuts)
    if (!(mappedEnd > mappedStart + 0.01)) continue
    const text = String(item.text ?? '').trim()
    if (!text) continue
    out.push({ start: mappedStart, end: mappedEnd, text })
  }
  return out
}

function normalizeMappedSubtitles(subtitles: MappedSubtitle[]): MappedSubtitle[] {
  if (subtitles.length <= 1) return subtitles
  const sorted = [...subtitles].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: MappedSubtitle[] = []
  for (const cur of sorted) {
    const text = cur.text.trim()
    if (!text) continue
    if (out.length === 0) {
      if (cur.end > cur.start + 0.02) out.push({ ...cur, text })
      continue
    }
    const last = out[out.length - 1]
    const nextStart = Math.max(cur.start, last.end + 0.01)
    if (cur.end <= nextStart + 0.01) continue
    out.push({ start: nextStart, end: cur.end, text })
  }
  return out
}

/**
 * 프리뷰(textAlign:center, translateX(-50%), bottom:y%)와 유사하게 SSA 호환 태그 부착.
 * PotPlayer·VLC 등 — {\an2}=하단 기준 가운데, 해상도가 있으면 \pos로 좌우·세로 위치 근사.
 */
function buildSrtSsaAlignmentPrefix(style?: ExportSubtitleStyle): string {
  const base = '{\\an2}'
  const w = style?.videoWidth
  const h = style?.videoHeight
  if (!w || !h || w < 160 || h < 120) return base
  const xPct = Math.max(5, Math.min(95, Number(style?.x ?? 50)))
  const yPct = Math.max(2, Math.min(98, Number(style?.y ?? 10)))
  const cx = Math.round((w * xPct) / 100)
  const cy = Math.round(h * (1 - yPct / 100))
  return `{\\an2\\pos(${cx},${cy})}`
}

function buildSrtText(subtitles: MappedSubtitle[], style?: ExportSubtitleStyle): string {
  const prefix = buildSrtSsaAlignmentPrefix(style)
  const lines: string[] = []
  let cue = 1
  for (const item of subtitles) {
    lines.push(String(cue))
    lines.push(`${toSrtTimestamp(item.start)} --> ${toSrtTimestamp(item.end)}`)
    const body = item.text.trim()
    lines.push(prefix ? `${prefix}${body}` : body)
    lines.push('')
    cue += 1
  }
  return lines.join('\n')
}

/** WebVTT — PotPlayer 등에서 SRT보다 정렬·위치가 잘 먹는 경우가 많음 */
function toWebVttTimestamp(sec: number): string {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const whole = Math.floor(ss)
  const ms = Math.floor((ss - whole) * 1000)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

function escapeWebVttText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildWebVttText(subtitles: MappedSubtitle[], style?: ExportSubtitleStyle): string {
  const xPct = Math.max(5, Math.min(95, Number(style?.x ?? 50)))
  const yFromBottom = Math.max(2, Math.min(98, Number(style?.y ?? 10)))
  const lineFromTopPct = Math.max(0, Math.min(100, 100 - yFromBottom))
  const cues = subtitles.map((item, i) => {
    const start = toWebVttTimestamp(item.start)
    const end = toWebVttTimestamp(item.end)
    const settings = `align:center position:${xPct}% line:${lineFromTopPct}%`
    const body = escapeWebVttText(item.text.trim())
    return `${i + 1}\n${start} --> ${end} ${settings}\n${body}`
  })
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

function buildTxtText(subtitles: MappedSubtitle[]): string {
  const flatten = (s: string) =>
    s.replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ').trim()
  return subtitles
    .map((item) => flatten(item.text))
    .filter((t) => t.length > 0)
    .join(' ')
}

function escapeSubtitleFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function toAssTimestamp(sec: number): string {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const cs = Math.floor((s - Math.floor(s)) * 100)
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '').trim()
  const norm = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  if (!/^[0-9a-fA-F]{6}$/.test(norm)) return { r: 255, g: 255, b: 255 }
  const n = Number.parseInt(norm, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

// ASS/BGR/alpha format: &HAABBGGRR (AA 00=opaque, FF=transparent)
function toAssColor(hex: string, opacityPct = 100): string {
  const { r, g, b } = hexToRgb(hex)
  const alpha = Math.round(255 * (1 - Math.max(0, Math.min(1, opacityPct / 100))))
  const aa = alpha.toString(16).padStart(2, '0').toUpperCase()
  const bb = b.toString(16).padStart(2, '0').toUpperCase()
  const gg = g.toString(16).padStart(2, '0').toUpperCase()
  const rr = r.toString(16).padStart(2, '0').toUpperCase()
  return `&H${aa}${bb}${gg}${rr}`
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N')
}

function buildAssForceStyle(style?: ExportSubtitleStyle): string {
  const fontFamily = (style?.fontFamily?.trim() || 'Malgun Gothic').replace(/,/g, ' ')
  const fontSize = Math.max(8, Math.round(style?.fontSize ?? 26))
  const bold = (style?.fontWeight ?? 700) >= 600 ? 1 : 0
  const outline = Math.max(0, Number(style?.strokeWidth ?? 2))
  const primary = toAssColor(style?.textColor ?? '#f4f6fb', 100)
  const strokeColor = toAssColor(style?.strokeColor ?? '#000000', 100)
  const bgOpacity = Math.max(0, Math.min(100, Number(style?.bgOpacity ?? 62)))
  const backColor = toAssColor(style?.bgColor ?? '#080a10', bgOpacity)
  const borderStyle = bgOpacity > 0 ? 3 : 1
  const outlineColor = borderStyle === 3 ? backColor : strokeColor
  const appliedOutline = borderStyle === 3 ? Math.max(1, Math.round(Math.max(1, outline))) : outline
  return [
    `Fontname=${fontFamily}`,
    `Fontsize=${fontSize}`,
    `Bold=${bold}`,
    `PrimaryColour=${primary}`,
    `OutlineColour=${outlineColor}`,
    `BackColour=${backColor}`,
    `BorderStyle=${borderStyle}`,
    `Outline=${appliedOutline}`,
    'Shadow=0',
    'Alignment=2',
    'WrapStyle=2'
  ]
    .join(',')
    .replace(/'/g, "\\'")
}

function buildAssText(subtitles: MappedSubtitle[], style?: ExportSubtitleStyle): string {
  const playResX = Math.max(320, Math.round(style?.videoWidth ?? 1920))
  const playResY = Math.max(240, Math.round(style?.videoHeight ?? 1080))
  const fontFamily = (style?.fontFamily?.trim() || 'Malgun Gothic').replace(/,/g, ' ')
  // 프리뷰와 1:1 매칭을 위해 보정 없이 그대로 사용
  const fontSize = Math.max(8, Math.round(style?.fontSize ?? 26))
  const bold = (style?.fontWeight ?? 700) >= 600 ? -1 : 0
  const outline = Math.max(0, Number(style?.strokeWidth ?? 2))
  const primary = toAssColor(style?.textColor ?? '#f4f6fb', 100)
  const strokeColor = toAssColor(style?.strokeColor ?? '#000000', 100)
  const bgOpacity = Math.max(0, Math.min(100, Number(style?.bgOpacity ?? 62)))
  const backColor = toAssColor(style?.bgColor ?? '#080a10', bgOpacity)
  const borderStyle = bgOpacity > 0 ? 3 : 1
  const outlineColor = borderStyle === 3 ? backColor : strokeColor
  // BorderStyle=3에서 Outline은 박스 패딩 역할도 하므로 과도하지 않게 고정
  const appliedOutline = borderStyle === 3 ? Math.max(1, Math.round(Math.max(1, outline))) : outline
  const marginH = Math.round(playResX * 0.05)

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: Default,${fontFamily},${fontSize},${primary},${primary},${outlineColor},${backColor},${bold},0,0,0,100,100,0,0,${borderStyle},${appliedOutline},0,2,${marginH},${marginH},20,1`,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
  ]
  const lines = subtitles.map(
    (item) =>
      `Dialogue: 0,${toAssTimestamp(item.start)},${toAssTimestamp(item.end)},Default,,0,0,0,,${escapeAssText(item.text)}`
  )
  return [...header, ...lines, ''].join('\n')
}

function toDrawTextColor(hex: string): string {
  const { r, g, b } = hexToRgb(hex)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function escapeDrawTextText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, '\\n')
}

function escapeDrawTextPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function resolveWindowsFontFile(fontFamily: string): string | null {
  if (process.platform !== 'win32') return null
  const fontsDir = 'C:\\Windows\\Fonts'
  try {
    const files = readdirSync(fontsDir).filter((f) => /\.(ttf|otf|ttc)$/i.test(f))
    const normalized = fontFamily.toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (!normalized) return null
    const hit = files.find((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(normalized))
    if (hit) return join(fontsDir, hit)
    const tokens = fontFamily
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9]+/g, ''))
      .filter(Boolean)
    if (!tokens.length) return null
    const tokenHit = files.find((name) => {
      const n = name.toLowerCase().replace(/[^a-z0-9]+/g, '')
      return tokens.every((t) => n.includes(t))
    })
    if (tokenHit) return join(fontsDir, tokenHit)
  } catch {
    /* ignore */
  }
  return null
}

function pickInstalledKoreanFallbackFontFile(): string | null {
  if (process.platform !== 'win32') return null
  const fontsDir = 'C:\\Windows\\Fonts'
  const candidates = ['malgun.ttf', 'malgunbd.ttf', 'NotoSansKR-VF.ttf', 'gulim.ttc', 'batang.ttc']
  for (const name of candidates) {
    const full = join(fontsDir, name)
    if (existsSync(full)) return full
  }
  return null
}

function buildDrawTextFilter(subtitles: MappedSubtitle[], style?: ExportSubtitleStyle, cutExpr?: string | null): string {
  const font = (style?.fontFamily?.trim() || 'Malgun Gothic').replace(/'/g, "\\'")
  const fontFile = resolveWindowsFontFile(style?.fontFamily?.trim() || '')
  const fontSize = Math.max(8, Math.round(style?.fontSize ?? 26))
  const fontColor = toDrawTextColor(style?.textColor ?? '#f4f6fb')
  const strokeColor = toDrawTextColor(style?.strokeColor ?? '#000000')
  const strokeWidth = Math.max(0, Number(style?.strokeWidth ?? 2))
  const bgColor = toDrawTextColor(style?.bgColor ?? '#080a10')
  const bgOpacity = Math.max(0, Math.min(1, Number(style?.bgOpacity ?? 62) / 100))
  const xPct = Math.max(5, Math.min(95, Number(style?.x ?? 50)))
  const yPct = Math.max(2, Math.min(98, Number(style?.y ?? 10)))
  const xExpr = `(w*${(xPct / 100).toFixed(6)}-text_w/2)`
  const yExpr = `(h*(1-${(yPct / 100).toFixed(6)})-text_h)`

  let graph = `[0:v]${cutExpr ? `select='not(${cutExpr})',setpts=N/FRAME_RATE/TB` : 'null'}`
  for (const cue of subtitles) {
    const t = escapeDrawTextText(cue.text)
    graph +=
      `,drawtext=${fontFile ? `fontfile='${escapeDrawTextPath(fontFile)}'` : `font='${font}'`}:text='${t}':fontsize=${fontSize}:fontcolor=${fontColor}:` +
      `x=${xExpr}:y=${yExpr}:line_spacing=0:borderw=${strokeWidth}:bordercolor=${strokeColor}:` +
      `box=1:boxcolor=${bgColor}@${bgOpacity.toFixed(3)}:boxborderw=10:` +
      `enable='between(t,${cue.start.toFixed(3)},${cue.end.toFixed(3)})'`
  }
  return `${graph}[vout]`
}

function runFfmpegExport(
  ffmpeg: string,
  args: string[],
  expectedDurationSec: number,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderrAll = ''
    let stderrBuf = ''
    const expectedMs = Math.max(1, Math.round(expectedDurationSec * 1000))
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      stderrAll += text
      stderrBuf += text
      let idx = stderrBuf.indexOf('\n')
      while (idx >= 0) {
        const line = stderrBuf.slice(0, idx).trim()
        stderrBuf = stderrBuf.slice(idx + 1)
        if (line.startsWith('out_time_ms=')) {
          const raw = Number(line.slice('out_time_ms='.length))
          if (Number.isFinite(raw) && raw >= 0) {
            const outMs = Math.floor(raw / 1000)
            const pct = Math.max(0, Math.min(99, Math.round((outMs / expectedMs) * 100)))
            onProgress(pct)
          }
        }
        idx = stderrBuf.indexOf('\n')
      }
    })
    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      if (code === 0) {
        onProgress(100)
        resolve()
      } else {
        reject(new Error(`ffmpeg 내보내기 실패: ${stderrAll.trim() || `exit code ${code}`}`))
      }
    })
  })
}

function getLocalGpuDllCandidates(): string[] {
  const devDllDir = join(__dirname, '../../dll')
  const packagedDllDir = join(process.resourcesPath, 'dll')
  return [devDllDir, packagedDllDir]
}

function hasLocalGpuDllCandidate(): boolean {
  return getLocalGpuDllCandidates().some((dir) => existsSync(join(dir, 'cublas64_12.dll')))
}

function hasNvidiaGpu(): boolean {
  try {
    const r = spawnSync('nvidia-smi', ['-L'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: process.platform === 'win32'
    })
    if (r.status !== 0) return false
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.toLowerCase()
    return out.includes('gpu ') || out.includes('nvidia')
  } catch {
    return false
  }
}

app.whenReady().then(() => {
  ipcMain.handle('shell:showItemInFolder', (_event, raw: unknown) => {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false as const, reason: 'empty' }
    const p = normalizeDroppedPath(raw)
    if (!existsSync(p)) return { ok: false as const, reason: 'missing' }
    shell.showItemInFolder(p)
    return { ok: true as const }
  })

  ipcMain.handle('ffmpeg:capabilities', async (): Promise<FfmpegCapabilities> => {
    try {
      const p = getUsableFfmpegExecutable()
      return getFfmpegCapabilities(p)
    } catch {
      return { ffmpegPath: '', isProResAvailable: false, isQtrleAvailable: false }
    }
  })

  ipcMain.handle('dialog:openVideo', async (event) => {
    const win = dialogParentWindow(event)
    prepareDialogParent(win)
    const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined, {
      title: '편집할 영상 선택',
      properties: ['openFile'],
      filters: [{ name: '영상', extensions: [...VIDEO_EXTENSIONS] }]
    })
    if (canceled || !filePaths?.length) {
      return { canceled: true as const, filePaths: [] as string[] }
    }
    return { canceled: false as const, filePaths }
  })

  ipcMain.handle('project:open', async (event) => {
    const win = dialogParentWindow(event)
    prepareDialogParent(win)
    const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined, {
      title: '프로젝트 열기',
      properties: ['openFile'],
      filters: [{ name: 'AutoSubtitle 프로젝트', extensions: ['autosub'] }]
    })
    if (canceled || !filePaths?.[0]) return { canceled: true as const }
    const abs = filePaths[0]
    const content = readFileSync(abs, 'utf8')
    return { canceled: false as const, path: abs, content }
  })

  ipcMain.handle('project:save', async (_event, payload: unknown) => {
    const p = payload as { path?: string; content?: string }
    if (typeof p?.path !== 'string' || typeof p?.content !== 'string') {
      return { ok: false as const, reason: '저장 인수가 올바르지 않습니다.' }
    }
    try {
      writeFileSync(p.path, p.content, 'utf8')
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, reason: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('project:saveAs', async (event, payload: unknown) => {
    const win = dialogParentWindow(event)
    prepareDialogParent(win)
    const p = payload as { content?: string; defaultPath?: string }
    if (typeof p?.content !== 'string') return { canceled: true as const }
    const suggestedNew = join(app.getPath('documents'), 'New_AutoSubtitle.autosub')
    const defaultPath =
      typeof p.defaultPath === 'string' && p.defaultPath.trim() ? p.defaultPath.trim() : suggestedNew
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined, {
      title: '프로젝트 다른 이름으로 저장',
      defaultPath,
      filters: [{ name: 'AutoSubtitle 프로젝트', extensions: ['autosub'] }]
    })
    if (canceled || !filePath) return { canceled: true as const }
    writeFileSync(filePath, p.content, 'utf8')
    return { canceled: false as const, path: filePath }
  })

  ipcMain.handle('deps:status', async () => {
    const ffmpegOk = ffmpegReadyForUse()
    let modelLoaded = false
    let modelPresent = false
    try {
      const sc = ensureSidecar()
      const s = (await sc.call('get_model_status')) as { loaded?: boolean; model_present?: boolean }
      modelLoaded = Boolean(s.loaded)
      modelPresent = Boolean(s.model_present)
    } catch {
      modelLoaded = false
      modelPresent = false
    }
    // 재시작마다 새 사이드카라 loaded 는 false — 디스크에 모델만 있어도 게이트는 닫음
    return {
      ffmpegOk,
      modelLoaded,
      modelPresent,
      engineReady: ffmpegOk && (modelLoaded || modelPresent)
    }
  })

  ipcMain.handle('deps:prepare-all', async () => {
    if (depsPrepareLocked) {
      throw new Error('이미 필수 엔진을 준비하는 중입니다. 완료될 때까지 기다려 주세요.')
    }
    depsPrepareLocked = true
    try {
      const pythonExe = resolvePythonInterpreter()
      const script = getSidecarScriptPath()
      const reqPath = join(dirname(script), 'requirements.txt')
      await ensureSidecarPipDeps(pythonExe, reqPath)
      // pip로 site-packages가 바뀌면 기존 사이드카 프로세스는 import 갱신이 안 됨 → 재시작
      sidecar?.stop()
      sidecar = null
      const sc = ensureSidecar()
      await prepareAllEngines(mainWindow, sc)
      return { ok: true as const }
    } finally {
      depsPrepareLocked = false
      attachSidecarProgressToWindow()
    }
  })

  ipcMain.handle('gpu:status', async () => {
    const installed = isGpuRuntimeInstalled()
    const nvidiaPresent = hasNvidiaGpu()
    const urlConfigured = Boolean(process.env.AUTOSUB_GPU_DLL_ZIP_URL?.trim() || DEFAULT_GPU_DLL_ZIP_URL)
    const localCandidate = hasLocalGpuDllCandidate()
    return {
      installed,
      canInstall: nvidiaPresent && !installed && (urlConfigured || localCandidate),
      nvidiaPresent,
      urlConfigured,
      localCandidate
    }
  })

  ipcMain.handle('gpu:install', async () => {
    if (gpuInstallLocked) throw new Error('GPU 런타임 설치가 이미 진행 중입니다.')
    gpuInstallLocked = true
    try {
      const zipUrl = process.env.AUTOSUB_GPU_DLL_ZIP_URL?.trim() || DEFAULT_GPU_DLL_ZIP_URL
      const result = await installGpuRuntime({
        localCandidates: getLocalGpuDllCandidates(),
        zipUrl
      })
      sidecar?.stop()
      sidecar = null
      return { ok: true as const, source: result.source, dir: result.dir }
    } finally {
      gpuInstallLocked = false
    }
  })

  ipcMain.handle('sidecar:call', async (_evt, method: string, params?: Record<string, unknown>) => {
    const sc = ensureSidecar()
    const timeoutMs =
      method === 'prepare_model'
        ? PREPARE_MODEL_TIMEOUT_MS
        : method === 'transcribe'
          ? TRANSCRIBE_TIMEOUT_MS
          : undefined
    const result = await sc.call(method, params, timeoutMs)
    if (method === 'prepare_model') {
      const w = mainWindow
      if (w && !w.isDestroyed()) {
        w.webContents.send('model:ready')
      }
    }
    return result
  })

  ipcMain.on('video-drop-path', (event, raw: unknown) => {
    void (async () => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return
      if (typeof raw !== 'string' || !raw.trim()) {
        win.webContents.send('transcribe:error', { message: '유효하지 않은 경로입니다.' })
        return
      }
      const absPath = normalizeDroppedPath(raw)
      if (!existsSync(absPath)) {
        win.webContents.send('transcribe:error', { message: `파일을 찾을 수 없습니다: ${absPath}` })
        return
      }
      if (!isVideoFilePath(absPath)) {
        win.webContents.send('transcribe:error', { message: '지원하지 않는 영상 형식입니다. (mp4, mkv, avi)' })
        return
      }
      const sc = ensureSidecar()
      const reqStartMs = Date.now()
      const status = (await sc.call('get_model_status')) as { loaded?: boolean; device?: string | null }
      if (!status.loaded) {
        const prep = (await sc.call('prepare_model', {}, PREPARE_MODEL_TIMEOUT_MS)) as {
          load?: { device?: string | null }
        }
        if (!win.isDestroyed()) win.webContents.send('model:ready')
        if (!win.isDestroyed()) win.webContents.send('transcribe:mode', mapDeviceToMode(prep?.load?.device))
        if (!win.isDestroyed()) {
          win.webContents.send('transcribe:diag', {
            message: `[진단] 모델 로드: ${modeLabelFromDevice(prep?.load?.device)}`
          })
        }
      } else if (!win.isDestroyed()) {
        win.webContents.send('transcribe:mode', mapDeviceToMode(status.device))
        win.webContents.send('transcribe:diag', {
          message: `[진단] 기존 모델 사용: ${modeLabelFromDevice(status.device)}`
        })
      }
      sc.setTranscribeProgressHandler((pct) => {
        if (!win.isDestroyed()) win.webContents.send('transcribe:progress', pct)
      })
      try {
        const result = (await sc.call('transcribe', { path: absPath }, TRANSCRIBE_TIMEOUT_MS)) as {
          device?: string | null
          device_before?: string | null
          fallback_to_cpu?: boolean
          transcribe_ms?: number
        }
        if (!win.isDestroyed()) win.webContents.send('transcribe:mode', mapDeviceToMode(result?.device))
        if (!win.isDestroyed()) {
          const totalMs = Date.now() - reqStartMs
          const txMs =
            typeof result?.transcribe_ms === 'number' && Number.isFinite(result.transcribe_ms)
              ? Math.max(0, Math.round(result.transcribe_ms))
              : null
          if (result?.fallback_to_cpu) {
            win.webContents.send('transcribe:diag', {
              message: '[진단] GPU 오류로 CPU 모드로 자동 전환됨'
            })
          }
          win.webContents.send('transcribe:diag', {
            message: `[진단] 장치: ${modeLabelFromDevice(result?.device)} · 추출 ${txMs ?? '-'}ms · 전체 ${totalMs}ms`
          })
        }
        if (!win.isDestroyed()) win.webContents.send('transcribe:complete', result)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (!win.isDestroyed()) win.webContents.send('transcribe:error', { message })
      } finally {
        sc.setTranscribeProgressHandler(null)
      }
    })()
  })

  const EXPORT_FORMATS: readonly ExportFormat[] = ['video', 'srt', 'vtt', 'ass', 'txt', 'mp3', 'wav']

  function normalizeExportFormat(raw: unknown): ExportFormat {
    if (raw === undefined || raw === null) return 'video'
    const s = String(raw).trim().toLowerCase()
    if (s === '') return 'video'
    if ((EXPORT_FORMATS as readonly string[]).includes(s)) return s as ExportFormat
    throw new Error(`지원하지 않는 내보내기 형식: ${String(raw)}`)
  }

  ipcMain.handle('export:by-format', async (event, req: ExportRequest): Promise<ExportResult> => {
    const win = dialogParentWindow(event)
    if (!win) throw new Error('윈도우를 찾지 못했습니다.')
    prepareDialogParent(win)
    if (!Array.isArray(req?.subtitles) || req.subtitles.length === 0) throw new Error('내보낼 자막 데이터가 없습니다.')
    const format = normalizeExportFormat(req.format)
    const requiresFfmpeg = format === 'video' || format === 'mp3' || format === 'wav'
    if (requiresFfmpeg && !ffmpegReadyForUse()) {
      throw new Error('ffmpeg 준비가 필요합니다. 먼저 엔진 다운로드를 실행해 주세요.')
    }

    const inputPathRaw = normalizeDroppedPath(String(req?.inputPath ?? ''))
    const needsSourceMedia = format === 'video' || format === 'mp3' || format === 'wav'
    if (needsSourceMedia && (!inputPathRaw || !existsSync(inputPathRaw))) {
      throw new Error('입력 영상을 찾지 못했습니다.')
    }
    const inputPath = inputPathRaw && existsSync(inputPathRaw) ? inputPathRaw : ''
    const parsedInput = inputPath
      ? parse(normalize(inputPath))
      : parse(join(app.getPath('documents'), 'AutoSubtitle_export'))
    const defaultExtByFormat: Record<ExportFormat, string> = {
      video: parsedInput.ext || '.mp4',
      srt: '.srt',
      vtt: '.vtt',
      ass: '.ass',
      txt: '.txt',
      mp3: '.mp3',
      wav: '.wav'
    }
    const formatLabelByFormat: Record<ExportFormat, string> = {
      video: 'Video',
      srt: 'SubRip',
      vtt: 'WebVTT',
      ass: 'Advanced SubStation Alpha',
      txt: 'Text',
      mp3: 'MP3 Audio',
      wav: 'WAV Audio'
    }
    const ext = defaultExtByFormat[format]
    const suggested = join(parsedInput.dir, `${parsedInput.name}_AutoSubtitle${ext}`)
    const saveRes = await dialog.showSaveDialog(win, {
      title: '내보내기',
      defaultPath: suggested,
      filters:
        format === 'video'
          ? [{ name: formatLabelByFormat[format], extensions: ['mp4', 'mkv', 'mov'] }]
          : [{ name: formatLabelByFormat[format], extensions: [ext.replace('.', '')] }]
    })
    if (saveRes.canceled || !saveRes.filePath) return { canceled: true as const }

    const selected = parse(saveRes.filePath)
    const outputName = selected.name.endsWith('_AutoSubtitle') ? selected.name : `${selected.name}_AutoSubtitle`
    const outputPath = join(selected.dir, `${outputName}${selected.ext || ext}`)
    const cuts = normalizeCutRanges(Array.isArray(req.cutRanges) ? req.cutRanges : [])
    const mappedSubtitles = normalizeMappedSubtitles(buildMappedSubtitles(req.subtitles, cuts))
    if (mappedSubtitles.length === 0) throw new Error('내보낼 유효 자막이 없습니다.')

    if (format === 'srt') {
      writeUtf8TextFile(outputPath, buildSrtText(mappedSubtitles, req.subtitleStyle))
      sendExportProgress(win, { percent: 100 })
      return { canceled: false as const, outputPath, format }
    }
    if (format === 'vtt') {
      writeUtf8TextFile(outputPath, buildWebVttText(mappedSubtitles, req.subtitleStyle))
      sendExportProgress(win, { percent: 100 })
      return { canceled: false as const, outputPath, format }
    }
    if (format === 'ass') {
      writeUtf8TextFile(outputPath, buildAssText(mappedSubtitles, req.subtitleStyle))
      sendExportProgress(win, { percent: 100 })
      return { canceled: false as const, outputPath, format }
    }
    if (format === 'txt') {
      writeUtf8TextFile(outputPath, buildTxtText(mappedSubtitles))
      sendExportProgress(win, { percent: 100 })
      return { canceled: false as const, outputPath, format }
    }
    if (format === 'video') {
      const tempDir = mkdtempSync(join(tmpdir(), 'autosub-export-'))
      clearSubtitlePngsInDir(tempDir)
      try {
        sendExportProgress(win, { percent: 0, label: '준비 중…' })
        const ffmpeg = getUsableFfmpegExecutable()
        const h264Encoder = selectHardwareH264Encoder(ffmpeg)
        const encDisplay = formatEncoderDisplayName(h264Encoder)
        sendExportProgress(win, { percent: 2, label: 'FFmpeg·인코더 확인 중…', encoderName: encDisplay })
        sendExportProgress(win, { percent: 4, label: '영상 길이 분석 중…', encoderName: encDisplay })
        const inputDur = probeVideoDurationSec(inputPath, ffmpeg)
        sendExportProgress(win, { percent: 6, label: '해상도 확인 중…', encoderName: encDisplay })
        const detectedResolution = detectVideoResolution(inputPath, ffmpeg)
        const fullW = detectedResolution?.width ?? req.subtitleStyle?.videoWidth ?? 1920
        const fullH = detectedResolution?.height ?? req.subtitleStyle?.videoHeight ?? 1080
        const subDim = getSubtitleRenderDimensions(fullW, fullH)
        sendExportProgress(win, { percent: 8, label: '자막 렌더 창을 여는 중…', encoderName: encDisplay })
        const exportSubtitleStyle: ExportSubtitleStyle = {
          fontFamily: req.subtitleStyle?.fontFamily ?? 'Malgun Gothic',
          fontSize: req.subtitleStyle?.fontSize ?? 26,
          textColor: req.subtitleStyle?.textColor ?? '#f4f6fb',
          fontWeight: req.subtitleStyle?.fontWeight ?? 700,
          bgColor: req.subtitleStyle?.bgColor ?? '#080a10',
          bgOpacity: req.subtitleStyle?.bgOpacity ?? 62,
          bgPaddingPct: req.subtitleStyle?.bgPaddingPct ?? 100,
          strokeColor: req.subtitleStyle?.strokeColor ?? '#000000',
          strokeWidth: req.subtitleStyle?.strokeWidth ?? 2,
          x: req.subtitleStyle?.x ?? 50,
          y: req.subtitleStyle?.y ?? 10,
          videoWidth: subDim.width,
          videoHeight: subDim.height
        }

        const mappedEndMax = mappedSubtitles.reduce((m, s) => Math.max(m, s.end), 0)
        const overlayDurationSec = estimateOverlayDurationSec(inputDur, cuts, mappedEndMax)

        const capture = await captureSubtitlePngSequence({
          mappedSubtitles,
          subtitleStyle: exportSubtitleStyle,
          outputDir: tempDir,
          onPoolProgress: (ev) => {
            if (ev.total <= 0) return
            if (ev.kind === 'loading') {
              sendExportProgress(win, {
                percent: Math.min(11, 8 + Math.round((ev.index / ev.total) * 3)),
                label: `렌더 창 ${ev.index}/${ev.total} 연결 중…(최대 ${getExportRendererLoadMaxSecondsForUi()}초)`,
                encoderName: encDisplay
              })
            } else {
              sendExportProgress(win, {
                percent: Math.min(12, 8 + Math.round((ev.completed / ev.total) * 4)),
                label: `렌더 창 ${ev.completed}/${ev.total} 준비됨`,
                encoderName: encDisplay
              })
            }
          },
          onProgress: (done, total) => {
            sendExportProgress(win, {
              percent: Math.min(32, 12 + Math.round((done / Math.max(1, total)) * 20)),
              label: '자막 비트맵 캡처 중…',
              encoderName: encDisplay
            })
          }
        })

        sendExportProgress(win, { percent: 32, label: '원본과 합성·인코딩 중… (단일 패스)', encoderName: encDisplay })

        await Promise.race([
          runSinglePassSubtitleBurnIn({
            ffmpegPath: ffmpeg,
            inputVideoPath: inputPath,
            outputPath,
            fullVideoWidth: fullW,
            fullVideoHeight: fullH,
            renderWidth: subDim.width,
            renderHeight: subDim.height,
            overlayDurationSec,
            rawBgraBuffers: capture.rawBgraBuffersOrdered,
            timing: capture.pythonPayload.timing.map(({ start, end }) => ({ start, end })),
            h264Encoder,
            onProgress: (pct) => {
              sendExportProgress(win, {
                percent: Math.min(99, 32 + Math.round((pct / 100) * 67)),
                label: '원본과 합성·인코딩 중…',
                encoderName: encDisplay
              })
            }
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('내보내기 인코딩 시간이 한도를 초과했습니다.')), EXPORT_VIDEO_TIMEOUT_MS)
          })
        ])

        sendExportProgress(win, { percent: 100, label: '완료', encoderName: encDisplay })
        return { canceled: false as const, outputPath, format }
      } finally {
        try {
          rmSync(tempDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }

    if (format === 'mp3' || format === 'wav') {
      const ffmpeg = getUsableFfmpegExecutable()
      const cutExpr =
        cuts.length > 0 ? cuts.map((c) => `between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})`).join('+') : null
      const args: string[] = ['-y', '-i', inputPath]
      if (cutExpr) {
        args.push('-af', `aselect='not(${cutExpr})',asetpts=N/SR/TB`)
      }
      args.push('-vn')
      if (format === 'mp3') {
        args.push('-c:a', 'libmp3lame', '-q:a', '2')
      } else {
        args.push('-c:a', 'pcm_s16le')
      }
      args.push('-progress', 'pipe:2', '-nostats', outputPath)
      const mappedEndMax = mappedSubtitles.reduce((m, s) => Math.max(m, s.end), 0)
      await runFfmpegExport(
        ffmpeg,
        args,
        Math.max(1, mappedEndMax),
        (pct) => {
          sendExportProgress(win, { percent: pct, label: '오디오 인코딩 중…' })
        }
      )
      return { canceled: false as const, outputPath, format }
    }

    throw new Error(`지원하지 않는 내보내기 형식: ${format}`)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  sidecar?.stop()
  sidecar = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sidecar?.stop()
  sidecar = null
})

/** 오프스크린 자막 PNG 시퀀스 (`src/main/exportLogic.ts`) — FFmpeg 오버레이 파이프라인에서 사용 */
export {
  captureSubtitlePngSequence,
  createRenderWindow,
  type CaptureSubtitlePngSequenceOptions,
  type CaptureSubtitlePngSequenceResult,
  type MappedSubtitle as ExportMappedSubtitle
} from './exportLogic'
