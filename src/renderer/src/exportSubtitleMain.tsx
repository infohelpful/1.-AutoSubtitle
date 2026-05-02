import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ExportSubtitle from './ExportSubtitle'
import './exportSubtitle.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ExportSubtitle />
  </StrictMode>
)
