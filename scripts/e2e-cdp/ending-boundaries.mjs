// Isolated real-media regression: run after whole-project realignment completes.
// Pass the pre-alignment saved snapshot and the launcher's project-save path.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { resolve } from 'node:path'
import { connect } from './cdp.mjs'
const [beforePath, savePath] = process.argv.slice(2)
const before = JSON.parse(fs.readFileSync(beforePath,'utf8'))
const c = await connect()
async function button(text) {
  await c.evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Missing button');b.click()})()`)
  await c.sleep(150)
}
async function save() {
  const previous=fs.statSync(savePath).mtimeMs
  await button('저장')
  for(let i=0;i<100;i++){if(fs.statSync(savePath).mtimeMs>previous)return JSON.parse(fs.readFileSync(savePath,'utf8'));await c.sleep(100)}
  throw Error('Save timeout')
}
async function key(key) {
  await c.evaluate('document.activeElement?.blur()')
  for(const type of ['rawKeyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key,code:'Key'+key.toUpperCase(),windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0),modifiers:2})
  await c.sleep(200)
}
try {
  assert(await c.evaluate(`document.querySelector('.subtitle-panel-sub').textContent.includes('줄 정렬 완료')`),'Realignment not completed')
  const duration=await c.evaluate(`document.querySelector('.preview-seek').max`)
  const after=await save()
  const speech = p=>p.subtitles.flatMap(l=>l.words??[]).filter(w=>!w.isSilence&&!w.isDeleted)
  const oldWords=speech(before), words=speech(after)
  assert.deepEqual(words.map(w=>[w.id,w.word]),oldWords.map(w=>[w.id,w.word]))
  assert.deepEqual(after.cutRanges,before.cutRanges)
  const ending=words.find(w=>w.word==='없습니다.'&&w.start>53&&w.start<54)
  assert(ending && ending.end>54 && ending.end<54.12,JSON.stringify(ending))
  const gaps=after.subtitles.flatMap(l=>l.words??[]).filter(w=>w.isSilence&&!w.isDeleted&&!w.manualStartLocked&&!w.manualEndLocked)
  assert(gaps.every(g=>words.every(w=>g.end<=w.start+1e-6||g.start>=w.end-1e-6)),'Automatic gap overlaps speech')
  const cuts=[...after.cutRanges,...(after.virtualTimeline??[]).filter(b=>b.isDeleted).map(b=>({start:b.mediaStartSec,end:b.mediaEndSec}))]
    .sort((a,b)=>a.start-b.start)
  const merged=[]
  for(const cut of cuts){const last=merged.at(-1);if(last&&cut.start<=last.end)last.end=Math.max(last.end,cut.end);else merged.push({...cut})}
  for(const old of oldWords){const word=words.find(w=>w.id===old.id);for(const cut of merged){
    if(old.end<=cut.start)assert(word.end<=cut.start+1e-6,'Realignment crossed a user cut')
    if(old.start>=cut.end)assert(word.start>=cut.end-1e-6,'Realignment crossed a user cut')
  }}
  for(const old of oldWords){const word=words.find(w=>w.id===old.id);if(old.manualStartLocked)assert.equal(word.start,old.start);if(old.manualEndLocked)assert.equal(word.end,old.end)}
  await key('z')
  assert.deepEqual((await save()).subtitles,before.subtitles,'Undo did not restore original boundaries and gaps')
  await key('y')
  assert.deepEqual((await save()).subtitles,after.subtitles,'Redo did not restore realignment')
  // Reopen the actual saved file through the app's drop/FileReader path, without
  // depending on which entries remain in the test launcher's dialog queue.
  await c.evaluate(`(() => {const input=document.createElement('input');input.type='file';input.dataset.e2eProjectFile='1';input.hidden=true;document.body.append(input)})()`)
  const doc=await c.send('DOM.getDocument')
  const node=await c.send('DOM.querySelector',{nodeId:doc.result.root.nodeId,selector:'input[data-e2e-project-file]'})
  await c.send('DOM.setFileInputFiles',{nodeId:node.result.nodeId,files:[resolve(savePath)]})
  await c.evaluate(`(() => {const input=document.querySelector('input[data-e2e-project-file]');const dt=new DataTransfer();dt.items.add(input.files[0]);document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));input.remove()})()`)
  await c.sleep(1400)
  assert.equal(await c.evaluate(`document.querySelector('.preview-seek').max`),duration)
  const sourceTime=53.5
  const programTime=sourceTime-merged.reduce((sum,cut)=>sum+Math.max(0,Math.min(sourceTime,cut.end)-cut.start),0)
  await c.evaluate(`(() => {const el=document.querySelector('.preview-seek');el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${programTime});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await c.sleep(400)
  assert(await c.evaluate(`document.querySelector('.preview-subtitle-text').textContent.includes('없습니다.')`))
  assert(!await c.evaluate(`document.querySelector('.preview-subtitle-text').textContent.includes('오디오')`),'Internal gap label leaked into caption')
  // Virtualized rows only follow the playhead during playback, not paused seeks.
  await c.evaluate(`document.querySelector('.preview-play-btn').click()`)
  let highlighted=false
  for(let i=0;i<100;i++){
    const state=await c.evaluate(`({time:document.querySelector('video').currentTime,active:[...document.querySelectorAll('.subtitle-word-chip--active')].map(e=>e.textContent.trim())})`)
    if(state.time>53.7 && state.time<54.02 && state.active.includes('없습니다.')){highlighted=true;break}
    if(state.time>54.1)break
    await c.sleep(20)
  }
  await c.evaluate(`document.querySelector('.preview-play-btn[aria-label="일시정지"]')?.click()`)
  assert(highlighted,'Corrected ending was not highlighted during playback')
  console.log(JSON.stringify({pass:true,words:words.length,originalEnd:oldWords.find(w=>w.id===ending.id).end,newEnd:ending.end,duration,
    changedEnds:words.filter((w,i)=>Math.abs(w.end-oldWords[i].end)>.02).length,
    lowConfidence:words.filter(w=>w.reviewReasons?.includes('low_character_confidence')).length,
    checks:['speech identity','no overlapping gaps','manual locks','Undo/Redo','reopen','ending highlight']},null,2))
} finally {c.close()}
