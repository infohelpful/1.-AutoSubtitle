import { SILENCE_PLACEHOLDER_TEXT } from './wordContract'

/** Python 사이드카(Faster-Whisper) 및 UI 공통 자막 줄 형식 */
export type SubtitleWord = {
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
    .map((w) => w.word)
    .join(' ')
    .trim()
}

/** SRT/VTT/ASS/번인 IPC 큐용 — `{ start, end, text }` 만 남기되, tombstone 으로 좁힌다. */
export type SubtitleCueLineForExport = { start: number; end: number; text: string }

export function subtitleCueLinesForExport(
  lines: readonly SubtitleLine[]
): SubtitleCueLineForExport[] {
  const out: SubtitleCueLineForExport[] = []
  for (const line of lines) {
    const hasWords = Array.isArray(line.words) && line.words.length > 0
    if (hasWords) {
      const vis = visibleSubtitleWords(line.words)
      if (vis.length === 0) continue
      const start = Math.min(...vis.map((w) => w.start))
      const end = Math.max(...vis.map((w) => w.end))
      const text = displayTextFromSubtitleWords(line.words) || (line.text ?? '').trim()
      if (text.length === 0) continue
      out.push({ start, end, text })
    } else {
      const text = (line.text ?? '').trim()
      if (text.length === 0) continue
      out.push({ start: line.start, end: line.end, text })
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
      words.push(entry)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    out.push({ start, end, text, words })
  }
  return out
}
