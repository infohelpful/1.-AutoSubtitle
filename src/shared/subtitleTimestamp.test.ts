import { expect, it } from 'vitest'
import { toSrtTimestamp, toWebVttTimestamp, toAssTimestamp } from './subtitleTimestamp'

it('keeps imported millisecond boundaries and carries rounded fractions across seconds and hours', () => {
  expect(toSrtTimestamp(17.34)).toBe('00:00:17,340')
  expect(toSrtTimestamp(68.98)).toBe('00:01:08,980')
  expect(toWebVttTimestamp(72.25)).toBe('00:01:12.250')
  expect(toSrtTimestamp(59.9996)).toBe('00:01:00,000')
  expect(toWebVttTimestamp(3599.9996)).toBe('01:00:00.000')
  expect(toAssTimestamp(17.34)).toBe('0:00:17.34')
  expect(toAssTimestamp(3599.996)).toBe('1:00:00.00')
  for(const sec of [-1, NaN, Infinity]) expect(toSrtTimestamp(sec)).toBe('00:00:00,000')
})
