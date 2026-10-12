import assert from 'node:assert/strict'
import {connect} from './cdp.mjs'
const c=await connect()
async function until(expression) {
  const deadline=Date.now()+120000
  while(Date.now()<deadline){if(await c.evaluate(expression))return;await c.sleep(100)}
  throw Error('Timeout: '+expression)
}
async function click(label) {
  await until(`[...document.querySelectorAll('button')].some(b=>(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)})&&!b.disabled)`)
  const p=await c.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(p.x,p.y)
}
try {
  await c.sleep(1000)
  await click('불러오기')
  await until(`document.querySelector('video')?.readyState>=2&&!document.querySelector('.preview-play-btn').disabled`)
  assert.ok(await c.evaluate(`document.querySelector('video').duration>30`))
  await c.evaluate(`(()=>{
    window.__streamNodes=[];window.__fullDecodes=0;
    const p=AudioBufferSourceNode.prototype,original=p.start;
    p.start=function(when,offset,duration){window.__streamNodes.push({node:this,when,duration,ranges:this.__autosubtitleSourceRanges});return original.apply(this,arguments)};
    const decode=BaseAudioContext.prototype.decodeAudioData;
    BaseAudioContext.prototype.decodeAudioData=function(){window.__fullDecodes++;return decode.apply(this,arguments)};
  })()`)
  await click('재생')
  await until(`document.querySelector('.preview-play-btn').getAttribute('aria-label')==='일시정지'`)
  let maxDelta=0,maxBuffered=0
  for(let i=0;i<44;i++) {
    await c.sleep(500)
    const s=await c.evaluate(`(()=>{
      const nodes=window.__streamNodes,v=document.querySelector('video');
      const active=nodes.filter(n=>n.node.buffer&&n.node.context.currentTime>=n.when&&n.node.context.currentTime<n.when+n.duration);
      const n=active[0],now=n?.node.context.currentTime,r=n?.ranges?.find(r=>now>=r.ctxStart&&now<r.ctxStart+r.durationSec);
      return{count:active.length,time:v.currentTime,paused:v.paused,audio:r&&r.mediaStartSec+now-r.ctxStart,
        buffered:nodes.reduce((sum,n)=>sum+(n.node.buffer?.duration??0),0),chunks:nodes.length,decodes:window.__fullDecodes,
        error:document.querySelector('[role="alert"]')?.textContent};
    })()`)
    assert.equal(s.paused,false,JSON.stringify(s))
    assert.equal(s.count,1,JSON.stringify(s))
    assert.equal(s.decodes,0,'Streaming playback must not decode the full file')
    assert.ok(s.buffered<=18.01,JSON.stringify(s))
    const delta=Math.abs(s.time-s.audio)
    assert.ok(delta<.25,JSON.stringify(s))
    maxDelta=Math.max(maxDelta,delta);maxBuffered=Math.max(maxBuffered,s.buffered)
  }
  await click('일시정지')
  assert.equal(await c.evaluate(`window.__streamNodes.filter(n=>n.node.buffer).length`),0,'Pause must release every PCM block')
  console.log('PASS 22 seconds across streaming blocks, bounded buffers, no full decode, pause cleanup',{maxDelta,maxBuffered})
  if(process.argv.includes('--tail')) {
    const p=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('.subtitle-word-chip')].find(e=>+e.dataset.wordStart===1780);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await c.click(p.x,p.y)
    await click('재생')
    await c.sleep(1200)
    const tail=await c.evaluate(`(()=>{const n=window.__streamNodes.find(n=>n.node.buffer&&n.node.context.currentTime>=n.when&&n.node.context.currentTime<n.when+n.duration);const now=n.node.context.currentTime,r=n.ranges.find(r=>now>=r.ctxStart&&now<r.ctxStart+r.durationSec);return{video:document.querySelector('video').currentTime,audio:r.mediaStartSec+now-r.ctxStart,buffered:window.__streamNodes.reduce((sum,n)=>sum+(n.node.buffer?.duration??0),0)}})()`)
    assert.ok(tail.video>1780 && tail.video<1783)
    assert.ok(Math.abs(tail.video-tail.audio)<.25)
    assert.ok(tail.buffered<=18.01)
    await click('일시정지')
    console.log('PASS seek near the end of 30-minute media',tail)
  }
} finally {c.close()}
