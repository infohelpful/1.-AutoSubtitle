import type { ExportSubtitleUpdatePayload, ExportProgressPayload, SidecarApi } from '../shared/ipc'

declare global {
  interface Window {
    api: SidecarApi
    /** 자막 오버레이 전용 창 등 — preload가 `electron` 브리지를 노출할 때만 존재 */
    electron?: {
      ipcRenderer: {
        on(
          channel: 'update-subtitle',
          listener: (event: { senderId: number }, payload: ExportSubtitleUpdatePayload) => void
        ): void
        removeListener(
          channel: 'update-subtitle',
          listener: (event: { senderId: number }, payload: ExportSubtitleUpdatePayload) => void
        ): void
      }
    }
  }
}

export {}
