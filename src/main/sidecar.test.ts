import { afterEach, expect, it } from 'vitest'
import { PythonSidecar } from './sidecar'
const instances: PythonSidecar[] = []
const fixture = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line); if(r.method==='hang')return;
  process.stdout.write(JSON.stringify({id:r.id,result:process.pid})+'\\n');
})`
const create = () => {
  const instance = new PythonSidecar(process.execPath, ['-e', fixture])
  instances.push(instance)
  return instance
}
afterEach(() => { for (const instance of instances.splice(0)) instance.stop() })
it('kills timed out work, rejects the queue and starts a fresh process for the next request', async () => {
  const sc = create()
  const firstPid = await sc.call('pid')
  const pending = sc.call('hang', {}, 100)
  const queued = sc.call('pid')
  const settled = await Promise.allSettled([pending, queued])
  expect(settled.map(r => r.status)).toEqual(['rejected', 'rejected'])
  expect((settled[0] as PromiseRejectedResult).reason.message).toContain('timeout')
  const nextPid = await sc.call('pid')
  expect(nextPid).not.toBe(firstPid)
  expect(await sc.call('pid')).toBe(nextPid)
}, 15000)
it('settles an active call immediately on explicit stop', async () => {
  const sc = create()
  await sc.call('pid')
  const pending = sc.call('hang')
  await new Promise(r => setTimeout(r, 30))
  sc.stop('Canceled by user')
  await expect(pending).rejects.toThrow('Canceled by user')
}, 15000)
it('terminates worker descendants instead of leaving background inference alive', async () => {
  const script = `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      process.stdout.write(JSON.stringify({id:JSON.parse(line).id,result:child.pid})+'\\n');
    });`
  const sc = new PythonSidecar(process.execPath, ['-e', script])
  instances.push(sc)
  const childPid = await sc.call<number>('pid')
  sc.stop()
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(() => process.kill(childPid, 0)).toThrow()
}, 15000)
