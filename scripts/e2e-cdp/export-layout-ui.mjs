import assert from 'node:assert/strict'
import { connect } from './cdp.mjs'
const c = await connect()
const until = async expression => {
  for (let i=0;i<600;i++) { if (await c.evaluate(expression)) return; await c.sleep(200) }
  throw Error('Timed out: '+expression)
}
async function click(label) {
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`)
  const p = await c.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(p.x,p.y)
}
try {
  if (!process.argv.includes('--sar-only')) {
  await click('불러오기')
  await until(`document.querySelector('video')?.readyState>=2 && document.querySelector('video').videoWidth===3840`)
  await c.evaluate(`(()=>{const v=document.querySelector('video');v.currentTime=.8})()`)
  await c.sleep(300)
  console.log('4K preview',await c.evaluate(`(()=>{const v=document.querySelector('video');return {width:v.videoWidth,height:v.videoHeight}})()`))
  await click('내보내기')
  await until(`document.body.innerText.includes('내보내기 완료')`)
  console.log('PASS actual 4K UI export')
  }
  await click('불러오기')
  await until(`document.querySelector('video')?.readyState>=2 && document.querySelector('video').title.includes('layout-ui-sar.mp4')`)
  const sar = await c.evaluate(`(()=>{const v=document.querySelector('video');return {width:v.videoWidth,height:v.videoHeight}})()`)
  assert.deepEqual(sar,{width:540,height:720})
  console.log('PASS SAR=8:9 + 90deg browser display dimensions',sar)
  if (process.argv.includes('--sar-only')) {
    await click('내보내기')
    await until(`document.body.innerText.includes('내보내기 완료')`)
    console.log('PASS actual SAR + rotation UI export')
  }
} finally { c.close() }
