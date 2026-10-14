/** Explicit repair for an uncut extraction saved before acoustic gap validation.
 * Bundle with esbuild for Node. Arguments: input.autosub peaks.json NEW-output.autosub durationSec
 * Never applied automatically during project loading; preserves the original file.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { confirmExtractedSilence } from '../src/renderer/src/utils/confirmedSilenceAfterExtract'
import { buildActiveBlocksSnapshotFromSubtitles } from '../src/shared/virtualTimeline'
import { parseAutosubProjectFile, type AutosubProjectFile } from '../src/shared/autosubProject'
import type { SubtitleLine } from '../src/shared/subtitles'

const [input, peaksPath, output, durationArg] = process.argv.slice(2)
if (!input || !peaksPath || !output || !(Number(durationArg) > 0)) throw new Error('Provide input, peaks, NEW output, exact media duration')
if (existsSync(output)) throw new Error('Output already exists; choose a new path')
const project: AutosubProjectFile = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, ''))
assert.ok(parseAutosubProjectFile(project).ok, 'Invalid input project')
assert.equal(project.cutRanges.length, 0, 'This repair is only for an uncut extraction')
assert.ok(!project.virtualTimeline?.some(b => b.isDeleted), 'Preserve edited/deleted project separately')
assert.ok(!project.subtitles.some(l => l.isDeleted || l.words?.some(w => w.isDeleted ||
  (w.isSilence && (w.manualStartLocked || w.manualEndLocked)))), 'Do not discard manual silence edits')
const waveform = JSON.parse(readFileSync(peaksPath, 'utf8'))
const speechWords = (lines: SubtitleLine[]) => lines.flatMap(l => l.words ?? []).filter(w => !w.isSilence && w.word.trim() !== '--')
const count = (lines: SubtitleLine[]) => ({ lines: lines.length, speech: speechWords(lines).length,
  silence: lines.flatMap(l => l.words ?? []).filter(w => w.isSilence || w.word.trim() === '--').length })
const subtitles = confirmExtractedSilence(project.subtitles, waveform, Number(durationArg))
assert.deepEqual(speechWords(subtitles), speechWords(project.subtitles), 'Speech text/times/metadata must remain exact')
const repaired = { ...project, savedAt: new Date().toISOString(), subtitles,
  virtualTimeline: buildActiveBlocksSnapshotFromSubtitles(subtitles, project.cutRanges) }
assert.ok(parseAutosubProjectFile(repaired).ok, 'Invalid repaired project')
writeFileSync(output, JSON.stringify(repaired, null, 2), { encoding: 'utf8', flag: 'wx' })
console.log(JSON.stringify({ input, output, before: count(project.subtitles), after: count(subtitles),
  speechUnchanged: true, sourceMediaUnchanged: true }, null, 2))
