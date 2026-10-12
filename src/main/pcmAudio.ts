import { open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PCM_BLOCK_SECONDS, PCM_MAX_RANGES, type PcmAudioBlock, type PcmRange } from '../shared/pcmAudio'

async function readExact(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const data = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const {bytesRead} = await file.read(data,offset,length-offset,position+offset)
    if (!bytesRead) throw new Error('준비된 오디오가 잘렸습니다. 영상을 다시 열어 주세요.')
    offset += bytesRead
  }
  return data
}

/** Parse RIFF and RF64 without reading the data body (RF64 may exceed 4 GiB). */
async function describePcm(file: FileHandle) {
  const size = (await file.stat()).size
  const header = await readExact(file,12,0)
  const rf64 = header.toString('ascii',0,4)==='RF64'
  if ((!rf64 && header.toString('ascii',0,4)!=='RIFF') || header.toString('ascii',8,12)!=='WAVE') throw new Error('WAV 형식이 아닙니다.')
  let position = 12, data64: number | undefined, validFormat = false
  for (let chunks=0;chunks<128 && position+8<=size;chunks++) {
    const chunk = await readExact(file,8,position)
    const name = chunk.toString('ascii',0,4), length = chunk.readUInt32LE(4)
    position += 8
    if (name==='data') {
      const dataBytes = rf64 && length===0xffffffff ? data64 : length
      if (!validFormat || dataBytes==null || !Number.isSafeInteger(dataBytes) || dataBytes<=0 || dataBytes%4 || position+dataBytes>size) throw new Error('유효하지 않은 PCM 데이터입니다.')
      return {offset:position,totalFrames:dataBytes/4}
    }
    if (position+length>size) throw new Error('WAV 헤더가 잘렸습니다.')
    if (name==='ds64' && rf64) {
      if (length<28) throw new Error('유효하지 않은 RF64 헤더입니다.')
      const value = (await readExact(file,28,position)).readBigUInt64LE(8)
      if (value>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('오디오 파일이 너무 큽니다.')
      data64=Number(value)
    }
    if (name==='fmt ') {
      if (length<16) throw new Error('유효하지 않은 PCM 헤더입니다.')
      const fmt=await readExact(file,Math.min(length,40),position)
      const tag=fmt.readUInt16LE(0)
      const extensible=tag===0xfffe && length>=40 && fmt.readUInt16LE(16)>=22 && fmt.readUInt16LE(18)===16 &&
        fmt.subarray(24,40).toString('hex')==='0100000000001000800000aa00389b71'
      validFormat=(tag===1 || extensible) && fmt.readUInt16LE(2)===2 && fmt.readUInt32LE(4)===48000 &&
        fmt.readUInt32LE(8)===192000 && fmt.readUInt16LE(12)===4 && fmt.readUInt16LE(14)===16
    }
    position += length + (length%2)
  }
  throw new Error('PCM 데이터 헤더를 찾지 못했습니다.')
}

/** Bounded IPC read: only our canonical cache, at most six seconds per call. */
export async function readPreparedPcm(cacheDir: string, url: string, ranges: PcmRange[]): Promise<PcmAudioBlock> {
  if (typeof url!=='string' || !Array.isArray(ranges) || ranges.length>PCM_MAX_RANGES) throw new Error('잘못된 오디오 요청입니다.')
  const input=fileURLToPath(url), root=await realpath(cacheDir), path=await realpath(input)
  if (resolve(dirname(path))!==resolve(root) || !/^[a-f0-9]{64}\.wav$/.test(basename(path))) throw new Error('준비된 오디오 캐시만 읽을 수 있습니다.')
  let count=0
  for (const range of ranges) {
    if (!range || !Number.isSafeInteger(range.startFrame) || range.startFrame<0 || !Number.isSafeInteger(range.frameCount) || range.frameCount<=0) throw new Error('잘못된 오디오 구간입니다.')
    count += range.frameCount
    if (count>48000*PCM_BLOCK_SECONDS) throw new Error('오디오 요청 구간이 너무 큽니다.')
  }
  const file=await open(path,'r')
  try {
    const info=await describePcm(file)
    if (ranges.some(range=>range.startFrame+range.frameCount>info.totalFrames)) throw new Error('오디오 범위를 벗어났습니다.')
    const pcm=new ArrayBuffer(count*4), output=new Uint8Array(pcm)
    let offset=0
    for (const range of ranges) {
      const data=await readExact(file,range.frameCount*4,info.offset+range.startFrame*4)
      output.set(data,offset)
      offset+=data.byteLength
    }
    return {sampleRate:48000,channels:2,totalFrames:info.totalFrames,pcm}
  } finally { await file.close() }
}
