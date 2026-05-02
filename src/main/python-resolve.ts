import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const PRINT_EXE = ['-c', 'import sys; print(sys.executable)']

/** Electron 자식 프로세스 PATH가 비어 있어 `python`을 못 찾는 경우가 있어, 흔한 설치 경로를 앞에 붙인다. */
function collectWindowsPythonPathPrefixes(): string[] {
  const dirs: string[] = []
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  const pyLauncher = join(windir, 'py.exe')
  if (existsSync(pyLauncher)) dirs.push(windir)

  const local = process.env.LOCALAPPDATA
  if (local) {
    const base = join(local, 'Programs', 'Python')
    if (existsSync(base) && statSync(base).isDirectory()) {
      for (const name of readdirSync(base)) {
        if (!/^python\d*/i.test(name)) continue
        const dir = join(base, name)
        if (!statSync(dir).isDirectory()) continue
        if (existsSync(join(dir, 'python.exe'))) dirs.push(dir)
      }
    }
  }

  const pf = process.env.ProgramFiles
  if (pf) {
    for (const v of ['Python312', 'Python311', 'Python310', 'Python39', 'Python38']) {
      const dir = join(pf, v)
      if (existsSync(join(dir, 'python.exe'))) dirs.push(dir)
    }
  }

  return [...new Set(dirs)]
}

export function pythonSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  if (process.platform !== 'win32') return env
  const extra = collectWindowsPythonPathPrefixes().join(delimiter)
  if (!extra) return env
  const cur = env.Path ?? env.PATH ?? ''
  const merged = `${extra}${delimiter}${cur}`
  env.Path = merged
  env.PATH = merged
  return env
}

/**
 * Windows에서 `python`만으로는 PATH에 없어 ENOENT가 나는 경우가 많아,
 * `py -3` / `python` 으로 실제 python.exe 경로를 찾는다.
 */
export function resolvePythonInterpreter(): string {
  const envPath = process.env.PYTHON_PATH?.trim()
  if (envPath) {
    if (existsSync(envPath)) return envPath
    return envPath
  }

  const win = process.platform === 'win32'
  const spawnEnv = pythonSpawnEnv()

  const attempts: Array<{ cmd: string; args: string[] }> = []
  if (win) {
    const pyLauncher = join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'py.exe')
    if (existsSync(pyLauncher)) attempts.push({ cmd: pyLauncher, args: ['-3', ...PRINT_EXE] })
    attempts.push({ cmd: 'py', args: ['-3', ...PRINT_EXE] })
    attempts.push({ cmd: 'python', args: PRINT_EXE })
    attempts.push({ cmd: 'python3', args: PRINT_EXE })
  } else {
    attempts.push({ cmd: 'python3', args: PRINT_EXE }, { cmd: 'python', args: PRINT_EXE })
  }

  for (const { cmd, args } of attempts) {
    const r = spawnSync(cmd, args, {
      encoding: 'utf-8',
      shell: win,
      windowsHide: true,
      env: spawnEnv
    })
    if (r.error || r.status !== 0 || !r.stdout) continue
    const lines = r.stdout
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const exe = lines[lines.length - 1]
    if (!exe) continue
    if (existsSync(exe)) return exe
    if (win) return exe
  }

  return win ? 'python' : 'python3'
}
