import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './SubtitleFormatToolbar.css'

type Props = {
  fontFamily: string
  fonts: string[]
  recentFonts: string[]
  fontSize: number
  fontWeight: number
  textColor: string
  strokeColor: string
  strokeWidth: number
  bgColor: string
  bgOpacity: number
  bgPaddingPct: number
  x: number
  y: number
  onFontFamily: (value: string) => void
  onFontSize: (value: number) => void
  onFontWeight: (value: number) => void
  onTextColor: (value: string) => void
  onStrokeColor: (value: string) => void
  onStrokeWidth: (value: number) => void
  onBgColor: (value: string) => void
  onBgOpacity: (value: number) => void
  onBgPaddingPct: (value: number) => void
  onX: (value: number) => void
  onY: (value: number) => void
}

const COLORS = [
  '#365314', '#713f12', '#7c2d12', '#7f1d1d', '#831843', '#581c87', '#1e3a8a', '#164e63', '#000000',
  '#84cc16', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#3b82f6', '#06b6d4', '#6b7280',
  '#bef264', '#fef08a', '#fdba74', '#fca5a5', '#f9a8d4', '#d8b4fe', '#93c5fd', '#67e8f9', '#d1d5db',
  '#ecfccb', '#fefce8', '#fff7ed', '#fef2f2', '#fdf2f8', '#faf5ff', '#eff6ff', '#ecfeff', '#ffffff'
]
const FONT_SIZES = [14, 18, 22, 26, 32, 40, 50, 60, 75, 90, 100, 110, 125, 150, 200, 250, 300]
type Panel = 'size' | 'text' | 'stroke' | 'background' | 'position'
const PANEL_TITLES: Record<Panel, string> = {
  size: '글자 크기', text: '글자 색상', stroke: '테두리', background: '배경', position: '자막 위치'
}

/** Keep incomplete typing local; only finite, in-range values reach preview/export. */
function NumberField({ label, value, min, max, unit, onChange }: {
  label: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const number = draft.trim() === '' ? value : Number(draft)
    const next = Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : value
    setDraft(String(next))
    onChange(next)
  }
  return <label className="format-number-field">
    <span>{label}</span>
    <span className="format-number-input">
      <input type="number" aria-label={label} min={min} max={max} step={1} value={draft}
        onChange={(event) => {
          const raw = event.target.value
          setDraft(raw)
          const number = Number(raw)
          if (raw.trim() && Number.isInteger(number) && number >= min && number <= max) onChange(number)
        }} onBlur={commit} onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit() }
        }} />
      <span>{unit}</span>
    </span>
  </label>
}

function ColorPalette({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [hex, setHex] = useState(value)
  useEffect(() => setHex(value), [value])
  const commit = () => {
    const candidate = hex.startsWith('#') ? hex : `#${hex}`
    if (/^#[0-9a-f]{6}$/i.test(candidate)) { onChange(candidate); setHex(candidate) }
    else setHex(value)
  }
  return <div className="format-palette">
    <div className="format-swatches" role="group" aria-label={`${label} 팔레트`}>
      {COLORS.map((color) => <button key={color} type="button" style={{ backgroundColor: color }}
        title={color} aria-label={`${label} ${color}`} aria-pressed={value.toLowerCase() === color}
        onClick={() => onChange(color)} />)}
    </div>
    <label className="format-custom-color"><span>직접 지정</span>
      <input type="color" aria-label={`${label} 색상 선택`} value={value} onChange={(event) => onChange(event.target.value)} />
      <input type="text" aria-label={`${label} HEX`} spellCheck={false} value={hex} maxLength={7}
        onChange={(event) => setHex(event.target.value)} onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } }} />
    </label>
  </div>
}

