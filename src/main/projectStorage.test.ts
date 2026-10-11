import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintMedia, saveProjectDocument } from './projectStorage'
import { sameMedia } from '../shared/projectMedia'

const directories: string[] = []
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'autosub-project-')); directories.push(dir); return dir }
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const project = { format: 'autosubtitle-project', version: 2, savedAt: 'now', videoPath: null,
  mediaFingerprint: null, subtitles: [], cutRanges: [], subtitleStyle: { fontFamily: 'Arial', fontSize: 30,
    fontWeight: 700, bgOpacity: 50, bgPaddingPct: 10, strokeWidth: 1, x: 50, y: 10 } }

describe('project disk IO', () => {
  it('hashes the entire file, detecting a same-size tail edit and allowing relocated copies', async () => {
    const dir = await directory()
    const file = join(dir, 'media.bin'), copy = join(dir, 'copy.bin')
    const data = Buffer.alloc(3 * 1024 * 1024, 1)
    await writeFile(file, data)
    const original = await fingerprintMedia(file)
    await copyFile(file, copy)
    expect(sameMedia(original, await fingerprintMedia(copy))).toBe(true)
    data[data.length - 1] = 2
    await writeFile(file, data)
    expect(sameMedia(original, await fingerprintMedia(file))).toBe(false)
    await expect(fingerprintMedia(join(dir, 'missing'))).rejects.toThrow()
  })
  it('replaces valid project atomically and leaves previous bytes intact on invalid input', async () => {
    const dir = await directory(), path = join(dir, 'project.autosub')
    await writeFile(path, 'original')
    await expect(saveProjectDocument(path, '{bad')).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('original')
    await expect(saveProjectDocument(path, JSON.stringify({ ...project, version: 999 }))).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('original')
    await saveProjectDocument(path, JSON.stringify(project))
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(2)
    expect(await readdir(dir)).toEqual(['project.autosub'])
  })
  it('cleans the temp file on rename failure without damaging the destination', async () => {
    const dir = await directory(), path = join(dir, 'destination')
    await mkdir(path)
    await writeFile(join(path, 'keep'), 'untouched')
    await expect(saveProjectDocument(path, JSON.stringify(project))).rejects.toThrow()
    expect(await readFile(join(path, 'keep'), 'utf8')).toBe('untouched')
    expect(await readdir(dir)).toEqual(['destination'])
  })
})
