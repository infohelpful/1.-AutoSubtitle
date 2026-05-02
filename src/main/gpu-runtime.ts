import { app, net } from 'electron'
import { logMain } from './app-log'
import { mergeEnvFromFile } from './dotenv-merge'
import { spawn } from 'node:child_process'
import { createWriteStream, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'

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
  const token =
    process.env.AUTOSUB_GPU_DLL_ZIP_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim()
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

/** Chromium 네트워크 스택 — 설치본에서 Node `https`와 달리 시스템 프록시·인증서에 맞춰 동작 */
async function netFetchBuffer(url: string, headers: Record<string, string>): Promise<{
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}> {
  const res = await net.fetch(url, { headers })
  const buf = Buffer.from(await res.arrayBuffer())
  const h: Record<string, string | string[] | undefined> = {}
  res.headers.forEach((value, key) => {
    h[key] = value
  })
  return {
    statusCode: res.status,
    headers: h,
    body: buf
  }
}

async function streamNetResponseToFile(
  res: Awaited<ReturnType<typeof net.fetch>>,
  outFile: string,
  onProgress?: (pct: number) => void
): Promise<void> {
  if (!res.body) throw new Error('GPU 런타임 다운로드: 응답 본문이 없습니다.')
  const total = parseInt(res.headers.get('content-length') ?? '', 10)
  let received = 0
  const webBody = res.body as import('stream/web').ReadableStream<Uint8Array>
  const nodeReadable = Readable.fromWeb(webBody)
  const countStream = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      received += chunk.length
      if (onProgress && Number.isFinite(total) && total > 0) {
        onProgress(Math.min(100, (received / total) * 100))
      }
      callback(null, chunk)
    }
  })
  const ws = createWriteStream(outFile)
  await pipeline(nodeReadable, countStream, ws)
  onProgress?.(100)
}

function githubApiErrorSnippet(body: Buffer, max = 220): string {
  const t = body.toString('utf8').replace(/\s+/g, ' ').slice(0, max)
  return t.length ? ` body=${t}` : ''
}

/** `/releases/latest` 가 404여도, draft가 아닌 릴리스 목록에 에셋이 있으면 찾을 수 있음 */
async function findAssetIdFromReleasesList(
  owner: string,
  repo: string,
  assetName: string,
  apiHeaders: Record<string, string>
): Promise<{ id: number; tag_name?: string } | null> {
  const listUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=50`
  const res = await netFetchBuffer(listUrl, apiHeaders)
  logMain('gpu-http', 'GitHub API GET releases (페이지 목록)', `HTTP ${res.statusCode}${githubApiErrorSnippet(res.body)}`)
  if (res.statusCode < 200 || res.statusCode >= 300) return null
  const arr = JSON.parse(res.body.toString('utf8')) as Array<{
    tag_name?: string
    draft?: boolean
    assets?: Array<{ id?: number; name?: string }>
  }>
  for (const rel of arr) {
    if (rel.draft) continue
    const a = (rel.assets ?? []).find((x) => x?.name === assetName)
    if (a?.id) return { id: a.id, tag_name: rel.tag_name }
  }
  return null
}

async function downloadGithubReleaseAssetByApiId(
  owner: string,
  repo: string,
  assetId: number,
  outFile: string,
  baseHeaders: Record<string, string>,
  onProgress?: (pct: number) => void
): Promise<void> {
  const assetApiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`
  const assetHeaders = { ...baseHeaders, Accept: 'application/octet-stream' }
  const fetchRes = await net.fetch(assetApiUrl, { headers: assetHeaders })
  if (fetchRes.status >= 300 && fetchRes.status < 400) {
    const loc = fetchRes.headers.get('location')
    if (loc) {
      await downloadToFile(loc, outFile, 0, onProgress)
      return
    }
  }
  if (!fetchRes.ok) {
    throw new Error(`GPU 에셋 다운로드 실패(API): HTTP ${fetchRes.status}`)
  }
  await streamNetResponseToFile(fetchRes, outFile, onProgress)
}

