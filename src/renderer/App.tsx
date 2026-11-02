/* ============================================================
   StudyFlow · 应用外壳
   - 登录状态未知：启动屏（读取 auth:status）
   - 未登录：只渲染登录页，不挂 Layout、不触发 bootstrap
   - boot 为空：全屏启动屏 / 加载失败页
   - 没有目标：强制进入引导（#/setup）
   - 其余：Layout + 当前 hash 路由页面（页面懒加载）
   ============================================================ */
import { lazy, Suspense, useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { Layout } from './components/layout'
import { Button, ErrorState, Spinner, ToastHost } from './components/ui'
import { navigate, useRoute } from './lib/router'
import type { Route } from './lib/router'
import LoginPage from './pages/Login'
import { useAppStore } from './store/app'
import './styles/shell.css'

// 页面由另一个 agent 并行开发，此刻文件可能尚不存在：
// 用 @ts-ignore（而不是 @ts-expect-error）——页面落地后不会变成“未使用的指令”错误。
// @ts-ignore 页面模块暂缺
const Dashboard = lazy(() => import('./pages/Dashboard'))
// @ts-ignore 页面模块暂缺
const Onboarding = lazy(() => import('./pages/Onboarding'))
// @ts-ignore 页面模块暂缺
const Today = lazy(() => import('./pages/Today'))
// @ts-ignore 页面模块暂缺
const Exam = lazy(() => import('./pages/Exam'))
// @ts-ignore 页面模块暂缺
const PlanNew = lazy(() => import('./pages/PlanNew'))
// @ts-ignore 页面模块暂缺
const Stats = lazy(() => import('./pages/Stats'))
// @ts-ignore 页面模块暂缺
const Settings = lazy(() => import('./pages/Settings'))

/* ───────────────────────────── 品牌标记 ───────────────────────────── */

function BrandMark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7.5h9.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M4 12h13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.72" />
      <path d="M4 16.5h6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.45" />
      <path
        d="M15.6 13.2l2.1 2.1 4-4.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/* ───────────────────────────── 启动屏 ───────────────────────────── */

interface BootSplashProps {
  title: string
  description?: string
  busy?: boolean
}

function BootSplash({ title, description, busy = false }: BootSplashProps): JSX.Element {
  return (
    <div className="sf-boot">
      <div className="sf-boot__card">
        <span className="sf-boot__mark">
          <BrandMark />
        </span>
        <span className="sf-boot__brand">StudyFlow</span>
        <span className="sf-boot__title">{title}</span>
        {description ? <p className="sf-boot__desc">{description}</p> : null}
        {busy ? (
          <span className="sf-boot__progress">
            <Spinner size={14} label="加载中" />
            加载中…
          </span>
        ) : null}
      </div>
    </div>
  )
}

function BootFailure({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="sf-boot">
      <div className="sf-boot__card">
        <span className="sf-boot__mark">
          <BrandMark />
        </span>
        <span className="sf-boot__brand">StudyFlow</span>
        <ErrorState error={undefined} message={message} onRetry={onRetry} retryText="重新加载" />
        <div className="sf-boot__actions">
          <Button variant="subtle" size="sm" onClick={() => window.location.reload()}>
            刷新窗口
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────────── 路由页面 ───────────────────────────── */

function PageFallback(): JSX.Element {
  return (
    <div className="sf-route-loading">
      <Spinner size={20} label="页面加载中" />
      <span>加载中…</span>
    </div>
  )
}

function NotFound({ path }: { path: string }): JSX.Element {
  return (
    <div className="sf-notfound">
      <span className="sf-notfound__code">404</span>
      <span className="sf-notfound__title">没有找到这个页面</span>
      <p className="sf-notfound__desc">
        地址 <code className="sf-mono">{path}</code> 不存在，可能来自旧版本的书签。
      </p>
      <div className="sf-notfound__actions">
        <Button variant="primary" onClick={() => navigate('/')}>
          回到学习看板
        </Button>
        <Button variant="ghost" onClick={() => navigate('/stats')}>
          查看统计
        </Button>
      </div>
    </div>
  )
}

function RouteView({ route }: { route: Route }): JSX.Element {
  const { path } = route

  if (path === '/') return <Dashboard />
  if (path === '/setup') return <Onboarding />
  if (path === '/plan/new') return <PlanNew />
  if (path === '/stats') return <Stats />
  if (path === '/settings') return <Settings />
  if (path.startsWith('/day/')) return <Today dayId={route.params.dayId ?? ''} />
  if (path.startsWith('/exam/')) return <Exam examId={route.params.examId ?? ''} />

  return <NotFound path={path} />
}

/* ───────────────────────────── App ───────────────────────────── */

export default function App(): JSX.Element {
  const boot = useAppStore((state) => state.boot)
  const loading = useAppStore((state) => state.loading)
  const error = useAppStore((state) => state.error)
  const auth = useAppStore((state) => state.auth)
  const authLoading = useAppStore((state) => state.authLoading)
  const authError = useAppStore((state) => state.authError)
  const load = useAppStore((state) => state.load)
  const loadAuth = useAppStore((state) => state.loadAuth)
  const route = useRoute()

  // 启动时自己问一次登录状态（main.tsx 的 load() 也会问；这里只兜底一次，
  // 避免和 load() 抢跑时重复请求，也避免失败后无限自动重试）
  const authAsked = useRef(false)
  useEffect(() => {
    if (authAsked.current || auth !== null || authLoading || loading) return
    authAsked.current = true
    void loadAuth()
  }, [auth, authLoading, loading, loadAuth])

  const needsSetup = auth !== null && auth.authenticated && boot !== null && boot.goals.length === 0 && route.path !== '/setup'

  useEffect(() => {
    if (needsSetup) navigate('/setup')
  }, [needsSetup])

  // 登录状态还没拿到：先看启动屏；读取失败才显示可重试的错误页
  if (auth === null) {
    if (authError !== null) {
      return (
        <BootFailure
          message={authError}
          onRetry={() => {
            void loadAuth()
          }}
        />
      )
    }
    return <BootSplash title="正在启动" description="正在读取登录状态…" busy={authLoading || loading} />
  }

  // 未登录：只渲染登录页（ToastHost 是 portal，不占布局，只为让提示可见）
  if (!auth.authenticated) {
    return (
      <>
        <LoginPage />
        <ToastHost />
      </>
    )
  }

  if (!boot) {
    if (error !== null) {
      return (
        <BootFailure
          message={error}
          onRetry={() => {
            void load()
          }}
        />
      )
    }
    return <BootSplash title="正在启动" description="正在读取本地学习数据…" busy={loading} />
  }

  // 空目标：等重定向生效前先不渲染看板，避免闪一下空界面
  if (needsSetup) {
    return <BootSplash title="准备开始" description="还没有学习目标，正在打开引导…" busy />
  }

  return (
    <>
      <Layout>
        <Suspense fallback={<PageFallback />}>
          <RouteView route={route} />
        </Suspense>
      </Layout>
      <ToastHost />
    </>
  )
}