export function SubtitleFormatToolbar(props: Props) {
  const [panel, setPanel] = useState<Panel | null>(null)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const popup = useRef<HTMLDivElement>(null)
  const id = useId()
  const [position, setPosition] = useState({ left: 8, top: 8 })
  useLayoutEffect(() => {
    if (!panel || !anchor.current || !popup.current) return
    const rect = anchor.current.getBoundingClientRect()
    const box = popup.current.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - box.height - 8))
    })
    popup.current.focus({ preventScroll: true })
  }, [panel])
  useEffect(() => {
    if (!panel) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !anchor.current?.contains(event.target)) setPanel(null)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setPanel(null); anchor.current?.focus() }
    }
    const close = () => setPanel(null)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', key)
      window.removeEventListener('resize', close)
    }
  }, [panel])
  const button = (key: Panel, content: ReactNode) => <button type="button" className="format-menu-button"
    aria-label={PANEL_TITLES[key]} aria-expanded={panel === key} aria-haspopup="dialog"
    aria-controls={panel === key ? id : undefined} onClick={(event) => {
      anchor.current = event.currentTarget
      setPanel((current) => current === key ? null : key)
    }}>{content}<span className="format-chevron" aria-hidden="true">⌄</span></button>
  const colorIcon = (color: string, kind: string) => <span aria-hidden="true" className={`format-color-icon ${kind}`} style={{ borderBottomColor: color }}>A</span>
  return <div className="subtitle-format-toolbar" role="group" aria-label="전체 자막 서식"
    onKeyDown={(event) => { if (event.code === 'Space') event.stopPropagation() }}>
    <button className="format-bold" type="button" title="굵게" aria-label="굵게" aria-pressed={props.fontWeight >= 700}
      onClick={() => props.onFontWeight(props.fontWeight >= 700 ? 400 : 700)}>B</button>
    <select aria-label="글꼴 굵기" value={props.fontWeight} onChange={(event) => props.onFontWeight(Number(event.target.value))}>
      {[400, 500, 600, 700, 800, 900].map((weight) => <option key={weight} value={weight}>{weight}</option>)}
    </select>
    <select className="format-font" aria-label="글꼴" value={props.fontFamily} onChange={(event) => props.onFontFamily(event.target.value)}>
      {props.recentFonts.length > 0 && <optgroup label="최근 사용">{props.recentFonts.map((font) => <option key={font} value={font}>{font}</option>)}</optgroup>}
      <optgroup label="전체 글꼴">{Array.from(new Set([props.fontFamily, ...props.fonts])).map((font) => <option key={font} value={font}>{font}</option>)}</optgroup>
    </select>
    {button('size', <><span aria-hidden="true">Aa</span><span>{props.fontSize}</span></>)}
    <span className="format-divider" />
    {button('text', <>{colorIcon(props.textColor, '')}<span>글자색</span></>)}
    {button('stroke', <>{colorIcon(props.strokeColor, 'format-outline-icon')}<span>테두리</span></>)}
    {button('background', <>{colorIcon(props.bgColor, 'format-background-icon')}<span>배경</span></>)}
    <span className="format-divider" />
    {button('position', <><span aria-hidden="true">↔</span><span>위치</span></>)}
    <span className="format-scope">전체 자막에 적용</span>
    {panel && createPortal(<div ref={popup} id={id} role="dialog" aria-label={PANEL_TITLES[panel]} tabIndex={-1}
      className="subtitle-format-popup" style={position} data-waveform-no-dismiss="1">
      <div className="format-popup-heading"><strong>{PANEL_TITLES[panel]}</strong><button type="button" aria-label="서식 설정 닫기"
        onClick={() => { setPanel(null); anchor.current?.focus() }}>×</button></div>
      {panel === 'size' && <>
        <NumberField label="글자 크기" value={props.fontSize} min={14} max={300} unit="px" onChange={props.onFontSize} />
        <div className="format-size-presets" role="group" aria-label="글자 크기 목록">
          {FONT_SIZES.map((size) => <button type="button" key={size} aria-pressed={props.fontSize === size}
            onClick={() => { props.onFontSize(size); setPanel(null); anchor.current?.focus() }}>{size}</button>)}
        </div>
      </>}
      {panel === 'text' && <ColorPalette label="글자색" value={props.textColor} onChange={props.onTextColor} />}
      {panel === 'stroke' && <>
        <ColorPalette label="테두리" value={props.strokeColor} onChange={props.onStrokeColor} />
        <NumberField label="테두리 두께" value={props.strokeWidth} min={0} max={6} unit="px" onChange={props.onStrokeWidth} />
        <button type="button" className="format-clear" onClick={() => props.onStrokeWidth(0)}>테두리 없음</button>
      </>}
      {panel === 'background' && <>
        <ColorPalette label="배경" value={props.bgColor} onChange={props.onBgColor} />
        <NumberField label="배경 불투명도" value={props.bgOpacity} min={0} max={100} unit="%" onChange={props.onBgOpacity} />
        <NumberField label="배경 여백" value={props.bgPaddingPct} min={30} max={150} unit="%" onChange={props.onBgPaddingPct} />
        <button type="button" className="format-clear" onClick={() => props.onBgOpacity(0)}>배경 없음</button>
      </>}
      {panel === 'position' && <>
        <div className="format-position-presets" role="group" aria-label="좌우 위치 선택">
          {([['왼쪽', 25], ['가운데', 50], ['오른쪽', 75]] as const).map(([label, value]) => <button key={label} type="button"
            aria-pressed={props.x === value} onClick={() => props.onX(value)}>{label}</button>)}
        </div>
        <NumberField label="좌우 위치" value={props.x} min={5} max={95} unit="%" onChange={props.onX} />
        <div className="format-position-presets" role="group" aria-label="상하 위치 선택">
          {([['위', 80], ['중간', 45], ['아래', 5]] as const).map(([label, value]) => <button key={label} type="button"
            aria-pressed={props.y === value} onClick={() => props.onY(value)}>{label}</button>)}
        </div>
        <NumberField label="상하 위치" value={props.y} min={0} max={92} unit="%" onChange={props.onY} />
        <p className="format-help">좌우: 왼쪽에서 자막 중심까지의 거리<br />상하: 화면 아래에서 자막 하단까지의 거리</p>
      </>}
    </div>, document.body)}
  </div>
}
