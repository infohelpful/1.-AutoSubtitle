import type { SubtitleLine, SubtitleWord } from './subtitles'
import { parseWordAlignmentMeta } from './wordAlignmentMeta'

export type PreparedRealignCue = SubtitleLine & {
  wordGroups: Array<{ sourceIndex: number; ids: string[] }>
}

export function prepareRealignCue(line: SubtitleLine, requestId: string): PreparedRealignCue {
  const seen = new Set<string>()
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
  return { ...line, words, start: Math.min(line.start, ...words.map(w => w.start)),
    end: Math.max(line.end, ...words.map(w => w.end)) }
}
