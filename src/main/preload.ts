import { contextBridge, ipcRenderer } from 'electron'
import { IPC, PUSH } from '../shared/contracts'
import type { IpcChannel, RendererApi, Result } from '../shared/contracts'

/** 允许渲染进程调用的通道白名单（契约里所有 invoke 通道 + 推送通道） */
const ALLOWED = new Set<string>([...Object.values(IPC), ...Object.values(PUSH)])

const api: RendererApi = {
  invoke<T>(channel: IpcChannel, payload?: unknown): Promise<Result<T>> {
    if (!ALLOWED.has(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN', message: `非法通道: ${String(channel)}` }
      })
    }
    return ipcRenderer.invoke(channel, payload) as Promise<Result<T>>
  },

  on(channel: string, cb: (payload: unknown) => void): () => void {
    if (!ALLOWED.has(channel)) return () => {}
    const listener = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },

  platform: process.platform as RendererApi['platform']
}

contextBridge.exposeInMainWorld('api', api)
