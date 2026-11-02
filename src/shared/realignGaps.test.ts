import { describe, expect, it } from 'vitest'
import { reconcileRealignedGaps, preserveRealignmentCuts } from './realignWords'
import type { SubtitleLine, SubtitleWord } from './subtitles'

const row = (words: SubtitleWord[]): SubtitleLine => ({ start: words[0].start, end: words.at(-1)!.end, text: '', words })
const audio = (start: number, end: number): SubtitleWord => ({ start, end, word: '오디오', isSilence: true, gapKind: 'unclassified' })
describe('reconcileRealignedGaps', () => {
  it('prevents expanded speech boundaries from entering user cuts', () => {
    const before=[row([{id:'a',start:53.459,end:53.58,word:'없습니다.'},
      {id:'b',start:54.9,end:55.2,word:'다음'}])]
    const after=[row([{...before[0].words![0],end:54.1,sourceEnd:54.18},
      {...before[0].words![1],start:54.7}])]
    const result=preserveRealignmentCuts(before,after,[{start:54.0225,end:54.78375}])
    expect(result[0].words!.map(w=>[w.start,w.end])).toEqual([[53.459,54.0225],[54.78375,55.2]])
    expect(result[0].words![0].sourceEnd).toBe(54.18)
    expect(after[0].words![0].end).toBe(54.1)
  })
  it('respects a manually bounded gap and leaves existing cut overlaps unchanged', () => {
    const before=[row([{id:'a',start:1,end:2,word:'말'}, {...audio(2,3),manualStartLocked:true},
      {id:'b',start:4,end:6,word:'발화'}])]
    const after=[row([{...before[0].words![0],end:2.4},...before[0].words!.slice(1)])]
    const result=preserveRealignmentCuts(before,after,[{start:5,end:5.5}])
    expect(result[0].words![0].end).toBe(2)
    expect(result[0].words![2]).toEqual(before[0].words![2])
  })
  it('reclaims an audible ending from the old audio chip and the next silence row', () => {
    const speech = { start: 53.479, end: 54.05, word: '없습니다.', id: 'word' }
    const lines = [row([speech, audio(53.58, 54.0225)]), row([{...audio(54.0225,54.78375), word:'--', gapKind:undefined}])]
    const output = reconcileRealignedGaps(lines)
    expect(output[0].words).toEqual([speech])
    expect(output[1].words![0].start).toBe(54.05)
    expect(output[1].end).toBe(54.78375)
    expect(lines[0].words).toHaveLength(2)
    expect(reconcileRealignedGaps(output)).toEqual(output)
  })
  it('removes a fully reclaimed gap row without losing its following row', () => {
    const first=row([{start:1,end:3,word:'끝'}]), last=row([{start:4,end:5,word:'다음'}])
    expect(reconcileRealignedGaps([first,row([audio(2,3)]),last])).toEqual([first,last])
  })
  it('preserves cuts, manual gap boundaries, and untouched intervals', () => {
    const gaps = [audio(0,.5), {...audio(1,2),isDeleted:true}, {...audio(2,3),manualEndLocked:true}]
    const lines = [row([{start:1,end:3,word:'말'},...gaps])]
    expect(reconcileRealignedGaps(lines)).toEqual(lines)
  })
  it('splits an automatic gap around speech without duplicating its identity', () => {
    const output=reconcileRealignedGaps([row([{...audio(0,4),id:'gap'}]),row([{start:1,end:2,word:'말'}])])
    expect(output[0].words!.map(w=>[w.start,w.end,w.id])).toEqual([[0,1,'gap'],[2,4,undefined]])
  })
})
