// Run against the isolated launch-test-app.cjs session after loading a fixture.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { connect } from './cdp.mjs'

const c = await connect()
const results = []
const lines = JSON.parse(readFileSync(process.env.AUTOSUBTITLE_SYNC_PROJECT ?? 'tools/sync-validation-output/problem-684-accurate.autosub', 'utf8')).subtitles
async function until(expr) {
  for (let i = 0; i < 600; i++) {
    if (await c.evaluate(expr)) return
    await c.sleep(100)
  }
  throw Error('Timeout: ' + expr)
}
try {
  await until(`document.querySelector('video')?.readyState >= 2 && document.querySelectorAll('.subtitle-word-chip').length > 0`)
  await c.evaluate(`(() => {
    window.__syncRanges = []; window.__syncSamples = []; window.__syncRecording = false;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) {
      window.__syncContext = this.context;
      window.__syncRanges.push(...(this.__autosubtitleSourceRanges ?? []));
      return start.apply(this, args);
    };
    const v = document.querySelector('video');
    function frame(now, meta) { window.__syncFrame = { time: meta.mediaTime, wall: now }; v.requestVideoFrameCallback(frame); }
    v.requestVideoFrameCallback(frame);
    function tick() {
      if (window.__syncRecording && window.__syncContext) {
        const ctx = window.__syncContext, stamp = ctx.getOutputTimestamp();
        const outputTime = stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000;
        const sourceAt = t => {
          const r = window.__syncRanges.find(r => t >= r.ctxStart && t < r.ctxStart + r.durationSec);
          return r ? r.mediaStartSec + t - r.ctxStart : null;
        };
        const activeCard = document.querySelector('.subtitle-card--active');
        const active = [...document.querySelectorAll('.subtitle-word-chip--active')].map(e => ({
          word: e.textContent, start: +e.dataset.wordStart, end: +e.dataset.wordEnd,
          silence: e.classList.contains('subtitle-word-chip--silence'), card: e.closest('.subtitle-card')?.id
        }));
        window.__syncSamples.push({video: v.currentTime, frame: window.__syncFrame, wall: performance.now(),
          source: sourceAt(ctx.currentTime), output: sourceAt(outputTime), ui: +document.querySelector('.preview-seek').value,
          active, card: activeCard?.id, caption: document.querySelector('.preview-subtitle-text')?.textContent,
          paused: v.paused, seeking: v.seeking, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency});
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })()`)
  const starts = process.argv.slice(2).map(Number)
  for (const start of starts.length ? starts : [299, 469, 590]) {
    const row = lines.findLastIndex(l => l.start <= start)
    await c.evaluate(`(() => {const list=document.querySelector('.subtitle-virtual-list');list.scrollTop=${row}*list.scrollHeight/${lines.length};})()`)
    await c.evaluate(`(() => {
      const e = document.querySelector('.preview-seek');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${start});
      e.dispatchEvent(new Event('input',{bubbles:true}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
    })()`)
    await c.sleep(500)
    await until(`!document.querySelector('video').seeking`)
    const sought = await c.evaluate(`document.querySelector('video').currentTime`)
    assert.ok(Math.abs(sought - start) < .04, JSON.stringify({start, sought}))
    await c.evaluate(`(() => {
      window.__syncRanges=[];window.__syncSamples=[];window.__syncRecording=true;
      document.querySelector('.preview-play-icon').closest('button').click();
    })()`)
    for (let i=0;i<44;i++) {
      await c.sleep(500)
      const time = await c.evaluate(`document.querySelector('video').currentTime`)
      const index = lines.findLastIndex(l=>l.start <= time)
      await c.evaluate(`(() => {
        const list=document.querySelector('.subtitle-virtual-list');
        const card=document.getElementById('subtitle-card-${index}');
        if(card)card.scrollIntoView({block:'center'});
        else list.scrollTop=${index}*list.scrollHeight/${lines.length};
      })()`)
    }
    await c.evaluate(`(() => {window.__syncRecording=false;
      [...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='일시정지')?.click();
    })()`)
    const samples = await c.evaluate('window.__syncSamples')
    const settled = samples.filter(s=>s.source != null && s.source > start + 1 && !s.seeking && !s.paused)
    const max = fn => Math.max(0,...settled.map(fn))
    const stats = {start, samples: samples.length, settled: settled.length,
      videoSourceMax: max(s=>Math.abs(s.video-s.source)), videoOutputMax: max(s=>Math.abs(s.video-s.output)),
      uiSourceMax: max(s=>Math.abs(s.ui-s.source)),
      uiOutputMax: max(s=>Math.abs(s.ui-s.output)),
      highlightEarly: settled.filter(s=>s.output != null && s.active.some(w=>w.start > s.output+.025)).length,
      multiActive: settled.filter(s=>s.active.length > 1).length,
      silenceActive: settled.filter(s=>s.active.some(w=>w.silence)).length,
      activeSamples: settled.filter(s=>s.active.length).length,
      baseLatency: settled[0]?.baseLatency, outputLatency: settled[0]?.outputLatency}
    console.log(JSON.stringify(stats))
    results.push({stats, samples})
  }
  writeFileSync('tools/sync-validation-output/sync-clock-native.json', JSON.stringify(results))
  assert.ok(results.every(r=>r.stats.settled > 100 && r.stats.activeSamples > 20 && r.stats.highlightEarly===0 && r.stats.multiActive===0 && r.stats.silenceActive===0))
} finally { c.close() }
