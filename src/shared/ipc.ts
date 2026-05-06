export type OpenVideoDialogResult =
  | { canceled: true; filePaths: [] }
  | { canceled: false; filePaths: string[] }

export type ModelStatus = {
  repo_id: string
  model_dir: string
  model_present: boolean
  loaded: boolean
  device: string | null
}

export type DepsStatus = {
  ffmpegOk: boolean
  /** 현재 Python 프로세스에 Whisper가 올라와 있으면 true */
  modelLoaded: boolean
  /** CT2 모델 디렉터리에 파일(model.bin 등)이 있으면 true — 재실행 시에도 유지 */
  modelPresent: boolean
  engineReady: boolean
}

export type TranscribeErrorPayload = {
  message: string
}

export type TranscribeMode = 'cpu' | 'gpu'
export type TranscribeDiagPayload = { message: string }
export type GpuRuntimeStatus = {
  installed: boolean
  canInstall: boolean
  nvidiaPresent: boolean
  urlConfigured: boolean
  localCandidate: boolean
  /** GPU DLL 복사 대상 폴더 (`app.getPath('userData')/dll`) — 프로젝트 루트의 `dll`과 다름 */
  dllDir: string
}

export type GpuInstallProgressPayload = { pct: number; stage: string }

export type CutRange = {
  start: number
  end: number
}

export type ExportVideoRequest = {
  inputPath: string
  subtitles: Array<{ start: number; end: number; text: string }>
  cutRanges: CutRange[]
}

export type ExportSubtitleStyle = {
  fontFamily: string
  fontSize: number
  textColor: string
  fontWeight: number
  bgColor: string
  bgOpacity: number
  /** 자막 배경 박스 안쪽 여백(패딩) — 기본 100%, UI 상 약 30~150% */
  bgPaddingPct?: number
  strokeColor: string
  strokeWidth: number
  x: number
  y: number
  videoWidth?: number
  videoHeight?: number
}

/** 오프스크린 자막 창 → 메인: 폰트·레이아웃 반영 후에만 `capturePage` 하도록 동기화 */
export const IPC_EXPORT_SUBTITLE_RENDER_READY = 'export-subtitle:render-ready' as const

/** Offscreen / PNG 시퀀스 렌더용 — `update-subtitle` IPC 페이로드 (프리뷰 `ExportSubtitleStyle`와 동일 필드 + 텍스트·해상도) */
export type ExportSubtitleUpdatePayload = {
  text: string
  width: number
  height: number
} & Omit<ExportSubtitleStyle, 'videoWidth' | 'videoHeight'>

/** PNG 시퀀스 캡처 후 Python 등으로 넘길 때 사용하는 정리된 형태 */
export type SubtitlePngSequencePythonPayload = {
  outputDir: string
  /** `sub_0.png`, `sub_1.png`, … 절대 경로 (순서 유지) */
  imagePaths: string[]
  timing: Array<{ start: number; end: number; text: string }>
}

export type ExportFormat =
  | 'video'
  | 'srt'
  | 'vtt'
  | 'ass'
  | 'txt'
  | 'mp3'
  | 'wav'

export type ExportRequest = ExportVideoRequest & {
  format: ExportFormat
  subtitleStyle?: ExportSubtitleStyle
}

export type ExportVideoResult =
  | { canceled: true }
  | { canceled: false; outputPath: string }

export type ExportResult =
  | { canceled: true }
  | { canceled: false; outputPath: string; format: ExportFormat }

/** `.autosub` 프로젝트 파일 열기 */
export type ProjectOpenResult =
  | { canceled: true }
  | { canceled: false; path: string; content: string }

/** 다른 이름으로 저장 대화상자 후 저장 */
export type ProjectSaveAsResult =
  | { canceled: true }
  | { canceled: false; path: string }

export type ProjectSaveResult =
  | { ok: true }
  | { ok: false; reason: string }

/** 메인 → 렌더러 내보내기 진행률 (`export:progress`) */
export type ExportProgressPayload = {
  percent: number
  label?: string
  /** 내보내기에 쓰는 H.264 인코더(사용자 표시용) */
  encoderName?: string
}

/** `ffmpeg -encoders` 기반 — Phase 1 코덱 선택·UI 노출용 */
export type FfmpegCapabilities = {
  /** 실제로 프로브에 쓴 실행 파일 경로(또는 PATH 상 이름) */
  ffmpegPath: string
  isProResAvailable: boolean
  isQtrleAvailable: boolean
}

