import { connect } from './cdp.mjs'
const c = await connect()
const vid = () => c.evaluate(`(() => { const v = document.querySelector('video'); return { playing: !v.paused, t: +v.currentTime.toFixed(2) } })()`)
const clickBtn = (re) => c.evaluate(`[...document.querySelectorAll('button')].find(b => ${re}.test((b.getAttribute('aria-label')||'') + b.title + b.textContent))?.click()`)
const ensurePaused = async () => { if ((await vid()).playing) { await clickBtn('/일시정지/'); await c.sleep(450) } }
const all = await c.evaluate(`[...document.querySelectorAll('.subtitle-word-chip:not(.subtitle-word-chip--silence)')].map(e => ({ id: e.id, s: +e.dataset.wordStart, t: e.textContent.trim(), line: +e.id.split('-')[2] }))`)
const xy = async (id) => { await c.evaluate(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({block:'center'})`); await c.sleep(150)
  return c.evaluate(`(() => { const b = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: b.left + b.width/2, y: b.top + b.height/2 } })()`) }
const clickChip = async (chip) => { const { x, y } = await xy(chip.id); await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await c.click(x, y) }
const near = (st, want, tol = 1.2) => st.playing && st.t >= want - 0.15 && st.t <= want + tol
const rows = []
const check = (name, ok, extra) => { rows.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name, ok ? '' : JSON.stringify(extra)) }

// pick chips from the same speech line (line 2) so "next word" is well defined
const L = all.filter((x) => x.line === 2)
for (const delay of [0, 40]) {
  // C: click chip -> Right -> Space  => plays from the NEXT word
  await ensurePaused(); await clickChip(L[1]); await c.press('ArrowRight'); if (delay) await c.sleep(delay); await c.press('Space'); await c.sleep(550)
  let st = await vid(); check(`click chip -> Right -> Space (${delay}ms) plays next word ${L[2].t}`, near(st, L[2].s), { want: L[2].s, st })
  // G: click chip -> Left -> Space => plays from previous word
  await ensurePaused(); await clickChip(L[3]); await c.press('ArrowLeft'); if (delay) await c.sleep(delay); await c.press('Space'); await c.sleep(550)
  st = await vid(); check(`click chip -> Left -> Space (${delay}ms) plays word ${L[2].t}`, near(st, L[2].s), { want: L[2].s, st })
  // H: two quick clicks then Space => the second one wins
  await ensurePaused(); await clickChip(L[0]); await clickChip(L[4]); if (delay) await c.sleep(delay); await c.press('Space'); await c.sleep(550)
  st = await vid(); check(`two quick clicks -> Space (${delay}ms) plays second chip ${L[4].t}`, near(st, L[4].s), { want: L[4].s, st })
}
// D: Space toggles reliably after a click: play, pause, play
await ensurePaused(); await clickChip(L[2]); await c.press('Space'); await c.sleep(500)
let a = await vid(); await c.press('Space'); await c.sleep(300); let b = await vid(); await c.press('Space'); await c.sleep(500); let d = await vid()
check('click -> Space(play) -> Space(pause) -> Space(play)', a.playing && !b.playing && d.playing && d.t >= b.t - 0.05, { a, b, d })
// E: while playing, click another chip then immediately Space
await ensurePaused(); await clickChip(L[0]); await c.press('Space'); await c.sleep(400)
await clickChip(L[5]); await c.press('Space'); await c.sleep(550)
let e = await vid(); check(`playing -> click ${L[5].t} -> Space plays that chip`, near(e, L[5].s), { want: L[5].s, e })
// F: Down moves to the edit box; Space typed there must insert a space (not toggle playback)
await ensurePaused(); await clickChip(L[1]); await c.press('ArrowDown'); await c.sleep(300)
const before = await c.evaluate(`document.getElementById('subtitle-v-2').value`)
await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 })
await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
await c.sleep(250)
const after = await c.evaluate(`document.getElementById('subtitle-v-2').value`)
const playingAfter = (await vid()).playing
check('edit box: Space inserts a space and does not start playback', after.length === before.length + 1 && !playingAfter, { before, after, playingAfter })
// restore text
await c.press('Backspace')
await ensurePaused()
console.log(`\n${rows.filter(Boolean).length}/${rows.length} passed`)
c.close()
