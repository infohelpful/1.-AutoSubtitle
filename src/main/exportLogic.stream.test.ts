import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderState } from '../shared/exportRenderSchedule'

const h = vi.hoisted(() => {
  type Listener = (event: { sender: { id: number } }) => void
  const listeners = new Map<string, Set<Listener>>()
  const state = {
    nextWindowId: 1,
    sent: [] as Array<{ windowId: number; payload: Record<string, unknown> }>,
    captures: 0,
    destroyed: 0,
    failCaptureAt: -1
  }
  const ipcMain = {
    on(channel: string, fn: Listener) {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(fn)
    },
    removeListener(channel: string, fn: Listener) {
      listeners.get(channel)?.delete(fn)
    },
    emit(channel: string, event: { sender: { id: number } }) {
      for (const fn of [...(listeners.get(channel) ?? [])]) fn(event)
    }
  }
  return { listeners, state, ipcMain }
})

vi.mock('electron', () => {
  class FakeWebContents {
    id: number
    last: Record<string, unknown> = {}
    private once_: Record<string, Array<() => void>> = {}
    constructor(id: number) {
      this.id = id
    }
    once(event: string, fn: () => void): void {
      ;(this.once_[event] ??= []).push(fn)
    }
    fire(event: string): void {
      for (const fn of this.once_[event] ?? []) fn()
      this.once_[event] = []
    }
    setZoomFactor(): void {}
    async executeJavaScript(): Promise<null> {
      return null
    }
    send(_channel: string, payload: Record<string, unknown>): void {
      this.last = payload
      h.state.sent.push({ windowId: this.id, payload })
      setTimeout(() => h.ipcMain.emit('export-subtitle:render-ready', { sender: { id: this.id } }), 1)
    }
    async capturePage(): Promise<unknown> {
      h.state.captures += 1
      if (h.state.captures === h.state.failCaptureAt) throw new Error('capture failed')
      const w = Number(this.last['width'])
      const hgt = Number(this.last['height'])
      // 첫 바이트에 텍스트 첫 글자 코드를 실어 순서를 검증한다.
      const marker = String(this.last['text'] ?? ' ').charCodeAt(0) & 0xff
      const buf = Buffer.alloc(w * hgt * 4, marker)
      return { getSize: () => ({ width: w, height: hgt }), resize: () => ({ toBitmap: () => buf }), toBitmap: () => buf }
    }
  }
  class FakeBrowserWindow {
    webContents: FakeWebContents
    private dead = false
    constructor() {
      this.webContents = new FakeWebContents(h.state.nextWindowId++)
    }
    async loadFile(): Promise<void> {
      queueMicrotask(() => this.webContents.fire('did-finish-load'))
    }
    async loadURL(): Promise<void> {
      queueMicrotask(() => this.webContents.fire('did-finish-load'))
    }
    setContentSize(): void {}
    isDestroyed(): boolean {
      return this.dead
    }
    destroy(): void {
      if (!this.dead) h.state.destroyed += 1
      this.dead = true
    }
  }
  return { BrowserWindow: FakeBrowserWindow, ipcMain: h.ipcMain }
})

import { openSubtitleCapturePool } from './exportLogic'

const style = {
  fontFamily: 'Malgun Gothic',
  fontSize: 26,
  textColor: '#ffffff',
  fontWeight: 700,
  bgColor: '#000000',
  bgOpacity: 60,
  strokeColor: '#000000',
  strokeWidth: 2,
  x: 50,
  y: 10,
  videoWidth: 320,
  videoHeight: 240,
  wordHighlightColor: '#ffd54a'
}

function states(n: number): RenderState[] {
  return Array.from({ length: n }, (_, i) => ({
    startFrame: i * 10,
    endFrame: i * 10 + 10,
    text: `${String.fromCharCode(65 + (i % 26))} x`,
    words: [String.fromCharCode(65 + (i % 26)), 'x'],
    activeIndex: i % 2
  }))
}

beforeEach(() => {
  h.state.nextWindowId = 1
  h.state.sent = []
  h.state.captures = 0
  h.state.destroyed = 0
  h.state.failCaptureAt = -1
})

