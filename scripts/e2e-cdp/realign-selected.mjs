import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {connect} from './cdp.mjs'
const output=resolve(process.argv[2]??'tools/sync-validation-output/selected-word-result.autosub')
const c=await connect()
async function until(expression) {
  const deadline=Date.now()+180000
  while(Date.now()<deadline){if(await c.evaluate(expression))return;await c.sleep(200)}
  throw Error('Timeout: '+expression+'; '+await c.evaluate(`document.body.innerText.slice(-2000)`))
}
async function click(label) {
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`)
  const p=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(p.x,p.y)
}
async function save(as=false) {
  await click(as?'다른 이름으로 저장':'저장')
  await until(`![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='저장')?.disabled`)
  return JSON.parse(readFileSync(output,'utf8'))
}
async function hotkey(key) {
  await c.evaluate(`document.activeElement.blur()`)
  const data={key,code:'Key'+key.toUpperCase(),modifiers:2,windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0)}
  await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...data})
  await c.send('Input.dispatchKeyEvent',{type:'keyUp',...data})
  await c.sleep(150)
}
try {
  await c.sleep(1000)
  await click('불러오기')
  await until(`document.querySelector('textarea[data-subtitle-edit]')?.value.includes('3배')&&!document.querySelector('.preview-play-btn').disabled`)
  await click('발음 입력')
  const selected=await c.evaluate(`document.querySelector('select[aria-label="발음 입력할 단어"]').selectedOptions[0].textContent`)
  assert.ok(selected.startsWith('3배'))
  await c.evaluate(`document.querySelector('input[aria-label="실제 발음"]').focus()`)
  await c.send('Input.insertText',{text:'세배'})
  await click('발음 적용')
  const before=await save(true), target=before.subtitles[0].words.find(w=>w.word==='3배')
  await click('선택 단어 싱크 재정렬')
  await until(`document.body.innerText.includes('정렬 완료 ·')`)
  const after=await save(), updated=after.subtitles[0].words.find(w=>w.id===target.id)
  assert.equal(updated.alignmentStatus,'aligned')
  assert.equal(updated.alignmentText,'세배')
  assert.ok(updated.charSpans.length)
  assert.deepEqual(after.subtitles[0].words.filter(w=>w.id!==target.id),before.subtitles[0].words.filter(w=>w.id!==target.id))
  await hotkey('z')
  assert.deepEqual((await save()).subtitles,before.subtitles)
  await hotkey('y')
  assert.deepEqual((await save()).subtitles,after.subtitles)
  console.log('PASS selected stable-ID real alignment, untouched context words and complete Undo/Redo')
  await c.evaluate(`(()=>{const s=document.querySelector('select[aria-label="발음 입력할 단어"]');s.value=s.options[0].value;s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await c.evaluate(`document.querySelector('input[aria-label="실제 발음"]').focus()`)
  await c.send('Input.insertText',{text:'그리고'})
  await click('발음 적용')
  const checkbox=await c.evaluate(`(()=>{const e=document.querySelector('input[aria-label="그리고 정렬 선택"]');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(checkbox.x,checkbox.y)
  const ids=await c.evaluate(`[...document.querySelectorAll('input[data-alignment-word-id]:checked')].map(e=>e.dataset.alignmentWordId)`)
  assert.equal(ids.length,2)
  const beforeMulti=await save()
  await click('선택 단어 싱크 재정렬')
  await until(`document.body.innerText.includes('정렬 완료 ·')`)
  const afterMulti=await save()
  assert.ok(afterMulti.subtitles[0].words.filter(w=>ids.includes(w.id)).every(w=>w.alignmentStatus==='aligned'))
  assert.deepEqual(afterMulti.subtitles[0].words.filter(w=>!ids.includes(w.id)),beforeMulti.subtitles[0].words.filter(w=>!ids.includes(w.id)))
  await hotkey('z')
  assert.deepEqual((await save()).subtitles,beforeMulti.subtitles)
  await hotkey('y')
  assert.deepEqual((await save()).subtitles,afterMulti.subtitles)
  const shot=await c.send('Page.captureScreenshot',{format:'png'})
  writeFileSync(output+'.png',Buffer.from(shot.result.data,'base64'))
  console.log('PASS disjoint multi-selection and Undo/Redo; all nonselected words preserved')
} finally {c.close()}
