import {
  FLOAT_EPS,
  scrubTimelineNoiseFromWordPiece,
  shouldOmitFromSubtitleEditLineText,
  SILENCE_PLACEHOLDER_TEXT
} from './wordContract'
import { parseManualBoundaryLocks, parseWordAlignmentMeta, type WordAlignmentMeta } from './wordAlignmentMeta'
import { subtitlePresentationSpans } from './subtitlePresentation'

/** Python 사이드카(Faster-Whisper) 및 UI 공통 자막 줄 형식 */
export type SubtitleWord = SubtitleWordCore & WordAlignmentMeta

type SubtitleWordCore = {
  /**
   * 원본 미디어 파일 기준 절대 시각(초). EDL 정책: 삭제·리플로 절대 바뀌지 않음.
   * 편집(프로그램) 축 시간이 필요한 곳(Peaks 줌·세그먼트)은 `mapMediaToEditSec` 같은
   * 매핑을 통해서만 변환해 쓰고, 자막 상태에는 항상 원본 미디어 시각만 저장한다.
   */
  start: number
  end: number
  word: string
  /** true: gap-fill 등으로 삽입된 무음 구간(표시용 `word`는 보통 `??`) */
  isSilence?: boolean
  /** true: 비파괴 삭제(tombstone). 배열·타임스탬프는 유지하되 표시·재생·내보내기에서 제외 */
  isDeleted?: boolean
  /**
   * true: 단어 트림(엣지 드래그)으로 인접 단어에 흡수되어 tombstone 처리된 경우.
   *  - 텍스트는 흡수한 단어로 옮겨갔고, 미디어 오디오는 그대로 유지된다(잘리지 않음).
   *  - 따라서 stitched 파형 cut 으로 반영하지 *않는다*. `isDeleted` 일반 삭제(스킵 재생/내보내기)
   *    과 구분하기 위한 비파괴 메타 플래그.
   */
  mergedByEdgeTrim?: boolean
  /**
   * 자르기(`splitWordAtEditSecFromWaveform`) 분할 흔적 — 분할된 조각마다 부모 chain 에
   *  '1'(좌), '2'(우) 를 누적해 붙여 동일 storage 슬롯에서도 좌·우가 서로 다른 안정 ID 를
   *  갖도록 만든다(`vrewSubtitleAdapter` 가 어댑트할 때 `block_{g}_{slot}_{splitChain}` 형태).
   *  값이 없으면 분할되지 않은 원본 단어 — 기존 ID 그대로 부여.
   */
  splitChain?: string
}

export type SubtitleLine = {
  start: number
  end: number
  text: string
  words?: SubtitleWord[]
  /**
   * true: 줄 자체가 tombstone — 줄 안의 모든 단어가 `isDeleted` 가 되었을 때 함께 표시.
   * UI 에서 카드 자체를 숨기지만 배열에서는 제거하지 않아 추후 복구가 가능하다.
   */
  isDeleted?: boolean
}

/** 화면 표시·내보내기용 — `isDeleted` tombstone 과 무음 더미를 제외한 단어들 */
export function visibleSubtitleWords(
  words: readonly SubtitleWord[] | undefined
): SubtitleWord[] {
  if (!words || words.length === 0) return []
  return words.filter((w) => !w.isDeleted && !w.isSilence)
}

/**
 * `subtitleLinesToVrewRows(..., { gapFill: false })` 한 줄의 단어 순서는
 * `line.words` 에서 `isDeleted` 가 아닌 항목만 원래 순서대로 고른 것과 같다.
 * 그 **보이는** 순서 인덱스 → `SubtitleLine.words` 저장소 인덱스.
 *
 * gap-fill 로 무음 더미가 삽입된 행과는 대응하지 않는다.
 */
export function storageWordIndexFromVisibleNonDeletedIndex(
  line: SubtitleLine | undefined,
  visibleIndex: number
): number {
  if (!line?.words?.length || visibleIndex < 0) return -1
  const words = line.words
  let v = 0
  for (let wi = 0; wi < words.length; wi++) {
    if (words[wi]!.isDeleted) continue
    if (v === visibleIndex) return wi
    v++
  }
  return -1
}

/** 목록·내보내기용 — 삭제·무음 플레이스홀더는 제외한 표시 문자열 */
export function displayTextFromSubtitleWords(
  words: readonly SubtitleWord[] | undefined
): string {
  if (!words || words.length === 0) return ''
  return visibleSubtitleWords(words)
    .map((w) => scrubTimelineNoiseFromWordPiece(w.word))
    .filter((piece) => piece.length > 0 && !shouldOmitFromSubtitleEditLineText(piece))
    .join(' ')
    .trim()
}

/**
 * 내보내기 단어 강조용 — `displayTextFromSubtitleWords` 가 줄 문자열에 쓰는 것과 **같은 조각**을 시간과 함께 돌려준다.
 * (`pieces.map(p => p.text).join(' ')` 가 `displayTextFromSubtitleWords(words)` 와 같다.)
 */