describe('openSubtitleCapturePool.stream', () => {
  it('keeps original layout dimensions when the capture is downscaled', async () => {
    const pool = await openSubtitleCapturePool({ subtitleStyle: { ...style, layoutWidth: 3840, layoutHeight: 2160 }, stateCount: 1 })
    try { for await (const _ of pool.stream(states(1))) { /* consume the capture */ } }
    finally { pool.close() }
    expect(h.state.sent[0].payload).toMatchObject({ width: 320, height: 240, layoutWidth: 3840, layoutHeight: 2160, fontSize: 26 })
  })
  it('yields states in schedule order with the word-highlight payload', async () => {
    const pool = await openSubtitleCapturePool({ subtitleStyle: style, stateCount: 7 })
    const input = states(7)
    const out: Array<{ startFrame: number; endFrame: number; marker: number }> = []
    for await (const s of pool.stream(input)) {
      out.push({ startFrame: s.startFrame, endFrame: s.endFrame, marker: s.buf[0]! })
    }
    pool.close()
    expect(out.map((s) => s.startFrame)).toEqual(input.map((s) => s.startFrame))
    expect(out.map((s) => s.marker)).toEqual(input.map((s) => s.text.charCodeAt(0)))
    const payloads = h.state.sent.map((s) => s.payload)
    expect(payloads).toHaveLength(7)
    for (const p of payloads) {
      expect(p['wordHighlightColor']).toBe('#ffd54a')
      expect(Array.isArray(p['words'])).toBe(true)
    }
    expect(h.state.destroyed).toBeGreaterThan(0)
  })

  it('resets highlight fields for a plain-line state', async () => {
    const pool = await openSubtitleCapturePool({ subtitleStyle: style, stateCount: 1 })
    for await (const s of pool.stream([{ startFrame: 0, endFrame: 5, text: 'plain', activeIndex: -1 }])) void s
    pool.close()
    const p = h.state.sent[0]!.payload
    expect(p['words']).toBeUndefined()
    expect(p['activeIndex']).toBe(-1)
  })

  it('does not capture far ahead of a slow consumer (bounded memory)', async () => {
    const pool = await openSubtitleCapturePool({ subtitleStyle: style, stateCount: 40 })
    const it = pool.stream(states(40))
    await it.next()
    await new Promise((r) => setTimeout(r, 600))
    // 5 windows → maxAhead 12; one item consumed.
    expect(h.state.captures).toBeLessThanOrEqual(13)
    expect(h.state.captures).toBeGreaterThan(1)
    await it.return(undefined)
    pool.close()
  })

  it('stops capturing when the consumer closes the stream early', async () => {
    const pool = await openSubtitleCapturePool({ subtitleStyle: style, stateCount: 40 })
    const it = pool.stream(states(40))
    await it.next()
    await it.return(undefined)
    const after = h.state.captures
    await new Promise((r) => setTimeout(r, 400))
    expect(h.state.captures).toBe(after)
    pool.close()
  })

  it('propagates a capture failure to the consumer', async () => {
    h.state.failCaptureAt = 3
    const pool = await openSubtitleCapturePool({ subtitleStyle: style, stateCount: 6 })
    await expect(
      (async () => {
        for await (const s of pool.stream(states(6))) void s
      })()
    ).rejects.toThrow('capture failed')
    pool.close()
  })

  it('rejects promptly when the export is canceled', async () => {
    const controller = new AbortController()
    const pool = await openSubtitleCapturePool({
      subtitleStyle: style,
      stateCount: 40,
      signal: controller.signal
    })
    const run = (async () => {
      for await (const s of pool.stream(states(40))) {
        void s
        controller.abort()
      }
    })()
    await expect(run).rejects.toThrow('canceled')
    pool.close()
  })

  it('can be streamed again after a finished run (encoder retry)', async () => {
    const pool = await openSubtitleCapturePool({ subtitleStyle: style, stateCount: 3 })
    for (let run = 0; run < 2; run += 1) {
      const frames: number[] = []
      for await (const s of pool.stream(states(3))) frames.push(s.startFrame)
      expect(frames).toEqual([0, 10, 20])
    }
    pool.close()
  })
})
