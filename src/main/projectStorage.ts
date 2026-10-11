import { createHash, randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { parseAutosubProjectFile } from '../shared/autosubProject'
import type { MediaFingerprint } from '../shared/projectMedia'

export async function fingerprintMedia(path: string): Promise<MediaFingerprint> {
  const file = await open(path, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new Error('영상 파일이 아닙니다.')
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('확인 중 영상 파일이 변경되었습니다. 다시 시도해 주세요.')
    }
    return { algorithm: 'sha256', size: before.size, digest: hash.digest('hex') }
  } finally { await file.close() }
}

/** Validate first, then atomically replace in the same directory; failed writes keep the previous project. */
export async function saveProjectDocument(path: string, content: string): Promise<void> {
  const parsed = parseAutosubProjectFile(JSON.parse(content))
  if (!parsed.ok) throw new Error(parsed.reason)
  const tempPath = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(tempPath, 'wx')
    try {
      await file.writeFile(JSON.stringify(parsed.data, null, 2), 'utf8')
      await file.sync()
    } finally { await file.close() }
    await rename(tempPath, path)
  } finally { await unlink(tempPath).catch(() => {}) }
}
