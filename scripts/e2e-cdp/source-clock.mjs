import assert from 'node:assert/strict'
import { connect } from './cdp.mjs'
const c = await connect()
const until = async expression => {
  const deadline=Date.now()+120000
  while(Date.now()<deadline){if(await c.evaluate(expression))return;await c.sleep(200)}
  throw Error('Timeout: '+expression)
}
async function click(label) {
  await until(`[...document.querySelectorAll('button')].some(b=>(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)})&&!b.disabled)`)
  const point=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(point.x,point.y)
}
try {
  await c.evaluate(`(()=>{window.__sourceClockStarts=[];const start=AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start=function(...args){const b=this.buffer;if(b){const data=b.getChannelData(0);
      const amplitude=t=>{let sum=0;for(let i=Math.round(t*b.sampleRate);i<Math.round((t+.1)*b.sampleRate);i++)sum+=Math.abs(data[i]??0);return sum/(.1*b.sampleRate)};
      window.__sourceClockStarts.push({offset:args[1],duration:b.duration,early:amplitude(.2),speech:amplitude(.7)})}return start.apply(this,args)};})()`)
  await click('불러오기')
  await until(`document.querySelector('video')?.readyState>=2 && !document.querySelector('.preview-play-btn')?.disabled`)
  await c.sleep(300)
  const initial=await c.evaluate(`(()=>{const v=document.querySelector('video');return {duration:v.duration,time:v.currentTime,src:v.src,audio:document.querySelector('audio').src}})()`)
  assert.ok(Math.abs(initial.duration-3)<.05, JSON.stringify(initial))
  assert.ok(initial.time<.1,JSON.stringify(initial))
  assert.ok(initial.src.includes('PreparedMedia'))
  assert.ok(initial.audio.endsWith('.wav'))
  await click('재생')
  await until(`window.__sourceClockStarts.length>0 && document.querySelector('video').currentTime>.7`)
  await click('일시정지')
  const starts=await c.evaluate('window.__sourceClockStarts')
  assert.ok(starts.every(s=>Math.abs(s.duration-3)<.001),JSON.stringify(starts))
  assert.ok(starts[0].early<.0001,JSON.stringify(starts))
  assert.ok(starts[0].speech>.03,JSON.stringify(starts))
  console.log('PASS: browser clock starts at zero; real WebAudio has original 0.5s delay',initial,starts)
  await click('내보내기')
  await until(`document.body.innerText.includes('내보내기 완료')`)
  console.log('PASS: nonzero-PTS source exported through real renderer/FFmpeg')
} finally {c.close()}
