import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {connect} from './cdp.mjs'
const c=await connect()
const file=resolve(process.argv[2]??'tools/sync-validation-output/stream-30min.mp4')
async function until(expression,ms=30000) {
  const end=Date.now()+ms
  while(Date.now()<end){if(await c.evaluate(expression))return;await c.sleep(100)}
  throw Error('Timeout '+expression)
}
try {
  await c.sleep(1000)
  await until(`document.querySelector('select[aria-label="추출 싱크 정밀도"]')?.disabled===false`,120000)
  await c.evaluate(`(()=>{window.__cancelCompletions=[];window.api.onTranscribeComplete(r=>window.__cancelCompletions.push(r))})()`)
  const data={items:[],files:[file],dragOperationsMask:1}
  for(const type of ['dragEnter','dragOver','drop'])await c.send('Input.dispatchDragEvent',{type,x:200,y:260,data})
  await until(`!!document.querySelector('.extract-modal-backdrop')`)
  // Exercise a running preparation/inference job rather than cancelling before dispatch.
  await c.sleep(2500)
  const p=await c.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='추출 취소');const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const start=Date.now()
  await c.click(p.x,p.y)
  await until(`!document.querySelector('.extract-modal-backdrop')`)
  const ms=Date.now()-start
  await c.sleep(800)
  assert.equal(await c.evaluate(`document.querySelectorAll('.subtitle-word-chip').length`),0)
  assert.equal(await c.evaluate(`window.__cancelCompletions.length`),0)
  assert.ok(await c.evaluate(`document.body.innerText.includes('자막 추출을 취소했습니다')`))
  assert.ok(await c.evaluate(`(async()=>{const s=await window.api.sidecarCall('get_model_status');return typeof s.loaded==='boolean'})()`),'Sidecar must accept new work after cancellation')
  console.log('PASS extraction cancel, no late completion, empty cancelled result and worker restart',{ms})
} finally {c.close()}
