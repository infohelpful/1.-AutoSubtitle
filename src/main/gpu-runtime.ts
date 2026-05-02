import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const REQUIRED_DLLS = ['cublas64_12.dll'] as const

export function getGpuRuntimeDir(): string {
  return join(app.getPath('userData'), 'dll')
}

export function isGpuRuntimeInstalled(): boolean {
  const dir = getGpuRuntimeDir()
  return REQUIRED_DLLS.every((name) => existsSync(join(dir, name)))
}

function hasRequiredDlls(dir: string): boolean {
  return REQUIRED_DLLS.every((name) => existsSync(join(dir, name)))
}

function findDirectoryContainingRequiredDlls(rootDir: string): string | null {
  const stack = [rootDir]
  while (stack.length > 0) {
    const dir = stack.pop()!
    if (hasRequiredDlls(dir)) return dir
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(dir, name)
      try {
        if (statSync(full).isDirectory()) stack.push(full)
      } catch {
        /* ignore unreadable entries */
      }
    }
  }
  return null
}

function buildDownloadHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'AutoSubtitle-GPU-Installer',
    Accept: 'application/octet-stream,*/*'
  }
  const auth = process.env.AUTOSUB_GPU_DLL_ZIP_AUTH?.trim()
  const token = process.env.AUTOSUB_GPU_DLL_ZIP_TOKEN?.trim()
  if (auth) headers.Authorization = auth
  else if (token) headers.Authorization = `token ${token}`
  return headers
}

function parseGithubReleaseAssetUrl(urlText: string): {
  owner: string
  repo: string
  tag: string
  assetName: string
} | null {
  try {
    const u = new URL(urlText)
    if (u.hostname !== 'github.com') return null
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/)
    if (!m) return null
    return { owner: m[1], repo: m[2], tag: decodeURIComponent(m[3]), assetName: decodeURIComponent(m[4]) }
  } catch {
    return null
  }
}

async function httpsGet(url: string, headers: Record<string, string>): Promise<{
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}> {
  return await new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const bufs: Buffer[] = []
      res.on('data', (d) => bufs.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(bufs)
        })
      })
    })
    req.on('error', reject)
  })
}

async function downloadGithubAssetViaApi(
  info: { owner: string; repo: string; tag: string; assetName: string },
  outFile: string
): Promise<void> {
  const headers = buildDownloadHeaders()
  const releaseUrl = `https://api.github.com/repos/${info.owner}/${info.repo}/releases/tags/${encodeURIComponent(info.tag)}`
  const releaseRes = await httpsGet(releaseUrl, {
    ...headers,
    Accept: 'application/vnd.github+json'
  })
  if (releaseRes.statusCode < 200 || releaseRes.statusCode >= 300) {
    throw new Error(`GPU 릴리스 메타 조회 실패: HTTP ${releaseRes.statusCode}`)
  }
  const releaseJson = JSON.parse(releaseRes.body.toString('utf8')) as {
    assets?: Array<{ id?: number; name?: string }>
  }
  const asset = (releaseJson.assets ?? []).find((a) => a?.name === info.assetName)
  if (!asset?.id) {
    throw new Error(`GPU 릴리스 에셋(${info.assetName})을 찾지 못했습니다.`)
  }
  const assetApiUrl = `https://api.github.com/repos/${info.owner}/${info.repo}/releases/assets/${asset.id}`
  const dlRes = await httpsGet(assetApiUrl, {
    ...headers,
    Accept: 'application/octet-stream'
  })
  if (dlRes.statusCode >= 300 && dlRes.statusCode < 400 && typeof dlRes.headers.location === 'string') {
    await downloadToFile(dlRes.headers.location, outFile)
    return
  }
  if (dlRes.statusCode < 200 || dlRes.statusCode >= 300) {
    throw new Error(`GPU 에셋 다운로드 실패(API): HTTP ${dlRes.statusCode}`)
  }
  writeFileSync(outFile, dlRes.body)
}

async function downloadToFile(urlText: string, outFile: string, redirects = 0): Promise<void> {
  if (redirects > 5) throw new Error('GPU 런타임 다운로드 리다이렉트가 너무 많습니다.')
  const url = new URL(urlText)
  const client = url.protocol === 'http:' ? http : https
  await new Promise<void>((resolve, reject) => {
    const req = client.get(
      url,
      {
        headers: buildDownloadHeaders()
      },
      (res) => {
      const code = res.statusCode ?? 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        void downloadToFile(next, outFile, redirects + 1).then(resolve).catch(reject)
        return
      }
      if (code < 200 || code >= 300) {
        res.resume()
        if (code === 401 || code === 403 || code === 404) {
          const gh = parseGithubReleaseAssetUrl(urlText)
          if (gh) {
            void downloadGithubAssetViaApi(gh, outFile).then(resolve).catch(reject)
            return
          }
          reject(
            new Error(
              `GPU 런타임 다운로드 실패: HTTP ${code} (비공개 릴리스라면 AUTOSUB_GPU_DLL_ZIP_TOKEN 또는 AUTOSUB_GPU_DLL_ZIP_AUTH 설정 필요)`
            )
          )
          return
        }
        reject(new Error(`GPU 런타임 다운로드 실패: HTTP ${code}`))
        return
      }
      const ws = createWriteStream(outFile)
      void pipeline(res, ws).then(resolve).catch(reject)
      }
    )
    req.on('error', reject)
  })
}

async function expandZipOnWindows(zipPath: string, outDir: string): Promise<void> {
  const script = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true
    })
    let err = ''
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`GPU ZIP 압축 해제 실패(code=${code}): ${err.trim()}`))
    })
  })
}

export async function installGpuRuntime(options: {
  localCandidates: string[]
  zipUrl?: string
}): Promise<{ source: 'local' | 'download' | 'existing'; dir: string }> {
  const targetDir = getGpuRuntimeDir()
  mkdirSync(targetDir, { recursive: true })
  if (isGpuRuntimeInstalled()) {
    return { source: 'existing', dir: targetDir }
  }

  for (const dir of options.localCandidates) {
    if (hasRequiredDlls(dir)) {
      cpSync(dir, targetDir, { recursive: true })
      if (!isGpuRuntimeInstalled()) {
        throw new Error('로컬 DLL 복사 후 필수 GPU 런타임 파일 확인에 실패했습니다.')
      }
      return { source: 'local', dir: targetDir }
    }
  }

  if (!options.zipUrl) {
    throw new Error('GPU 런타임 소스를 찾지 못했습니다. dll 폴더를 두거나 AUTOSUB_GPU_DLL_ZIP_URL을 설정해 주세요.')
  }

  const baseTmp = join(tmpdir(), `autosub-gpu-${randomUUID()}`)
  const zipPath = join(baseTmp, 'gpu-runtime.zip')
  const extracted = join(baseTmp, 'expanded')
  mkdirSync(baseTmp, { recursive: true })
  mkdirSync(extracted, { recursive: true })
  try {
    await downloadToFile(options.zipUrl, zipPath)
    await expandZipOnWindows(zipPath, extracted)
    const sourceDir = findDirectoryContainingRequiredDlls(extracted)
    if (!sourceDir) {
      throw new Error('다운로드한 ZIP 내부에서 필수 GPU DLL 위치를 찾지 못했습니다.')
    }
    cpSync(sourceDir, targetDir, { recursive: true })
    if (!isGpuRuntimeInstalled()) {
      throw new Error('다운로드한 GPU 런타임에서 필수 DLL을 찾지 못했습니다.')
    }
    return { source: 'download', dir: targetDir }
  } finally {
    rmSync(baseTmp, { recursive: true, force: true })
  }
}
