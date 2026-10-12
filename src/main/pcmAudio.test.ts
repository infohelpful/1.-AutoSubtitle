import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readPreparedPcm } from './pcmAudio'

let dir: string, path: string
beforeEach(async () => {dir=await mkdtemp(join(tmpdir(),'pcm-window-'));path=join(dir,'a'.repeat(64)+'.wav')})
afterEach(async () => {await rm(dir,{recursive:true,force:true})})
function wav(rf64=false) {
  const fmt=Buffer.alloc(24)
  fmt.write('fmt ');fmt.writeUInt32LE(16,4);fmt.writeUInt16LE(1,8);fmt.writeUInt16LE(2,10)
  fmt.writeUInt32LE(48000,12);fmt.writeUInt32LE(192000,16);fmt.writeUInt16LE(4,20);fmt.writeUInt16LE(16,22)
  const body=Buffer.alloc(400)
  for(let frame=0;frame<100;frame++){body.writeInt16LE(frame,frame*4);body.writeInt16LE(-frame,frame*4+2)}
  const data=Buffer.alloc(8);data.write('data');data.writeUInt32LE(rf64?0xffffffff:body.length,4)
  const extra=Buffer.alloc(rf64?36:0)
  if(rf64){extra.write('ds64');extra.writeUInt32LE(28,4);extra.writeBigUInt64LE(BigInt(body.length),16)}
  const header=Buffer.alloc(12);header.write(rf64?'RF64':'RIFF');header.write('WAVE',8)
  header.writeUInt32LE(rf64?0xffffffff:36+body.length,4)
  return Buffer.concat([header,extra,fmt,data,body])
}
it.each([false,true])('reads exact disjoint sample ranges in RIFF/RF64: %s',async rf64 => {
  await writeFile(path,wav(rf64))
  const url=pathToFileURL(path).href
  const meta=await readPreparedPcm(dir,url,[])
  expect(meta).toMatchObject({sampleRate:48000,channels:2,totalFrames:100})
  expect(meta.pcm.byteLength).toBe(0)
  const result=await readPreparedPcm(dir,url,[{startFrame:13,frameCount:3},{startFrame:98,frameCount:2},{startFrame:0,frameCount:1}])
  expect([...new Int16Array(result.pcm)]).toEqual([13,-13,14,-14,15,-15,98,-98,99,-99,0,0])
})
it('rejects non-cache files, oversized requests and invalid ranges',async () => {
  await writeFile(path,wav())
  const url=pathToFileURL(path).href
  for(const ranges of [[{startFrame:-1,frameCount:1}],[{startFrame:0,frameCount:288001}],[{startFrame:99,frameCount:2}],Array(257).fill({startFrame:0,frameCount:1})]) {
    await expect(readPreparedPcm(dir,url,ranges)).rejects.toThrow()
  }
  const original=join(dir,'source.wav');await writeFile(original,wav())
  await expect(readPreparedPcm(dir,pathToFileURL(original).href,[])).rejects.toThrow('캐시')
  await expect(readPreparedPcm(join(dir,'other'),url,[])).rejects.toThrow()
})
it('rejects truncated data, non-PCM and invalid RF64 sizes',async () => {
  const wrongFormat=wav();wrongFormat.writeUInt16LE(3,20)
  const bad64=wav(true);bad64.writeBigUInt64LE(2n**63n,28)
  for(const content of [wav().subarray(0,60),wrongFormat,bad64]) {
    await writeFile(path,content)
    await expect(readPreparedPcm(dir,pathToFileURL(path).href,[])).rejects.toThrow()
  }
})
