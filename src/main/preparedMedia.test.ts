import { mkdtemp, writeFile, utimes, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prunePreparedMediaCache } from './preparedMedia'

it('prunes only stale owned files and leaves recent caches and unrelated media intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-clock-cache-'))
  try {
    const old = 'a'.repeat(64)+'.wav', recent = 'b'.repeat(64)+'.mp4', source = 'source.mp4'
    const partial = 'c'.repeat(64)+'.12345678-1234-1234-1234-123456789abc.wav'
    for (const name of [old,recent,source,partial]) await writeFile(join(dir,name),'fixture')
    for (const name of [old,source,partial]) await utimes(join(dir,name),new Date(0),new Date(0))
    await prunePreparedMediaCache(dir,60_000)
    expect((await readdir(dir)).sort()).toEqual([recent,source].sort())
  } finally { await rm(dir,{recursive:true,force:true}) }
})
