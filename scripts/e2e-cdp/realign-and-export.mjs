import assert from 'node:assert/strict'
import { connect } from './cdp.mjs'
const c = await connect()
async function clickText(label) {
  const p = await c.evaluate(`(() => { const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if(!e||e.disabled)throw Error('Button unavailable: '+${JSON.stringify(label)}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
  await c.click(p.x,p.y)
}
const sleepUntil = async (expression, timeout = 120000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await c.evaluate(expression)) return; await c.sleep(500) }
  throw Error('Timed out waiting: ' + expression)
}
try {
  await sleepUntil(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='불러오기'&&!b.disabled)`)
  await clickText('불러오기')
  await sleepUntil(`document.querySelectorAll('.subtitle-word-chip').length > 10`)
  await c.evaluate(`(() => {
    window.__e2eRealignReplies = [];
    // Trace IPC results through the user-visible status, without modifying the app API.
  })()`)
  await clickText('현재 줄 싱크 재정렬')
  await sleepUntil(`document.body.innerText.includes('정렬 취소')`)
  await clickText('정렬 취소')
  await sleepUntil(`document.body.innerText.includes('정렬을 취소했습니다.')`)
  console.log('PASS: user cancel')
  const beforeEdit = await c.evaluate(`document.querySelector('textarea[data-subtitle-edit]').value`)
  await clickText('현재 줄 싱크 재정렬')
  await c.evaluate(`(() => {const e=document.querySelector('textarea[data-subtitle-edit]');e.focus();e.setSelectionRange(0,0)})()`)
  await c.send('Input.insertText', { text: '테스트 ' })
  await sleepUntil(`document.body.innerText.includes('정렬 중 자막이나 영상이 바뀌어 결과를 적용하지 않았습니다.')`, 180000)
  assert.ok(await c.evaluate(`document.querySelector('textarea[data-subtitle-edit]').value.startsWith('테스트 ')`))
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 })
  await c.sleep(300)
  assert.equal(await c.evaluate(`document.querySelector('textarea[data-subtitle-edit]').value`), beforeEdit)
  console.log('PASS: stale response discarded, text edit undone')
  await clickText('현재 줄 싱크 재정렬')
  await sleepUntil(`document.body.innerText.includes('정렬 완료 ·')`, 180000)
  console.log('PASS: current-line alignment')
  const highlight = await c.evaluate(`(() => { const label=[...document.querySelectorAll('label')].find(e=>e.textContent.includes('단어 강조')); const input=label?.querySelector('input'); if (!input) throw Error('Highlight checkbox missing'); const r=input.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,checked:input.checked}; })()`)
  if (!highlight.checked) await c.click(highlight.x, highlight.y)
  await clickText('내보내기')
  await sleepUntil(`document.body.innerText.includes('내보내기 완료') || document.body.innerText.includes('내보내기를 완료')`, 180000)
  console.log('PASS: real UI word-highlight export')
} finally { c.close() }
