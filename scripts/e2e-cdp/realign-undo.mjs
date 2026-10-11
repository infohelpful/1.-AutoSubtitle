// Run immediately after realign-and-export, while the last edit is alignment.
import assert from 'node:assert/strict'
import { connect } from './cdp.mjs'
const c = await connect()
const bounds = () => c.evaluate(`[...document.querySelectorAll('[id^="subtitle-word-0-"]')].map(e=>[e.dataset.wordStart,e.dataset.wordEnd])`)
async function hotkey(key) {
  const data = { key, code: 'Key' + key.toUpperCase(), modifiers: 2, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) }
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...data })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...data })
  await c.sleep(300)
}
try {
  const aligned = await bounds()
  await hotkey('z')
  const undone = await bounds()
  assert.notDeepEqual(undone, aligned, 'fixture must have a changed alignment boundary')
  await hotkey('y')
  assert.deepEqual(await bounds(), aligned)
  console.log('PASS: complete alignment undo/redo transaction', { before: undone[0], after: aligned[0] })
} finally { c.close() }
