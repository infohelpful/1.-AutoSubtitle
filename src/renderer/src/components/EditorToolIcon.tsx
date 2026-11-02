const paths = {
  undo: 'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12',
  redo: 'm15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12',
  sync: 'M20 7a8 8 0 1 0 0 10M20 3v4h-4M12 8v4l3 2',
  syncAll: 'M4 4h12M4 8h8M4 12h5M21 14a6 6 0 1 0 0 5m0-9v4h-4',
  reading: 'M5 4h14v12H9l-4 4V4m4 4h6m-6 4h4',
  import: 'M14 3H5v18h14V8l-5-5v5h5M8 14h8m-3-3 3 3-3 3',
  split: 'M5 3v5c0 4 14 4 14 8v5M19 3v5c0 4-14 4-14 8v5M2 18l3 3 3-3m8 0 3 3 3-3',
  export: 'M12 15V3m-4 4 4-4 4 4M4 14v7h16v-7',
  show: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12m13 0a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
  hide: 'm3 3 18 18M10 5h2c6 0 10 7 10 7a20 20 0 0 1-3 4M6 6a20 20 0 0 0-4 6s4 7 10 7h2m-5-9a3 3 0 0 0 4 4',
  cancel: 'm6 6 12 12M6 18 18 6',
  chevron: 'm8 10 4 4 4-4'
}

export function EditorToolIcon({ name }: { name: keyof typeof paths }) {
  return <svg className="editor-tool-icon" width="22" height="22" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name]} />
  </svg>
}
