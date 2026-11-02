/** Quantize the complete timestamp before splitting fields, avoiding floating
 * fractional seconds such as 17.34 becoming 17,339 and handling unit carries. */
function timestamp(sec: number, units: number, separator: string, hourDigits: number): string {
  const ticks = Math.round(Math.max(0, Number.isFinite(sec) ? sec : 0) * units)
  const whole = Math.floor(ticks / units)
  return `${String(Math.floor(whole / 3600)).padStart(hourDigits, '0')}:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}${separator}${String(ticks % units).padStart(units === 1000 ? 3 : 2, '0')}`
}

export const toSrtTimestamp = (sec: number): string => timestamp(sec, 1000, ',', 2)
export const toWebVttTimestamp = (sec: number): string => timestamp(sec, 1000, '.', 2)
export const toAssTimestamp = (sec: number): string => timestamp(sec, 100, '.', 1)
