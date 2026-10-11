import { connect } from './cdp.mjs'
const c = await connect()
const st = () => c.evaluate(`(() => { const a = document.activeElement; return { id: a.id || a.tagName, sel: a.selectionStart ?? null } })()`)
const step = async (k) => { await c.press(k); console.log(k.padEnd(11), JSON.stringify(await st())) }
await c.evaluate(`document.querySelector('video')?.pause?.()`)
async function clickCaret(line, rc) {
  await c.evaluate(`document.getElementById('subtitle-caret-${line}-${rc}')?.scrollIntoView({block:'center'})`); await c.sleep(250)
  const p = await c.evaluate(`(() => { const b = document.getElementById('subtitle-caret-${line}-${rc}').getBoundingClientRect(); return {x: b.left + b.width/2, y: b.top + b.height/2} })()`)
  await c.click(p.x, p.y)
}
// line 2 (speech, 8 chips, wraps into 2 rows?) caret 3
await clickCaret(2, 3); console.log('click 2:3  ', JSON.stringify(await st()))
await step('ArrowDown'); await step('ArrowDown'); await step('ArrowDown')
console.log('--- up')
await step('ArrowUp'); await step('ArrowUp'); await step('ArrowUp')
console.log('--- from edit box: Down goes to next speech line chips, Up back to this line chips')
await c.press('F2'); console.log('F2         ', JSON.stringify(await st()))
await step('ArrowDown'); await step('ArrowUp')
c.close()
