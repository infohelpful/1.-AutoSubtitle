// Run with Electron after npm run build. Uses the actual offscreen renderer and fonts.
const { app, BrowserWindow, ipcMain } = require('electron')
const { resolve } = require('node:path')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const root = resolve(__dirname, '../..')
const output = resolve(root, 'tools/sync-validation-output')
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const windows = []
  try {
    mkdirSync(output, { recursive: true })
    async function render(width, height, layoutWidth, layoutHeight) {
      const win = new BrowserWindow({ width, height, useContentSize: true, show: false, transparent: true,
        webPreferences: { offscreen: true, preload: resolve(root, 'out/preload/index.js'), sandbox: false, contextIsolation: true } })
      windows.push(win)
      await win.loadFile(resolve(root, 'out/renderer/exportSubtitle.html'))
      await win.webContents.executeJavaScript(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`)
      const ready = new Promise((resolveReady, reject) => {
        const timer = setTimeout(() => { ipcMain.removeListener('export-subtitle:render-ready', onReady); reject(Error('Renderer timeout')) }, 15000)
        function onReady(event) { if (event.sender.id === win.webContents.id) { clearTimeout(timer); ipcMain.removeListener('export-subtitle:render-ready', onReady); resolveReady() } }
        ipcMain.on('export-subtitle:render-ready', onReady)
      })
      win.webContents.send('update-subtitle', { width, height, layoutWidth, layoutHeight,
        text: '한글 자막의 글자 크기와 줄바꿈을 확인합니다. '.repeat(10),
        fontFamily: 'Malgun Gothic', fontSize: 60, fontWeight: 700, textColor: '#ffffff',
        bgColor: '#000000', bgOpacity: 80, strokeColor: '#000000', strokeWidth: 2, x: 50, y: 10 })
      await ready
      const box = await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector('.export-subtitle-plain'),r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,font:getComputedStyle(e).fontSize}})()`)
      let shot = await win.webContents.capturePage()
      const nativeSize = shot.getSize()
      if (nativeSize.width !== width || nativeSize.height !== height) shot = shot.resize({ width, height })
      assert.equal(shot.toBitmap({ scaleFactor: 1 }).length, width * height * 4)
      writeFileSync(resolve(output, `layout-${layoutWidth}x${layoutHeight}-${width}x${height}.png`), shot.toPNG())
      win.destroy()
      return { x: box.x * layoutWidth / width, y: box.y * layoutHeight / height,
        width: box.width * layoutWidth / width, height: box.height * layoutHeight / height, font: box.font }
    }
    for (const [lw, lh, w, h] of [[3840,2160,1920,1080], [1080,1920,608,1080], [128,32,320,240]]) {
      const full = await render(lw, lh, lw, lh)
      const scaled = await render(w, h, lw, lh)
      for (const key of ['x','y','width','height']) assert.ok(Math.abs(full[key]-scaled[key])<.1, JSON.stringify({key,full,scaled}))
      assert.equal(scaled.font, '60px')
      console.log('PASS original-pixel layout', {lw,lh,w,h,full,scaled})
    }
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { for (const win of windows) if (!win.isDestroyed()) win.destroy(); app.quit() }
})
