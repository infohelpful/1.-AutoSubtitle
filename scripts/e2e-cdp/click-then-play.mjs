// Regression: a chip click while playing must become the next start for both controls.
import { connect } from './cdp.mjs'
const c = await connect()
// Extraction can leave old chips visible while the new media is still preparing.
let ready = false
for (let i = 0; i < 600; i++) {
  ready = await c.evaluate(`!document.querySelector('.extract-modal-backdrop') && document.querySelector('video')?.readyState >= 2 && document.querySelector('.preview-play-btn')?.disabled === false`)
  if (ready) break
  await c.sleep(200)
}
if (!ready) { c.close(); throw Error('Waited two minutes for media preparation') }
await c.evaluate(`(() => {
  if (window.__audioSources) return;
  window.__audioSources = [];
  const p = AudioBufferSourceNode.prototype;
  const start = p.start, stop = p.stop, connect = p.connect, disconnect = p.disconnect;
  p.start = function(when = 0, offset = 0, duration) {
    this.__trace = { node: this, when: when || this.context.currentTime, offset, duration: duration ?? this.buffer.duration - offset, stopped: false, connected: this.__connected === true };
    window.__audioSources.push(this.__trace); return start.apply(this, arguments);
  };
  p.stop = function() { if (this.__trace) this.__trace.stopped = true; return stop.apply(this, arguments); };
  p.connect = function() { this.__connected = true; if (this.__trace) this.__trace.connected = true; return connect.apply(this, arguments); };
  p.disconnect = function() { this.__connected = false; if (this.__trace) this.__trace.connected = false; return disconnect.apply(this, arguments); };
})()`)
const state = () => c.evaluate(`(() => {
  const v = document.querySelector('video');
  const active = window.__audioSources.filter(s => !s.stopped && s.connected && s.node.context.state === 'running' && s.node.context.currentTime >= s.when && s.node.context.currentTime < s.when + s.duration);
  return { playing: !v.paused, t: v.currentTime, audioCount: active.length, audioTime: active.map(s => s.offset + s.node.context.currentTime - s.when) };
})()`)
const button = async (playing) => {
  const point = await c.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => ${playing ? '/일시정지/' : '/재생/'} .test((b.getAttribute('aria-label') || '') + b.title)); if (!b) throw Error('Playback button missing'); const r = b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
  await c.click(point.x, point.y, 0)
}
const pause = async () => { if ((await state()).playing) await button(true); await c.sleep(250) }
const chips = await c.evaluate(`[...document.querySelectorAll('.subtitle-word-chip:not(.subtitle-word-chip--silence)')].map(e=>({id:e.id,s:+e.dataset.wordStart,text:e.textContent.trim()}))`)
const picked = [chips[2], chips[6], chips[10]].filter(Boolean)
if (picked.length < 3) throw Error('Drop the speech fixture first (at least 11 chips required)')
let failures = 0
try {
  for (const playing of [false, true]) for (const control of ['button', 'space']) for (const delay of [0, 50, 150]) {
    let passed = 0
    for (const chip of picked) {
      await pause()
      if (playing) { await button(false); await c.sleep(350) }
      await c.evaluate(`document.getElementById(${JSON.stringify(chip.id)}).scrollIntoView({block:'center'})`)
      const p = await c.evaluate(`(() => {const r=document.getElementById(${JSON.stringify(chip.id)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      await c.click(p.x, p.y, 0)
      if (delay) await c.sleep(delay)
      if (control === 'button') await button(false); else await c.press('Space')
      await c.sleep(500)
      const result = await state()
      if (result.playing && result.t >= chip.s - .1 && result.t < chip.s + 1.2 && result.audioCount === 1 && Math.abs(result.audioTime[0] - result.t) < .25) passed++
      else { failures++; console.log('FAIL', { playing, control, delay, chip, result }) }
    }
    console.log(`${playing ? 'playing' : 'paused'} click -> ${control} ${delay}ms: ${passed}/${picked.length}`)
  }
} finally { await pause(); c.close() }
if (failures) process.exitCode = 1