async function downloadGithubAssetViaApi(
  info: { owner: string; repo: string; tag: string; assetName: string },
  outFile: string,
  onProgress?: (pct: number) => void
): Promise<void> {
  const headers = buildDownloadHeaders()
  const apiHeaders = { ...headers, Accept: 'application/vnd.github+json' as const }
  const base = `https://api.github.com/repos/${info.owner}/${info.repo}/releases`
  const tagUrl = `${base}/tags/${encodeURIComponent(info.tag)}`
  let releaseRes = await netFetchBuffer(tagUrl, apiHeaders)
  logMain('gpu-http', `GitHub API GET tags/${info.tag}`, `HTTP ${releaseRes.statusCode}${githubApiErrorSnippet(releaseRes.body)}`)
  let usedSource: 'tag' | 'latest' | 'list' = 'tag'
  let latestStatus = 0
  if (releaseRes.statusCode === 404) {
    const latestUrl = `${base}/latest`
    releaseRes = await netFetchBuffer(latestUrl, apiHeaders)
    latestStatus = releaseRes.statusCode
    usedSource = 'latest'
    logMain('gpu-http', 'GitHub API GET releases/latest', `HTTP ${releaseRes.statusCode}${githubApiErrorSnippet(releaseRes.body)}`)
  }
  if (releaseRes.statusCode < 200 || releaseRes.statusCode >= 300) {
    logMain('gpu-http', 'tags/latest 실패 → releases 목록에서 에셋 검색')
    const found = await findAssetIdFromReleasesList(info.owner, info.repo, info.assetName, apiHeaders)
    if (found) {
      logMain('gpu-http', '목록에서 에셋 발견', `tag=${found.tag_name ?? '?'} assetId=${found.id}`)
      await downloadGithubReleaseAssetByApiId(info.owner, info.repo, found.id, outFile, headers, onProgress)
      return
    }
    throw new Error(
      `GitHub 릴리스 메타 조회 실패: HTTP ${releaseRes.statusCode} (태그·latest·목록 모두에서 에셋을 찾지 못함; latest=${latestStatus || '시도안함'})`
    )
  }
  const releaseJson = JSON.parse(releaseRes.body.toString('utf8')) as {
    tag_name?: string
    assets?: Array<{ id?: number; name?: string }>
  }
  let asset = (releaseJson.assets ?? []).find((a) => a?.name === info.assetName)
  if (!asset?.id) {
    logMain('gpu-http', '해당 릴리스에 파일 없음 → 전체 목록에서 재검색')
    const found = await findAssetIdFromReleasesList(info.owner, info.repo, info.assetName, apiHeaders)
    if (found) {
      await downloadGithubReleaseAssetByApiId(info.owner, info.repo, found.id, outFile, headers, onProgress)
      return
    }
    const names = (releaseJson.assets ?? []).map((a) => a?.name).filter(Boolean).join(', ')
    const hint =
      usedSource === 'latest'
        ? `latest 릴리스(${releaseJson.tag_name ?? '?'})`
        : `태그 ${info.tag} 릴리스`
    throw new Error(
      `GPU 릴리스에 파일「${info.assetName}」이 없습니다(${hint}). ` +
        `Assets에 있는 실제 파일 이름을 확인하세요. ` +
        (names ? `현재 에셋: ${names}` : '에셋 목록이 비어 있습니다.')
    )
  }
  await downloadGithubReleaseAssetByApiId(info.owner, info.repo, asset.id, outFile, headers, onProgress)
}

