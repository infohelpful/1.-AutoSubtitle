// Chromium composition events exercise the renderer. This does not replace a
// manual Windows IME candidate-window/keyboard-layout test.
import assert from 'node:assert/strict'
import {connect} from './cdp.mjs'
const c=await connect()
const value=()=>c.evaluate(`document.getElementById('subtitle-v-0').value`)
const rail=()=>c.evaluate(`[...document.getElementById('subtitle-v-0').closest('article').querySelectorAll('.subtitle-word-chip')].map(e=>e.textContent).join(' ')`)
async function undo() {
  await c.evaluate(`document.activeElement.blur()`)
  await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2})
  await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2})
  await c.sleep(150)
}
async function focus() {
  await c.evaluate(`(()=>{const e=document.getElementById('subtitle-v-0');e.scrollIntoView({block:'center'});e.focus();e.setSelectionRange(0,0)})()`)
}
try {
  const original=await value(), originalRail=await rail()
  await focus()
  for(const text of ['ㅎ','하','한','한ㄱ','한그','한글']) {
    await c.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length})
    await c.sleep(40)
    assert.equal(await value(),text+original,'Composition draft must survive render')
    assert.equal(await rail(),originalRail,'Do not commit partial Hangul into the word model')
  }
  await c.send('Input.insertText',{text:'한글'})
  await c.sleep(150)
  assert.equal(await value(),'한글'+original)
  assert.ok((await rail()).includes('한글'))
  await undo()
  assert.equal(await value(),original,'One Undo restores the committed composition')
  assert.equal(await rail(),originalRail)

  await focus()
  await c.send('Input.imeSetComposition',{text:'취소',selectionStart:2,selectionEnd:2})
  await c.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0})
  await c.sleep(150)
  assert.equal(await value(),original,'Cancelling composition restores text')
  assert.equal(await rail(),originalRail)

  await focus()
  const longText='긴 문장 편집 검증입니다. '.repeat(200)
  const start=Date.now()
  await c.send('Input.insertText',{text:longText})
  await c.sleep(200)
  assert.equal(await value(),longText+original)
  assert.ok((await rail()).includes('긴 문장'))
  const elapsed=Date.now()-start
  await undo()
  assert.equal(await value(),original)
  assert.equal(await rail(),originalRail)
  console.log('PASS Hangul composition/commit/cancel, one-step Undo and long paste', {chars:longText.length,elapsedMs:elapsed})
} finally {c.close()}
