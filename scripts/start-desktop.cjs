// Explorer drops cannot cross into an elevated editor. Require normal Windows
// integrity instead of weakening UIPI or changing system security settings.
const { spawnSync, spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { resolve, join } = require('node:path')

function startDesktop() {
  const root = resolve(__dirname, '..')
  if (process.platform !== 'win32') throw new Error('이 실행기는 Windows용입니다.')
  const whoami = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe')
  const token = spawnSync(whoami, ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  const integrity = /S-1-16-(\d+)/.exec(token.stdout || '')
  if (token.error || token.status !== 0 || !integrity) throw new Error('실행 권한을 확인하지 못했습니다.')
  if (Number(integrity[1]) >= 12288) {
    throw new Error('관리자 권한에서는 탐색기 파일 드롭이 차단됩니다. 이 창을 닫고 탐색기에서 start-autosubtitle.cmd를 일반 더블클릭으로 실행해 주세요.')
  }
  const exe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  for (const file of [exe, join(root, 'out', 'main', 'index.js'), join(root, 'out', 'renderer', 'index.html')]) {
    if (!existsSync(file)) throw new Error('앱 실행 파일이 없습니다. 프로젝트에서 npm install 및 npm run build를 먼저 실행해 주세요.')
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, [root], { cwd: root, env, detached: true, windowsHide: true, stdio: 'ignore' })
  child.once('error', error => { console.error(`앱 실행 실패: ${error.message}`); process.exitCode = 1 })
  child.unref()
  console.log('AutoSubtitle을 일반 권한으로 실행합니다.')
}

try { startDesktop() } catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
