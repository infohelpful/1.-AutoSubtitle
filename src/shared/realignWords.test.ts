import { expect, it } from 'vitest'
import { prepareRealignCue, mergeRealignedCue } from './realignWords'
const line = { start: 0, end: 3, text: '말', words: [
  { start: 0, end: 1, word: '--', isSilence: true },
  { start: 1, end: 2, word: '말', manualStartLocked: true },
  { start: 2, end: 3, word: '삭제', isDeleted: true }
] }
it('preserves silence/deleted slots and locked edges while assigning stable identity', () => {
  const request = prepareRealignCue(line, 'r1')
  const returned = { ...request, words: request.words!.map(w => ({ ...w, end: 1.8 })) }
  const next = mergeRealignedCue(line, request, returned)
  expect(next.words?.[0]).toBe(line.words[0])
  expect(next.words?.[2]).toBe(line.words[2])
  expect(next.words?.[1]).toMatchObject({ id: 'r1:word:0', start: 1, end: 1.8 })
})
it('rejects identity changes, omissions and overridden manual edges', () => {
  const request = prepareRealignCue(line, 'r1')
  for (const words of [[], [{ ...request.words![0], id: 'wrong' }], [{ ...request.words![0], start: .9 }]]) {
    expect(() => mergeRealignedCue(line, request, { ...request, words })).toThrow()
  }
})

it('splits corrected phrases only with measured child times and preserves outer locks and lineage', () => {
  const phrase = { start: 0, end: 3, text: '다시 입력', words: [
    { id: 'parent', start: .2, end: 2.8, word: '다시 입력', manualStartLocked: true, manualEndLocked: true },
    { id: 'empty', start: 2, end: 3, word: '' }
  ] }
  const request = prepareRealignCue(phrase, 'r2')
  expect(request.words?.map(w => w.word)).toEqual(['다시', '입력'])
  expect(request.words?.map(w => [w.manualStartLocked, w.manualEndLocked])).toEqual([[true, false], [false, true]])
  const returned = { ...request, words: request.words!.map((w, i) => ({ ...w,
    start: i ? 1.6 : .2, end: i ? 2.8 : 1.5, sourceStart: i ? 1.6 : .3, sourceEnd: i ? 2.7 : 1.5,
    alignmentStatus: 'manual' as const })) }
  const next = mergeRealignedCue(phrase, request, returned)
  expect(next.words?.map(w => w.word)).toEqual(['다시', '입력', ''])
  expect(next.words?.[0].id).toBe('parent')
  expect(next.words?.[1]).toMatchObject({ parentWordId: 'parent', manualEndLocked: true })
  expect(next.words?.[2]).toBe(phrase.words[1])
  expect(phrase.words).toHaveLength(2)
})

it('keeps the original phrase slot if any child cannot be aligned; never commits interpolated times', () => {
  const phrase = {start: 0, end: 3, text: '새 문장', words: [{id: 'old', start: 0, end: 3, word: '새 문장'}]}
  const request = prepareRealignCue(phrase, 'r3')
  const returned = { ...request, words: request.words!.map(w => ({ ...w, alignmentStatus: 'unaligned' as const })) }
  const next = mergeRealignedCue(phrase, request, returned)
  expect(next.words).toHaveLength(1)
  expect(next.words![0]).toMatchObject({ id: 'old', word: '새 문장', start: 0, end: 3, reviewReasons: ['retokenization_unaligned'] })
})

it('keeps an explicit whole-slot reading intact', () => {
  const cue = prepareRealignCue({start: 0, end: 1, text: '3 배', words: [{id: 'x', start: 0, end: 1, word: '3 배', readingOverride: '세배'}]}, 'r')
  expect(cue.words).toHaveLength(1)
  expect(cue.words![0].readingOverride).toBe('세배')
})

it('removes old character timing when a later attempt cannot align the word', () => {
  const cue = {start: 0, end: 1, text: '말', words: [{id: 'x', start: 0, end: 1, word: '말',
    charSpans: [{char: '말', start: 0, end: 1, score: .9}]}]}
  const request = prepareRealignCue(cue, 'r')
  const returned = {...request, words: [{id: 'x', start: 0, end: 1, word: '말', alignmentStatus: 'unaligned' as const}]}
  expect(mergeRealignedCue(cue, request, returned).words![0].charSpans).toBeUndefined()
})

it('uses full sentence context but applies only selected stable IDs', () => {
  const line = {start:0,end:3,text:'하나 둘 셋',words:[
    {id:'a',word:'하나',start:0,end:.9,alignmentStatus:'estimated' as const},
    {id:'b',word:'둘',start:1,end:1.9}, {id:'c',word:'셋',start:2,end:3}
  ]}
  const request = prepareRealignCue(line,'r')
  const returned = {...request,words:request.words!.map(w=>({...w,start:w.start+.1,end:w.end-.1,alignmentStatus:'aligned' as const}))}
  const next = mergeRealignedCue(line,request,returned,new Set(['b']))
  expect(next.words![0]).toBe(line.words[0])
  expect(next.words![2]).toBe(line.words[2])
  expect(next.words![1]).toMatchObject({id:'b',start:1.1,alignmentStatus:'aligned'})
  expect(next.words![1].end).toBeCloseTo(1.8)
  const disjoint = mergeRealignedCue(line,request,returned,new Set(['a','c']))
  expect(disjoint.words![1]).toBe(line.words[1])
  expect(disjoint.words![0].alignmentStatus).toBe('aligned')
  expect(disjoint.words![2].alignmentStatus).toBe('aligned')
  expect(() => mergeRealignedCue(line,request,returned,new Set(['missing']))).toThrow('다시 선택')
  expect(() => mergeRealignedCue(line,request,returned,new Set())).toThrow('다시 선택')
  returned.words[1].start = 2.5
  returned.words[1].end = 2.9
  expect(() => mergeRealignedCue(line,request,returned,new Set(['b']))).toThrow('충돌')
})

it('retokenizes only the selected phrase and keeps context phrases unchanged', () => {
  const line = {start:0,end:4,text:'새 문장 다른 문장',words:[
    {id:'a',word:'새 문장',start:0,end:2}, {id:'b',word:'다른 문장',start:2,end:4}
  ]}
  const request = prepareRealignCue(line,'r')
  const returned = {...request,words:request.words!.map((w,i)=>({...w,start:i,end:i+.9,
    sourceStart:i,sourceEnd:i+.9,alignmentStatus:'aligned' as const}))}
  const next = mergeRealignedCue(line,request,returned,new Set(['a']))
  expect(next.words!.map(w=>w.word)).toEqual(['새','문장','다른 문장'])
  expect(next.words![1].parentWordId).toBe('a')
  expect(next.words![2]).toBe(line.words[1])
})
