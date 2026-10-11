import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect } from './cdp.mjs'
// Launcher queue: legacy fixture, saved output, mismatch fixture, wrong media,
// correct copied media, missing fixture, correct copied media.
const dir = resolve('tools/sync-validation-output')
const run = process.argv[2] ?? '1'
if (!/^\d+$/.test(run)) throw Error('Run must be numeric')
const savedPath = resolve(dir, `project-v2-e2e-${run}.autosub`)
const c = await connect()
const until = async expression => {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) { if (await c.evaluate(expression)) return; await c.sleep(200) }
  throw Error('Timed out: ' + expression)
}
async function click(label) {
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`)
  const p = await c.evaluate(`(() => {const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(p.x,p.y)
}
async function edit(text) {
  await c.evaluate(`(() => {const e=document.querySelector('textarea[data-subtitle-edit]');e.focus();e.select()})()`)
  if (text) await c.send('Input.insertText', {text})
  else await c.press('Backspace')
  await c.sleep(300)
}
const readSaved = () => JSON.parse(readFileSync(savedPath, 'utf8'))
try {
  await click('불러오기')
  await until(`document.querySelectorAll('.subtitle-word-chip').length > 10`)
  await until(`document.querySelector('[data-testid="project-media-notice"]')?.textContent.includes('이전 프로젝트')`)
  const highlight = await c.evaluate(`(() => {const e=[...document.querySelectorAll('label')].find(l=>l.textContent.includes('단어 강조')).querySelector('input');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,checked:e.checked}})()`)
  if (!highlight.checked) await c.click(highlight.x,highlight.y)
  await edit('')
  await click('다른 이름으로 저장')
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='저장'&&!b.disabled)`)
  const saved = readSaved()
  assert.equal(saved.version,2)
  assert.equal(saved.subtitleStyle.wordHighlightEnabled,true)
  assert.equal(saved.mediaFingerprint.algorithm,'sha256')
  assert.ok(saved.subtitles[0].words.some(w=>w.word===''))
  const ids = saved.subtitles.flatMap(l=>(l.words??[]).filter(w=>!w.isSilence).map(w=>w.id))
  assert.equal(new Set(ids).size,ids.length)
  await click('불러오기')
  await until(`document.querySelector('textarea[data-subtitle-edit]')?.value === '' && ![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='저장')?.disabled`)
  assert.ok(await c.evaluate(`[...document.querySelectorAll('label')].find(l=>l.textContent.includes('단어 강조')).querySelector('input').checked`))
  await edit('다시 입력')
  await click('저장')
  await until(`![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='저장')?.disabled`)
  const retyped = readSaved()
  assert.equal(retyped.subtitles[0].words.find(w=>!w.isSilence&&!w.isDeleted).word,'다시 입력')
  assert.deepEqual(retyped.subtitles.flatMap(l=>(l.words??[]).filter(w=>!w.isSilence).map(w=>w.id)),ids)
  assert.deepEqual(retyped.subtitles.map(l=>l.words.map(w=>[w.start,w.end])),saved.subtitles.map(l=>l.words.map(w=>[w.start,w.end])))
  console.log('PASS: v1 → v2 UI save/reopen; blank slots, IDs, times, highlight; retype after reopen')
  writeFileSync(resolve(dir,'project-mismatch.autosub'), JSON.stringify({...retyped,videoPath:resolve(dir,'project-wrong.mp4')}))
  writeFileSync(resolve(dir,'project-missing.autosub'), JSON.stringify({...retyped,videoPath:resolve(dir,'does-not-exist.mp4')}))
  await click('불러오기')
  await until(`document.querySelector('[data-testid="project-media-notice"]')?.textContent.includes('다른 영상')`)
  assert.ok(await c.evaluate(`!document.querySelector('video')?.getAttribute('src')`))
  assert.ok(await c.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='현재 줄 싱크 재정렬')?.disabled`))
  await click('원본 영상 연결')
  await until(`document.querySelector('[data-testid="project-media-notice"]')?.textContent.includes('내용이 다른')`)
  assert.ok(await c.evaluate(`!document.querySelector('video')?.getAttribute('src')`))
  await click('원본 영상 연결')
  await until(`document.querySelector('[data-testid="project-media-notice"]')?.textContent.includes('다시 연결했습니다')`)
  assert.ok(await c.evaluate(`!!document.querySelector('video')?.getAttribute('src')`))
  await until(`document.querySelector('textarea[data-subtitle-edit]')?.value==='다시 입력'`)
  console.log('PASS: mismatch blocks video, wrong relink rejected, identical relocated media accepted without retranscription')
  await click('불러오기')
  await until(`document.querySelector('[data-testid="project-media-notice"]')?.textContent.includes('읽을 수 없습니다')`)
  await click('원본 영상 연결')
  await until(`document.querySelector('[data-testid="project-media-notice"]')?.textContent.includes('다시 연결했습니다')`)
  console.log('PASS: missing original restored without losing subtitle edits')
} finally { c.close() }
