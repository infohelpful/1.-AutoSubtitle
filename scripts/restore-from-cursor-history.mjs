/**
 * Cursor User/History 최신 스냅샷 → 워크스페이스 파일로 복사
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const base = 'C:/Users/MyComputer/AppData/Roaming/Cursor/User/History'
let restored = 0
const errs = []

for (const dir of fs.readdirSync(base)) {
  const ep = path.join(base, dir, 'entries.json')
  if (!fs.existsSync(ep)) continue
  let j
  try {
    j = JSON.parse(fs.readFileSync(ep, 'utf8'))
  } catch {
    continue
  }
  const res = j.resource || ''
  if (!res.includes('AutoSubtitle')) continue
  let best = null
  for (const e of j.entries || []) {
    if (!best || e.timestamp > best.timestamp) best = e
  }
  if (!best) continue
  const src = path.join(base, dir, best.id)
  if (!fs.existsSync(src)) {
    errs.push(`missing blob: ${src}`)
    continue
  }
  let dest
  try {
    const u = new URL(res)
    const p = u.pathname
    dest = decodeURIComponent(p)
    if (/^\/[a-zA-Z]:/.test(dest)) dest = dest.slice(1)
  } catch (e) {
    errs.push(`bad resource: ${res}`)
    continue
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    restored++
    console.log('OK', dest)
  } catch (e) {
    errs.push(`${dest}: ${e.message}`)
  }
}

console.log('--- done:', restored, 'files')
if (errs.length) {
  console.log('errors:', errs.length)
  errs.slice(0, 20).forEach((x) => console.log(x))
}
