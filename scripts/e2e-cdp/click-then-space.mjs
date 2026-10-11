import { connect } from './cdp.mjs'
const c = await connect()
const vid = () => c.evaluate(`(() => { const v = document.querySelector('video'); return { playing: !v.paused, t: +v.currentTime.toFixed(2) } })()`)
const active = () => c.evaluate(`(() => { const a = document.activeElement; return a.id || a.tagName })()`)
const clickBtn = (re) => c.evaluate(`[...document.querySelectorAll('button')].find(b => ${re}.test((b.getAttribute('aria-label')||'') + b.title + b.textContent))?.click()`)
const ensurePaused = async () => { if ((await vid()).playing) { await clickBtn('/일시정지/'); await c.sleep(400) } }
const chips = await c.evaluate(`[...document.querySelectorAll('.subtitle-word-chip:not(.subtitle-word-chip--silence)')].map(e => ({ id: e.id, s: +e.dataset.wordStart, t: e.textContent.trim() }))`)
async function chipXY(id) {
  await c.evaluate(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({block:'center'})`)
  await c.sleep(150)
  return c.evaluate(`(() => { const b = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: b.left + b.width/2, y: b.top + b.height/2 } })()`)
}
const pick = [chips[1], chips[4], chips[8], chips[12], chips[16], chips[20], chips[24]].filter(Boolean)
const mode = process.argv[2] || 'chip'
for (const scenario of ['paused', 'playing']) {
  for (const delay of [0, 20, 60, 120, 300]) {
    let ok = 0, n = 0; const fail = []
    for (const chip of pick) {
      await ensurePaused()
      if (scenario === 'playing') { await clickBtn('/재생/'); await c.sleep(450) }
      const { x, y } = await chipXY(chip.id)
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await c.click(x, y)
      if (delay) await c.sleep(delay)
      await c.press('Space')
      await c.sleep(600)
      const st = await vid(); n++
      const startedHere = st.playing && st.t >= chip.s - 0.15 && st.t <= chip.s + 1.6
      if (startedHere) ok++; else fail.push({ chip: chip.t, want: +chip.s.toFixed(2), got: st, active: await active() })
    }
    console.log(scenario.padEnd(8), 'click->Space', String(delay).padStart(3), 'ms:', `${ok}/${n}`, fail.length ? JSON.stringify(fail.slice(0, 2)) : '')
  }
}
await ensurePaused()
c.close()
