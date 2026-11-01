/* ============================================================
   StudyFlow · 全局错误边界
   渲染树任何一处抛错，都不留白屏；样式自带，不依赖 ui.css。
   ============================================================ */
import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import '../styles/shell.css'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 详细堆栈留给控制台（主进程/调试用），界面上只展示可读信息
    console.error('[StudyFlow] 界面渲染异常:', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="sf-crash" role="alert">
        <div className="sf-crash__panel">
          <div className="sf-crash__brand">
            <span className="sf-crash__dot" aria-hidden="true" />
            <span>StudyFlow</span>
          </div>
          <h1 className="sf-crash__title">界面遇到了点问题</h1>
          <p className="sf-crash__desc">
            你的学习数据都存在本机，不会因为这次异常丢失。可以先尝试重试；如果一直出现，请重新加载窗口。
          </p>
          <pre className="sf-crash__detail">{error.message || String(error)}</pre>
          <div className="sf-crash__actions">
            <button type="button" className="sf-crash__btn sf-crash__btn--primary" onClick={this.handleRetry}>
              重试渲染
            </button>
            <button type="button" className="sf-crash__btn" onClick={this.handleReload}>
              重新加载窗口
            </button>
          </div>
        </div>
      </div>
    )
  }
}
