import { app, shell, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { registerIpcHandlers } from './ipc/register'
import { prepareAuth } from './auth/service'

/**
 * 测试隔离：SF_USER_DATA=<目录> 时把数据目录整体挪走。
 * 冒烟脚本每次都指向 .tmp-smoke-data，保证不碰用户真实的 %APPDATA%/StudyFlow。
 * 必须赶在 app ready / 任何 getPath('userData') 之前设置。
 */
const userDataOverride = process.env['SF_USER_DATA']
if (userDataOverride !== undefined && userDataOverride.trim() !== '') {
  app.setPath('userData', resolve(userDataOverride))
}

const isDev = !app.isPackaged

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: '#0E1116',
    autoHideMenuBar: true,
    title: 'StudyFlow · 学习进度',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 冒烟要截图：禁止后台节流，否则窗口被遮挡时合成器不出帧，capturePage 会拿到旧画面
      backgroundThrottling: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 冒烟自检：SF_SMOKE=1 时窗口加载完读一次 DOM，打印后退出（供 CI / 本地验收）
  if (process.env['SF_SMOKE'] === '1') {
    const shotsDir = process.env['SF_SHOTS']
    // 截图依赖真实合成帧：把窗口顶到最前，避免被其它窗口遮挡后不再出帧
    if (shotsDir) {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.show()
      win.focus()
      win.moveTop()
    }
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[smoke:console:${level}] ${message} (${sourceId}:${line})`)
      // 可选：渲染层打 `[shot] <label>` 就截一张图，命名确定，方便文档配图（SF_SHOTS=<目录>）
      // 注意：console-message 到达时，刚切换的页面常常还没合成出新帧，
      // 立刻 capturePage 会拿到上一屏画面。所以先 invalidate + 等一会儿再截。
      if (shotsDir && message.startsWith('[shot] ')) {
        const label = message.slice(7).trim().replace(/[^\w.-]+/g, '-') || 'shot'
        mkdirSync(shotsDir, { recursive: true })
        setTimeout(() => {
          // 等一屏再截：console.log 到合成器出帧之间常有一屏延迟，否则会拍上一个页面。
          // 先等两个 rAF（最多 600ms 兜底），确认渲染层确实画完新帧，再抓图。
          const settle = win.webContents
            .executeJavaScript(
              `new Promise((resolve) => {
                 let frames = 0
                 const tick = () => {
                   frames += 1
                   if (frames >= 2) return resolve(true)
                   requestAnimationFrame(tick)
                 }
                 requestAnimationFrame(tick)
                 setTimeout(() => resolve(false), 600)
               })`
            )
            .catch(() => false)
          void settle
            .then(() => win.webContents.capturePage())
            .then((image) => {
              writeFileSync(join(shotsDir, `${label}.png`), image.toPNG())
              console.log(`[smoke] 已截图 ${label}`)
            })
            .catch((error) => console.error('[smoke] 截图失败', error))
        }, 1200)
      }
    })
    win.webContents.on('did-fail-load', (_event, code, desc) => {
      console.error(`[smoke] load failed ${code} ${desc}`)
    })
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const defaultScript = `(() => ({
               hash: location.hash,
               title: document.title,
               text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 900),
               nodes: document.querySelectorAll('#root *').length,
               api: typeof window.api,
               apiKeys: window.api ? Object.keys(window.api) : [],
               broken: Array.from(document.images).filter((i) => !i.complete || i.naturalWidth === 0).length
             }))()`
        let script = defaultScript
        const custom = process.env['SF_SMOKE_SCRIPT']
        if (custom) {
          try {
            script = readFileSync(custom, 'utf8')
          } catch (error) {
            console.error('[smoke] 读取脚本失败', error)
          }
        }
        void win.webContents
          .executeJavaScript(script)
          .then((info) => console.log('[smoke] ' + JSON.stringify(info)))
          .catch((error) => console.error('[smoke] eval failed', error))
          .finally(() => {
            setTimeout(() => app.quit(), 700)
          })
      }, 2500)
    })
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // 账号模块要先就绪：登录页在拿到会话之前就会调 auth:status
  try {
    await prepareAuth()
  } catch (err) {
    console.error('[auth] 账号模块初始化失败', err)
  }
  registerIpcHandlers()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
