import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { connect } from './cdp.mjs'

// Run after a successful transcription, with its ASR model still loaded.
const file = resolve(process.argv[2] ?? 'tools/sync-validation-output/stream-30min.mp4')
const c = await connect()
try {
  const before = await c.evaluate(`window.api.sidecarCall('get_model_status')`)
  assert.equal(before.loaded, true, 'Load an ASR model by transcribing a short clip first')
  await c.evaluate(`(() => {
    window.__waveformCancelled = window.api.sidecarCall('waveform_peaks', {
      path: ${JSON.stringify(file)}, requestId: 'waveform-cancel-old'
    });
  })()`)
  await c.sleep(Number(process.argv[3] ?? 100))
  await c.evaluate(`window.api.cancelWaveform('waveform-cancel-old')`)
  const cancelled = await c.evaluate('window.__waveformCancelled')
  assert.equal(cancelled.ok, false)
  await c.evaluate(`(() => {
    window.__waveformRetry = window.api.sidecarCall('waveform_peaks', {
      path: ${JSON.stringify(file)}, requestId: 'waveform-cancel-new'
    });
  })()`)
  await c.evaluate(`window.api.cancelWaveform('waveform-cancel-old')`)
  const after = await c.evaluate(`window.api.sidecarCall('get_model_status')`)
  assert.equal(after.loaded, true, 'Waveform cancellation must preserve the ASR worker/model')
  const retry = await c.evaluate('window.__waveformRetry')
  assert.equal(retry.ok, true, JSON.stringify(retry))
  const peaks = JSON.parse(await readFile(retry.path, 'utf8'))
  assert.ok(peaks.data.length > 0)
  const leftovers = (await readdir(dirname(retry.path))).filter(name => /\.work\.json(?:\.part)?$/.test(name))
  assert.deepEqual(leftovers, [], 'Cancelled/retried waveform scratch files must be removed')
  console.log(JSON.stringify({ cancelled, retry, modelPreserved: after.loaded, peakSamples: peaks.data.length, leftovers }))
} finally {
  await c.evaluate(`window.api.cancelWaveform('waveform-cancel-new')`).catch(() => {})
  c.close()
}
