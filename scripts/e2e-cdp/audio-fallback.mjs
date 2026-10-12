// Load a speech project longer than 10 seconds through launch-test-app.cjs.
import assert from 'node:assert/strict'
import {connect} from './cdp.mjs'
const c=await connect()
async function until(expression, timeout=30000) {
  const end=Date.now()+timeout
  while(Date.now()<end){if(await c.evaluate(expression))return;await c.sleep(100)}
  throw Error('Timeout: '+expression+'; state='+JSON.stringify(await state()))
}
const state=()=>c.evaluate(`(()=>{const a=document.querySelector('audio'),v=document.querySelector('video');return {audio:a&&{paused:a.paused,muted:a.muted,t:a.currentTime},video:v&&{paused:v.paused,t:v.currentTime},button:document.querySelector('.preview-play-btn')?.getAttribute('aria-label')}})()`)
async function click(label) {
  await until(`[...document.querySelectorAll('button')].some(b=>(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)})&&!b.disabled)`)
  const p=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(p.x,p.y)
}
try {
  await c.sleep(1000)
  await click('불러오기')
  await until(`document.querySelector('video')?.readyState>=2&&!document.querySelector('.preview-play-btn').disabled`,120000)
  await c.sleep(300)
  assert.ok(await c.evaluate(`document.querySelector('video').duration>10`),'Use a speech fixture longer than 10 seconds')
  await c.evaluate(`(()=>{window.__fallbackFailures=0;const p=AudioBufferSourceNode.prototype,original=p.start;p.start=function(...args){p.start=original;window.__fallbackFailures++;throw Error('E2E forced WebAudio failure')}})()`)
  await click('재생')
  await until(`!document.querySelector('audio').paused&&!document.querySelector('video').paused`)
  console.log('Fallback state',await state())
  assert.equal(await c.evaluate(`document.querySelector('audio').muted`),false,'HTML fallback must be audible')
  await until(`document.querySelector('.preview-play-btn').getAttribute('aria-label')==='일시정지'`)
  await click('일시정지')
  await c.sleep(500)
  assert.equal((await state()).audio.paused,true)
  await click('재생')
  await until(`!document.querySelector('video').paused&&document.querySelector('.preview-play-btn').getAttribute('aria-label')==='일시정지'`)
  assert.equal(await c.evaluate(`document.querySelector('audio').muted&&document.querySelector('audio').paused`),true)
  await click('일시정지')
  // A cancelled request must not restart when its delayed canplay/seek timer fires.
  await c.evaluate(`(()=>{const a=document.querySelector('audio');Object.defineProperty(a,'readyState',{configurable:true,get:()=>0});const p=AudioBufferSourceNode.prototype,original=p.start;p.start=function(){p.start=original;window.__fallbackFailures++;throw Error('E2E delayed fallback')}})()`)
  await click('재생')
  await until(`window.__fallbackFailures===2`)
  const chip=await c.evaluate(`(()=>{const e=document.querySelectorAll('.subtitle-word-chip:not(.subtitle-word-chip--silence)')[2];e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(chip.x,chip.y,0)
  await c.evaluate(`(()=>{const a=document.querySelector('audio');delete a.readyState;a.dispatchEvent(new Event('canplay'));a.dispatchEvent(new Event('loadeddata'))})()`)
  await c.sleep(900)
  const cancelled=await state()
  assert.equal(cancelled.audio.paused,true,'Cancelled HTML fallback must stay paused')
  assert.equal(cancelled.video.paused,true,'Cancelled fallback must not restart video')
  assert.equal(cancelled.button,'재생')
  console.log('PASS audible HTML fallback, pause, retry with one audio owner, and delayed request cancellation')
} finally {c.close()}
