import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from './cdp.mjs'

const saved = process.env.AUTOSUBTITLE_SYNC_SAVE ?? 'tools/sync-validation-output/sync-684-aligned-test.autosub'
const c = await connect()
async function until(expr, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await c.evaluate(expr)) return
    await c.sleep(250)
  }
  throw Error('Timeout: ' + expr)
}
async function button(label) {
  const find=`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`
  await until(`!!(${find})&&!(${find}).disabled`)
  await c.evaluate(`(${find}).click()`)
}
async function save() {
  const before=existsSync(saved)?readFileSync(saved,'utf8'):''
  await button('다른 이름으로 저장')
  for(let i=0;i<200;i++) {
    if(existsSync(saved)) {const text=readFileSync(saved,'utf8');if(text!==before)return JSON.parse(text)}
    await c.sleep(100)
  }
  throw Error('Save timeout')
}
async function hotkey(key) {
  await c.evaluate('document.activeElement?.blur()')
  for(const type of ['rawKeyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key,code:'Key'+key.toUpperCase(),windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0),modifiers:2})
  await c.sleep(250)
}
async function seek(time) {
  await c.evaluate(`(() => {const el=document.querySelector('.preview-seek');el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${time});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await c.sleep(600)
  await until(`!document.querySelector('video').seeking`)
  return c.evaluate(`document.querySelector('video').currentTime`)
}
try {
  let original, aligned
  if (process.env.AUTOSUBTITLE_SYNC_RESUME === '1') {
    original=JSON.parse(readFileSync('tools/sync-validation-output/sync-684-before-realign.autosub','utf8'))
    aligned=JSON.parse(readFileSync('tools/sync-validation-output/sync-684-after-realign.autosub','utf8'))
  } else {
  await button('불러오기')
  await until(`document.querySelectorAll('.subtitle-word-chip').length>10&&document.querySelector('video').readyState>=2`)
  original=await save()
  writeFileSync('tools/sync-validation-output/sync-684-before-realign.autosub',JSON.stringify(original))
  await button('전체 자막 싱크 재정렬')
  await button('정렬 취소')
  assert.deepEqual((await save()).subtitles,original.subtitles)
  console.log('PASS: full-project cancellation is atomic')
  await button('전체 자막 싱크 재정렬')
  await until(`document.body.innerText.includes('줄 정렬 완료 ·')`,600000)
  aligned=await save()
  assert.equal(aligned.subtitles.length,original.subtitles.length)
  assert.notDeepEqual(aligned.subtitles,original.subtitles)
  for(let i=0;i<original.subtitles.length;i++) {
    const a=original.subtitles[i],b=aligned.subtitles[i]
    assert.equal(b.text,a.text)
    if(a.words.every(w=>w.isSilence||w.isDeleted))assert.deepEqual(b,a)
    a.words.forEach((w,j)=>{if(w.manualStartLocked)assert.equal(b.words[j].start,w.start);if(w.manualEndLocked)assert.equal(b.words[j].end,w.end)})
  }
  writeFileSync('tools/sync-validation-output/sync-684-after-realign.autosub',JSON.stringify(aligned))
  console.log('PASS: whole project realignment',aligned.subtitles.length)
  }
  await hotkey('z');assert.deepEqual((await save()).subtitles,original.subtitles)
  await hotkey('y');assert.deepEqual((await save()).subtitles,aligned.subtitles)
  console.log('PASS: whole project Undo/Redo')

  const duration=await c.evaluate(`+document.querySelector('.preview-seek').max`)
  await seek(12.1)
  await c.evaluate(`document.querySelector('.subtitle-virtual-list').scrollTop=0`)
  await c.sleep(300)
  await c.evaluate(`document.getElementById('subtitle-caret-1-0').focus()`)
  await c.press('Delete')
  const edited=await save()
  const deleted=edited.subtitles.flatMap(l=>l.words??[]).filter(w=>w.isDeleted)
  assert.equal(deleted.length,1)
  const gap=deleted[0].end-deleted[0].start
  assert.ok(Math.abs(await c.evaluate(`+document.querySelector('.preview-seek').max`)-(duration-gap))<.002)
  for(const t of [300,480,600]) {
    const actual=await seek(t)
    assert.ok(Math.abs(actual-t-gap)<.015,JSON.stringify({t,actual,gap}))
  }
  await hotkey('z')
  assert.deepEqual((await save()).subtitles,aligned.subtitles)
  console.log('PASS: cut-aware slider converts program time exactly once at 300/480/600 seconds')
  await button('자동 줄바꿈')
  const split=await save()
  assert.ok(split.subtitles.length>aligned.subtitles.length)
  assert.deepEqual(split.subtitles.flatMap(l=>l.words),aligned.subtitles.flatMap(l=>l.words))
  console.log('PASS: auto line break preserves every word/audio timestamp',split.subtitles.length)
} finally {c.close()}
