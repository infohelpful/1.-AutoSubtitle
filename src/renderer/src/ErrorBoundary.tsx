import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

/**
 * 루트 아래에서 처리되지 않은 렌더 예외 시 빈(흰) 화면 대신 메시지 표시.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[App render]', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            fontFamily: 'system-ui, sans-serif',
            color: '#1a1a1a',
            background: '#fafafa',
            minHeight: '100vh',
            boxSizing: 'border-box'
          }}
        >
          <h1 style={{ fontSize: 18, margin: '0 0 12px' }}>화면을 불러오는 중 오류가 났습니다.</h1>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 13,
              padding: 12,
              background: '#fff',
              border: '1px solid #ddd',
              borderRadius: 8
            }}
          >
            {this.state.error.message}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}
