/* ============================================================
   StudyFlow · 应用外壳
   左侧导航 + 右侧内容区；窄窗口（<880px）收成图标栏。
   ============================================================ */
import { useEffect } from 'react'
import type { JSX, ReactNode } from 'react'
import { Link, useRoute } from '../lib/router'
import './layout.css'

/** 与 package.json 的 version 保持一致（渲染层不读 package.json，避免把依赖清单打进包） */
const APP_VERSION = '1.3.2'

function IconDashboard(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.4" y="2.4" width="5.4" height="5.4" rx="1.7" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10.2" y="2.4" width="5.4" height="5.4" rx="1.7" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.4" y="10.2" width="5.4" height="5.4" rx="1.7" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10.2" y="10.2" width="5.4" height="5.4" rx="1.7" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function IconPlus(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.4" y="2.4" width="13.2" height="13.2" rx="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 6.1v5.8M6.1 9h5.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function IconStats(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M3.6 14.6V10.2M7.4 14.6V5.2M11.2 14.6v-3.4M15 14.6V7.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function IconSettings(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M2.6 5.6h3.1M10.6 5.6h4.8M2.6 12.4h5.4M12.9 12.4h2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8.1" cy="5.6" r="1.9" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10.4" cy="12.4" r="1.9" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

interface NavItem {
  to: string
  label: string
  icon: JSX.Element
  match: (path: string) => boolean
}

/** 学习看板同时覆盖 day / exam 两个子页面，避免进入学习时导航失去归属 */
const NAV: NavItem[] = [
  { to: '/', label: '学习看板', icon: <IconDashboard />, match: (path) => path === '/' || path.startsWith('/day/') || path.startsWith('/exam/') },
  { to: '/plan/new', label: '新建计划', icon: <IconPlus />, match: (path) => path === '/plan/new' },
  { to: '/stats', label: '复盘统计', icon: <IconStats />, match: (path) => path === '/stats' },
  { to: '/settings', label: '设置', icon: <IconSettings />, match: (path) => path === '/settings' }
]

export interface LayoutProps {
  children: ReactNode
}

export function Layout({ children }: LayoutProps): JSX.Element {
  const { path } = useRoute()
  const activeTo = NAV.find((item) => item.match(path))?.to ?? null

  // 路由切换后内容区回到顶部（否则从长页面跳到短页面会停在半空）
  useEffect(() => {
    const scroller = document.getElementById('sf-main-scroll')
    if (scroller) scroller.scrollTop = 0
  }, [path])

  return (
    <div className="sf-shell">
      <aside className="sf-sidebar">
        <Link to="/" className="sf-logo">
          <span className="sf-logo__mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M9 3.1c-1.5-1-3.4-1.4-5.4-1.2-.5 0-.8.4-.8.9v9.5c0 .5.4.9.9.9 1.8 0 3.7.4 5.3 1.4 1.6-1 3.5-1.4 5.3-1.4.5 0 .9-.4.9-.9V2.8c0-.5-.3-.9-.8-.9-2-.2-3.9.2-5.4 1.2Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path d="M9 3.4v10.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity=".55" />
            </svg>
          </span>
          <span className="sf-logo__text">StudyFlow</span>
        </Link>

        <nav className="sf-nav" aria-label="主导航">
          {NAV.map((item) => {
            const active = item.to === activeTo
            return (
              <Link
                key={item.to}
                to={item.to}
                className={active ? 'sf-nav__item is-active' : 'sf-nav__item'}
              >
                <span className="sf-nav__rail" aria-hidden="true" />
                <span className="sf-nav__icon">{item.icon}</span>
                <span className="sf-nav__label" title={item.label}>
                  {item.label}
                </span>
              </Link>
            )
          })}
        </nav>

        <div className="sf-sidebar__foot">
          <span className="sf-sidebar__chip">本地</span>
          <span className="sf-sidebar__version">v{APP_VERSION}</span>
        </div>
      </aside>

      <main className="sf-main">
        <div className="sf-main__scroll sf-scroll" id="sf-main-scroll">
          {children}
        </div>
      </main>
    </div>
  )
}

// ───────────────────────────── 页面骨架（可选，页面可自行组织） ─────────────────────────────

export interface PageProps {
  title?: ReactNode
  subtitle?: ReactNode
  /** 标题行右侧操作（按钮 / 徽标） */
  actions?: ReactNode
  /** wide：统计、看板类宽页面 */
  width?: 'default' | 'wide'
  children: ReactNode
}

/**
 * 标准页面容器：统一标题排版、最大宽度与页面间距。
 * 页面也可以不用它，直接写自己的结构；注意外层已提供 padding。
 */
export function Page({ title, subtitle, actions, width = 'default', children }: PageProps): JSX.Element {
  return (
    <div className={width === 'wide' ? 'sf-page sf-page--wide' : 'sf-page'}>
      {title || actions ? (
        <header className="sf-page__head">
          <div className="sf-page__heading">
            {title ? <h1 className="sf-page__title">{title}</h1> : null}
            {subtitle ? <p className="sf-page__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="sf-page__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </div>
  )
}
