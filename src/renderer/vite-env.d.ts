/// <reference types="vite/client" />

import type { RendererApi } from '@shared/contracts'

declare global {
  interface Window {
    /**
     * preload 通过 contextBridge 暴露的唯一 IPC 面。
     * 只在 Electron 里存在；纯浏览器打开时可能为 undefined，
     * 所以业务层一律通过 lib/api.ts 访问，不要直接 use。
     */
    api: RendererApi
  }
}

export {}
