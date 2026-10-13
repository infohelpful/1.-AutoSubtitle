import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { buildSidecar } = createRequire(import.meta.url)('../../scripts/bundle-sidecar.cjs')

let root: string, dest: string
const exe = process.platform === 'win32' ? 'main.exe' : 'main'
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bundle-sidecar-'))
  mkdirSync(join(root, 'resources', 'bin'), { recursive: true })
  dest = join(root, 'resources', 'bin', exe)
  writeFileSync(dest, 'previous valid executable')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
function output(args: string[]) {
  const directory = args[args.indexOf('--distpath') + 1]
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, exe), 'new executable')
}

it.each([
  { status: null, error: new Error('spawn ENOENT') },
  { status: null, signal: 'SIGTERM' },
  { status: 1 }
])('preserves the installed executable when build cannot complete: %j', failure => {
  const run = vi.fn(() => failure)
  expect(() => buildSidecar({ root, run })).toThrow('PyInstaller failed')
  expect(readFileSync(dest, 'utf8')).toBe('previous valid executable')
  expect(readdirSync(join(root, 'python_sidecar', 'dist'))).toEqual([])
  expect(run).toHaveBeenCalledOnce()
})

it('never reuses a stale output when a builder reports success without producing a file', () => {
  mkdirSync(join(root, 'python_sidecar', 'dist'), { recursive: true })
  writeFileSync(join(root, 'python_sidecar', 'dist', exe), 'stale output')
  expect(() => buildSidecar({ root, run: () => ({ status: 0 }) })).toThrow('no executable')
  expect(readFileSync(dest, 'utf8')).toBe('previous valid executable')
})

it.each([
  { status: 1, stderr: 'stdin buffer unavailable' },
  { status: 0, stdout: 'library noise\n{}' },
  { status: 0, stdout: JSON.stringify({ id: 'bundle-smoke', error: { message: 'broken' } }) },
  { status: 0, stdout: [
    { id: 'bundle-smoke', result: { loaded: false } },
    { id: 'runtime-smoke', error: { message: 'metadata_errors' } }
  ].map(value => JSON.stringify(value)).join('\n') }
])('preserves the installed executable when frozen RPC smoke fails: %j', smoke => {
  const run = vi.fn((_command, args) => { output(args); return { status: 0 } }).mockImplementationOnce((_command, args) => {
    output(args); return { status: 0 }
  }).mockImplementationOnce(() => smoke as never)
  expect(() => buildSidecar({ root, run })).toThrow()
  expect(readFileSync(dest, 'utf8')).toBe('previous valid executable')
  expect(readdirSync(join(root, 'resources', 'bin'))).toEqual([exe])
})

it('uses the selected interpreter without a shell and installs only after clean RPC validation', () => {
  const run = vi.fn((_command: string, args: string[]) => { output(args); return { status: 0 } })
    .mockImplementationOnce((_command, args) => { output(args); return { status: 0 } })
    .mockImplementationOnce(() => ({ status: 0, stdout: [
      { id: 'bundle-smoke', result: { loaded: false } },
      { id: 'runtime-smoke', result: { audioDecode: true, alignmentSources: true, vadAsset: true } }
    ].map(value => JSON.stringify(value)).join('\n') }))
  expect(buildSidecar({ root, run, env: { AUTOSUBTITLE_BUILD_PYTHON: 'python with spaces.exe' } })).toBe(dest)
  expect(readFileSync(dest, 'utf8')).toBe('new executable')
  expect(run.mock.calls[0][0]).toBe('python with spaces.exe')
  expect(run.mock.calls[0][1].slice(0, 2)).toEqual(['-m', 'PyInstaller'])
  expect((run.mock.calls[0] as unknown as [string, string[], { shell: boolean }])[2].shell).toBe(false)
  expect(readdirSync(join(root, 'python_sidecar', 'dist'))).toEqual([])
})
