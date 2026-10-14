// 재생 중 "자막(줄)은 보이는데 단어 하이라이트가 꺼진 시간"을 실제 앱에서 측정한다.
// launch-test-app.cjs 를 아래 환경으로 먼저 띄운다:
//   AUTOSUBTITLE_E2E_PROJECT = tools/sync-validation-output/<프로젝트>.autosub
//   AUTOSUBTITLE_E2E_OUTPUT  = tools/sync-validation-output/<새 이름>.mp4
// 사용: node scripts/e2e-cdp/highlight-continuity.mjs [포트=9333] [재생초=25] [시작초(-1=첫 칩)=-1]
import { readFileSync } from 'node:fs'
import { connect } from './cdp.mjs'

const port = Number(process.argv[2] ?? 9333)
const playSec = Number(process.argv[3] ?? 25)
const startSec = Number(process.argv[4] ?? -1)
const startChip = 0
const c = await connect(port)
const until = async (expression, label = expression, ms = 120000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await c.evaluate(expression)) return
    await c.sleep(200)
  }
  throw Error('Timed out: ' + label)
}
async function clickButton(label) {
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`, `button ${label}`)
  const p = await c.evaluate(`(() => {const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(p.x, p.y)
}

try {
  await clickButton('불러오기')
  await until(`document.querySelectorAll('.subtitle-word-chip').length > 10`, 'word chips')
  await c.sleep(1500)

  if (startSec >= 0) {
    // 재생 위치 슬라이더로 원하는 시각으로 이동한 뒤 재생 버튼을 누른다.
    await c.evaluate(`(() => {
      const el = document.querySelector('input.preview-seek')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(el, ${JSON.stringify(String(startSec))})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await c.sleep(1500)
    const btn = await c.evaluate(`(() => {
      const b = document.querySelector('.preview-play-icon')?.closest('button')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    if (!btn) throw Error('재생 버튼을 찾지 못했다')
    await c.click(btn.x, btn.y, 800)
    console.log('시작 위치:', startSec, 's')
  } else {
    // 시작 위치로 이동: n번째 단어 칩 클릭 → Space 로 재생
    const pos = await c.evaluate(`(() => {
      const chips = [...document.querySelectorAll('.subtitle-word-chip')].filter(e => !e.classList.contains('subtitle-word-chip--silence'))
      const e = chips[${startChip}] ?? chips[0]
      e.scrollIntoView({block:'center'})
      const r = e.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: e.textContent }
    })()`)
    await c.click(pos.x, pos.y, 400)
    await c.press('Space')
    await c.sleep(600)
    console.log('시작 단어:', pos.text)
  }
  const started = await c.evaluate(`!document.querySelector('video').paused`)
  console.log('재생 시작:', started)

  // 목록이 재생 위치를 따라가지 않으므로, 활성 카드가 DOM 에 없으면 그 카드가 보이도록 목록을 스크롤한다.
  // (활성 카드가 실제로 보이는 구간만 집계해 "카드가 없어서 칩이 없는" 인공적인 꺼짐을 배제한다.)
  const projectPath = process.env.AUTOSUBTITLE_E2E_PROJECT
  const spans = (() => {
    if (!projectPath) return []
    const lines = JSON.parse(readFileSync(projectPath, 'utf8')).subtitles ?? []
    const out = lines.map((l, index) => ({ index, start: l.start, end: l.end })).sort((a, b) => a.start - b.start)
    for (let i = 0; i + 1 < out.length; i += 1) out[i].end = out[i + 1].start
    return out
  })()
  const idxAt = (t) => {
    let lo = 0
    let hi = spans.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (spans[mid].start <= t) lo = mid + 1
      else hi = mid - 1
    }
    return hi >= 0 ? hi : 0
  }

  const samples = []
  const t0 = Date.now()
  while (Date.now() - t0 < playSec * 1000) {
    const tNow = await c.evaluate(`document.querySelector('video').currentTime`)
    const estIdx = idxAt(tNow)
    const s = await c.evaluate(`(() => {
      const v = document.querySelector('video')
      const cap = document.querySelector('.preview-subtitle-text')?.textContent ?? ''
      const cardMounted = !!document.querySelector('.subtitle-card--active')
      const active = document.querySelectorAll('.subtitle-word-chip--active').length
      // 카드가 활성이 되기 전에 미리 마운트되도록, 예상 카드를 항상 화면 중앙에 둔다.
      const list = document.querySelector(".subtitle-virtual-list")
      if (list) {
        const avg = Math.max(20, list.scrollHeight / Math.max(1, ${spans.length}))
        const target = Math.max(0, ${estIdx} * avg - list.clientHeight / 2)
        if (Math.abs(list.scrollTop - target) > avg * 2) list.scrollTop = target
      }
      const activeCard = document.querySelector(".subtitle-card--active")
      const speechChips = activeCard ? [...activeCard.querySelectorAll(".subtitle-word-chip")].filter((e) => !e.classList.contains("subtitle-word-chip--silence")).length : -1
      const cardId = activeCard ? activeCard.id : ""
      return { t: v.currentTime, paused: v.paused, caption: cap.trim().length > 0, cardMounted, active, speechChips, cardId }
    })()`)
    samples.push({ wall: Date.now() - t0, ...s })
    await c.sleep(40)
  }
  await c.press('Space')

  const playing = samples.filter((s) => !s.paused)
  const capShown = playing.filter((s) => s.caption && s.cardMounted)
  console.log('활성 카드가 목록에 보인 샘플:', capShown.length, '/', playing.length)
  const off = capShown.filter((s) => s.active === 0)
  // 연속 꺼짐 구간(미디어 시간 기준)
  const runs = []
  let run = null
  for (const s of capShown) {
    if (s.active === 0) {
      if (!run) run = { from: s.t, to: s.t }
      run.to = s.t
    } else if (run) {
      runs.push(run)
      run = null
    }
  }
  if (run) runs.push(run)
  const long = runs.filter((r) => r.to - r.from >= 0.2)
  const longest = runs.reduce((m, r) => Math.max(m, r.to - r.from), 0)
  console.log('샘플', samples.length, '재생 중', playing.length, '자막 표시 중', capShown.length)
  console.log('자막은 보이는데 하이라이트 없음: %d / %d (%s%%)', off.length, capShown.length, ((100 * off.length) / Math.max(1, capShown.length)).toFixed(1))
  console.log('0.2초 이상 꺼진 구간 %d곳, 최장 %s초, 합계 %s초', long.length, longest.toFixed(2), long.reduce((a, r) => a + (r.to - r.from), 0).toFixed(1))
  console.log('꺼진 구간 목록(미디어 초):', long.slice(0, 12).map((r) => `${r.from.toFixed(2)}~${r.to.toFixed(2)}`).join('  '))
  // 꺼진 샘플을 카드 종류별로: 말 단어가 있는 카드에서 꺼진 것이 실제 문제, 무음 전용 카드는 설계상 강조 대상이 없다.
  const offSpeech = off.filter((s) => s.speechChips > 0)
  const offSilenceOnly = off.filter((s) => s.speechChips === 0)
  console.log('  └ 말 단어가 있는 카드에서 꺼짐: %d (%s%%) / 무음 전용 카드: %d', offSpeech.length, ((100 * offSpeech.length) / Math.max(1, capShown.length)).toFixed(1), offSilenceOnly.length)
  const speechRuns = []
  let sr = null
  for (const s of capShown) {
    if (s.active === 0 && s.speechChips > 0) {
      if (!sr) sr = { from: s.t, to: s.t, card: s.cardId }
      sr.to = s.t
    } else if (sr) {
      speechRuns.push(sr)
      sr = null
    }
  }
  if (sr) speechRuns.push(sr)
  const speechLong = speechRuns.filter((r) => r.to - r.from >= 0.2)
  console.log('  └ 말 카드에서 0.2초 이상 꺼진 구간 %d곳, 최장 %s초, 합계 %s초', speechLong.length,
    speechLong.reduce((m, r) => Math.max(m, r.to - r.from), 0).toFixed(2), speechLong.reduce((a, r) => a + (r.to - r.from), 0).toFixed(1))
  console.log('    ', speechLong.slice(0, 15).map((r) => `${r.from.toFixed(2)}~${r.to.toFixed(2)}`).join('  '))
} finally {
  c.close()
}
