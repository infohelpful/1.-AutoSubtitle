import { expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { validateMediaDecode } from './validateMediaDecode'
const bin = process.env.AUTOSUBTITLE_TEST_FFMPEG_DIR
const ffmpeg = bin ? join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : ''
it.skipIf(!ffmpeg || !existsSync(ffmpeg))('detects a damaged tail that a first-second decode misses', async () => {
  const directory = resolve('tools/sync-validation-output')
  mkdirSync(directory, { recursive: true })
  const source = join(directory, 'decode-complete.mp4'), damaged = join(directory, 'decode-damaged.mp4')
  const made = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=10:d=4',
    '-c:v', 'libx264', '-g', '10', '-movflags', '+faststart', source], { windowsHide: true })
  expect(made.status, made.stderr.toString()).toBe(0)
  await expect(validateMediaDecode(ffmpeg, source)).resolves.toBeUndefined()
  const data = readFileSync(source)
  writeFileSync(damaged, data.subarray(0, Math.floor(data.length * .8)))
  const first = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', damaged, '-t', '1', '-f', 'null', '-'], { windowsHide: true })
  expect(first.status, first.stderr.toString()).toBe(0)
  await expect(validateMediaDecode(ffmpeg, damaged)).rejects.toThrow('전체 디코드')
}, 30000)
it('rejects a canceled validation without starting a decoder', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(validateMediaDecode('missing', 'missing', { signal: controller.signal })).rejects.toThrow('canceled')
})
