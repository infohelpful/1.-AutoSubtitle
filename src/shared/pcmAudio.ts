/** Prepared audio is interleaved signed 16-bit, stereo, 48 kHz PCM. */
export type PcmRange = { startFrame: number; frameCount: number }
export type PcmAudioBlock = {
  sampleRate: number
  channels: number
  totalFrames: number
  pcm: ArrayBuffer
}
export const PCM_BLOCK_SECONDS = 6
export const PCM_MAX_RANGES = 256
export type PcmReader = (url: string, ranges: PcmRange[]) => Promise<PcmAudioBlock>
export type PcmReadResult = {ok: true; block: PcmAudioBlock} | {ok: false; reason: string}