/** `userData/WaveformCache/{md5}.autosub-peaks.json` — 영상 경로·mtime·size 로 무효화 */
export type WaveformPeaksCachePathResult =
  | { ok: true; cachePath: string; hash: string }
  | { ok: false; reason: string }

export type SidecarApi = {
  openVideoFileDialog: () => Promise<OpenVideoDialogResult>
  /** 드롭한 `File`의 디스크 절대 경로 (렌더러의 `File.path`는 비어 있는 경우가 많음) */
  getPathForFile: (file: File) => string
  /** 로컬 영상 파일을 `<video src>` 등에 쓸 `file://` URL */
  getMediaFileUrl: (absoluteFilePath: string) => string
  sidecarCall: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  getDepsStatus: () => Promise<DepsStatus>
  /** FFmpeg 경로 및 prores_ks / qtrle 인코더 사용 가능 여부 (경고 없이 대안 파이프라인 선택용) */
  getFfmpegCapabilities: () => Promise<FfmpegCapabilities>
  prepareAllEngines: () => Promise<{ ok: true }>
  getGpuRuntimeStatus: () => Promise<GpuRuntimeStatus>
  installGpuRuntime: () => Promise<{ ok: true; source: 'local' | 'download' | 'existing'; dir: string }>
  onGpuInstallProgress: (callback: (payload: GpuInstallProgressPayload) => void) => () => void
  openExternal: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  exportVideoWithBurnedSubtitles: (req: ExportVideoRequest) => Promise<ExportVideoResult>
  exportByFormat: (req: ExportRequest) => Promise<ExportResult>
  onExportProgress: (callback: (payload: ExportProgressPayload) => void) => () => void
  /** 내보낸 파일이 있는 폴더를 탐색기에서 연다 */
  showExportResultInFolder: (absoluteFilePath: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  onModelDownloadProgress: (callback: (percent: number) => void) => () => void
  onModelReady: (callback: () => void) => () => void
  /** 절대 경로를 메인 프로세스로 넘기면 `transcribe` 파이프라인이 실행됩니다 (`ipcRenderer.send`). */
  sendVideoDropPath: (absolutePath: string) => void
  onTranscribeMode: (callback: (mode: TranscribeMode) => void) => () => void
  onTranscribeDiag: (callback: (payload: TranscribeDiagPayload) => void) => () => void
  onTranscribeProgress: (callback: (percent: number) => void) => () => void
  onTranscribeComplete: (callback: (payload: unknown) => void) => () => void
  onTranscribeError: (callback: (err: TranscribeErrorPayload) => void) => () => void
  /** 내보내기 오프스크린 창 전용 — 폰트 로드 후 메인에 알림 (`capturePage` 직전) */
  notifySubtitleRenderReady: () => void
  /** `.autosub` JSON 열기 */
  openProjectFile: () => Promise<ProjectOpenResult>
  /** 현재 경로에 덮어쓰기 (UTF-8, BOM 없음) */
  saveProjectFile: (path: string, content: string) => Promise<ProjectSaveResult>
  /** 저장 대화상자로 새 경로에 저장 */
  saveProjectFileAs: (content: string, defaultPath?: string) => Promise<ProjectSaveAsResult>
  /** Peaks/파동 디버그 로그 (`userData/logs/waveform.log`) */
  logWaveformDebug: (
    scope: string,
    message: string,
    ...details: unknown[]
  ) => Promise<{ ok: true; path: string }>
  /** 타임라인 CUT·cutRanges 등 (`userData/logs/timeline.log`) */
  logTimelineEdit: (
    scope: string,
    message: string,
    ...details: unknown[]
  ) => Promise<{ ok: true; path: string }>
  /**
   * 로컬 미디어 파일을 ArrayBuffer로 읽음 — Peaks가 http 페이지에서 file:// 를 XHR로 못 가져올 때 파형 생성용.
   */
  readLocalMediaFileBuffer: (
    absoluteFilePath: string
  ) => Promise<{ ok: true; arrayBuffer: ArrayBuffer } | { ok: false; reason: string }>
  /**
   * audiowaveform이 만든 Peaks.js 호환 JSON — 메인에서 읽어 `waveformData` 주입용(dataUri 비동기 로드 생략).
   */
  readLocalPeaksJsonFile: (
    absoluteFilePath: string
  ) => Promise<{ ok: true; json: unknown } | { ok: false; reason: string }>
  /** 영상 절대 경로 → 글로벌 파형 캐시 JSON 절대 경로(MD5 해시) */
  getWaveformPeaksCachePath: (absoluteVideoPath: string) => Promise<WaveformPeaksCachePathResult>
}
