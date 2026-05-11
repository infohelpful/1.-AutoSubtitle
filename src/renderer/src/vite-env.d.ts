/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `1` 이면 재생 스케줄을 단어 블록(is_deleted 반영) 미디어 구간만 사용 */
  readonly VITE_WORD_PLAYBACK?: string
}
