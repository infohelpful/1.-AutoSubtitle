import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { connect } from './cdp.mjs'
const c = await connect()
async function until(expression) {
  for(let i=0;i<600;i++) { if(await c.evaluate(expression)) return; await c.sleep(200) }
  throw Error('Timeout: '+expression)
}
async function click(label) {
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`)
  const p=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(p.x,p.y)
}
try {
  await click('불러오기')
  await until(`document.querySelector('video')?.readyState>=2&&!document.querySelector('.preview-play-btn').disabled`)
  const source=fileURLToPath(await c.evaluate(`document.querySelector('audio').src`))
  await c.evaluate(`(()=>{const e=[...document.querySelectorAll('select')].find(e=>[...e.options].some(o=>o.value==='wav'));if(!e)throw Error('WAV option missing');e.value='wav';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await click('내보내기')
  await until(`document.body.innerText.includes('내보내기 완료')`)
  const decode=path=>{
    const r=spawnSync(resolve('tools/sync-validation-bin/ffmpeg.exe'),['-v','error','-i',path,'-ac','2','-ar','48000','-f','s16le','-'],{windowsHide:true,maxBuffer:2*1024*1024})
    assert.equal(r.status,0,r.stderr.toString());return r.stdout
  }
  const pcm=decode(source), actual=decode(resolve(process.argv[2] ?? 'tools/sync-validation-output/audio-ui-cut-export_AutoSubtitle.wav'))
  const expected=Buffer.concat([pcm.subarray(0,4801*4),pcm.subarray(9603*4,16003*4),pcm.subarray(19207*4)])
  assert.equal(actual.length,expected.length)
  assert.ok(actual.equals(expected),'Exported PCM differs from exact source samples')
  console.log('PASS real UI WAV export: exact stereo PCM samples',actual.length/4)
} finally {c.close()}
