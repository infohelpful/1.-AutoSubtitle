import { existsSync, readFileSync } from 'node:fs'

/** 환경 변수가 비어 있을 때만 채움 (시스템 env · 이미 로드된 값 우선) */
export function mergeEnvFromFile(envPath: string): void {
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
        value = value.slice(1, -1).trim()
      }
      process.env[key] = value
    }
  } catch {
    /* ignore */
  }
}
