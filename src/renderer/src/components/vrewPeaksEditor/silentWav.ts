/** Minimal PCM WAV (mono 16-bit) for Peaks when no external audio URL is provided */
export function createSilentWavBlob(durationSec: number): Blob {
  const sampleRate = 44100
  const numChannels = 1
  const bitsPerSample = 16
  const numSamples = Math.max(1, Math.floor(durationSec * sampleRate))
  const dataSize = numSamples * numChannels * (bitsPerSample / 8)
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, (sampleRate * numChannels * bitsPerSample) / 8, true)
  view.setUint16(32, (numChannels * bitsPerSample) / 8, true)
  view.setUint16(34, bitsPerSample, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  return new Blob([buffer], { type: 'audio/wav' })
}
