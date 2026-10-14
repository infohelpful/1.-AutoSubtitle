import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect } from './cdp.mjs'

// Launcher open queue: false-silence-guard-{cut,deleted,manual}.autosub.
// Save target must be a fresh private test output, never a user's original.
const saved = resolve(process.argv[2] ?? 'tools/sync-validation-output/false-silence-guard-saved.autosub')
assert.ok(!existsSync(saved), 'Choose a fresh output and matching launcher environment')
const c = await connect()
async function until(expression) {
  for (let i=0;i<300;i++) { if (await c.evaluate(expression)) return; await c.sleep(100) }
  throw new Error('Timeout: '+expression)
}
async function button(label) {
  const find = `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`
  await until(`!!(${find}) && !(${find}).disabled`)
  await c.evaluate(`(${find}).click()`)
}
async function save() {
  const previous = existsSync(saved) ? readFileSync(saved,'utf8') : null
  await button('다른 이름으로 저장')
  for (let i=0;i<300;i++) {
    if (existsSync(saved)) {
      const content=readFileSync(saved,'utf8')
      if (content!==previous) return JSON.parse(content)
    }
    await c.sleep(100)
  }
  throw new Error('Save did not complete')
}
try {
  for (const kind of ['cut','deleted','manual']) {
    await button('불러오기')
    await c.sleep(250)
    await until(`document.querySelector('video')?.readyState>=2 && document.querySelectorAll('.subtitle-word-chip').length>10`)
    const before=await save()
    const words=before.subtitles.flatMap(l=>l.words??[])
    if (kind==='cut') assert.deepEqual(before.cutRanges,[{start:.1,end:.2}])
    if (kind==='deleted') assert.ok(words.some(w=>w.isDeleted))
    if (kind==='manual') assert.ok(words.some(w=>w.isSilence&&w.manualStartLocked&&w.manualEndLocked))
    await button('무음 다시 확인')
    await until(`document.querySelector('[role="status"]')?.textContent.includes('컷·삭제·무음 경계 편집이 없는')`)
    const after=await save()
    delete before.savedAt; delete after.savedAt
    assert.deepEqual(after,before,kind+' edits must be preserved')
    writeFileSync(`tools/sync-validation-output/false-silence-guard-${kind}-result.json`,JSON.stringify({kind,protected:true}))
    console.log('PASS '+kind+' edit survives recheck and save/reopen serialization')
  }
} finally { c.close() }
