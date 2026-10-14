// Run against launch-test-app.cjs with a loaded project containing at least four rows.
// The launcher must queue [initialProject, savedProject] and use fresh output paths.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { connect } from './cdp.mjs'

const [savedProject, exportedSrt] = process.argv.slice(2)
assert(savedProject && exportedSrt, 'Pass the isolated project-save and SRT-output paths')
const c = await connect()
const read = expression => c.evaluate(expression)
async function click(selector) {
  const point = await read(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('Missing control'); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
  await c.click(point.x, point.y)
}
async function button(text) {
  const selector = await read(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b || b.disabled) throw Error('Missing or disabled button'); b.dataset.e2eButton='target'; return '[data-e2e-button="target"]'; })()`)
  await click(selector)
  await read(`document.querySelector('[data-e2e-button="target"]')?.removeAttribute('data-e2e-button')`)
}
async function wait(check, message) {
  for(let i=0;i<100;i++) { if(await check()) return; await c.sleep(100) }
  throw Error(message)
}
async function seek(time) {
  await read(`(() => {const el=document.querySelector('.preview-seek');el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${time});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await c.sleep(300)
}
const preview = () => read(`document.querySelector('.preview-subtitle-text').textContent`)
const hidden = () => read(`document.querySelectorAll('.subtitle-card--hidden-caption').length`)
try {
  await seek(13)
  const originalText=await preview()
  assert(originalText.length>0)
  const originalDuration=await read(`document.querySelector('.preview-seek').max`)
  const originalTime=await read(`document.querySelector('video').currentTime`)
  await click('[aria-label="2번 자막 선택"]')
  await click('[aria-label="4번 자막 선택"]')
  assert.equal(await read(`document.querySelector('.subtitle-selection-count').textContent`),'2줄 선택')
  assert.equal(await read(`document.querySelector('video').currentTime`),originalTime,'Selecting a row must not seek')
  await button('선택 자막 숨기기')
  assert.equal(await hidden(),2)
  assert.equal(await preview(),'')
  assert.equal(await read(`document.querySelector('.preview-seek').max`),originalDuration)
  await button('↶실행 취소')
  assert.equal(await hidden(),0)
  assert.equal(await preview(),originalText)
  await button('↷다시 실행')
  assert.equal(await hidden(),2)
  await button('다른 이름으로 저장')
  await wait(()=>fs.existsSync(savedProject),'Project save timed out')
  const saved=JSON.parse(fs.readFileSync(savedProject,'utf8'))
  assert.deepEqual(saved.subtitles.flatMap((line,i)=>line.isHidden?[i]:[]),[1,3])
  await read(`(() => {const el=document.querySelector('.preview-export-format');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'srt');el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await button('내보내기')
  await wait(()=>fs.existsSync(exportedSrt),'SRT export timed out')
  const srt=fs.readFileSync(exportedSrt,'utf8')
  assert(!srt.includes(saved.subtitles[1].text),'Hidden caption leaked into SRT')
  assert(!srt.includes(saved.subtitles[3].text),'Second hidden caption leaked into SRT')
  assert(srt.includes(saved.subtitles[2].text),'Visible caption missing from SRT')
  await button('불러오기')
  await c.sleep(1200)
  await wait(async()=>await hidden()===2,'Reopened visibility flags missing')
  await seek(13)
  assert.equal(await preview(),'')
  await click('[aria-label="2번 자막 선택"]')
  await click('[aria-label="4번 자막 선택"]')
  await button('선택 자막 표시')
  assert.equal(await hidden(),0)
  assert.equal(await preview(),originalText)
  await click('.subtitle-selection-toolbar input')
  assert.equal(await read(`document.querySelector('.subtitle-selection-count').textContent`),`${saved.subtitles.length}줄 선택`)
  await seek(600)
  assert(await read(`[...document.querySelectorAll('.subtitle-row-index input')].every(el=>el.checked)`),'Selection lost after virtualization')
  await button('선택 자막 숨기기')
  assert.equal(await preview(),'')
  const previousExportTime=fs.statSync(exportedSrt).mtimeMs
  await button('내보내기')
  await wait(()=>fs.statSync(exportedSrt).mtimeMs>previousExportTime,'Empty SRT export timed out')
  assert.equal(fs.readFileSync(exportedSrt,'utf8').trim(),'')
  await click('.preview-play-btn')
  const playbackStart=await read(`Number(document.querySelector('.preview-seek').value)`)
  await c.sleep(1100)
  assert(await read(`Number(document.querySelector('.preview-seek').value)`) > playbackStart+.5,'Hidden captions interrupted playback')
  assert.equal(await preview(),'')
  await click('.preview-play-btn')
  await button('↶실행 취소')
  await click('.subtitle-selection-toolbar input')
  await click('.subtitle-selection-toolbar input')
  assert(await read(`[...document.querySelectorAll('.subtitle-row-index input')].every(el=>!el.checked)`))
  assert.equal(await read(`document.querySelector('.preview-seek').max`),originalDuration)
  console.log(JSON.stringify({passed:true,rows:saved.subtitles.length,hiddenSaved:[2,4],duration:originalDuration,checks:['checkbox-no-seek','hide-preview','undo-redo','save-reopen','srt-export','restore','select-all','virtual-scroll-selection','all-hidden-export','hidden-playback']}))
} finally { c.close() }