async function downloadToFile(
  urlText: string,
  outFile: string,
  _redirects = 0,
  onProgress?: (pct: number) => void
): Promise<void> {
  /** manual 리다이렉트는 GitHub→objects.githubusercontent.com 등에서 Electron이 `Redirect was cancelled` 로 끊는 경우가 있음 */
  const res = await net.fetch(urlText, {
    headers: buildDownloadHeaders(),
    redirect: 'follow'
  })
  const code = res.status
  const finalU = (res.url ?? '').slice(0, 220)
  logMain('gpu-http', 'GET redirect=follow', `HTTP ${code} req=${urlText.slice(0, 120)}… final=${finalU}`)
  if (code === 401 || code === 403 || code === 404) {
    const gh = parseGithubReleaseAssetUrl(urlText)
    if (gh) {
      logMain('gpu-http', '직링크 실패 → GitHub API 폴백', `${code} parse=${gh.owner}/${gh.repo}@${gh.tag}`)
      await downloadGithubAssetViaApi(gh, outFile, onProgress)
      return
    }
    throw new Error(
      `GPU 런타임 다운로드 실패: HTTP ${code}. URL·릴리스·네트워크를 확인하세요. ` +
        `GitHub API 제한(403)이면 잠시 후 재시도하거나 AUTOSUB_GPU_DLL_ZIP_TOKEN을 설정할 수 있습니다.`
    )
  }
  if (!res.ok) {
    throw new Error(`GPU 런타임 다운로드 실패: HTTP ${code}`)
  }
  await streamNetResponseToFile(res, outFile, onProgress)
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
  /** 0–100 퍼센트와 단계 설명 (UI 진행 표시용) */
  onProgress?: (pct: number, stage: string) => void
}): Promise<{ source: 'local' | 'download' | 'existing'; dir: string }> {
  mergeEnvFromFile(join(app.getPath('userData'), '.env'))
  const report = (pct: number, stage: string) => options.onProgress?.(pct, stage)
  const targetDir = getGpuRuntimeDir()
  logMain(
    'gpu-runtime',
    'install 시작',
    `packaged=${app.isPackaged} targetDir=${targetDir} zipUrl=${options.zipUrl ?? '(없음)'} localDirs=${(options.localCandidates ?? []).join('; ')}`
  )
  mkdirSync(targetDir, { recursive: true })
  if (isGpuRuntimeInstalled()) {
    logMain('gpu-runtime', '이미 DLL 있음 — 스킵')
    report(100, '이미 설치됨')
    return { source: 'existing', dir: targetDir }
  }

  for (const dir of options.localCandidates) {
    if (hasRequiredDlls(dir)) {
      logMain('gpu-runtime', '로컬 후보에서 복사', dir)
      report(25, '로컬 GPU DLL 복사')
      cpSync(dir, targetDir, { recursive: true })
      if (!isGpuRuntimeInstalled()) {
        logMain('gpu-runtime', '로컬 복사 후 검증 실패')
        throw new Error('로컬 DLL 복사 후 필수 GPU 런타임 파일 확인에 실패했습니다.')
      }
      report(100, '완료')
      logMain('gpu-runtime', '로컬 복사 완료', targetDir)
      return { source: 'local', dir: targetDir }
    }
  }

  if (!options.zipUrl) {
    logMain('gpu-runtime', 'zipUrl 없음 — 중단')
    throw new Error('GPU 런타임 소스를 찾지 못했습니다. dll 폴더를 두거나 AUTOSUB_GPU_DLL_ZIP_URL을 설정해 주세요.')
  }

  const baseTmp = join(tmpdir(), `autosub-gpu-${randomUUID()}`)
  const zipPath = join(baseTmp, 'gpu-runtime.zip')
  const extracted = join(baseTmp, 'expanded')
  mkdirSync(baseTmp, { recursive: true })
  mkdirSync(extracted, { recursive: true })
  try {
    report(0, '다운로드 준비')
    logMain('gpu-runtime', '다운로드 시작', options.zipUrl)
    await downloadToFile(options.zipUrl, zipPath, 0, (p) => {
      report(5 + (p / 100) * 60, 'GPU 런타임 다운로드')
    })
    logMain('gpu-runtime', 'ZIP 저장 완료', zipPath)
    report(68, '압축 해제')
    await expandZipOnWindows(zipPath, extracted)
    logMain('gpu-runtime', '압축 해제 완료', extracted)
    report(82, '설치 경로로 복사')
    const sourceDir = findDirectoryContainingRequiredDlls(extracted)
    if (!sourceDir) {
      logMain('gpu-runtime', 'ZIP 안에서 cublas 등 필수 DLL 폴더를 찾지 못함')
      throw new Error('다운로드한 ZIP 내부에서 필수 GPU DLL 위치를 찾지 못했습니다.')
    }
    logMain('gpu-runtime', '복사 소스', sourceDir)
    cpSync(sourceDir, targetDir, { recursive: true })
    if (!isGpuRuntimeInstalled()) {
      logMain('gpu-runtime', '복사 후에도 필수 DLL 없음')
      throw new Error('다운로드한 GPU 런타임에서 필수 DLL을 찾지 못했습니다.')
    }
    report(100, '완료')
    logMain('gpu-runtime', '원격 설치 완료', targetDir)
    return { source: 'download', dir: targetDir }
  } catch (e) {
    logMain('gpu-runtime', '다운로드/압축/복사 단계 예외', e)
    throw e
  } finally {
    rmSync(baseTmp, { recursive: true, force: true })
  }
}
