// 자동 줄바꿈 + SRT/대본 가져오기 UI e2e.
// launch-test-app.cjs 를 아래 환경으로 먼저 띄운다(파일 선택 큐: 프로젝트 → SRT → 대본):
//   AUTOSUBTITLE_E2E_PROJECT = tools/sync-validation-output/real-video-fixture.autosub
//   AUTOSUBTITLE_E2E_OUTPUT  = tools/sync-validation-output/<새 이름>.mp4
//   AUTOSUBTITLE_E2E_OPEN_QUEUE = [project, import-test.srt, import-test-script.txt]
// 사용: node scripts/e2e-cdp/linebreak-import.mjs [포트=9333]
import assert from 'node:assert/strict'
import { connect } from './cdp.mjs'

const port = Number(process.argv[2] ?? 9333)
const c = await connect(port)
const until = async (expression, label = expression) => {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (await c.evaluate(expression)) return
    await c.sleep(200)
  }
  throw Error('Timed out: ' + label)
}
const notice = () => c.evaluate(`document.querySelector('.subtitle-panel-sub [role="status"]')?.textContent ?? ''`)
async function click(label) {
  await until(
    `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`,
    `button ${label}`
  )
  const p = await c.evaluate(`(() => {const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.click(p.x, p.y)
}

try {
  // confirm 대화상자는 CDP 를 막으므로 자동 승인으로 바꾼다.
  await c.evaluate(`window.confirm = () => true`)

  await click('불러오기')
  await until(`document.querySelectorAll('.subtitle-word-chip').length > 10`, 'word chips')
  console.log('PASS: project loaded')

  // 새 컨트롤이 렌더되는지
  assert.ok(await c.evaluate(`!!document.querySelector('.subtitle-linebreak-ctl input[type=number]')`), '줄당 글자 수 입력이 없다')
  assert.ok(await c.evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='대본/SRT 가져오기')`))
  assert.ok(await c.evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='자동 줄바꿈')`))
  console.log('PASS: line-break control and import button rendered')

  // 줄당 글자 수를 8 로 낮추고 자동 줄바꿈
  await c.evaluate(`(() => {
    const el = document.querySelector('.subtitle-linebreak-ctl input[type=number]')
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, '8'); el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await c.sleep(150)
  // 목록은 가상 스크롤이므로 DOM 칩 수가 아니라 첫 줄 텍스트 길이로 확인한다(원래 33자).
  const firstLineBefore = await c.evaluate(`document.querySelector('textarea[data-subtitle-edit]')?.value ?? ''`)
  await click('자동 줄바꿈')
  await until(`document.querySelector('.subtitle-panel-sub [role="status"]')?.textContent.includes('나눴습니다')`, 'line break notice')
  console.log('PASS: auto line break →', await notice())
  await until(
    `(document.querySelector('textarea[data-subtitle-edit]')?.value ?? '').length < ${firstLineBefore.length}`,
    'first line shortened'
  )
  const firstLineAfter = await c.evaluate(`document.querySelector('textarea[data-subtitle-edit]')?.value ?? ''`)
  assert.ok(firstLineAfter.length <= 14, `첫 줄이 충분히 짧아지지 않았다: "${firstLineAfter}"`)
  assert.ok(firstLineBefore.startsWith(firstLineAfter.trim()), '나뉜 첫 줄은 원래 줄의 앞부분이어야 한다')
  console.log(`PASS: first line "${firstLineBefore}" → "${firstLineAfter}"`)

  // SRT 가져오기 (큐의 두 번째 파일)
  await click('대본/SRT 가져오기')
  await until(`document.querySelector('.subtitle-panel-sub [role="status"]')?.textContent.includes('자막 3줄을 가져왔습니다')`, 'srt import notice')
  console.log('PASS: SRT import →', await notice())
  assert.equal(
    await c.evaluate(`document.querySelectorAll('textarea[data-subtitle-edit]').length > 0`),
    true
  )

  // 대본 가져오기 (큐의 세 번째 파일) — 방금 가져온 SRT 줄의 단어 시간과 정렬한다.
  await click('대본/SRT 가져오기')
  await until(
    `(() => { const t = document.querySelector('.subtitle-panel-sub [role="status"]')?.textContent ?? ''; return t.includes('대본') && t.includes('가져왔습니다') })()`,
    'script import notice'
  )
  console.log('PASS: script import →', await notice())
  console.log('ALL PASS')
} finally {
  c.close()
}
