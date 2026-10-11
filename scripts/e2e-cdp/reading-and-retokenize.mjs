import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect } from './cdp.mjs'
const output = resolve(process.argv[2] ?? 'tools/sync-validation-output/reading-result.autosub')
const c = await connect()
const until = async expression => {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) { if(await c.evaluate(expression)) return; await c.sleep(250) }
  throw Error('Timeout: ' + expression)
}
async function click(label) {
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`)
  const p=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(p.x,p.y)
}
async function save(as=false) {
  await click(as?'다른 이름으로 저장':'저장')
  await until(`![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='저장')?.disabled`)
  return JSON.parse(readFileSync(output,'utf8'))
}
async function hotkey(key) {
  await c.evaluate(`document.activeElement?.blur()`)
  const data={key,code:'Key'+key.toUpperCase(),modifiers:2,windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0)}
  await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...data})
  await c.send('Input.dispatchKeyEvent',{type:'keyUp',...data})
  await c.sleep(250)
}
try {
  await click('불러오기')
  await until(`document.querySelector('textarea[data-subtitle-edit]')?.value.includes('3배')`)
  const original=await c.evaluate(`document.querySelector('textarea[data-subtitle-edit]').value`)
  await click('발음 입력')
  assert.ok(await c.evaluate(`document.querySelector('select[aria-label="발음 입력할 단어"]').selectedOptions[0].textContent.startsWith('3배')`))
  await c.evaluate(`document.querySelector('input[aria-label="실제 발음"]').focus()`)
  await c.send('Input.insertText',{text:'세배'})
  await click('발음 적용')
  let project=await save(true)
  const word=project.subtitles[0].words.find(w=>w.word==='3배')
  assert.equal(word.readingOverride,'세배')
  assert.equal(word.alignmentStatus,'stale')
  await hotkey('z')
  assert.equal(await c.evaluate(`document.querySelector('input[aria-label="실제 발음"]').value`),'')
  await hotkey('y')
  assert.equal(await c.evaluate(`document.querySelector('input[aria-label="실제 발음"]').value`),'세배')
  await click('이 줄 싱크 재정렬')
  await until(`document.body.innerText.includes('정렬 완료 ·')`)
  project=await save()
  const aligned=project.subtitles[0].words.find(w=>w.id===word.id)
  assert.equal(aligned.word,'3배')
  assert.equal(aligned.alignmentText,'세배')
  assert.equal(aligned.alignmentStatus,'aligned')
  assert.ok(aligned.charSpans.length)
  console.log('PASS: reading override → metadata-only undo/redo → real alignment; display 3배 preserved')
  await click('닫기')
  await c.evaluate(`(()=>{const e=document.querySelector('textarea[data-subtitle-edit]');e.focus();e.select()})()`)
  await c.press('Backspace')
  await c.send('Input.insertText',{text:original.replace('3배','세배')})
  await c.sleep(250)
  const before=await save()
  assert.equal(before.subtitles[0].words.filter(w=>!w.isDeleted&&!w.isSilence&&w.word.trim()).length,1)
  await click('현재 줄 싱크 재정렬')
  await until(`document.body.innerText.includes('정렬 완료 ·')`)
  const after=await save()
  const speech=after.subtitles[0].words.filter(w=>!w.isDeleted&&!w.isSilence&&w.word.trim())
  assert.ok(speech.length>1)
  assert.ok(speech.slice(1).every(w=>w.parentWordId===speech[0].id))
  assert.ok(speech.every(w=>w.alignmentStatus==='aligned'))
  assert.equal(new Set(speech.map(w=>w.id)).size,speech.length)
  assert.ok(speech.every((w,i)=>!i||w.start>=speech[i-1].start))
  await hotkey('z')
  assert.deepEqual((await save()).subtitles,before.subtitles)
  await hotkey('y')
  assert.deepEqual((await save()).subtitles,after.subtitles)
  console.log('PASS: rewritten phrase → measured word splitting → complete undo/redo with stable IDs')
} finally { c.close() }
