/**
 * 教案截图专用流程：不造数据，直接用已备好课的 userData（SF_SMOKE_DATA=.tmp-probe-data）。
 * 用法：SF_SMOKE_DATA=.tmp-probe-data node scripts/smoke.mjs scripts/shots-lesson.js .shots
 */
;(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const results = []
  const record = (name, ok, extra) =>
    results.push({ name, ok, extra: extra === undefined ? null : extra })

  const waitFor = async (selector, timeout = 15000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      if (document.querySelector(selector)) return true
      await sleep(200)
    }
    return false
  }

  const boot = await window.api.invoke('app:bootstrap')
  if (!boot.ok || !boot.data.todayDay) {
    record('读到 todayDay', false)
    return { ok: true, passed: 0, failed: 1, results, screens: [] }
  }
  const day = boot.data.todayDay
  record('读到 todayDay', true, { title: day.title, status: day.status })

  await sleep(1500)
  window.location.hash = `#/day/${day.id}`
  const rendered = await waitFor('.sf-lesson')
  record('教案面板已渲染', rendered)

  const scroller = document.querySelector('.sf-main__scroll')
  const jump = (top) => {
    if (scroller) scroller.scrollTo({ top, behavior: 'instant' })
  }

  jump(0)
  await sleep(500)
  console.log('[shot] lesson')

  jump(760)
  await sleep(600)
  console.log('[shot] lesson-practice')

  jump(1900)
  await sleep(600)
  console.log('[shot] lesson-guide')

  const max = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0
  jump(max)
  await sleep(600)
  console.log('[shot] lesson-ask')

  record('教案页可滚动', max > 400, { maxScroll: Math.round(max) })
  const failed = results.filter((item) => !item.ok).length
  return { ok: true, passed: results.length - failed, failed, results, screens: [] }
})()
