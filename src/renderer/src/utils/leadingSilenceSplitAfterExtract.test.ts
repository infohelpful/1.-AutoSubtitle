import { describe, expect, it } from 'vitest'
import type { JsonWaveformData } from '../../shared/waveformJson'
import type { SubtitleLine } from '../../shared/subtitles'
import { splitLeadingSilenceInSubtitleLines } from './leadingSilenceSplitAfterExtract'

/** 6픽셀: 앞 5칸 무음, 마지막 칸만 큰 진폭 — implied duration = 6*1000/48000 */
function makeNearSilentPeaksJson(): JsonWaveformData {
  return {
    sample_rate: 48000,
    samples_per_pixel: 1000,
    data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80, 80]
  }
}

describe('splitLeadingSilenceInSubtitleLines', () => {
  it('splits leading silence before speech in first word', () => {
    const dur = (6 * 1000) / 48000
    const lines: SubtitleLine[] = [
      {
        start: 0,
        end: dur,
        text: 'Hello',
        words: [{ start: 0, end: dur, word: 'Hello' }]
      }
    ]
    const wf = makeNearSilentPeaksJson()
    const out = splitLeadingSilenceInSubtitleLines(lines, wf, dur, { dbfsGate: -40, minLeadingSilenceSec: 0.05 })
    expect(out).toHaveLength(1)
    const w = out[0]!.words!
    expect(w).toHaveLength(2)
    expect(w[0]!.isSilence).toBe(true)
    expect(w[0]!.word).toBe('--')
    expect(w[1]!.word).toBe('Hello')
    expect(w[0]!.end).toBeCloseTo(w[1]!.start, 5)
    expect(w[1]!.start).toBeCloseTo((5 / 6) * dur, 5)
  })

  it('leaves word unchanged when speech starts immediately', () => {
    const wf: JsonWaveformData = {
      sample_rate: 48000,
      samples_per_pixel: 1000,
      data: [80, 80, 80, 80, 80, 80]
    }
    const dur = 3000 / 48000
    const lines: SubtitleLine[] = [
      {
        start: 0,
        end: dur,
        text: 'Hi',
        words: [{ start: 0, end: dur, word: 'Hi' }]
      }
    ]
    const out = splitLeadingSilenceInSubtitleLines(lines, wf, dur)
    expect(out[0]!.words).toHaveLength(1)
    expect(out[0]!.words![0]!.word).toBe('Hi')
  })

  /** 20픽셀: 앞 5·뒤 5는 큰 진폭, 가운데 10픽셀 무음 → 중간 무음이 기본 임계(0.2s) 이상 */
  it('splits internal silence inside one word into -- and continuation', () => {
    const pixelCount = 20
    const loud = [80, 80] as const
    const silent = [0, 0] as const
    const data: number[] = []
    for (let i = 0; i < 5; i += 1) data.push(...loud)
    for (let i = 0; i < 10; i += 1) data.push(...silent)
    for (let i = 0; i < 5; i += 1) data.push(...loud)
    const wf: JsonWaveformData = {
      sample_rate: 48000,
      samples_per_pixel: 1000,
      data
    }
    const dur = (pixelCount * 1000) / 48000
    const lines: SubtitleLine[] = [
      {
        start: 0,
        end: dur,
        text: 'Hello',
        words: [{ start: 0, end: dur, word: 'Hello' }]
      }
    ]
    const out = splitLeadingSilenceInSubtitleLines(lines, wf, dur)
    expect(out[0]!.words).toHaveLength(3)
    expect(out[0]!.words![0]!.word).toBe('Hello')
    expect(out[0]!.words![1]!.isSilence).toBe(true)
    expect(out[0]!.words![1]!.word).toBe('--')
    expect(out[0]!.words![2]!.word).toBe('\u2026')
    expect(out[0]!.words![0]!.end).toBeCloseTo(out[0]!.words![1]!.start, 5)
    expect(out[0]!.words![1]!.end).toBeCloseTo(out[0]!.words![2]!.start, 5)
  })

  /** 앞쪽은 게이트만 넘는 약한 피크(-40~-32), 중간 무음, 뒤는 큰 소리 → 원문은 뒤 말 조각에만 */
  it('puts original word on first clearly audible speech chunk, not weak leading speech', () => {
    const pixelCount = 20
    const weak = [2, 2] as const
    const silent = [0, 0] as const
    const loud = [80, 80] as const
    const data: number[] = []
    for (let i = 0; i < 3; i += 1) data.push(...weak)
    for (let i = 0; i < 12; i += 1) data.push(...silent)
    for (let i = 0; i < 5; i += 1) data.push(...loud)
    const wf: JsonWaveformData = {
      sample_rate: 48000,
      samples_per_pixel: 1000,
      data
    }
    const dur = (pixelCount * 1000) / 48000
    const lines: SubtitleLine[] = [
      {
        start: 0,
        end: dur,
        text: 'Hello',
        words: [{ start: 0, end: dur, word: 'Hello' }]
      }
    ]
    const out = splitLeadingSilenceInSubtitleLines(lines, wf, dur)
    expect(out[0]!.words).toHaveLength(3)
    expect(out[0]!.words![0]!.word).toBe('\u2026')
    expect(out[0]!.words![0]!.isSilence).not.toBe(true)
    expect(out[0]!.words![1]!.isSilence).toBe(true)
    expect(out[0]!.words![1]!.word).toBe('--')
    expect(out[0]!.words![2]!.word).toBe('Hello')
  })

  /** 이미 `…` 한 덩어리만 있는 줄도(2패스 시나리오) 선행 무음을 `--`로 뺀다 */
  it('splits leading silence inside a lone continuation ellipsis word', () => {
    const pixelCount = 40
    const data: number[] = []
    for (let i = 0; i < 25; i += 1) data.push(0, 0)
    for (let i = 0; i < 15; i += 1) data.push(80, 80)
    const wf: JsonWaveformData = {
      sample_rate: 48000,
      samples_per_pixel: 1000,
      data
    }
    const dur = (pixelCount * 1000) / 48000
    const lines: SubtitleLine[] = [
      { start: 0, end: dur, text: '\u2026', words: [{ start: 0, end: dur, word: '\u2026' }] }
    ]
    const out = splitLeadingSilenceInSubtitleLines(lines, wf, dur)
    const words = out[0]!.words!
    expect(words.length).toBeGreaterThanOrEqual(2)
    expect(words.some((w) => w.isSilence === true && w.word === '--')).toBe(true)
  })

  /** `…`만 -40 넘는 약한 피크 + 긴 무음 + 진짜 말 → 엄격 게이트로 앞은 `--`로 빠짐 */
  it('stricter pixel gate for continuation turns weak lead-in into silence before speech', () => {
    const pixelCount = 32
    const data: number[] = []
    for (let i = 0; i < 10; i += 1) data.push(3, 3)
    for (let i = 0; i < 12; i += 1) data.push(0, 0)
    for (let i = 0; i < 10; i += 1) data.push(80, 80)
    const wf: JsonWaveformData = {
      sample_rate: 48000,
      samples_per_pixel: 1000,
      data
    }
    const dur = (pixelCount * 1000) / 48000
    const lines: SubtitleLine[] = [
      { start: 0, end: dur, text: '\u2026', words: [{ start: 0, end: dur, word: '\u2026' }] }
    ]
    const out = splitLeadingSilenceInSubtitleLines(lines, wf, dur)
    const words = out[0]!.words!
    expect(words.filter((w) => w.isSilence === true).length).toBeGreaterThanOrEqual(1)
    const lastNonSil = words.filter((w) => w.isSilence !== true).pop()
    expect(lastNonSil).toBeDefined()
    expect(lastNonSil!.end).toBeCloseTo(dur, 4)
  })

  /** 한 말 런 안: -22 미만으로 길게 이어지다가 큰 소리 → 선행은 `--`로 잘림 */
  it('trims leading low-energy tail within one speech run using voice onset', () => {
    const pixelCount = 20
    const data: number[] = []
    for (let i = 0; i < 12; i += 1) data.push(3, 3)
    for (let i = 0; i < 8; i += 1) data.push(80, 80)
    const wf: JsonWaveformData = {
      sample_rate: 48000,
      samples_per_pixel: 1000,
      data
    }
    const dur = (pixelCount * 1000) / 48000
    const lines: SubtitleLine[] = [
      { start: 0, end: dur, text: 'Go', words: [{ start: 0, end: dur, word: 'Go' }] }
    ]
    const out = splitLeadingSilenceInSubtitleLines(lines, wf, dur)
    const words = out[0]!.words!
    expect(words.some((w) => w.isSilence === true)).toBe(true)
    const sp = words.find((w) => w.isSilence !== true)
    expect(sp!.start).toBeGreaterThan(0.05)
  })

  /** gap-fill `--` 직후 단어: 선행 무음을 `--` 로 분리한 뒤 줄 끝에서 연속 `--` 는 하나로 병합(구간 합집합) */
  it('splits leading silence inside word after an explicit silence block', () => {
    const pixelCount = 30
    const silent = [0, 0] as const
    const loud = [80, 80] as const
    const data: number[] = []
    for (let i = 0; i < 5; i += 1) data.push(...silent)
    for (let i = 0; i < 8; i += 1) data.push(...silent)
    for (let i = 0; i < 17; i += 1) data.push(...loud)
    const wf: JsonWaveformData = {
      sample_rate: 48000,
      samples_per_pixel: 1000,
      data
    }
    const dur = (pixelCount * 1000) / 48000
    const t5 = (5 / pixelCount) * dur
    const lines: SubtitleLine[] = [
      {
        start: 0,
        end: dur,
        text: '-- Hi',
        words: [
          { start: 0, end: t5, word: '--', isSilence: true },
          { start: t5, end: dur, word: 'Hi' }
        ]
      }
    ]
    const out = splitLeadingSilenceInSubtitleLines(lines, wf, dur)
    const words = out[0]!.words!
    const silBlocks = words.filter((w) => w.isSilence === true)
    expect(silBlocks.length).toBeGreaterThanOrEqual(1)
    expect(silBlocks[0]!.end).toBeGreaterThan(t5 + 1e-4)
    const hi = words.find((w) => w.isSilence !== true && w.word === 'Hi')
    expect(hi).toBeDefined()
    expect(hi!.start).toBeGreaterThan(t5 + 1e-4)
  })
})
