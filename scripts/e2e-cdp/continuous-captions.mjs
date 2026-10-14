import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from './cdp.mjs'

const saved = process.argv[2]
assert.ok(saved?.includes('sync-validation-output'), 'Use a private launcher save target')
const c = await connect()
const result = {}
async function until(expression) {
  for (let i = 0; i < 200; i++) { if (await c.evaluate(expression)) return; await c.sleep(100) }
  throw Error('Timeout: ' + expression)
}
async function button(label) {
  const find = `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)})`
  await until(`!!(${find})&&!(${find}).disabled`)
  await c.evaluate(`(${find}).click()`)
}
async function hotkey(key) {
  const k = { key, code: 'Key' + key.toUpperCase(), windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers: 2 }
  for (const type of ['rawKeyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, ...k })
  await c.sleep(200)
}
async function seek(time) {
  await c.evaluate(`(()=>{const e=document.querySelector('.preview-seek');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${time});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await c.sleep(300)
}
async function save() {
  const before = existsSync(saved) ? readFileSync(saved, 'utf8') : ''
  await button('다른 이름으로 저장')
  for (let i = 0; i < 200; i++) {
    if (existsSync(saved)) { const raw = readFileSync(saved, 'utf8'); if (raw !== before) return JSON.parse(raw) }
    await c.sleep(100)
  }
  throw Error('Save timeout')
}
try {
  await button('불러오기')
  await until(`document.querySelector('video')?.readyState>=2&&document.querySelectorAll('.subtitle-word-chip').length>10`)
  const originalDuration = await c.evaluate(`+document.querySelector('.preview-seek').max`)
  const source = await save()
  await c.evaluate(`(()=>{
    window.__captionAudio=[];window.__captionFrames=[];window.__recordCaptions=false;
    const original=AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start=function(){window.__captionAudio.push(...(this.__autosubtitleSourceRanges??[]));return original.apply(this,arguments)};
    function tick(){if(window.__recordCaptions)window.__captionFrames.push({time:+document.querySelector('.preview-seek').value,text:document.querySelector('.preview-subtitle-text')?.textContent});requestAnimationFrame(tick)}requestAnimationFrame(tick);
  })()`)
  await seek(15.4)
  await c.evaluate('window.__recordCaptions=true')
  await button('재생')
  await until(`+document.querySelector('.preview-seek').value>16.2`)
  await button('일시정지')
  await c.evaluate('window.__recordCaptions=false')
  const frames = await c.evaluate('window.__captionFrames')
  const gapFrames = frames.filter(f => f.time >= 15.6 && f.time < 15.74)
  assert.ok(gapFrames.length > 2, 'Sample the former blank gap')
  assert.ok(gapFrames.every(f => f.text?.includes('컴퓨터')), JSON.stringify(gapFrames))
  assert.ok(frames.some(f => f.time >= 15.74 && f.text?.includes('작은 버튼')), 'Next row replaces text')
  const audio = await c.evaluate('window.__captionAudio')
  assert.ok(audio.some(r => r.mediaStartSec < 15.6 && r.mediaStartSec + r.durationSec > 16.2), JSON.stringify(audio))
  result.transition = { gapFrameCount: gapFrames.length, blankFrames: gapFrames.filter(f => !f.text).length, audio }

  result.deletions = []
  const originalWord = source.subtitles[1].words[0]
  for (const [key, caret] of [['Delete', 0], ['Backspace', 1]]) {
    await seek(10)
    await c.evaluate(`document.getElementById('subtitle-caret-1-${caret}').focus()`)
    await c.press(key)
    await until(`!document.querySelector('#subtitle-card-1 .subtitle-word-chip[data-word-start="${originalWord.start}"]')`)
    const duration = await c.evaluate(`+document.querySelector('.preview-seek').max`)
    assert.ok(Math.abs(duration - (originalDuration - originalWord.end + originalWord.start)) < .002, JSON.stringify({duration, originalDuration, originalWord}))
    const project = await save()
    assert.equal(project.subtitles[1].words[0].isDeleted, true)
    assert.equal(project.subtitles[1].words[0].word, originalWord.word)
    assert.deepEqual(project.subtitles[1].words.slice(1), source.subtitles[1].words.slice(1))
    const headings = await c.evaluate(`[...document.querySelectorAll('#subtitle-card-1 .subtitle-time,#subtitle-card-2 .subtitle-time')].map(e=>e.textContent)`)
    assert.equal(headings[1], headings[2], 'Adjacent displayed row boundaries remain continuous')
    await seek(9.5)
    await c.evaluate('window.__captionAudio=[]')
    await button('재생')
    await until('window.__captionAudio.length>0')
    const ranges = await c.evaluate('window.__captionAudio')
    assert.ok(ranges.every(r => r.mediaStartSec + r.durationSec <= originalWord.start + .001 || r.mediaStartSec >= originalWord.end - .001), JSON.stringify(ranges))
    await button('일시정지')
    result.deletions.push({key, duration, headings, ranges})
    await c.evaluate('document.activeElement.blur()')
    await hotkey('z')
    await until(`Math.abs(+document.querySelector('.preview-seek').max-${originalDuration})<.002`)
    await hotkey('y')
    await until(`Math.abs(+document.querySelector('.preview-seek').max-${duration})<.002`)
    await hotkey('z')
    await until(`Math.abs(+document.querySelector('.preview-seek').max-${originalDuration})<.002`)
  }

  // Last-chip deletion must retain the media cut after the row disappears.
  await c.evaluate(`document.getElementById('subtitle-caret-0-0').focus()`)
  await c.press('Delete')
  await until(`!document.getElementById('subtitle-card-0')`)
  const lastChip = await save()
  assert.equal(lastChip.subtitles[0].isDeleted, true)
  assert.ok(lastChip.virtualTimeline.some(b => b.isDeleted && b.mediaEndSec > 9))
  await c.evaluate('document.activeElement.blur()')
  await hotkey('z')
  await until(`!!document.getElementById('subtitle-card-0')`)
  result.singleChipUndo = true
  result.expandedDeletions = []
  for (const key of ['Delete', 'Backspace']) {
    const find = `document.querySelector('#subtitle-card-1 .subtitle-word-chip')`
    await c.evaluate(`${find}.scrollIntoView({block:'center'})`)
    await c.sleep(250)
    const point = await c.evaluate(`(()=>{const r=${find}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await c.click(point.x, point.y, 70)
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 2 })
    await until(`!!document.querySelector('#subtitle-card-1 [data-waveform-active-word-chip="1"]')&&!!document.querySelector('.subtitle-waveform-flow-root canvas')`)
    await c.press(key)
    await until(`!document.querySelector('#subtitle-card-1 .subtitle-word-chip[data-word-start="${originalWord.start}"]')`)
    assert.ok(Math.abs(await c.evaluate(`+document.querySelector('.preview-seek').max`) - (originalDuration - originalWord.end + originalWord.start)) < .002)
    result.expandedDeletions.push(key)
    await c.evaluate('document.activeElement.blur()')
    await hotkey('z')
    await until(`Math.abs(+document.querySelector('.preview-seek').max-${originalDuration})<.002`)
  }

  // The entire remaining media tail must be scheduled, not just aligned word spans.
  await seek(originalDuration - 2)
  await c.evaluate('window.__captionAudio=[]')
  await button('재생')
  await until('window.__captionAudio.length>0')
  const tail = await c.evaluate('window.__captionAudio')
  const last = tail.at(-1)
  assert.ok(Math.abs(last.mediaStartSec + last.durationSec - originalDuration) < .003, JSON.stringify(tail))
  await until(`!!document.querySelector('[aria-label="재생"]')`)
  result.tail = tail
  await save()
  writeFileSync('tools/sync-validation-output/continuous-captions-native-result.json', JSON.stringify(result, null, 2))
  console.log('PASS continuous captions/audio, Delete/Backspace media cuts, compressed clocks, preserved source timing, single-chip deletion, Undo/Redo')
} finally { c.close() }
