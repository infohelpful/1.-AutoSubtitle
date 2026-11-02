// Run against the isolated test launcher with a project loaded. No project is saved.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { connect } from './cdp.mjs'

const c = await connect()
const read = expression => c.evaluate(expression)
async function waitFor(expression) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await read(expression)) return
    await c.sleep(100)
  }
  assert.fail(`Timed out: ${expression}`)
}
async function click(selector) {
  const point = await read(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
  await c.click(point.x, point.y)
}
async function button(text) {
  await read(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`)
  await c.sleep(100)
}
try {
  await button('자막')
  assert(await read(`document.querySelector('video') !== null`), 'Load the test project first')
  const before = await read(`({duration:document.querySelector('.preview-seek').max, paused:document.querySelector('video').paused})`)
  assert.equal(await read(`[...document.querySelectorAll('button')].filter(b=>['자막 편집','자막 서식'].includes(b.textContent.trim())).length`), 0)
  for (const text of ['현재 줄 싱크 재정렬', '전체 자막 싱크 재정렬', '발음 입력', '대본/SRT 가져오기']) {
    assert.equal(await read(`[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()===${JSON.stringify(text)} && b.closest('.preview-subtitle-controls')).length`), 1)
    assert.equal(await read(`[...document.querySelectorAll('.subtitle-panel-head button')].filter(b=>b.textContent.trim()===${JSON.stringify(text)}).length`), 0)
  }
  for (const width of [1920, 1600, 1000]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: false })
    await c.sleep(100)
    assert(await read(`(() => {const els=[...document.querySelectorAll('.preview-subtitle-controls button,.preview-export-format,.editor-split-menu summary')].filter(e=>e.getBoundingClientRect().width);return els.every(e=>{const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth}) && document.documentElement.scrollWidth<=innerWidth;})()`), `Toolbar fits ${width}px`)
    await click('.editor-split-menu summary')
    assert(await read(`(() => {const el=document.querySelector('.editor-split-options');const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<innerHeight && el.contains(document.elementFromPoint(r.x+20,r.y+20));})()`), 'Menu is visible above content')
    const state = await read(`document.querySelector('.editor-split-options input').checked`)
    await click('.editor-split-options input')
    assert.equal(await read(`document.querySelector('.editor-split-options input').checked`), !state)
    await c.press('Space')
    assert.equal(await read(`document.querySelector('.editor-split-options input').checked`), state)
    assert.equal(await read(`document.querySelector('video').paused`), before.paused, 'Space on options must not start playback')
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    assert.equal(await read(`document.querySelector('.editor-split-menu').open`), false)
    assert(await read(`document.activeElement.matches('.editor-split-menu summary')`))
    await click('.editor-split-menu summary')
    await click('.preview-export-format')
    await c.press('Enter')
    assert.equal(await read(`document.querySelector('.editor-split-menu').open`), false, 'Outside click closes menu')
    const screenshot = await c.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(`tools/sync-validation-output/toolbar-${width}.png`, Buffer.from(screenshot.result.data, 'base64'))
  }
  const highlight = await read(`document.querySelector('.preview-export-word-highlight input[type="checkbox"]').checked`)
  await click('.preview-export-word-highlight input[type="checkbox"]')
  assert.equal(await read(`document.querySelector('input[aria-label="단어 강조 색"]').disabled`), highlight)
  for (const format of ['srt', 'video']) {
    await read(`(() => {const e=document.querySelector('.preview-export-format');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'${format}');e.dispatchEvent(new Event('change',{bubbles:true}));})()`)
    await waitFor(`document.querySelector('.preview-export-format').value === '${format}'`)
    assert(await read(`!!document.querySelector('.subtitle-visibility-tools .preview-export-word-highlight')`))
  }
  assert.equal(await read(`document.querySelector('.preview-export-word-highlight input[type="checkbox"]').checked`), !highlight)
  await click('.preview-export-word-highlight input[type="checkbox"]')
  await button('발음 입력')
  assert(await read(`!!document.querySelector('[aria-label="단어 발음 편집"]')`))
  await button('닫기')
  await button('서식')
  assert(await read(`!!document.querySelector('.subtitle-format-toolbar')`))
  assert.equal(await read(`!!document.querySelector('.editor-subtitle-tools')`), false)
  await click('button[aria-label="글자 크기"]')
  assert(await read(`!!document.querySelector('.subtitle-format-popup')`))
  await button('자막')
  assert.equal(await read(`!!document.querySelector('.subtitle-format-popup')`), false)
  assert.equal(await read(`document.querySelector('.preview-seek').max`), before.duration)
  console.log('PASS: toolbar placement, 1920/1600/1000px, split options, keyboard, export settings, reading and format tabs; timeline unchanged')
} finally { c.close() }
