/**
 * SubtitleLine[] ↔ SentenceTokenTimeline 어댑터.
 * React/App 단일 소스는 SentenceTokenTimeline; UI·IPC·내보내기는 파생 SubtitleLine[] 를 사용한다.
 *
 * **Incremental round-trip cache (성능):**
 * 단어 1개 삭제·분할 시에도 어댑터를 그대로 호출하면 303 line × 1473 word 의 **전체** 객체가
 * 매번 재생성되어 모든 SubtitleVirtualRow 가 새 props 로 reconciliation 됐다(편집 1회 = 850ms longtask).
 * WeakMap 양방향 캐시로 **변경되지 않은 line/sentence 는 이전 reference 그대로 반환** —
 * 변경된 카드 1개만 새 객체이므로 React 가 나머지 302 행을 reference 비교로 skip 한다.
 *
 * cross-link:
 *  - `lineToSentence` : SubtitleLine → 그 line 으로 만든 (혹은 line 의 원본인) TimelineSentence
 *  - `sentenceToLine` : TimelineSentence → 그 sentence 로 만든 (혹은 sentence 의 원본인) SubtitleLine
 *  두 캐시를 round-trip 마다 cross-set 하므로 `adapterA(adapterB(x))` 의 부분 reference 가 유지된다.
 *  WeakMap 이므로 메모리 누수 없음.
 */
import type { SubtitleLine, SubtitleWord } from './subtitles'
import { displayTextFromSubtitleWords, visibleSubtitleWords } from './subtitles'
import type { SentenceTokenTimeline, TimelineSentence, TimelineToken } from './sentenceTokenTimeline'

function sentenceIdForLineIndex(li: number): string {
  return `sub-${li}`
}

function tokenIdFor(li: number, wi: number): string {
  return `tok-${li}-${wi}`
}

const lineToSentence: WeakMap<SubtitleLine, TimelineSentence> = new WeakMap()
const sentenceToLine: WeakMap<TimelineSentence, SubtitleLine> = new WeakMap()

function buildSentenceFromLine(line: SubtitleLine, li: number): TimelineSentence {
  const words = line.words
  if (words && words.length > 0) {
    const tokens: TimelineToken[] = words.map((w, wi) => {
      const t: TimelineToken = {
        id: tokenIdFor(li, wi),
        text: w.word,
        start_original: w.start,
        end_original: w.end
      }
      if (w.isDeleted === true) t.is_deleted = true
      if (w.isSilence === true) t.isSilence = true
      if (w.splitChain) t.splitChain = w.splitChain
      return t
    })
    return {
      id: sentenceIdForLineIndex(li),
      tokens,
      is_deleted: line.isDeleted === true ? true : false
    }
  }
  return {
    id: sentenceIdForLineIndex(li),
    tokens: [
      {
        id: tokenIdFor(li, 0),
        text: (line.text ?? '').trim() || ' ',
        start_original: line.start,
        end_original: line.end
      }
    ],
    is_deleted: line.isDeleted === true ? true : false
  }
}

function buildLineFromSentence(sentence: TimelineSentence): SubtitleLine | null {
  const raw = sentence.tokens
  if (raw.length === 0) return null

  const words: SubtitleWord[] = raw.map((t) => {
    const w: SubtitleWord = {
      start: t.start_original,
      end: t.end_original,
      word: t.text
    }
    if (t.is_deleted === true) w.isDeleted = true
    if (t.isSilence === true) w.isSilence = true
    if (t.splitChain) w.splitChain = t.splitChain
    return w
  })

  const vis = visibleSubtitleWords(words)
  const start =
    vis.length > 0 ? Math.min(...vis.map((w) => w.start)) : Math.min(...words.map((w) => w.start))
  const end =
    vis.length > 0 ? Math.max(...vis.map((w) => w.end)) : Math.max(...words.map((w) => w.end))
  const text = displayTextFromSubtitleWords(words)
  /**
   * 줄 단위 tombstone(`isDeleted: true`) 은 어레이에서 잘라내지 않는다.
   * - useWordEdgeDrag 의 revive 가 흡수된 단어를 되살리려면 그 라인의 단어들이 flat 입력에 포함되어 있어야 함.
   * - 어레이 길이가 매 commit 마다 변하면 react/store hydrate 가 full-snapshot 경로로 떨어져 비쌈.
   * - UI 측 SubtitleVirtualList 가 0-height 로 숨기므로 사용자에게는 사라진 것처럼 보인다.
   */
  const line: SubtitleLine = {
    start,
    end: Math.max(start + 0.1, end),
    text,
    words
  }
  if (sentence.is_deleted === true) line.isDeleted = true
  return line
}

/**
 * 기존 자막 줄 배열 → 문장·토큰 타임라인.
 * 줄 인덱스가 문장 id(stable)에 대응한다.
 *
 * 변경되지 않은 line 은 이전 round-trip 에서 cross-link 된 sentence reference 를 그대로 재사용한다.
 */
export function subtitleLinesToSentenceTokenTimeline(lines: readonly SubtitleLine[]): SentenceTokenTimeline {
  const out: TimelineSentence[] = []
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!
    const cached = lineToSentence.get(line)
    if (cached !== undefined) {
      out.push(cached)
      continue
    }
    const sentence = buildSentenceFromLine(line, li)
    lineToSentence.set(line, sentence)
    sentenceToLine.set(sentence, line)
    out.push(sentence)
  }
  return out
}

/**
 * 타임라인 → 자막 줄 배열 (편집기·Peaks·저장 포맷과 호환).
 *
 * 변경되지 않은 sentence 는 cross-link 된 이전 line reference 를 그대로 재사용한다 — 같은 reference 로
 * `useMemo([subtitles])` 소비처가 line-level shallow 비교 시 sub-tree 를 skip 할 수 있다.
 */
export function sentenceTokenTimelineToSubtitleLines(timeline: SentenceTokenTimeline): SubtitleLine[] {
  const result: SubtitleLine[] = []
  for (const sentence of timeline) {
    const cached = sentenceToLine.get(sentence)
    if (cached !== undefined) {
      result.push(cached)
      continue
    }
    const line = buildLineFromSentence(sentence)
    if (line === null) continue
    sentenceToLine.set(sentence, line)
    lineToSentence.set(line, sentence)
    result.push(line)
  }
  return result
}
