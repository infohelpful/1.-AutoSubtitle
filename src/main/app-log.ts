import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let logFilePath: string | null = null
let sessionHeaderWritten = false

let waveformLogFilePath: string | null = null
let waveformSessionHeaderWritten = false

let timelineLogFilePath: string | null = null
let timelineSessionHeaderWritten = false

function ensureLogFilePath(): string {
  if (logFilePath) return logFilePath
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
  }
  logFilePath = join(dir, 'main.log')
  return logFilePath
}

function formatPart(x: unknown): string {
  if (x === undefined) return ''
  if (x === null) return 'null'
  if (typeof x === 'string') return x
  if (x instanceof Error) return x.stack ?? x.message
  if (typeof x === 'object' && x !== null && !Array.isArray(x)) {
    const o = x as Record<string, unknown>
    if (o.type === 'Error' && typeof o.message === 'string') {
      return typeof o.stack === 'string' ? o.stack : o.message
    }
  }
  try {
    return JSON.stringify(x)
  } catch {
    return String(x)
  }
}

/**
 * `%AppData%/autosubtitle/logs/main.log` 등 userData 아래 `logs/main.log`에 append.
 */
export function logMain(scope: string, message: string, ...details: unknown[]): void {
  const path = ensureLogFilePath()
  const tail = details.length > 0 ? ` ${details.map(formatPart).join(' | ')}` : ''
  const line = `${new Date().toISOString()}\t[${scope}]\t${message}${tail}\n`
  try {
    if (!sessionHeaderWritten) {
      sessionHeaderWritten = true
      appendFileSync(
        path,
        `\n=== AutoSubtitle main · ${new Date().toISOString()} · 파일: ${path} ===\n`,
        'utf8'
      )
    }
    appendFileSync(path, line, 'utf8')
  } catch {
    /* ignore */
  }
}

export function getMainLogFilePath(): string {
  return ensureLogFilePath()
}

function ensureWaveformLogFilePath(): string {
  if (waveformLogFilePath) return waveformLogFilePath
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
  }
  waveformLogFilePath = join(dir, 'waveform.log')
  return waveformLogFilePath
}

/**
 * Peaks / 파동 UI 디버그 — `logs/waveform.log` (userData)에 append.
 */
export function logWaveform(scope: string, message: string, ...details: unknown[]): void {
  const path = ensureWaveformLogFilePath()
  const tail = details.length > 0 ? ` ${details.map(formatPart).join(' | ')}` : ''
  const line = `${new Date().toISOString()}\t[${scope}]\t${message}${tail}\n`
  try {
    if (!waveformSessionHeaderWritten) {
      waveformSessionHeaderWritten = true
      appendFileSync(
        path,
        `\n=== AutoSubtitle waveform debug · ${new Date().toISOString()} · 파일: ${path} ===\n`,
        'utf8'
      )
    }
    appendFileSync(path, line, 'utf8')
  } catch {
    /* ignore */
  }
}

export function getWaveformLogFilePath(): string {
  return ensureWaveformLogFilePath()
}

function ensureTimelineLogFilePath(): string {
  if (timelineLogFilePath) return timelineLogFilePath
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
  }
  timelineLogFilePath = join(dir, 'timeline.log')
  return timelineLogFilePath
}

/** 타임라인 편집(CUT·구간 삭제·cutRanges) — `logs/timeline.log` */
export function logTimeline(scope: string, message: string, ...details: unknown[]): void {
  const path = ensureTimelineLogFilePath()
  const tail = details.length > 0 ? ` ${details.map(formatPart).join(' | ')}` : ''
  const line = `${new Date().toISOString()}\t[${scope}]\t${message}${tail}\n`
  try {
    if (!timelineSessionHeaderWritten) {
      timelineSessionHeaderWritten = true
      appendFileSync(
        path,
        `\n=== AutoSubtitle timeline · ${new Date().toISOString()} · 파일: ${path} ===\n`,
        'utf8'
      )
    }
    appendFileSync(path, line, 'utf8')
  } catch {
    /* ignore */
  }
}

export function getTimelineLogFilePath(): string {
  return ensureTimelineLogFilePath()
}
