/**
 * 내보내기 렌더 스케줄 — 줄 자막과 단어 강조를 **출력 프레임 단위 상태 구간**으로 변환한다.
 *
 * - 시간 축: 입력 cue/word 는 원본(source) 초, 출력은 program 프레임이다. 컷·순서·반복은 `ProgramClip` 으로만 표현한다.
 * - 프레임 n 의 상태는 `t = n / fps`(프레임 시작 시각)에서 판정한다. FFmpeg raw 오버레이의 프레임 선택과 같다.
 * - 단어 강조는 `resolveHighlightWordIndex` 를 쓴다(목록 칩 강조와 같은 규칙). 단어 사이 틈·마지막 단어 뒤에서는
 *   직전 단어 강조를 `HIGHLIGHT_HOLD_SEC` 까지 유지하고, 그보다 긴 침묵에서만 줄은 보이고 강조만 꺼진다.
 * - 프레임에 닿지 않는 짧은 구간은 상태로 만들지 않는다. 동일 상태를 여러 번 캡처하지 않도록 구간을 합친다.
 */
import type { ProgramClip } from './clipPlan'
import { HIGHLIGHT_HOLD_SEC, HIGHLIGHT_LEAD_SEC, resolveHighlightWordIndex } from './activeWordResolver'

/** 부동소수 경계 보정(초). 1µs 이하 오차는 같은 시각으로 본다. */
const EDGE_EPS_SEC = 1e-6

export type ScheduleWord = {
  start: number
  end: number
  /** 줄 텍스트에 실제로 보이는 조각(정리된 표시 문자열) */
  text: string
}

export type ScheduleCue = {
  start: number
  end: number
  text: string
  words?: readonly ScheduleWord[]
}

export type RenderState = {
  startFrame: number
  /** 배타적 끝 프레임 */
  endFrame: number
  text: string
  /** 단어 강조를 렌더할 때만 존재 — `words.join(' ') === text` */
  words?: string[]
  /** `words` 안의 활성 인덱스, 없으면 -1 */
  activeIndex: number
}

export type BuildRenderScheduleArgs = {
  cues: readonly ScheduleCue[]
  clips: readonly ProgramClip[]
  fps: number
  highlightWords: boolean
}

type Piece = {
  cueIndex: number
  clip: ProgramClip
  /** program 초 */
  start: number
  end: number
}

function frameAtOrAfter(sec: number, fps: number): number {
  return Math.ceil((sec - EDGE_EPS_SEC) * fps)
}

function usableWords(cue: ScheduleCue, text: string): ScheduleWord[] | null {
  const words = cue.words
  if (!words || words.length === 0) return null
  for (const w of words) {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start) return null
    if (typeof w.text !== 'string' || w.text.length === 0) return null
  }
  // 줄 텍스트가 사용자 편집 등으로 단어 조각과 달라지면 강조 위치를 보장할 수 없다.
  return words.map((w) => w.text).join(' ') === text ? [...words] : null
}

export function buildRenderSchedule(args: BuildRenderScheduleArgs): RenderState[] {
  const { cues, clips, fps, highlightWords } = args
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('Invalid frame rate')

  const pieces: Piece[] = []
  cues.forEach((cue, cueIndex) => {
    if (cue.text.trim().length === 0) return
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) return
    for (const clip of clips) {
      const s = Math.max(cue.start, clip.sourceStart)
      const e = Math.min(cue.end, clip.sourceEnd)
      if (e <= s) continue
      pieces.push({
        cueIndex,
        clip,
        start: clip.programStart + s - clip.sourceStart,
        end: clip.programStart + e - clip.sourceStart
      })
    }
  })
  pieces.sort((a, b) => a.start - b.start || a.end - b.end || a.cueIndex - b.cueIndex)

  const states: RenderState[] = []
  /** 이미 상태가 배정된 마지막 프레임(배타) — 먼저 시작한 cue 가 겹치는 구간을 차지한다 */
  let cursor = 0
  for (const piece of pieces) {
    const first = Math.max(frameAtOrAfter(piece.start, fps), cursor)
    const last = frameAtOrAfter(piece.end, fps)
    if (last <= first) continue
    cursor = Math.max(cursor, last)

    const cue = cues[piece.cueIndex]!
    const text = cue.text.trim()
    const words = highlightWords ? usableWords(cue, text) : null
    if (!words) {
      states.push({ startFrame: first, endFrame: last, text, activeIndex: -1 })
      continue
    }

    const { clip } = piece
    const wordTexts = words.map((w) => w.text)
    const toProgramFrame = (sourceSec: number): number =>
      frameAtOrAfter(clip.programStart + sourceSec - clip.sourceStart, fps)

    const boundaries = new Set<number>([first])
    for (const w of words) {
      // 단어 시작·끝, 그리고 끝난 뒤 유지가 풀리는 시각(끝 + 유지 시간)에서 상태가 바뀔 수 있다.
      for (const f of [
        toProgramFrame(w.start - HIGHLIGHT_LEAD_SEC),
        toProgramFrame(w.start),
        toProgramFrame(w.end),
        toProgramFrame(w.end + HIGHLIGHT_HOLD_SEC)
      ]) {
        if (f > first && f < last) boundaries.add(f)
      }
    }
    const starts = [...boundaries].sort((a, b) => a - b)
    const activeAt = (frame: number): number => {
      const sourceSec = clip.sourceStart + (frame / fps + EDGE_EPS_SEC - clip.programStart)
      return resolveHighlightWordIndex(words, sourceSec)
    }
    let run: RenderState | null = null
    for (let i = 0; i < starts.length; i += 1) {
      const startFrame = starts[i]!
      const endFrame = i + 1 < starts.length ? starts[i + 1]! : last
      const activeIndex = activeAt(startFrame)
      if (run && run.activeIndex === activeIndex && run.endFrame === startFrame) {
        run.endFrame = endFrame
      } else {
        run = { startFrame, endFrame, text, words: wordTexts, activeIndex }
        states.push(run)
      }
    }
  }
  return states
}
