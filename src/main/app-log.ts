import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let logFilePath: string | null = null
let sessionHeaderWritten = false

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
