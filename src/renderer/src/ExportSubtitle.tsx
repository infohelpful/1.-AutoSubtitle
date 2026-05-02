import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'

import type { ExportSubtitleUpdatePayload } from '../../shared/ipc'
import { getSubtitleBoxChromeInline } from '../../shared/subtitleBoxChrome'



const DEFAULT_STATE: ExportSubtitleUpdatePayload = {

  text: '',

  width: 1920,

  height: 1080,

  fontFamily: 'Malgun Gothic',

  fontSize: 26,

  textColor: '#f4f6fb',

  fontWeight: 700,

  bgColor: '#080a10',

  bgOpacity: 62,

  bgPaddingPct: 100,

  strokeColor: '#000000',

  strokeWidth: 2,

  x: 50,

  y: 10

}



function hexToRgb(hex: string): { r: number; g: number; b: number } {

  const clean = hex.replace('#', '').trim()

  const norm = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean

  if (!/^[0-9a-fA-F]{6}$/.test(norm)) return { r: 8, g: 10, b: 16 }

  const n = Number.parseInt(norm, 16)

  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }

}



/**

 * `App.tsx` 프리뷰의 `previewSubtitleTextStyle` useMemo와 동일한 계산

 * (videoNaturalSize.width → maxWidth, bottom/left %, stroke, 배경 rgba)

 */

function buildPreviewSubtitleTextStyle(args: {

  videoNaturalWidth: number

  subtitleBgColor: string

  subtitleBgOpacity: number

  subtitleFontFamily: string

  subtitleFontSize: number

  subtitleFontWeight: number

  subtitleTextColor: string

  subtitleStrokeColor: string

  subtitleStrokeWidth: number

  subtitleX: number

  subtitleY: number

  subtitleBgPaddingPct: number

}): CSSProperties {

  const subtitleMaxWidthPx =

    args.videoNaturalWidth > 0 ? Math.floor(args.videoNaturalWidth * 0.9) : 0

  const { r, g, b } = hexToRgb(args.subtitleBgColor)

  const shadow = Math.max(0, Math.min(6, args.subtitleStrokeWidth))

  const chrome = getSubtitleBoxChromeInline(args.subtitleFontSize, args.subtitleBgPaddingPct)

  return {

    left: `${args.subtitleX}%`,

    bottom: `${args.subtitleY}%`,

    transform: 'translateX(-50%)',

    position: 'absolute',

    display: 'inline-block',

    ...chrome,

    textAlign: 'center',

    width: 'max-content',

    maxWidth: subtitleMaxWidthPx > 0 ? `${subtitleMaxWidthPx}px` : '90%',

    background: `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, args.subtitleBgOpacity / 100))})`,

    fontFamily: args.subtitleFontFamily,

    fontSize: `${args.subtitleFontSize}px`,

    fontWeight: args.subtitleFontWeight,

    color: args.subtitleTextColor,

    whiteSpace: 'normal',

    wordBreak: 'keep-all',

    overflowWrap: 'normal',

    textShadow: `-${shadow}px 0 ${args.subtitleStrokeColor}, 0 ${shadow}px ${args.subtitleStrokeColor}, ${shadow}px 0 ${args.subtitleStrokeColor}, 0 -${shadow}px ${args.subtitleStrokeColor}, 0 2px 8px rgba(0,0,0,0.8)`

  }

}



function mergeUpdate(prev: ExportSubtitleUpdatePayload, raw: Partial<ExportSubtitleUpdatePayload>): ExportSubtitleUpdatePayload {

  return {

    ...prev,

    ...raw,

    text: raw.text ?? prev.text,

    width: raw.width ?? prev.width,

    height: raw.height ?? prev.height,

    fontFamily: raw.fontFamily ?? prev.fontFamily,

    fontSize: raw.fontSize ?? prev.fontSize,

    textColor: raw.textColor ?? prev.textColor,

    fontWeight: raw.fontWeight ?? prev.fontWeight,

    bgColor: raw.bgColor ?? prev.bgColor,

    bgOpacity: raw.bgOpacity ?? prev.bgOpacity,

    bgPaddingPct: raw.bgPaddingPct ?? prev.bgPaddingPct,

    strokeColor: raw.strokeColor ?? prev.strokeColor,

    strokeWidth: raw.strokeWidth ?? prev.strokeWidth,

    x: raw.x ?? prev.x,

    y: raw.y ?? prev.y

  }

}