export type SubtitleWordPiece = { start: number; end: number; text: string }

export function subtitleWordPiecesForExport(
  words: readonly SubtitleWord[] | undefined
): SubtitleWordPiece[] {
  if (!words || words.length === 0) return []
  const out: SubtitleWordPiece[] = []
  for (const w of visibleSubtitleWords(words)) {
    const text = scrubTimelineNoiseFromWordPiece(w.word)
    if (text.length === 0 || shouldOmitFromSubtitleEditLineText(text)) continue
    out.push({ start: w.start, end: w.end, text })
  }
  return out
}

function normSubtitleLineEdit(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 자막 카드 한 줄 편집(textarea)에 보일 문자열.
 * - `words` 로 만든 문장과 저장된 `line.text` 가 다르면 **줄 텍스트(사용자 편집)** 를 우선한다.
 * - 단어에 붙은 `...` / `--` 는 표시용으로만 제거한다.
 */
export function subtitleLineEditDisplayText(line: {
  text?: string
  words?: readonly SubtitleWord[] | undefined
}): string {
  const words = line.words
  const fromWords =
    words && words.length > 0 ? displayTextFromSubtitleWords(words) : ''

  const raw = String(line.text ?? '').trim()
  const fromTextSanitized = raw
    .split(/\s+/)
    .map((t) => scrubTimelineNoiseFromWordPiece(t))
    .filter((piece) => piece.length > 0 && !shouldOmitFromSubtitleEditLineText(piece))
    .join(' ')
    .trim()

  if (fromTextSanitized.length === 0) return fromWords

  if (fromWords.length > 0) {
    if (normSubtitleLineEdit(fromTextSanitized) !== normSubtitleLineEdit(fromWords)) {
      return fromTextSanitized
    }
    return fromWords
  }

  return fromTextSanitized
}

/** Only merge touching, explicitly marked quiet spans; token labels cannot prove silence. */
export function normalizeSilenceWordsForLineWords(words: readonly SubtitleWord[]): SubtitleWord[] {
  return mergeConsecutiveSilenceWords(words)
}

/** 연속된 무음 단어(`isSilence` 또는 표시 `--`)를 저장 순서대로 하나의 구간으로 합친다. */
export function mergeConsecutiveSilenceWords(words: readonly SubtitleWord[]): SubtitleWord[] {
  if (!words.length) return []
  const isSilBlock = (w: SubtitleWord): boolean =>
    w.isDeleted !== true &&
    (w.isSilence === true || String(w.word ?? '').trim() === SILENCE_PLACEHOLDER_TEXT)

  const out: SubtitleWord[] = []
  for (const w of words) {
    if (w.isDeleted === true) {
      out.push({ ...w })
      continue
    }
    if (!isSilBlock(w)) {
      out.push({ ...w })
      continue
    }
    const prev = out[out.length - 1]
    if (prev && prev.isDeleted !== true && isSilBlock(prev) &&
        !prev.manualStartLocked && !prev.manualEndLocked && !w.manualStartLocked && !w.manualEndLocked &&
        w.start <= prev.end + 1e-9 && prev.start <= w.end + 1e-9) {
      prev.start = Math.min(prev.start, w.start)
      prev.end = Math.max(prev.end, w.end)
      prev.word = SILENCE_PLACEHOLDER_TEXT
      prev.isSilence = true
      continue
    }
    out.push({
      ...w,
      word: SILENCE_PLACEHOLDER_TEXT,
      isSilence: true
    })
  }
  return out
}

export function mergeConsecutiveSilenceWordsInLine(line: SubtitleLine): SubtitleLine {
  if (!line.words?.length) return line
  const merged = normalizeSilenceWordsForLineWords(line.words)
  let same = merged.length === line.words.length
  if (same) {
    for (let i = 0; i < merged.length; i++) {
      const a = merged[i]!
      const b = line.words[i]!
      if (
        a.start !== b.start ||
        a.end !== b.end ||
        a.word !== b.word ||
        a.isSilence !== b.isSilence ||
        a.isDeleted !== b.isDeleted
      ) {
        same = false
        break
      }
    }
  }
  if (same) return line
  const alive = merged.filter((x) => !x.isDeleted)
  const start = alive.length > 0 ? Math.min(...alive.map((x) => x.start)) : line.start
  const end = alive.length > 0 ? Math.max(...alive.map((x) => x.end)) : line.end
  return {
    ...line,
    start,
    end: Math.max(start + 0.01, end),
    words: merged,
    text: displayTextFromSubtitleWords(merged) || line.text
  }
}

/**
 * Whisper 등에서 인접 단어 `end` / `start` 사이에 빈 시간이 있는데 `isSilence` 블록이 없으면
 * `--` 를 넣는다. 피크 분할만으로는 타임스탬프가 맞닿아 무음이 누락된 경우를 메운다.
 * `isDeleted` 가 있으면 저장 순서를 건드리지 않기 위해 스킵한다(추출 직후에는 보통 없음).
 */
export const EXTRACT_TEMPORAL_GAP_SILENCE_SEC = 0.08

export function insertMissingTemporalSilenceGapsInLine(
  line: SubtitleLine,
  gapThresholdSec: number = EXTRACT_TEMPORAL_GAP_SILENCE_SEC
): SubtitleLine {
  if (!line.words?.length) return line
  if (line.words.some((w) => w.isDeleted === true)) return line

  const sorted = [...line.words].sort((a, b) => a.start - b.start || a.end - b.end)
  const intervalTouchedBySilence = (t0: number, t1: number): boolean =>
    line.words!.some(
      (w) =>
        w.isDeleted !== true &&
        w.isSilence === true &&
        !(w.end <= t0 + FLOAT_EPS || w.start >= t1 - FLOAT_EPS)
    )

  const out: SubtitleWord[] = []
  let inserted = false
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0) {
      const prev = sorted[i - 1]!
      const cur = sorted[i]!
      const pe = Math.max(prev.start, prev.end)
      const cs = Math.min(cur.start, cur.end)
      const dur = cs - pe
      if (dur >= gapThresholdSec - FLOAT_EPS && !intervalTouchedBySilence(pe, cs)) {
        out.push({
          start: pe,
          end: cs,
          word: SILENCE_PLACEHOLDER_TEXT,
          isSilence: true
        })
        inserted = true
      }
    }
    out.push({ ...sorted[i]! })
  }

  if (!inserted) return line
  return mergeConsecutiveSilenceWordsInLine({ ...line, words: out })
}

