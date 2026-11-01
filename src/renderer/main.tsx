/* ============================================================
   StudyFlow · 渲染进程入口
   - 挂载 React（StrictMode + 全局 ErrorBoundary）
   - 先套默认深色主题，避免首帧白闪（bootstrap 返回后按设置校正）
   - 触发一次 store.load()
   ============================================================ */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import { ErrorBoundary } from './components/ErrorBoundary'
import { applyTheme } from './lib/theme'
import { bindPushListeners, useAppStore } from './store/app'
import App from './App'

const container = document.getElementById('root')
if (!container) {
  throw new Error('[StudyFlow] 找不到 #root 挂载点，index.html 可能被改动过')
}

applyTheme('dark')
bindPushListeners()

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)

void useAppStore.getState().load()
