import type { SubtitleLine, SubtitleWord } from './subtitles'
import { subtitleLineEditDisplayText } from './subtitles'
import { parseWordAlignmentMeta } from './wordAlignmentMeta'

export type PreparedRealignCue = SubtitleLine & {
  wordGroups: Array<{ sourceIndex: number; ids: string[] }>
}

export function prepareRealignCue(line: SubtitleLine, requestId: string, seen = new Set<string>()): PreparedRealignCue {
  const wordGroups: PreparedRealignCue['wordGroups'] = []
  const words = (line.words ?? []).flatMap((w, sourceIndex) => {
    if (w.isDeleted || w.isSilence || !w.word.trim()) return []
    const i = wordGroups.length
    const id = w.id && !seen.has(w.id) ? w.id : `${requestId}:word:${i}`
    seen.add(id)
    // An explicit pronunciation is a mapping for the whole slot. Keep it intact.
    const pieces = w.readingOverride ? [w.word] : w.word.trim().split(/\s+/u)
    const split = pieces.length > 1
    const group = pieces.map((piece, part) => {
      const child: SubtitleWord = { ...w, id: part === 0 ? id : `${requestId}:split:${i}:${part}`,
        word: split ? piece : w.word }
      if (split) {
        if (part > 0) child.parentWordId = id
        child.manualStartLocked = part === 0 && !!w.manualStartLocked
        child.manualEndLocked = part === pieces.length - 1 && !!w.manualEndLocked
        child.alignmentStatus = 'stale'
        delete child.charSpans
        delete child.textSpanMap
        delete child.alignmentText
      }
      return child
    })
    wordGroups.push({ sourceIndex, ids: group.map(child => child.id!) })
    return group
  })
  if (!words.length) throw new Error('재정렬할 발화 단어가 없습니다.')
  return { ...line, words, wordGroups }
}

export type RealignBatchEntry = { index: number; cue: PreparedRealignCue }

/** Respect the worker's 100-cue/10,000-word limits and keep IDs unique across rows. */
export function prepareRealignBatches(lines: readonly SubtitleLine[], requestId: string, targetIndex?: number): RealignBatchEntry[][] {
  const batches: RealignBatchEntry[][] = []
  const seen = new Set<string>()
  let batch: RealignBatchEntry[] = [], count = 0
  lines.forEach((line, index) => {
    if (targetIndex !== undefined && targetIndex !== index) return
    if (line.isDeleted || !line.words?.some(w => !w.isDeleted && !w.isSilence && w.word.trim())) return
    const cue = prepareRealignCue(line, `${requestId}:line:${index}`, seen)
    const size = cue.words!.length
    if (size > 10000) throw new Error('한 줄의 단어가 너무 많습니다. 줄을 나눈 뒤 다시 정렬해 주세요.')
    if (batch.length >= 100 || count + size > 10000) {
      batches.push(batch); batch = []; count = 0
    }
    batch.push({ index, cue }); count += size
  })
  if (batch.length) batches.push(batch)
  if (!batches.length) throw new Error('재정렬할 발화 단어가 없습니다.')
  return batches
}

/** A whole response is accepted once or rejected. It must never overwrite new user edits. */
export function mergeRealignedCue(line: SubtitleLine, request: PreparedRealignCue, returned: SubtitleLine, selectedWordIds?: ReadonlySet<string>): SubtitleLine {
  if (selectedWordIds) {
    const visibleIds = new Set((line.words ?? []).filter(w => !w.isDeleted && !w.isSilence && w.word.trim()).map(w => w.id))
    if (!selectedWordIds.size || [...selectedWordIds].some(id => !visibleIds.has(id))) {
      throw new Error('선택한 단어가 변경되었습니다. 다시 선택해 주세요.')
    }
  }
  const before = request.words ?? [], after = returned.words ?? []
  if (before.length !== after.length) throw new Error('정렬 결과 단어 수가 다릅니다.')
  const updates = new Map<string, SubtitleWord>()
  for (let i = 0; i < before.length; i++) {
    const a = before[i], b = after[i]
    if (!a.id || a.id !== b.id || a.word !== b.word || updates.has(a.id) ||
        !Number.isFinite(b.start) || !Number.isFinite(b.end) || b.start < 0 || b.end <= b.start ||
        (a.manualStartLocked && a.start !== b.start) || (a.manualEndLocked && a.end !== b.end)) {
      throw new Error('정렬 결과의 ID·문자·수동 경계가 요청과 다릅니다.')
    }
    const updated = { ...a, ...parseWordAlignmentMeta(b), start: b.start, end: b.end }
    for (const key of ['charSpans', 'textSpanMap', 'alignmentText'] as const) {
      if (b[key] === undefined) delete updated[key]
    }
    updates.set(a.id, updated)
  }
  const groups = new Map(request.wordGroups.map(group => [group.sourceIndex, group.ids]))
  const words = (line.words ?? []).flatMap((w, index) => {
    // Align with the full sentence as acoustic context, but keep all other slots
    // exactly as stored, including their IDs, manual edits and quality metadata.
    if (selectedWordIds && (!w.id || !selectedWordIds.has(w.id))) return [w]
    const ids = groups.get(index)
    if (!ids) return [w]
    const children = ids.map(id => updates.get(id)!)
    if (children.length > 1 && (children.some(child =>
      !['aligned', 'manual'].includes(child.alignmentStatus ?? '') || child.sourceStart == null || child.sourceEnd == null) ||
      children.some((child, i) => i > 0 && (child.start < children[i - 1].start || child.end < children[i - 1].end)))) {
      // Do not commit guessed, overlapping child slots when acoustic alignment failed.
      const failed: SubtitleWord = { ...w, alignmentStatus: 'unaligned', alignmentScore: null, sourceStart: null, sourceEnd: null,
        reviewReasons: [...new Set([...(w.reviewReasons ?? []), ...children.flatMap(c => c.reviewReasons ?? []), 'retokenization_unaligned'])] }
      delete failed.charSpans
      delete failed.textSpanMap
      delete failed.alignmentText
      return [failed]
    }
    return children
  })
  if (selectedWordIds) {
    const speech = words.filter(w => !w.isDeleted && !w.isSilence && w.word.trim())
    if (speech.some((word, i) => i > 0 && (word.start < speech[i - 1].start || word.end < speech[i - 1].end))) {
      throw new Error('선택 단어의 정렬이 이웃 단어와 충돌합니다. 이 줄 전체를 재정렬하거나 경계를 확인해 주세요.')
    }
  }
  return { ...line, text: subtitleLineEditDisplayText(line), words, start: Math.min(line.start, ...words.map(w => w.start)),
    end: Math.max(line.end, ...words.map(w => w.end)) }
}