/** SRT/VTT/ASS/번인 IPC 큐용 — `{ start, end, text }` 만 남기되, tombstone 으로 좁힌다. */
export type SubtitleCueLineForExport = { start: number; end: number; text: string }

export function subtitleCueLinesForExport(
  lines: readonly SubtitleLine[]
): SubtitleCueLineForExport[] {
  const out: SubtitleCueLineForExport[] = []
  for (const span of subtitlePresentationSpans(lines)) {
    const line = lines[span.index]
    const hasWords = Array.isArray(line.words) && line.words.length > 0
    if (hasWords) {
      const vis = visibleSubtitleWords(line.words)
      if (vis.length === 0) continue
      const { start, end } = span
      const text = displayTextFromSubtitleWords(line.words) || (line.text ?? '').trim()
      if (text.length === 0) continue
      out.push({ start, end, text })
    } else {
      const text = (line.text ?? '').trim()
      if (text.length === 0) continue
      out.push({ start: line.start, end: span.end, text })
    }
  }
  return out
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** 사이드카 JSON `subtitles` 배열을 `{ start, end, text }[]` 로 정규화 */
export function parseSubtitleLines(raw: unknown): SubtitleLine[] {
  if (!Array.isArray(raw)) return []
  const out: SubtitleLine[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const start = Number(item.start)
    const end = Number(item.end)
    const text = typeof item.text === 'string' ? item.text : ''
    const wordsRaw = Array.isArray(item.words) ? item.words : []
    const words: SubtitleWord[] = []
    for (const w of wordsRaw) {
      if (!isRecord(w)) continue
      const ws = Number(w.start)
      const we = Number(w.end)
      const ww = typeof w.word === 'string' ? w.word : ''
      const isSilence =
        w.isSilence === true ||
        (typeof (w as { is_silence?: unknown }).is_silence === 'boolean' &&
          (w as { is_silence?: boolean }).is_silence === true)
      const isDeleted =
        w.isDeleted === true ||
        (typeof (w as { is_deleted?: unknown }).is_deleted === 'boolean' &&
          (w as { is_deleted?: boolean }).is_deleted === true)
      if (!Number.isFinite(ws) || !Number.isFinite(we)) continue
      if (ww.trim().length === 0 && !isSilence && !isDeleted) continue
      const tw = ww.trim()
      const entry: SubtitleWord = {
        start: ws,
        end: we,
        word: isSilence ? SILENCE_PLACEHOLDER_TEXT : tw.length > 0 ? tw : '??'
      }
      if (isSilence) entry.isSilence = true
      if (isDeleted) entry.isDeleted = true
      // 무음 더미는 정렬 상태를 갖지 않는다.
      if (!isSilence) Object.assign(entry, parseWordAlignmentMeta(w))
      else Object.assign(entry, parseManualBoundaryLocks(w))
      words.push(entry)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const mergedWords = normalizeSilenceWordsForLineWords(words)
    const lineText = mergedWords.length > 0 ? displayTextFromSubtitleWords(mergedWords) : text.trim()
    out.push({ start, end, text: lineText, words: mergedWords })
  }
  return out
}
