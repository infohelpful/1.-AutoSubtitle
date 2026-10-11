import assert from 'node:assert/strict'
import { connect } from './cdp.mjs'
const c = await connect()
try {
  const chip = await c.evaluate(`(() => {
    const chips = [...document.querySelectorAll('.subtitle-word-chip')];
    const e = chips.find((e, i) => i > 0 && !e.classList.contains('subtitle-word-chip--silence') && !chips[i-1].classList.contains('subtitle-word-chip--silence') && e.id.split('-')[2] === chips[i-1].id.split('-')[2]);
    return {id:e.id, row:e.id.split('-')[2]};
  })()`)
  const text = () => c.evaluate(`document.getElementById('subtitle-v-${chip.row}').value`)
  const original = await text()
  const p = await c.evaluate(`(() => {const e=document.getElementById(${JSON.stringify(chip.id)}); e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(p.x,p.y)
  await c.press('Backspace')
  await c.sleep(250)
  const changed = await text()
  assert.equal([...changed].length, [...original].length - 1, 'Backspace removes exactly one character')
  assert.equal(await c.evaluate(`document.activeElement.id`), `subtitle-v-${chip.row}`)
  await c.send('Input.insertText', { text: '테스트' })
  await c.sleep(200)
  assert.ok((await text()).includes('테스트'))
  console.log('edited', await text(), await c.evaluate(`document.getElementById('subtitle-v-${chip.row}').closest('article').innerText`))
  assert.ok(await c.evaluate(`document.getElementById('subtitle-v-${chip.row}').closest('article').querySelector('.subtitle-word-rail')?.textContent.includes('테스트') || [...document.getElementById('subtitle-v-${chip.row}').closest('article').querySelectorAll('.subtitle-word-chip')].some(e=>e.textContent.includes('테스트'))`), 'chips update before blur')
  console.log('PASS: character deletion, text focus, live chip update')
} finally { c.close() }
