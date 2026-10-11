import { connect } from './cdp.mjs'
const c = await connect()
const file = process.argv[2]
const data = { items: [], files: [file], dragOperationsMask: 1 }
for (const type of ['dragEnter', 'dragOver', 'drop']) {
  const r = await c.send('Input.dispatchDragEvent', { type, x: 400, y: 300, data })
  console.log(type, JSON.stringify(r.error ?? 'ok'))
  await c.sleep(200)
}
for (let i = 0; i < 150; i++) {
  const n = await c.evaluate(`document.querySelectorAll('.subtitle-word-chip').length`)
  if (n > 0) { console.log('chips', n, 'after', i * 2, 's'); break }
  await c.sleep(2000)
}
console.log('cards', await c.evaluate(`document.querySelectorAll('[id^="subtitle-card-"]').length`))
c.close()
