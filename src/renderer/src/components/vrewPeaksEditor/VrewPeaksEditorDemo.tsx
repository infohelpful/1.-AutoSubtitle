import { useState } from 'react'
import { VrewPeaksSubtitleEditor } from './VrewPeaksSubtitleEditor'
import type { SubtitleRow } from './types'

const SAMPLE_ROWS: SubtitleRow[] = [
  {
    id: 'r1',
    words: [{ id: 1, text: '그대로', start: 35.26, end: 35.58 }],
    lineText: '그대로'
  },
  {
    id: 'r2',
    words: [{ id: 2, text: '유지됩니다', start: 35.6, end: 36.4 }],
    lineText: '유지됩니다'
  },
  {
    id: 'r3',
    words: [{ id: 3, text: '테스트', start: 36.5, end: 37.1 }],
    lineText: '테스트'
  }
]

/** Sample harness — e.g. mount under your route or temporarily in `App.tsx`. */
export function VrewPeaksEditorDemo(): JSX.Element {
  const [rows, setRows] = useState(SAMPLE_ROWS)
  return <VrewPeaksSubtitleEditor rows={rows} onRowsChange={setRows} />
}
