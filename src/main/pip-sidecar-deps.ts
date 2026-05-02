import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pythonSpawnEnv } from './python-resolve'

/** 첫 faster-whisper / HF 설치 등을 고려 */
const PIP_INSTALL_TIMEOUT_MS = 45 * 60 * 1000

/**
 * 사이드카와 동일한 인터프리터로 `python_sidecar/requirements.txt` 를 설치한다.
 * (이미 떠 있는 Python 프로세스는 site-packages 변경을 반영하지 못하므로, 호출 측에서 pip 후 sidecar 재시작 필요)
 */
export function ensureSidecarPipDeps(pythonExe: string, requirementsTxtPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(requirementsTxtPath)) {
      resolve()
      return
    }

    const env = pythonSpawnEnv()
    const child = spawn(
      pythonExe,
      ['-m', 'pip', 'install', '-r', requirementsTxtPath, '--disable-pip-version-check'],
      {
        env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    let stderr = ''
    let stdout = ''
    const onChunk = (buf: Buffer, which: 'out' | 'err') => {
      const s = buf.toString()
      if (which === 'err') stderr += s
      else stdout += s
      for (const line of s.split(/\r?\n/)) {
        const t = line.trim()
        if (t) console.log(which === 'err' ? '[pip stderr]' : '[pip]', t)
      }
    }
    child.stdout?.on('data', (d: Buffer) => onChunk(d, 'out'))
    child.stderr?.on('data', (d: Buffer) => onChunk(d, 'err'))

    const tmo = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('pip install timed out (45분). 네트워크 또는 방화벽을 확인해 주세요.'))
    }, PIP_INSTALL_TIMEOUT_MS)

    child.on('error', (e) => {
      clearTimeout(tmo)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(tmo)
      if (code === 0) {
        resolve()
        return
      }
      const tail = (stderr + stdout).trim().slice(-6000)
      reject(
        new Error(
          `pip install 실패 (exit ${code}). 같은 Python에 패키지를 설치할 수 있는지 확인해 주세요.\n` +
            (tail ? `\n--- 로그 (끝부분) ---\n${tail}` : '')
        )
      )
    })
  })
}