/** Realignment may reclaim the audible tail previously labelled as unknown audio.
 * Subtract speech from automatic gap chips across row boundaries. User cuts and
 * manually adjusted gaps remain intact, and no media duration is removed.
 */
export function reconcileRealignedGaps(lines: readonly SubtitleLine[]): SubtitleLine[] {
  const speech = lines.filter(line => !line.isDeleted).flatMap(line =>
    (line.words ?? []).filter(word => !word.isDeleted && !word.isSilence && word.word.trim()))
    .sort((a, b) => a.start - b.start)
  return lines.flatMap(line => {
    if (line.isDeleted || !line.words?.length) return [line]
    let changed = false
    const words = line.words.flatMap(word => {
      if (!word.isSilence || word.isDeleted || word.manualStartLocked || word.manualEndLocked) return [word]
      let parts = [{ start: word.start, end: word.end }]
      for (const spoken of speech) {
        if (spoken.start >= word.end) break
        if (spoken.end <= word.start) continue
        parts = parts.flatMap(part => {
          if (spoken.start >= part.end || spoken.end <= part.start) return [part]
          return [
            ...(spoken.start > part.start ? [{ start: part.start, end: spoken.start }] : []),
            ...(spoken.end < part.end ? [{ start: spoken.end, end: part.end }] : [])
          ]
        })
      }
      if (parts.length === 1 && parts[0].start === word.start && parts[0].end === word.end) return [word]
      changed = true
      return parts.filter(part => part.end - part.start > 1e-6).map((part, index) => ({ ...word, ...part,
        ...(index > 0 ? { id: undefined } : {}) }))
    })
    if (!changed) return [line]
    if (!words.length) return []
    return [{ ...line, words, start: Math.min(...words.map(word => word.start)), end: Math.max(...words.map(word => word.end)) }]
  })
}

/** Acoustic context may include deleted audio, but a timing update must not
 * expand a surviving word across an existing user cut or a locked gap. */
export function preserveRealignmentCuts(before: readonly SubtitleLine[], after: readonly SubtitleLine[],
  cuts: readonly { start: number; end: number }[]): SubtitleLine[] {
  const original = new Map(before.flatMap(line => line.words ?? []).filter(word => word.id).map(word => [word.id!, word]))
  const protectedRanges = [...cuts, ...before.flatMap(line => (line.words ?? []).filter(word =>
    word.isSilence && (word.manualStartLocked || word.manualEndLocked)))]
  return after.map(line => {
    let changed = false
    const words = line.words?.map(word => {
      if (word.isDeleted || word.isSilence) return word
      const old = original.get(word.id ?? '') ?? original.get(word.parentWordId ?? '')
      if (!old) return word
      let { start, end } = word
      for (const cut of protectedRanges) {
        if (old.end <= cut.start + 1e-6 && end > cut.start) end = Math.min(end, cut.start)
        if (old.start >= cut.end - 1e-6 && start < cut.end) start = Math.max(start, cut.end)
      }
      if (start === word.start && end === word.end) return word
      changed = true
      if (end <= start) { start = old.start; end = old.end }
      return { ...word, start, end,
        charSpans: word.charSpans?.flatMap(span => {
          const a = Math.max(span.start, start), b = Math.min(span.end, end)
          return b > a ? [{...span, start: a, end: b}] : []
        }), reviewReasons: [...new Set([...(word.reviewReasons ?? []), 'cut_boundary_preserved'])] }
    })
    if (!changed || !words?.length) return line
    return { ...line, words, start: Math.min(...words.map(word => word.start)), end: Math.max(...words.map(word => word.end)) }
  })
}
