import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {connect} from './cdp.mjs'
// Use a long, silent, low-frame-rate fixture to keep source size small.
const input=resolve(process.argv[2]??'tools/sync-validation-output/prepare-long-silent.mp4')
const c=await connect()
try {
  const result=await c.evaluate(`(async()=>{
    const start=performance.now(),id=crypto.randomUUID();
    const pending=window.api.prepareSourceMedia(${JSON.stringify(input)},id);
    await new Promise(r=>setTimeout(r,50));
    await window.api.cancelMediaPreparation(id);
    return {result:await pending,ms:performance.now()-start};
  })()`)
  assert.equal(result.result.ok,false,'Use a fresh, uncached long fixture')
  assert.match(result.result.reason,/취소/)
  assert.ok(result.ms<5000)
  // A delayed cancellation for an old ID must not cancel the next request.
  const retry=await c.evaluate(`(async()=>{
    const pending=window.api.prepareSourceMedia(${JSON.stringify(input)},'retry');
    await window.api.cancelMediaPreparation('previous-request');
    return await pending;
  })()`)
  assert.equal(retry.ok,true)
  assert.ok(retry.media.duration>=60)
  console.log('PASS real IPC cancellation and same-source retry',result)
} finally {c.close()}
