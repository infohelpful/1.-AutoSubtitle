import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { connect } from './cdp.mjs'

// Run with a private launcher save target. This output is overwritten after
// each controlled edit; never pass a source/user project as the save target.
const saved = process.argv[2]
assert.ok(saved?.includes('sync-validation-output'), 'Private save target required')
const c = await connect()
async function until(expression) {
  for(let i=0;i<300;i++){if(await c.evaluate(expression))return;await c.sleep(100)}
  throw Error('Timeout: '+expression)
}
async function click(label) {
  const find=`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`
  await until(`!!(${find})&&!(${find}).disabled`)
  await c.evaluate(`(${find}).click()`)
}
async function save() {
  const previous=readFileSync(saved,'utf8')
  await click('다른 이름으로 저장')
  for(let i=0;i<300;i++) {
    const content=readFileSync(saved,'utf8')
    if(content!==previous)return JSON.parse(content)
    await c.sleep(100)
  }
  throw Error('Save timeout')
}
try {
  await click('불러오기')
  await until(`document.querySelector('video')?.readyState>=2&&document.querySelectorAll('.subtitle-word-chip').length>10`)
  const results=[]
  for(const text of ['컴퓨터','--']) {
    const find=`[...document.querySelectorAll('.subtitle-word-chip')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`
    await c.evaluate(`${find}.scrollIntoView({block:'center'})`)
    await c.sleep(250)
    const before=await c.evaluate(`(()=>{const e=${find},r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,start:+e.dataset.wordStart,end:+e.dataset.wordEnd}})()`)
    await c.click(before.x,before.y,70)
    for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,x:before.x,y:before.y,button:'left',clickCount:2})
    await until(`document.querySelector('[data-waveform-active-word-chip="1"]')?.textContent.trim()===${JSON.stringify(text)}&&!!document.querySelector('[aria-label="구간 끝"]')`)
    await c.evaluate(`document.querySelector('.subtitle-waveform-flow-root').scrollIntoView({block:'center'})`)
    await c.sleep(300)
    const handle=await c.evaluate(`(()=>{const r=document.querySelector('[aria-label="구간 끝"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...handle,button:'left',clickCount:1})
    for(const dx of [8,16,24])await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x-dx,y:handle.y,button:'left',buttons:1})
    await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:handle.x-24,y:handle.y,button:'left',clickCount:1})
    await c.sleep(250)
    const project=await save()
    const word=project.subtitles.flatMap(l=>l.words??[]).find(w=>w.word===text&&w.start===before.start)
    assert.ok(word&&word.end<before.end-.005,JSON.stringify({before,word}))
    assert.equal(word.manualEndLocked,true)
    assert.equal(word.alignmentStatus,text==='--'?undefined:'manual')
    if(text==='--') {
      await click('무음 다시 확인')
      await until(`document.querySelector('[role="status"]')?.textContent.includes('컷·삭제·무음 경계 편집이 없는')`)
    }
    results.push({text,before:{start:before.start,end:before.end},after:word})
    await c.evaluate('document.activeElement.blur()')
    const key={key:'z',code:'KeyZ',modifiers:2,windowsVirtualKeyCode:90}
    await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...key})
    await c.send('Input.dispatchKeyEvent',{type:'keyUp',...key})
    await until(`(()=>{const e=${find};return e&&Math.abs(+e.dataset.wordEnd-${before.end})<1e-8})()`)
  }
  writeFileSync('tools/sync-validation-output/word-trim-locks-result.json',JSON.stringify(results,null,2))
  console.log('PASS native speech/silence handle drag, saved locks, silence recheck protection and Undo')
} finally { c.close() }
