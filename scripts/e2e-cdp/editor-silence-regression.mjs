// Fixture: four rows [speech 0..2, silence 2..4, silence 4..6, speech 6..9],
// a longer real video, no edits. Run with the isolated E2E launcher.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {connect} from './cdp.mjs'
const savedProject=process.argv[2]
assert(savedProject,'Pass the fresh isolated project output path')
const c=await connect()
const read=expression=>c.evaluate(expression)
async function button(label) {
  await read(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Missing button');b.click()})()`)
  await c.sleep(200)
}
async function seek(time) {
  await read(`(()=>{const el=document.querySelector('.preview-seek');el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${time});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await c.sleep(300)
}
const rect=index=>read(`document.querySelector('#subtitle-card-${index}')?.getBoundingClientRect().toJSON()`)
try {
  await button('불러오기')
  for(let i=0;i<100;i++) { if(await read(`document.querySelector('video')?.readyState>=2 && document.querySelectorAll('.subtitle-card').length===4`))break;await c.sleep(100) }
  const duration=await read(`document.querySelector('video').duration`)
  assert.equal(Number(await read(`document.querySelector('.preview-seek').max`)),duration)
  await seek(2.5)
  await read(`document.querySelector('.preview-play-btn').click()`)
  await c.sleep(350)
  assert.equal(await read(`document.querySelector('.subtitle-word-chip--active')?.textContent`),'--')
  assert.equal(await read(`document.querySelector('.subtitle-card--active')?.id`),'subtitle-card-1')
  assert.equal(await read(`getComputedStyle(document.querySelector('.subtitle-word-chip--active')).backgroundColor`),'rgb(13, 174, 204)')
  await read(`document.querySelector('.preview-play-btn').click()`)
  await read(`document.querySelector('#subtitle-caret-0-0').focus()`)
  const caret=await read(`(()=>{let e=document.querySelector('#subtitle-caret-0-0'),s=getComputedStyle(e);return{outline:s.outlineStyle,border:s.borderWidth,background:s.backgroundColor,bar:getComputedStyle(e,'::before').backgroundColor}})()`)
  assert.equal(caret.outline,'none');assert.equal(caret.border,'0px');assert.equal(caret.background,'rgba(0, 0, 0, 0)')
  const before=await rect(1)
  await read(`document.querySelector('#subtitle-word-1-0').focus()`)
  await c.press('Delete')
  await c.sleep(500)
  assert.equal(await rect(1),undefined)
  const after=await rect(2)
  assert(Math.abs(after.top-before.top)<2,`Deleted row retained blank space: ${after.top-before.top}px`)
  assert(Math.abs(Number(await read(`document.querySelector('.preview-seek').max`))-(duration-2))<.002)
  await button('↶실행 취소')
  assert(await rect(1),'Undo did not restore row')
  assert.equal(Number(await read(`document.querySelector('.preview-seek').max`)),duration)
  await read(`document.querySelector('#subtitle-word-1-0').focus()`)
  await c.press('Delete')
  await button('자막')
  await button('누락 구간 복구')
  await button('다른 이름으로 저장')
  for(let i=0;i<100&&!fs.existsSync(savedProject);i++) await c.sleep(100)
  const saved=JSON.parse(fs.readFileSync(savedProject,'utf8'))
  assert(saved.subtitles.some(line=>line.isDeleted&&line.words.some(w=>w.start===2&&w.end===4)))
  assert(!saved.subtitles.flatMap(line=>line.words??[]).some(w=>!w.isDeleted&&w.start<4&&w.end>2),'Repair resurrected deleted media')
  const tail=saved.subtitles.at(-1)
  assert.equal(tail.end,duration)
  assert.equal(tail.words[0].gapKind,'unclassified')
  assert.equal(tail.words[0].word,'오디오')
  console.log(JSON.stringify({passed:true,duration,deletedRowGapPx:after.top-before.top,caret,tail:[tail.start,tail.end],checks:['silence-highlight','caret-only','row-collapse','undo','original-duration','tail-coverage','preserve-cuts']}))
} finally {c.close()}
