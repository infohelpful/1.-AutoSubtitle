import { connect } from './cdp.mjs'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const c = await connect()
const file = process.argv[2]
assert.ok(file, 'Video path required')
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
if (process.argv[3] && result) await writeFile(process.argv[3], JSON.stringify(result, null, 2))
c.close()
assert.ok(result, 'Transcription did not finish within five minutes')
