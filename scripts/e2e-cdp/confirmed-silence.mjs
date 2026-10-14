import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect } from './cdp.mjs'

const expected = JSON.parse(readFileSync(resolve('tools/sync-validation-output/New_AutoSubtitle_silence-fixed.autosub'), 'utf8'))
const saved = resolve(process.argv.slice(2).find(arg=>arg!=='--recheck') ?? 'tools/sync-validation-output/false-silence-ui-saved.autosub')
assert.ok(!existsSync(saved), 'Choose a fresh save output and matching launcher environment')
const c = await connect()
const results = []
async function until(expression) {
  for (let i=0;i<150;i++) { if (await c.evaluate(expression)) return; await c.sleep(200) }
  throw new Error('Timeout: '+expression)
}
async function button(label) {
  const expression = `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)});if(!e||e.disabled)return false;e.click();return true})()`
  assert.ok(await c.evaluate(expression), label)
}
try {
  await until(`[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='불러오기'&&!e.disabled)`)
  await button('불러오기')
  await until(`document.querySelector('video')?.readyState>=2 && document.querySelectorAll('.subtitle-word-chip').length>10`)
  if (process.argv.includes('--recheck')) {
    const oldGap = `!!document.querySelector('.subtitle-word-chip[data-word-start="15.6"][data-word-end="15.74"]')`
    assert.ok(await c.evaluate(oldGap), 'Original project must retain old markers until explicit repair')
    await until(`[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='무음 다시 확인'&&!e.disabled)`)
    await button('무음 다시 확인')
    await until(`!(${oldGap})`)
    for (const [key,present] of [['z',true],['y',false]]) {
      const data={key,code:'Key'+key.toUpperCase(),modifiers:2,windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0)}
      await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...data})
      await c.send('Input.dispatchKeyEvent',{type:'keyUp',...data})
      await until(present?oldGap:`!(${oldGap})`)
    }
  }
  await c.evaluate(`(()=>{
    window.__silenceAudioStarts=[];
    const original=AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start=function(){window.__silenceAudioStarts.push({ranges:this.__autosubtitleSourceRanges});return original.apply(this,arguments)};
  })()`)
  for (const text of ['같은데요.', '겁니다.', '많으실', '같은데요.']) {
    const word = expected.subtitles.flatMap(l=>l.words??[]).find(w=>w.word===text)
    const find = `[...document.querySelectorAll('.subtitle-word-chip')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`
    await c.evaluate(`${find}.scrollIntoView({block:'center'})`)
    await c.sleep(250)
    const point = await c.evaluate(`(()=>{const e=${find};const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    // Send both clicks, as a real mouse does; clickCount=2 alone skips the
    // first click's focus/seek transition and does not exercise double-click UX.
    await c.click(point.x, point.y, 70)
    await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:2})
    await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:2})
    await until(`document.querySelector('[data-waveform-active-word-chip="1"]')?.textContent.trim()===${JSON.stringify(text)} && !!document.querySelector('.subtitle-waveform-flow-root canvas')`)
    const chip = await c.evaluate(`(()=>{const e=document.querySelector('[data-waveform-active-word-chip="1"]');return{start:+e.dataset.wordStart,end:+e.dataset.wordEnd}})()`)
    assert.equal(chip.start,word.start)
    assert.equal(chip.end,word.end)
    await c.evaluate('window.__silenceAudioStarts=[]')
    await button('자르기 라인부터 재생')
    await until('window.__silenceAudioStarts.length>0')
    const ranges = await c.evaluate('window.__silenceAudioStarts.flatMap(n=>n.ranges??[])')
    assert.ok(ranges.length, 'Audio source mapping must be available')
    assert.ok(Math.abs(ranges[0].mediaStartSec-word.start)<.002, JSON.stringify(ranges))
    const last = ranges.at(-1)
    assert.ok(Math.abs(last.mediaStartSec+last.durationSec-word.end)<.002, JSON.stringify(ranges))
    results.push({text,chip,ranges})
    await c.sleep(800)
    await c.evaluate(`document.querySelector('.subtitle-waveform-flow-root').scrollIntoView({block:'center'})`)
    const screenshot=await c.send('Page.captureScreenshot',{format:'png'})
    writeFileSync(`tools/sync-validation-output/false-silence-ui-${results.length}.png`,Buffer.from(screenshot.result.data,'base64'))
  }
  await button('다른 이름으로 저장')
  for (let i=0;i<100&&!existsSync(saved);i++) await c.sleep(100)
  assert.ok(existsSync(saved), 'Save must complete')
  const output = JSON.parse(readFileSync(saved,'utf8'))
  const spoken = lines=>lines.flatMap(l=>l.words??[]).filter(w=>!w.isSilence)
  assert.deepEqual(spoken(output.subtitles),spoken(expected.subtitles))
  for(const [s,e] of [[15.6,15.74],[41.36,41.62]]) {
    assert.ok(!output.subtitles.flatMap(l=>l.words??[]).some(w=>w.isSilence&&w.start<e&&w.end>s))
  }
  writeFileSync('tools/sync-validation-output/false-silence-ui-result.json',JSON.stringify(results,null,2))
  const screenshot=await c.send('Page.captureScreenshot',{format:'png'})
  writeFileSync('tools/sync-validation-output/false-silence-ui.png',Buffer.from(screenshot.result.data,'base64'))
  console.log('PASS corrected project load/save, cross-row/same-row/reverse double-clicks, exact audio playback ranges, no false screenshot gaps')
} finally { c.close() }
