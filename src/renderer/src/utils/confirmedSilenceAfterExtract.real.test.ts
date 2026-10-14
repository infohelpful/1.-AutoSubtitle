import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { confirmExtractedSilence } from './confirmedSilenceAfterExtract'
import type { SubtitleLine } from '../../../shared/subtitles'

// Optional private reproduction data; never commit the user's project/media.
const projectPath = resolve('tools/sync-validation-output/user-false-silence-original.autosub')
const peaksPath = resolve('tools/sync-validation-output/user-false-silence-peaks.json')
it.skipIf(!existsSync(projectPath) || !existsSync(peaksPath))('preserves the saved speech and removes the two voiced gaps reported in screenshots', () => {
  const input = JSON.parse(readFileSync(projectPath, 'utf8')).subtitles as SubtitleLine[]
  const peaks = JSON.parse(readFileSync(peaksPath, 'utf8'))
  const output = confirmExtractedSilence(input, peaks, 958.2666666666667)
  const words = (lines: SubtitleLine[]) => lines.flatMap(l => l.words ?? [])
  const speech = (lines: SubtitleLine[]) => words(lines).filter(w => !w.isSilence && w.word.trim() !== '--')
  expect(speech(output)).toEqual(speech(input))
  expect(speech(output)).toHaveLength(1137)
  const gaps = words(output).filter(w => w.isSilence)
  for (const [s,e] of [[15.6,15.74],[41.36,41.62]]) {
    expect(words(input).some(w => w.isSilence && w.start === s && w.end === e)).toBe(true)
    expect(gaps.some(w => w.start < e && w.end > s)).toBe(false)
  }
  for (const gap of gaps) {
    expect(gap.end - gap.start).toBeGreaterThanOrEqual(.2 - 1e-9)
    const first = Math.floor(gap.start * 800), last = Math.ceil(gap.end * 800)
    expect(peaks.data.slice(first * 2, last * 2).every((v: number) => Math.abs(v) <= 1.28)).toBe(true)
  }
})
