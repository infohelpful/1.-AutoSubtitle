// Minimal CDP helper (Node 24 global WebSocket)
export async function connect(port = 9333) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
  }
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
    return r.result?.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const KEYS = {
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
    Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
    End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
    F2: { key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
  }
  const press = async (name, modifiers = 0) => {
    const k = KEYS[name]
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...k })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k })
    await sleep(120)
  }
  const typeText = async (text) => { await send('Input.insertText', { text }); await sleep(120) }
  const click = async (x, y, settleMs = 150) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    if (settleMs > 0) await sleep(settleMs)
  }
  return { send, evaluate, press, typeText, click, sleep, close: () => ws.close() }
}
