// Run with the isolated launcher and the reported 1111111111 project (or its saved copy).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { connect } from './cdp.mjs'
const [input, saved, importSrt, exportedSrt] = process.argv.slice(2)
assert(input && saved, 'Pass input and fresh saved project artifact paths')
const original = JSON.parse(fs.readFileSync(input, 'utf8'))
const c = await connect()
const read = expression => c.evaluate(expression)
async function waitFor(expression) {
  for (let i=0;i<150;i++) { if(await read(expression)) return; await c.sleep(100) }
  throw Error(`Timed out: ${expression}`)
}
async function button(label) {
  await read(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Missing button: '+${JSON.stringify(label)});b.click()})()`)
  await c.sleep(200)
}
async function seek(time) {
  await read(`(()=>{const el=document.querySelector('.preview-seek');el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${time});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await c.sleep(250)
}
try {
  await waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='불러오기'&&!b.disabled)`)
  await button('불러오기')
  await waitFor(`document.querySelector('video')?.readyState>=2 && document.querySelector('#subtitle-word-0-0')?.textContent==='오디오'`)
  await c.send('Emulation.setDeviceMetricsOverride',{width:1600,height:950,deviceScaleFactor:1,mobile:false})
  const duration = await read(`document.querySelector('video').duration`)
  assert.equal(Number(await read(`document.querySelector('.preview-seek').max`)),duration)
  const samples=[]
  for(const [time,text] of [[0,''],[14.9,''],[15.1,'구형 피씨에 윈도우 11을 설치할 때'],
    [68.8,'순서대로 정리해 드리겠습니다'],[68.99,''],[70,''],[72.2,''],[72.3,'벤토이 프로그램 다운로드 사이트 정보는'],[duration-.004,'']]) {
    await seek(time)
    const actual = await read(`document.querySelector('.preview-subtitle-text')?.textContent??''`)
    assert.equal(actual,text,`Caption at ${time}`)
    samples.push({time,text:actual})
  }
  await seek(0)
  await read(`document.querySelector('.subtitle-virtual-list').scrollTop=0`)
  await read(`document.querySelector('.preview-play-btn').click()`)
  await c.sleep(650)
  const playing = await read(`({time:document.querySelector('video').currentTime,chip:document.querySelector('.subtitle-word-chip--active')?.textContent})`)
  assert(playing.time>0 && playing.time<3, 'Playback skipped leading intro: '+playing.time)
  assert.equal(playing.chip,'오디오')
  await read(`document.querySelector('.preview-play-btn').click()`)
  await seek(70)
  await read(`document.querySelector('.subtitle-virtual-list').scrollTop=25*150`)
  await waitFor(`!!document.querySelector('#subtitle-word-25-0')`)
  await read(`document.querySelector('.preview-play-btn').click()`)
  await c.sleep(450)
  assert.equal(await read(`document.querySelector('.subtitle-word-chip--active')?.textContent`),'오디오')
  assert.equal(await read(`document.querySelector('.preview-subtitle-text')?.textContent??''`),'')
  await read(`document.querySelector('.preview-play-btn').click()`)
  await button('다른 이름으로 저장')
  for(let i=0;i<100&&!fs.existsSync(saved);i++)await c.sleep(100)
  const project=JSON.parse(fs.readFileSync(saved,'utf8'))
  const speech=p=>p.subtitles.filter(l=>l.text).map(l=>({start:l.start,end:l.end,text:l.text,words:l.words}))
  assert.deepEqual(speech(project),speech(original))
  assert.deepEqual(project.cutRanges,original.cutRanges)
  assert.equal(project.virtualTimeline.filter(b=>b.isDeleted).length,0)
  assert.equal(project.subtitles[0].start,0)
  assert.equal(project.subtitles[0].end,15)
  assert(project.subtitles.some(l=>l.start===68.98&&l.end===72.25&&l.text===''))
  assert(Math.abs(project.subtitles.at(-1).end-duration)<.001)
  // Explicit deletion must still ripple, and undo must restore the entire intro.
  await seek(0)
  await read(`document.querySelector('.subtitle-virtual-list').scrollTop=0`)
  await waitFor(`!!document.querySelector('#subtitle-word-0-0')`)
  await read(`document.querySelector('#subtitle-word-0-0').focus()`)
  await c.press('Delete')
  await c.sleep(300)
  assert(Math.abs(Number(await read(`document.querySelector('.preview-seek').max`))-(duration-15))<.001)
  await button('실행 취소')
  assert.equal(Number(await read(`document.querySelector('.preview-seek').max`)),duration)
  if(importSrt && exportedSrt) {
    // Configure launcher OPEN_QUEUE as [input, importSrt].
    await button('자막')
    await c.send('Page.enable')
    await button('대본/SRT 가져오기')
    await c.send('Page.handleJavaScriptDialog',{accept:true})
    await waitFor(`document.body.innerText.includes('자막 156줄을 가져왔습니다')`)
    assert.equal(Number(await read(`document.querySelector('.preview-seek').max`)),duration)
    await seek(70)
    assert.equal(await read(`document.querySelector('.preview-subtitle-text')?.textContent??''`),'')
    await read(`(()=>{const e=document.querySelector('.preview-export-format');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'srt');e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await button('내보내기')
    for(let i=0;i<100&&!fs.existsSync(exportedSrt);i++)await c.sleep(100)
    const normalize=s=>s.trim().replace(/\r\n/g,'\n').replace(/\{[^}]*\}/g,'')
    // The app adds position tags to SRT. Content and every timestamp must match.
    assert.equal(normalize(fs.readFileSync(exportedSrt,'utf8')),normalize(fs.readFileSync(importSrt,'utf8')))
  }
  console.log(JSON.stringify({passed:true,duration,rows:project.subtitles.length,playing,samples,saved,importExportVerified:!!exportedSrt}))
} finally {c.close()}
