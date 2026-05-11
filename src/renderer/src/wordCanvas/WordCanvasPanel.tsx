import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { List } from 'react-window'
import type { RowComponentProps } from 'react-window'
import { useEditorStore } from './editorStore'
import { SentenceCard } from './SentenceCard'
import type { SentenceId } from './types'

export type WordCanvasPanelProps = {
  className?: string
}

/** h-24 파형 + 테두리·여백 여유 */
const WORD_CANVAS_ROW_HEIGHT_PX = 128
/** Tailwind max-h-56 = 14rem = 224px */
const WORD_CANVAS_LIST_HEIGHT_PX = 224

type WordCanvasRowExtraProps = {
  sentenceIds: readonly SentenceId[]
}

function WordCanvasVirtualRow(props: RowComponentProps<WordCanvasRowExtraProps>): ReactElement | null {
  const { index, style, sentenceIds } = props
  const id = sentenceIds[index]
  if (!id) {
    return <div style={style} />
  }
  return (
    <div style={style} className="box-border">
      <SentenceCard sentenceId={id} className="rounded-md border border-slate-800/80 p-2" />
    </div>
  )
}

/**
 * 정규화 스토어의 `sentenceOrder` 기준으로 문장 카드(로컬 파형)를 **가상 스크롤**한다.
 * 300+ 행을 동시에 마운트하면 IO·zustand 구독이 한 프레임에 몰려 Maximum update depth 가 난다.
 */
function WordCanvasPanelInner({ className }: WordCanvasPanelProps): ReactElement {
  const sentenceOrder = useEditorStore((s) => s.sentenceOrder)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [listW, setListW] = useState(0)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (!cr) return
      const w = Math.max(80, Math.floor(cr.width))
      setListW((prev) => (prev === w ? prev : w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rowProps = useMemo(
    (): WordCanvasRowExtraProps => ({ sentenceIds: sentenceOrder }),
    [sentenceOrder]
  )

  if (sentenceOrder.length === 0) {
    return <></>
  }

  return (
    <section className={className} aria-label="문장별 로컬 파형" data-word-canvas-panel>
      <header className="mb-2 text-xs font-medium text-slate-500">문장별 로컬 파형</header>
      <div ref={wrapRef} className="max-h-56 overflow-hidden pr-1">
        {listW > 0 ? (
          <List<WordCanvasRowExtraProps>
            className="word-canvas-virtual-list"
            style={{ height: WORD_CANVAS_LIST_HEIGHT_PX, width: listW }}
            rowCount={sentenceOrder.length}
            rowHeight={WORD_CANVAS_ROW_HEIGHT_PX}
            rowComponent={WordCanvasVirtualRow}
            rowProps={rowProps}
            overscanCount={4}
          />
        ) : null}
      </div>
    </section>
  )
}

export const WordCanvasPanel = memo(WordCanvasPanelInner)
