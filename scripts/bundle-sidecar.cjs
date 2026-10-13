/** Build in isolation and replace the helper only after JSON-RPC validation. */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function buildSidecar({ root = path.resolve(__dirname, '..'), run = spawnSync, env = process.env } = {}) {
  const sidecarDir = path.join(root, 'python_sidecar')
  const distDir = path.join(sidecarDir, 'dist')
  const destDir = path.join(root, 'resources', 'bin')
  const exeName = process.platform === 'win32' ? 'main.exe' : 'main'
  const pythonRelative = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  const localPython = ['.venv-sidecar-build', '.venv-alignment'].map(name => path.join(root, name, ...pythonRelative))
    .find(candidate => fs.existsSync(candidate))
  const python = env.AUTOSUBTITLE_BUILD_PYTHON || env.PYTHON_PATH || localPython || (process.platform === 'win32' ? 'python' : 'python3')
  fs.mkdirSync(distDir, { recursive: true })
  const buildDir = fs.mkdtempSync(path.join(distDir, 'build-'))
  const built = path.join(buildDir, 'dist', exeName)
  const dest = path.join(destDir, exeName)
  const staging = path.join(destDir, `${exeName}.${randomUUID()}.tmp`)
  try {
    console.log('[bundle-sidecar] Building with', python)
    const result = run(python, ['-m', 'PyInstaller', '--noconfirm', '--clean',
      '--distpath', path.join(buildDir, 'dist'), '--workpath', path.join(buildDir, 'work'), 'main.spec'], {
      cwd: sidecarDir, stdio: 'inherit', shell: false, windowsHide: true, env, timeout: 30 * 60_000
    })
    if (result.error || result.status !== 0) {
      throw new Error(`PyInstaller failed: ${result.error?.message || result.signal || result.status}. Set AUTOSUBTITLE_BUILD_PYTHON to a Python with PyInstaller and sidecar requirements installed.`)
    }
    if (!fs.existsSync(built) || fs.statSync(built).size === 0) throw new Error('PyInstaller produced no executable')
    const smokeRequests = [{ id: 'bundle-smoke', method: 'get_model_status', params: {} },
      { id: 'runtime-smoke', method: 'runtime_check', params: {} }]
    const smoke = run(built, [], { input: smokeRequests.map(request => JSON.stringify(request)).join('\n') + '\n',
      encoding: 'utf8', shell: false, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...env, PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', AUTOSUBTITLE_MODELS_DIR: path.join(buildDir, 'empty-models') } })
    if (smoke.error || smoke.status !== 0) throw new Error(`Built sidecar did not start: ${smoke.error?.message || smoke.stderr || smoke.status}`)
    let replies
    try { replies = smoke.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)) } catch { throw new Error('Built sidecar did not return clean JSON-RPC') }
    const [reply, runtime] = replies
    if (replies.length !== 2 || reply.id !== 'bundle-smoke' || reply.error || typeof reply.result?.loaded !== 'boolean') {
      throw new Error('Built sidecar returned an invalid model status')
    }
    if (runtime.id !== 'runtime-smoke' || runtime.error || runtime.result?.audioDecode !== true ||
      runtime.result?.alignmentSources !== true || runtime.result?.vadAsset !== true) {
      throw new Error(`Built sidecar runtime check failed: ${JSON.stringify(runtime)}`)
    }
    fs.mkdirSync(destDir, { recursive: true })
    fs.copyFileSync(built, staging)
    fs.renameSync(staging, dest)
    console.log('[bundle-sidecar] RPC verified; installed', dest)
    return dest
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging)
    const relative = path.relative(path.resolve(distDir), path.resolve(buildDir))
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe build cleanup path')
    fs.rmSync(buildDir, { recursive: true, force: true })
  }
}

module.exports = { buildSidecar }
if (require.main === module) {
  try { buildSidecar() } catch (error) { console.error('[bundle-sidecar]', error.message); process.exitCode = 1 }
}
