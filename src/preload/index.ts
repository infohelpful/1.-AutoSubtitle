import { pathToFileURL } from 'node:url'
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  IPC_EXPORT_SUBTITLE_RENDER_READY,
  type ExportRequest,
  type ExportResult,
  type ExportVideoRequest,
  type ExportVideoResult,
  type ExportSubtitleUpdatePayload,
  type ExportProgressPayload,
  type FfmpegCapabilities,
  type GpuInstallProgressPayload,
  type GpuRuntimeStatus,
  type OpenVideoDialogResult,
  type ProjectOpenResult,
  type ProjectSaveAsResult,
  type ProjectSaveResult
} from '../shared/ipc'

const CH_PROGRESS = 'model:download-progress'
const CH_READY = 'model:ready'
const CH_VIDEO_DROP = 'video-drop-path'
const CH_TX_MODE = 'transcribe:mode'
const CH_TX_DIAG = 'transcribe:diag'
const CH_TX_PROGRESS = 'transcribe:progress'
const CH_TX_COMPLETE = 'transcribe:complete'
const CH_TX_ERROR = 'transcribe:error'
const CH_EXPORT_PROGRESS = 'export:progress'
const CH_UPDATE_SUBTITLE = 'update-subtitle'
const CH_GPU_INSTALL_PROGRESS = 'gpu:install-progress'

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    on(
      channel: string,
      listener: (event: IpcRendererEvent, payload: ExportSubtitleUpdatePayload) => void
    ): void {
      if (channel !== CH_UPDATE_SUBTITLE) return
      ipcRenderer.on(channel, listener)
    },
    removeListener(
      channel: string,
      listener: (event: IpcRendererEvent, payload: ExportSubtitleUpdatePayload) => void
    ): void {
      if (channel !== CH_UPDATE_SUBTITLE) return
      ipcRenderer.removeListener(channel, listener)
    }
  }
})

contextBridge.exposeInMainWorld('api', {
  openVideoFileDialog: () =>
    ipcRenderer.invoke('dialog:openVideo') as Promise<OpenVideoDialogResult>,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getMediaFileUrl: (absoluteFilePath: string) => pathToFileURL(absoluteFilePath).href,
  sidecarCall: (method: string, params?: Record<string, unknown>) =>
    ipcRenderer.invoke('sidecar:call', method, params) as Promise<unknown>,
  getDepsStatus: () => ipcRenderer.invoke('deps:status'),
  getFfmpegCapabilities: () => ipcRenderer.invoke('ffmpeg:capabilities') as Promise<FfmpegCapabilities>,
  prepareAllEngines: () => ipcRenderer.invoke('deps:prepare-all') as Promise<{ ok: true }>,
  getGpuRuntimeStatus: () => ipcRenderer.invoke('gpu:status') as Promise<GpuRuntimeStatus>,
  installGpuRuntime: () =>
    ipcRenderer.invoke('gpu:install') as Promise<{ ok: true; source: 'local' | 'download' | 'existing'; dir: string }>,
  onGpuInstallProgress: (callback: (payload: GpuInstallProgressPayload) => void) => {
    const listener = (_event: IpcRendererEvent, payload: GpuInstallProgressPayload) => callback(payload)
    ipcRenderer.on(CH_GPU_INSTALL_PROGRESS, listener)
    return () => ipcRenderer.removeListener(CH_GPU_INSTALL_PROGRESS, listener)
  },
  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:openExternal', url) as Promise<{ ok: true } | { ok: false; reason: string }>,
  exportVideoWithBurnedSubtitles: (req: ExportVideoRequest) =>
    ipcRenderer.invoke('export:by-format', { ...req, format: 'video' } satisfies ExportRequest) as Promise<ExportVideoResult>,
  exportByFormat: (req: ExportRequest) => ipcRenderer.invoke('export:by-format', req) as Promise<ExportResult>,
  showExportResultInFolder: (absoluteFilePath: string) =>
    ipcRenderer.invoke('shell:showItemInFolder', absoluteFilePath) as Promise<{ ok: true } | { ok: false; reason: string }>,
  onExportProgress: (callback: (payload: ExportProgressPayload) => void) => {
    const listener = (_event: IpcRendererEvent, payload: ExportProgressPayload) => callback(payload)
    ipcRenderer.on(CH_EXPORT_PROGRESS, listener)
    return () => ipcRenderer.removeListener(CH_EXPORT_PROGRESS, listener)
  },
  onModelDownloadProgress: (callback: (percent: number) => void) => {
    const listener = (_event: IpcRendererEvent, percent: number) => callback(percent)
    ipcRenderer.on(CH_PROGRESS, listener)
    return () => ipcRenderer.removeListener(CH_PROGRESS, listener)
  },
  onModelReady: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on(CH_READY, listener)
    return () => ipcRenderer.removeListener(CH_READY, listener)
  },
  sendVideoDropPath: (absolutePath: string) => {
    ipcRenderer.send(CH_VIDEO_DROP, absolutePath)
  },
  onTranscribeMode: (callback: (mode: 'cpu' | 'gpu') => void) => {
    const listener = (_event: IpcRendererEvent, mode: 'cpu' | 'gpu') => callback(mode)
    ipcRenderer.on(CH_TX_MODE, listener)
    return () => ipcRenderer.removeListener(CH_TX_MODE, listener)
  },
  onTranscribeDiag: (callback: (payload: { message: string }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { message: string }) => callback(payload)
    ipcRenderer.on(CH_TX_DIAG, listener)
    return () => ipcRenderer.removeListener(CH_TX_DIAG, listener)
  },
  onTranscribeProgress: (callback: (percent: number) => void) => {
    const listener = (_event: IpcRendererEvent, percent: number) => callback(percent)
    ipcRenderer.on(CH_TX_PROGRESS, listener)
    return () => ipcRenderer.removeListener(CH_TX_PROGRESS, listener)
  },
  onTranscribeComplete: (callback: (payload: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload)
    ipcRenderer.on(CH_TX_COMPLETE, listener)
    return () => ipcRenderer.removeListener(CH_TX_COMPLETE, listener)
  },
  onTranscribeError: (callback: (err: { message: string }) => void) => {
    const listener = (_event: IpcRendererEvent, err: { message: string }) => callback(err)
    ipcRenderer.on(CH_TX_ERROR, listener)
    return () => ipcRenderer.removeListener(CH_TX_ERROR, listener)
  },
  notifySubtitleRenderReady: () => {
    ipcRenderer.send(IPC_EXPORT_SUBTITLE_RENDER_READY)
  },
  openProjectFile: () => ipcRenderer.invoke('project:open') as Promise<ProjectOpenResult>,
  saveProjectFile: (path: string, content: string) =>
    ipcRenderer.invoke('project:save', { path, content }) as Promise<ProjectSaveResult>,
  saveProjectFileAs: (content: string, defaultPath?: string) =>
    ipcRenderer.invoke('project:saveAs', { content, defaultPath }) as Promise<ProjectSaveAsResult>
})
