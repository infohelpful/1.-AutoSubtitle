import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, utimes, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { connect } from './cdp.mjs'

const artifacts = resolve('tools/sync-validation-output')
const profile = await mkdtemp(join(artifacts, 'cache-startup-'))
const prepared = join(profile, 'PreparedMedia'), waveform = join(profile, 'WaveformCache')
await Promise.all([mkdir(prepared), mkdir(waveform)])
const old = join(prepared, 'a'.repeat(64) + '.wav')
const oldPreview = join(prepared, 'a'.repeat(64) + '.mp4')
const work = join(waveform, 'a'.repeat(32) + '.autosub-peaks.json.12345678-1234-1234-1234-123456789abc.work.json.part')
const unrelated = join(prepared, 'user-video.mp4')
for (const path of [old, oldPreview, work, unrelated]) {
  await writeFile(path, 'retention fixture')
  await utimes(path, new Date(0), new Date(0))
}
const exe = resolve('node_modules/electron/dist/electron.exe')
const args = ['scripts/e2e-cdp/launch-test-app.cjs', '--remote-debugging-port=9334', `--user-data-dir=${profile}`]
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1',
  AUTOSUBTITLE_E2E_PROJECT: join(artifacts, 'real-video-fixture.autosub'),
  AUTOSUBTITLE_E2E_OUTPUT: join(profile, 'unused.mp4'), AUTOSUBTITLE_E2E_OPEN_QUEUE: '[]' }
delete env.AUTOSUBTITLE_E2E_SAVE_PROJECT
function start() {
  const child = spawn(exe, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let error = ''
  child.stderr.on('data', data => { error = (error + data).slice(-4000) })
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolveDone({ code, error }))
  })
  return { child, done }
}
const first = start()
let c
try {
  for (let i = 0; i < 100; i++) {
    try { c = await connect(9334); break } catch { await new Promise(r => setTimeout(r, 100)) }
  }
  assert.ok(c, 'Primary editor must start')
  await assert.rejects(access(old))
  await assert.rejects(access(oldPreview))
  await assert.rejects(access(work))
  await access(unrelated)
  // New work appears while this session is alive. A duplicate process must not
  // prune it, even when its timestamp looks old.
  const active = join(prepared, 'b'.repeat(64) + '.wav')
  await writeFile(active, 'active session marker')
  await utimes(active, new Date(0), new Date(0))
  const second = start()
  let timer
  const duplicate = await Promise.race([second.done, new Promise((_, reject) => {
    timer = setTimeout(() => { second.child.kill(); reject(new Error('Duplicate editor did not exit')) }, 10000)
  })]).finally(() => clearTimeout(timer))
  assert.equal(duplicate.code, 0, duplicate.error)
  await access(active)
  assert.ok(await c.evaluate('!!window.api'), 'Primary editor remains available')
  console.log('PASS startup cleanup, source preservation, duplicate profile lock and active cache preservation', profile)
} finally {
  if (c) {
    await c.send('Browser.close').catch(() => {})
    c.close()
  } else first.child.kill()
  await first.done
}
