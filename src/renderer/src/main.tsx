/** Maximum update depth 에러를 React component stack 까지 캡쳐해서 waveform.log 에 남기는 진단 — App 보다 먼저 install */
import { installReactDepthDiagnostic } from './reactDepthDiagnostic'

installReactDepthDiagnostic()

import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './tailwind.css'
import './App.css'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
