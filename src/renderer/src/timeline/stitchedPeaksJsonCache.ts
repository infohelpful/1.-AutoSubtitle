/**
 * Stitched Peaks JSON 결과를 **(srcKey × cut 시그니처)** 키로 LRU 보관하는 캐시.
 *
 * 도입 이유:
 *  - 컷이 단순히 늘어나는 일반 삭제는 `stitchWaveformJsonExpandCutsIncremental` 로 splice 만으로 처리하지만,
 *    **Undo / 컷 축소** 는 이전엔 전체 `stitchWaveformJsonByCuts`(148만 number 새 배열) 로 떨어졌다.
 *  - 편집 도중 동일한 컷 조합을 자주 거쳐가므로(특히 단일 단어 삭제 → Ctrl+Z → 다른 단어 삭제),
 *    LRU 로 **같은 reference 를 그대로 돌려주면** Undo 가 0ms 가 될 뿐 아니라,
 *    `useMemo`/effect 다운스트림(`timelineMediaEndHint`, 자식 metrics, hydrate 로그 등) cascade 가
 *    "변경 없음" 으로 판정돼 통째로 스킵된다.
 *
 * 정책:
 *  - 동일 `srcKey`(videoPath|wf.length|stitchDur) 인 항목만 보관·재사용. `srcKey` 가 바뀌면 **전체 자동 evict**.
 *  - 메모리 예산(기본 64MB) 또는 항목 수(기본 8) 중 먼저 초과되면 **LRU 부터 evict**.
 *  - `peek(srcKey)` 가 **MRU(가장 최근 사용)** 를 돌려준다 — incremental expansion 의 base 로 적합.
 */
import type { JsonWaveformData } from 'peaks.js'
import type { CutRange } from '../../../shared/ipc'

export type StitchedPeaksJsonCacheEntry = {
  srcKey: string
  /** mergeCutRanges 된 컷 목록 — incremental expansion 의 base */
  mergedCuts: CutRange[]
  out: JsonWaveformData
  /** approx bytes — eviction 예산 계산용 */
  sizeBytes: number
}

export type StitchedPeaksJsonCacheOptions = {
  maxEntries?: number
  /** 캐시가 보관할 총 출력 데이터 크기 상한(byte). 기본 64MB. */
  maxBytes?: number
}

/** 출력 data 길이로 대략 바이트 추정 (V8 SMI/Double 혼합이라 정확하진 않음; 평균 4B/숫자) */
function approxSizeBytesOfWaveformJson(json: JsonWaveformData): number {
  const raw = json as unknown as { data?: number[]; channels?: Array<{ data?: number[] }> }
  if (Array.isArray(raw.data)) return raw.data.length * 4
  const ch0 = raw.channels?.[0]?.data
  if (Array.isArray(ch0)) return ch0.length * 4
  return 0
}

export class StitchedPeaksJsonLruCache {
  private readonly maxEntries: number
  private readonly maxBytes: number
  /** 키 = `${srcKey}|${cutSig}`. Map 삽입 순서 = LRU 순서(앞쪽 = 오래된, 뒤쪽 = 최근). */
  private readonly map: Map<string, StitchedPeaksJsonCacheEntry> = new Map()
  private currentBytes = 0
  /** 활성 `srcKey` — 바뀌면 전체 evict */
  private activeSrcKey: string | null = null

  constructor(options?: StitchedPeaksJsonCacheOptions) {
    this.maxEntries = Math.max(1, options?.maxEntries ?? 8)
    /** 캐시 예산은 호출자가 지정하는 값을 신뢰한다 — 테스트/임시 적은 예산이 의도된 동작이도록 */
    this.maxBytes = Math.max(0, options?.maxBytes ?? 64 * 1024 * 1024)
  }

  /** 모든 항목 제거 */
  clear(): void {
    this.map.clear()
    this.currentBytes = 0
    this.activeSrcKey = null
  }

  /** 현재 보관 중인 항목 수 — 테스트/디버그용 */
  size(): number {
    return this.map.size
  }

  /** 현재 누적 바이트 — 테스트/디버그용 */
  bytes(): number {
    return this.currentBytes
  }

  /**
   * write 경로에서만 호출 — `srcKey` 가 바뀌면 캐시 전체 invalidate.
   * read 경로(get/peekMru)는 부작용 없이 mismatch 시 null 만 반환한다.
   */
  private invalidateIfSrcKeyChanged(srcKey: string): void {
    if (this.activeSrcKey !== null && this.activeSrcKey !== srcKey) {
      this.clear()
    }
    this.activeSrcKey = srcKey
  }

  /** exact lookup. hit 이면 MRU 로 승격하고 entry 반환. mismatch / miss 모두 부작용 없음. */
  get(srcKey: string, cutSig: string): StitchedPeaksJsonCacheEntry | null {
    if (this.activeSrcKey !== null && this.activeSrcKey !== srcKey) return null
    const k = `${srcKey}|${cutSig}`
    const v = this.map.get(k)
    if (!v) return null
    // MRU 로 이동
    this.map.delete(k)
    this.map.set(k, v)
    return v
  }

  /**
   * 같은 `srcKey` 의 가장 최근 사용 항목(MRU). incremental expand 의 base 로 사용.
   * `excludeCutSig` 가 주어지면 그 시그니처 항목은 건너뛴다(예: 자기 자신 제외).
   * 부작용 없음 — 호출해도 LRU 순서가 변하지 않는다.
   */
  peekMru(srcKey: string, excludeCutSig?: string): StitchedPeaksJsonCacheEntry | null {
    if (this.activeSrcKey !== null && this.activeSrcKey !== srcKey) return null
    if (this.map.size === 0) return null
    // Map iteration 은 삽입 순서, 마지막이 MRU
    const keys = [...this.map.keys()]
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const k = keys[i]!
      if (excludeCutSig != null && k === `${srcKey}|${excludeCutSig}`) continue
      const v = this.map.get(k)
      if (v) return v
    }
    return null
  }

  /** entry 등록 (또는 동일 키 갱신). 등록 후 LRU/바이트 예산을 맞춰 evict. */
  set(srcKey: string, cutSig: string, entry: Omit<StitchedPeaksJsonCacheEntry, 'srcKey' | 'sizeBytes'>): StitchedPeaksJsonCacheEntry {
    this.invalidateIfSrcKeyChanged(srcKey)
    const k = `${srcKey}|${cutSig}`
    const existing = this.map.get(k)
    if (existing) {
      this.currentBytes -= existing.sizeBytes
      this.map.delete(k)
    }
    const sizeBytes = approxSizeBytesOfWaveformJson(entry.out)
    const full: StitchedPeaksJsonCacheEntry = {
      srcKey,
      mergedCuts: entry.mergedCuts,
      out: entry.out,
      sizeBytes
    }
    this.map.set(k, full)
    this.currentBytes += sizeBytes
    this.evictIfNeeded()
    return full
  }

  private evictIfNeeded(): void {
    while (this.map.size > 0 && (this.map.size > this.maxEntries || this.currentBytes > this.maxBytes)) {
      const firstKey = this.map.keys().next().value as string | undefined
      if (!firstKey) break
      const v = this.map.get(firstKey)
      this.map.delete(firstKey)
      if (v) this.currentBytes -= v.sizeBytes
    }
    if (this.currentBytes < 0) this.currentBytes = 0
  }
}
