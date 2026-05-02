/**
 * PyInstaller로 python_sidecar 를 빌드한 뒤 resources/bin 에 복사한다.
 * npm run dist 가 항상 최신 main.exe 를 넣도록 하기 위함(수동 복사 누락 방지).
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const sidecarDir = path.join(root, 'python_sidecar')
const distDir = path.join(sidecarDir, 'dist')
const destDir = path.join(root, 'resources', 'bin')

const exeName = process.platform === 'win32' ? 'main.exe' : 'main'
const built = path.join(distDir, exeName)
const dest = path.join(destDir, exeName)

console.log('[bundle-sidecar] pyinstaller main.spec …')
const r = spawnSync('pyinstaller', ['--noconfirm', 'main.spec'], {
  cwd: sidecarDir,
  stdio: 'inherit',
  shell: true,
  env: process.env
})
if (r.status !== 0 && r.status != null) {
  process.exit(r.status)
}
if (!fs.existsSync(built)) {
  console.error('[bundle-sidecar] 빌드 산출물 없음:', built)
  process.exit(1)
}
fs.mkdirSync(destDir, { recursive: true })
fs.copyFileSync(built, dest)
console.log('[bundle-sidecar] 복사 완료', built, '→', dest)
