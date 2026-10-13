import { connect } from './cdp.mjs'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const c = await connect()
const positional = process.argv.slice(2).filter(arg => arg !== '--fast')
const file = positional[0]
assert.ok(file, 'Video path required')
if (process.argv.includes('--fast')) {
  const selected = await c.evaluate(`(() => {
    const s = document.querySelector('select[aria-label="추출 싱크 정밀도"]');
    if (!s || s.disabled) return false;
    s.value = 'fast'; s.dispatchEvent(new Event('change', {bubbles: true})); return true;
  })()`)
  assert.ok(selected, 'Wait for the app to become ready before selecting fast mode')
  await c.sleep(150)
  assert.equal(await c.evaluate(`document.querySelector('select[aria-label="추출 싱크 정밀도"]').value`), 'fast')
}
await c.evaluate(`(() => {
  window.__e2eTranscription = null; window.__e2eTranscriptionError = null;
  const done = window.api.onTranscribeComplete(result => { window.__e2eTranscription = result; done(); failed(); });
  const failed = window.api.onTranscribeError(error => { window.__e2eTranscriptionError = error; done(); failed(); });
})()`)
const data = { items: [], files: [file], dragOperationsMask: 1 }
for (const type of ['dragEnter', 'dragOver', 'drop']) {
  const r = await c.send('Input.dispatchDragEvent', { type, x: 400, y: 300, data })
  console.log(type, JSON.stringify(r.error ?? 'ok'))
  await c.sleep(200)
}
for (let i = 0; i < 150; i++) {
  const error = await c.evaluate('window.__e2eTranscriptionError')
  if (error) { c.close(); throw new Error(JSON.stringify(error)) }
  const n = await c.evaluate(`window.__e2eTranscription && !document.querySelector('.extract-modal-backdrop') ? document.querySelectorAll('.subtitle-word-chip').length : 0`)
  if (n > 0) { console.log('chips', n, 'after', i * 2, 's'); break }
  await c.sleep(2000)
}
console.log('cards', await c.evaluate(`document.querySelectorAll('[id^="subtitle-card-"]').length`))
const result = await c.evaluate('window.__e2eTranscription')
if (positional[1] && result) await writeFile(positional[1], JSON.stringify(result, null, 2))
c.close()
assert.ok(result, 'Transcription did not finish within five minutes')
if (process.argv.includes('--fast')) {
  assert.equal(result.alignmentSummary?.appliedEngine, 'rms', JSON.stringify(result.alignmentSummary))
  assert.deepEqual(result.alignmentSummary?.reviewReasons, [])
}
