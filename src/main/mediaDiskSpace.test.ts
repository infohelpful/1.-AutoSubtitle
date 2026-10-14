import { statfs } from 'node:fs/promises'
import { beforeEach, expect, it, vi } from 'vitest'
import { estimatePreparedBytes, MEDIA_DISK_RESERVE_BYTES, requireMediaDiskSpace } from './mediaDiskSpace'

vi.mock('node:fs/promises', () => ({ statfs: vi.fn() }))
beforeEach(() => vi.resetAllMocks())
const capacity = (bytes: bigint) => vi.mocked(statfs).mockResolvedValue({ bavail: bytes, bsize: 1n } as Awaited<ReturnType<typeof statfs>>)

it('accounts for PCM length, missing previews and existing cache independently', () => {
  const hour = estimatePreparedBytes(3600, 100_000_000, true, false)
  expect(hour).toBe(691_200_000 + 1024 ** 2)
  expect(estimatePreparedBytes(3600, 100_000_000, false, true)).toBe(101_000_000 + 1024 ** 2)
  expect(estimatePreparedBytes(3600, 100_000_000, true, true)).toBe(hour + 101_000_000 + 1024 ** 2)
  expect(estimatePreparedBytes(3600, 100_000_000, false, false)).toBe(0)
  for (const duration of [0, -1, NaN, Infinity, Number.MAX_VALUE]) {
    expect(() => estimatePreparedBytes(duration, 100, true, false)).toThrow()
  }
})

it('rejects insufficient available space including the reserve, and permits the exact threshold', async () => {
  const needed = BigInt(10_000 + MEDIA_DISK_RESERVE_BYTES)
  capacity(needed - 1n)
  await expect(requireMediaDiskSpace('cache', 10_000)).rejects.toThrow('공간이 부족')
  capacity(needed)
  await expect(requireMediaDiskSpace('cache', 10_000)).resolves.toBeUndefined()
  expect(statfs).toHaveBeenCalledWith('cache', { bigint: true })
})

it('does not require new capacity to reuse existing files', async () => {
  await requireMediaDiskSpace('cache', 0)
  expect(statfs).not.toHaveBeenCalled()
})

it('reports unreadable or invalid capacity rather than beginning an unchecked decode', async () => {
  vi.mocked(statfs).mockRejectedValue(new Error('drive disconnected'))
  await expect(requireMediaDiskSpace('cache', 100)).rejects.toThrow('확인하지 못')
  capacity(-1n)
  await expect(requireMediaDiskSpace('cache', 100)).rejects.toThrow('확인하지 못')
  await expect(requireMediaDiskSpace('cache', Infinity)).rejects.toThrow('잘못된')
})
