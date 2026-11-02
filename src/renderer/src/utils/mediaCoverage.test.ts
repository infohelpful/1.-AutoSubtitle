import { expect, it } from 'vitest'
import { completeMediaCoverage } from './mediaCoverage'
import { confirmExtractedSilence } from './confirmedSilenceAfterExtract'
import { subtitleLinesToSentenceTokenTimeline, sentenceTokenTimelineToSubtitleLines } from '../../../shared/sentenceTokenTimelineAdapter'
import { buildExportCueLines } from '../../../shared/exportCuePipeline'
import { buildTimelineClips } from '../timeline/mapping'
import { removeSilenceWordsFromSubtitleLines } from '../../../shared/phase5EditPolicy'
import type { SubtitleLine } from '../../../shared/subtitles'
import { srtCuesToSubtitleLines } from '../../../shared/scriptImport'
import { pickActiveSubtitleIndex } from '../../../shared/subtitlePresentation'

const speech: SubtitleLine[] = [{start:1,end:2,text:'말',words:[{id:'a',start:1,end:2,word:'말'}]},
  {start:4,end:5,text:'끝',words:[{id:'b',start:4,end:5,word:'끝'}]}]
const quiet = {sample_rate:1000,samples_per_pixel:10,bits:8,channels:1,data:Array(1200).fill(0)}

it('preserves SRT intro, short cue gaps and outro through save/reopen without changing cue times', () => {
  const cues = [{start:15,end:17.34,text:'구형 피씨에 윈도우 11을 설치할 때'},
    {start:17.4,end:19,text:'다음 자막'},
    {start:67.16,end:68.98,text:'순서대로 정리해 드리겠습니다'},
    {start:72.25,end:74.29,text:'벤토이 프로그램 다운로드 사이트 정보는'}]
  const result=completeMediaCoverage(srtCuesToSubtitleLines(cues),80,null)
  expect(result[0]).toMatchObject({start:0,end:15,text:'',words:[{word:'오디오',gapKind:'unclassified'}]})
  expect(result.some(l=>l.start===68.98&&l.end===72.25&&l.text==='')).toBe(false)
  expect(result.find(l=>l.start===67.16)?.words?.at(-1)).toMatchObject({start:68.98,end:72.25,word:'오디오'})
  expect(result.find(l=>l.start===15)?.words?.at(-1)).toMatchObject({start:17.34,end:17.4,word:'오디오'})
  expect(result.at(-1)).toMatchObject({start:72.25,end:80})
  const reopened=sentenceTokenTimelineToSubtitleLines(JSON.parse(JSON.stringify(subtitleLinesToSentenceTokenTimeline(result))))
  expect(buildExportCueLines(reopened)).toEqual(cues)
  for(const t of [0,14.99,17.35,68.98,70,72.249,79.99]) {
    const active = pickActiveSubtitleIndex(reopened,t)
    expect(active === null ? '' : reopened[active].text).toBe('')
  }
  expect(completeMediaCoverage(reopened,80,null)).toEqual(reopened)
  expect(buildTimelineClips([],80).at(-1)?.editEnd).toBe(80)
  const deleted=reopened.map((line,i)=>i===0?{...line,isDeleted:true,words:line.words!.map(w=>({...w,isDeleted:true}))}:line)
  expect(completeMediaCoverage(deleted,80,null)[0].isDeleted).toBe(true)
})

it('represents the start, middle and trailing media without changing speech, audio duration or export text', () => {
  const result = completeMediaCoverage(speech,6,quiet)
  expect(result.map(line=>[line.start,line.end])).toEqual([[0,1],[1,2],[2,4],[4,5],[5,6]])
  expect(result.filter(line=>line.text)).toEqual(speech)
  expect(buildExportCueLines(result).map(cue=>cue.text)).toEqual(['말','끝'])
  expect(completeMediaCoverage(result,6,quiet)).toEqual(result)
  expect(buildTimelineClips([],6).map(c=>[c.mediaStart,c.mediaEnd])).toEqual([[0,6]])
})

it('keeps unconfirmed audio editable without mislabelling it as confirmed silence, including after storage conversion', () => {
  const result=completeMediaCoverage(speech,6,null)
  expect(result[0].words![0]).toMatchObject({word:'오디오',gapKind:'unclassified'})
  const timeline=JSON.parse(JSON.stringify(subtitleLinesToSentenceTokenTimeline(result)))
  expect(sentenceTokenTimelineToSubtitleLines(timeline)[0].words![0]).toMatchObject({word:'오디오',gapKind:'unclassified'})
  const missingPeaks=completeMediaCoverage([],6,{...quiet,data:[]})
  expect(missingPeaks).toHaveLength(1)
  expect(missingPeaks[0].end).toBe(6)
  expect(missingPeaks[0].words![0].gapKind).toBe('unclassified')
  expect(removeSilenceWordsFromSubtitleLines(missingPeaks)).toEqual(missingPeaks)
})

it('does not fill deleted words or explicit cuts, and avoids tiny inter-word chip clutter', () => {
  const deleted={start:2,end:4,text:'',isDeleted:true,words:[{start:2,end:4,word:'삭제',isDeleted:true}]}
  const result=completeMediaCoverage([...speech,deleted],6,quiet,[{start:5,end:6}])
  expect(result.flatMap(l=>l.words??[]).filter(w=>w.isSilence).map(w=>[w.start,w.end])).toEqual([[0,1]])
  expect(completeMediaCoverage([{start:0,end:1,text:'가',words:[{start:0,end:1,word:'가'}]},
    {start:1.1,end:2,text:'나',words:[{start:1.1,end:2,word:'나'}]}],2,quiet)).toHaveLength(2)
})

it('retains a fully quiet video and covers exact endpoints when extracting silence', () => {
  expect(completeMediaCoverage(confirmExtractedSilence([],quiet,6),6,quiet)).toEqual([
    {start:0,end:6,text:'',words:[{start:0,end:6,word:'--',isSilence:true}]}
  ])
  const tail=[{start:0,end:5.999,text:'',words:[{start:0,end:5.999,word:'--',isSilence:true}]}]
  const extended=completeMediaCoverage(tail,6,quiet)
  expect(extended).toHaveLength(1)
  expect(extended[0].words![0].end).toBe(6)
})