/**

 * 내보내기 전용 자막 레이어 — `exportSubtitle.css` 만 로드해 App.css 프리뷰 클래스와 겹치지 않게 함.

 * 메인 프로세스에서 `webContents.send('update-subtitle', payload)` 로 프레임별 갱신.

 */

export default function ExportSubtitle(): JSX.Element {

  const [data, setData] = useState<ExportSubtitleUpdatePayload>(() => ({ ...DEFAULT_STATE }))



  const previewSubtitleTextStyle = useMemo(

    () =>

      buildPreviewSubtitleTextStyle({

        videoNaturalWidth: data.width,

        subtitleBgColor: data.bgColor,

        subtitleBgOpacity: data.bgOpacity,

        subtitleFontFamily: data.fontFamily,

        subtitleFontSize: data.fontSize,

        subtitleFontWeight: data.fontWeight,

        subtitleTextColor: data.textColor,

        subtitleStrokeColor: data.strokeColor,

        subtitleStrokeWidth: data.strokeWidth,

        subtitleX: data.x,

        subtitleY: data.y,

        subtitleBgPaddingPct: data.bgPaddingPct ?? 100

      }),

    [

      data.bgColor,

      data.bgOpacity,

      data.bgPaddingPct,

      data.fontFamily,

      data.fontSize,

      data.fontWeight,

      data.strokeColor,

      data.strokeWidth,

      data.textColor,

      data.width,

      data.x,

      data.y

    ]

  )



  useEffect(() => {

    const html = document.documentElement

    const body = document.body

    const root = document.getElementById('root')

    const prevHtmlBg = html.style.background

    const prevBodyBg = body.style.background

    const prevBodyMargin = body.style.margin

    const prevRootBg = root?.style.background ?? ''

    html.style.background = 'transparent'

    body.style.background = 'transparent'

    body.style.margin = '0'

    if (root) root.style.background = 'transparent'

    return () => {

      html.style.background = prevHtmlBg

      body.style.background = prevBodyBg

      body.style.margin = prevBodyMargin

      if (root) root.style.background = prevRootBg

    }

  }, [])



  /** 영상 픽셀과 1:1로 맞추기 — device-width 뷰포트가 DPI·배율과 섞여 잘리는 것 방지 */

  useEffect(() => {

    const w = Math.max(1, Math.round(data.width))

    const h = Math.max(1, Math.round(data.height))

    const meta = document.querySelector('meta[name="viewport"]')

    if (meta) {

      meta.setAttribute(

        'content',

        `width=${w}, height=${h}, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no`

      )

    }

    const html = document.documentElement

    const body = document.body

    const root = document.getElementById('root')

    html.style.margin = '0'

    html.style.padding = '0'

    html.style.width = `${w}px`

    html.style.height = `${h}px`

    html.style.overflow = 'hidden'

    body.style.margin = '0'

    body.style.padding = '0'

    body.style.width = `${w}px`

    body.style.height = `${h}px`

    body.style.overflow = 'hidden'

    if (root) {

      root.style.margin = '0'

      root.style.padding = '0'

      root.style.width = `${w}px`

      root.style.height = `${h}px`

      root.style.overflow = 'hidden'

    }

  }, [data.width, data.height])



  useEffect(() => {

    const bridge = window.electron?.ipcRenderer

    if (!bridge) return



    const handler = (_event: unknown, payload: Partial<ExportSubtitleUpdatePayload>) => {
      let merged: ExportSubtitleUpdatePayload | undefined
      flushSync(() => {
        setData((prev) => {
          merged = mergeUpdate(prev, payload)
          return merged
        })
      })

      void (async (): Promise<void> => {
        try {
          if (merged && merged.text.trim().length > 0) {
            const spec = `${merged.fontWeight} ${merged.fontSize}px "${merged.fontFamily}"`
            await document.fonts.load(spec)
          }
          await document.fonts.ready
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          })
          window.api.notifySubtitleRenderReady()
        } catch {
          window.api.notifySubtitleRenderReady()
        }
      })()
    }



    bridge.on('update-subtitle', handler)

    return () => {

      bridge.removeListener('update-subtitle', handler)

    }

  }, [])

  return (

    <div className="export-subtitle-root">

      <div className="export-subtitle-overlay">

        <div className="export-subtitle-stage">

          {data.text.trim().length > 0 ? (

            <p className="export-subtitle-plain" style={previewSubtitleTextStyle}>

              {data.text}

            </p>

          ) : null}

        </div>

      </div>

    </div>

  )

}


