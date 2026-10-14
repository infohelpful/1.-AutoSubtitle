import { statfs } from 'node:fs/promises'

const MiB = 1024 ** 2
export const MEDIA_DISK_RESERVE_BYTES = 256 * MiB

/** Estimate new files only. The reserve also covers headers and small mux overhead. */
export function estimatePreparedBytes(duration: number, sourceBytes: number, audio: boolean, preview: boolean): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
    throw new Error('미디어 임시 파일 용량을 계산하지 못했습니다.')
  }
  const bytes = (audio ? Math.ceil(duration * 48000) * 4 + MiB : 0) +
    (preview ? Math.ceil(sourceBytes * 1.01) + MiB : 0)
  if (!Number.isSafeInteger(bytes)) throw new Error('미디어 임시 파일 용량이 너무 큽니다.')
  return bytes
}

/** Preflight, not a reservation: another process can consume space after this check. */
export async function requireMediaDiskSpace(directory: string, newBytes: number): Promise<void> {
  if (newBytes === 0) return
  await checkAvailableSpace(directory, newBytes)
}

/** Active writes must retain the reserve even when no additional size is known. */
export async function requireMediaDiskReserve(directory: string): Promise<void> {
  await checkAvailableSpace(directory, 0)
}

async function checkAvailableSpace(directory: string, newBytes: number): Promise<void> {
  if (!Number.isSafeInteger(newBytes) || newBytes < 0) throw new Error('잘못된 임시 파일 용량입니다.')
  let available: bigint
  try {
    const info = await statfs(directory, { bigint: true })
    available = info.bavail * info.bsize
    if (info.bavail < 0n || info.bsize <= 0n) throw new Error('Invalid filesystem capacity')
  } catch {
    throw new Error('미디어 임시 저장 공간을 확인하지 못했습니다. 저장 드라이브 연결과 접근 권한을 확인해 주세요.')
  }
  const needed = BigInt(newBytes) + BigInt(MEDIA_DISK_RESERVE_BYTES)
  if (available < needed) {
    const mb = (bytes: bigint) => String((bytes + BigInt(MiB) - 1n) / BigInt(MiB))
    throw new Error(`미디어 임시 저장 공간이 부족합니다. 필요 약 ${mb(needed)}MB(여유 공간 포함), 사용 가능 ${mb(available)}MB. 저장 공간을 확보한 뒤 다시 시도해 주세요.`)
  }
}
