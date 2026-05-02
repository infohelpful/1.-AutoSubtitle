import { app, nativeImage, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join, normalize } from 'node:path'

/**
 * 창 제목줄 왼쪽 아이콘 경로.
 *
 * - `process.cwd()`는 Electron 실행 위치에 따라 프로젝트 루트가 아닐 수 있어 사용하지 않음.
 * - 개발: 컴파일 산출물 `out/main` 기준으로 `../../build/icon.{ico,png}` 탐색.
 * - 설치본: `extraResources` 로 `resources/build/icon.{ico,png}` 복사 후 동일 상대 경로로 탐색.
 */
export function getWindowIconPath(): string | undefined {
  const tryFile = (...candidates: string[]): string | undefined => {
    for (const p of candidates) {
      const abs = normalize(p)
      if (existsSync(abs)) return abs
    }
    return undefined
  }

  if (!app.isPackaged) {
    /** `__dirname` → `…/out/main`(번들 시에도 이 디렉터리 기준) → 저장소 루트는 `../..` */
    const fromMainDir = join(__dirname, '..', '..')
    return tryFile(
      join(fromMainDir, 'build', 'icon.ico'),
      join(fromMainDir, 'build', 'icon.png')
    )
  }

  const res = process.resourcesPath
  return tryFile(
    join(res, 'build', 'icon.ico'),
    join(res, 'build', 'icon.png'),
    join(res, 'icon.ico'),
    join(res, 'icon.png'),
    process.execPath
  )
}

/**
 * Windows 설치본에서 생성자 `icon` 만으로 제목줄에 안 나오는 경우가 있어,
 * 표시 직전에 `setIcon` 으로 한 번 더 적용한다.
 */
export function applyWindowIconToTitleBar(win: BrowserWindow): void {
  const p = getWindowIconPath()
  if (!p || !existsSync(p)) return
  try {
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) win.setIcon(img)
  } catch {
    /* ignore */
  }
}

/** 레거시·트레이 등에서 NativeImage 가 필요할 때 */
export function getWindowIcon(): Electron.NativeImage | undefined {
  const pathStr = getWindowIconPath()
  if (!pathStr) return undefined
  try {
    const img = nativeImage.createFromPath(pathStr)
    return img.isEmpty() ? undefined : img
  } catch {
    return undefined
  }
}
