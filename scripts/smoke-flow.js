/* eslint-disable */
/**
 * 冒烟脚本：由主进程在 SF_SMOKE=1 && SF_SMOKE_SCRIPT=<本文件> 时注入渲染进程执行。
 * 覆盖「不花 token」的完整链路：建目标 → 存计划 → 完成任务 → 进度 → 出题守卫 → 统计 → 导出 → 渲染。
 * 最后会删掉本次创建的目标，不留脏数据。
 */
(async () => {
  const inv = (channel, payload) => window.api.invoke(channel, payload)
  const results = []

  const record = (name, ok, extra) => {
    results.push({ name, ok, ...(extra === undefined ? {} : { extra }) })
  }

  const must = async (name, channel, payload) => {
    const t0 = performance.now()
    const res = await inv(channel, payload)
    const ms = Math.round(performance.now() - t0)
    if (!res || res.ok !== true) {
      record(name, false, res && res.error ? { code: res.error.code, message: res.error.message } : 'no-result')
      throw new Error(`${name} 失败: ${res && res.error ? res.error.code + ' ' + res.error.message : '未知错误'}`)
    }
    record(name, true, ms)
    return res.data
  }

  const expectError = async (name, channel, payload, code) => {
    const res = await inv(channel, payload)
    const actual = res && res.error ? res.error.code : res && res.ok ? 'OK' : 'UNKNOWN'
    record(name, actual === code, { expect: code, actual })
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const snapshot = (label) => ({
    label,
    hash: location.hash,
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 700),
    nodes: document.querySelectorAll('#root *').length
  })

  const screens = []
  let goalId = null
  let dayId = null
  const accountPassword = 'smoke-pass-1'
  const accountEmail = `smoke-${Date.now()}@local.test`
  try {
    // 0. 账号：登录功能之后，所有数据通道都要求先登录。
    //    冒烟数据目录是全新的，所以这里先注册；复用数据目录时回退到登录。
    const status0 = await inv('auth:status')
    record('auth:status 未登录', Boolean(status0 && status0.ok && status0.data.authenticated === false))
    const registered = await inv('auth:register', {
      email: accountEmail,
      password: accountPassword,
      displayName: '冒烟账号'
    })
    if (registered && registered.ok) {
      record('auth:register', true)
    } else {
      await must('auth:login（复用数据目录）', 'auth:login', { email: accountEmail, password: accountPassword })
    }
    const authed = await must('auth:status 已登录', 'auth:status')
    record('auth:hasAccounts 为真', authed.hasAccounts === true && authed.authenticated === true)

    // 0. 清场：删掉历史目标，保证从干净状态开始
    const boot = await must('bootstrap/初始', 'app:bootstrap')
    for (const goal of boot.goals || []) {
      await inv('goal:delete', { goalId: goal.id })
    }

    // 1. 建目标
    const goal = await must('goal:create', 'goal:create', {
      title: '冒烟：Python 速通',
      description: '验证非 AI 链路：建目标、存计划、勾任务、进度与统计。',
      kind: 'skill',
      level: 'basic',
      dailyMinutes: 60,
      targetDate: null
    })
    goalId = goal.id

    // 1.5 资料导入：md / docx / pptx 各一份，验证解析 + 入库 + 列表
    const imported = await must('material:import', 'material:import', {
      goalId,
      paths: ['.tmp-fixtures/kana.md', '.tmp-fixtures/sample.docx', '.tmp-fixtures/lecture.pptx']
    })
    record('资料导入 3 份', imported.imported === 3 && imported.skipped.length === 0, {
      imported: imported.imported,
      skipped: imported.skipped
    })
    const materials = await must('material:list', 'material:list', { goalId })
    const md = materials.find((m) => m.title === 'kana')
    const docx = materials.find((m) => m.title === 'sample')
    const pptx = materials.find((m) => m.title === 'lecture')
    record(
      '资料解析出正文',
      materials.length === 3 &&
        Boolean(md) &&
        Boolean(docx) &&
        Boolean(pptx) &&
        Boolean(md.content.includes('# 第一章')) &&
        Boolean(docx.content.includes('第一段正文')) &&
        Boolean(pptx.content.includes('课堂 PPT 第一页标题')) &&
        Boolean(pptx.content.includes('【备注】')) &&
        Boolean(pptx.content.includes('## 第 2 页')),
      {
        titles: materials.map((m) => m.title),
        mdChars: md ? md.content.length : 0,
        docxChars: docx ? docx.content.length : 0,
        pptxChars: pptx ? pptx.content.length : 0
      }
    )
    const rejected = await must('material:import 拒收 pdf', 'material:import', {
      goalId,
      paths: ['.tmp-fixtures/notes.pdf']
    })
    record(
      '不支持的格式被跳过并给原因',
      rejected.imported === 0 &&
        rejected.skipped.length === 1 &&
        rejected.skipped[0].reason.includes('不支持'),
      { skipped: rejected.skipped }
    )

    // 2. 存计划（AI 生成的等价物，手工构造 3 天）
    const plan = await must('plan:save', 'plan:save', {
      goalId,
      plan: {
        title: 'Python 速通 · 3 天',
        summary: '冒烟用计划',
        totalDays: 3,
        days: [1, 2, 3].map((index) => ({
          index,
          title: `第 ${index} 天：基础语法 ${index}`,
          goal: `掌握第 ${index} 组语法`,
          estMinutes: 60,
          checkpoints: [`能写出第 ${index} 天的示例代码`],
          tasks: [
            { title: `读教材第 ${index} 章`, kind: 'read', estMinutes: 25 },
            { title: `写 ${index} 道练习题`, kind: 'practice', estMinutes: 25 },
            { title: `复述第 ${index} 章重点`, kind: 'review', estMinutes: 10 }
          ]
        }))
      }
    })

    const allDays = await must('day:list（建计划后）', 'day:list', { goalId })
    record(
      '新计划的所有 Day 都是「学习中」，没有 locked',
      allDays.length === 3 && allDays.every((item) => item.status === 'learning'),
      { statuses: allDays.map((item) => item.status) }
    )
    const lastDayId = allDays[allDays.length - 1] && allDays[allDays.length - 1].id

    // 2.1 计划编辑：能改标题；不能直接加天数（要重新生成）
    const renamed = await must('plan:update/改标题', 'plan:update', {
      planId: plan.id,
      title: 'Python 速通 · 改过的标题'
    })
    record('plan:update 改标题生效', renamed.title === 'Python 速通 · 改过的标题', {
      title: renamed.title
    })
    await expectError('plan:update 加天数被拒（VALIDATION）', 'plan:update', {
      planId: plan.id,
      totalDays: 10
    }, 'VALIDATION')

    // 3. 首屏状态
    let boot2 = await must('bootstrap/建计划后', 'app:bootstrap')
    record('bootstrap 数据完整', Boolean(boot2.activePlan && boot2.todayDay && boot2.progress), {
      totalDays: boot2.activePlan && boot2.activePlan.totalDays,
      todayIndex: boot2.todayDay && boot2.todayDay.index,
      todayStatus: boot2.todayDay && boot2.todayDay.status,
      percent: boot2.progress && boot2.progress.percent,
      segments: boot2.progress && boot2.progress.segments && boot2.progress.segments.length
    })
    dayId = boot2.todayDay && boot2.todayDay.id

    // 4. 勾完第一天任务 → 状态自动变 exam_ready
    let day = await must('day:get', 'day:get', { dayId })
    for (const task of day.tasks) {
      day = await must(`task:setStatus(${task.index})`, 'task:setStatus', { taskId: task.id, status: 'done' })
    }
    record('第一天任务全完成 → exam_ready', day.status === 'exam_ready', { status: day.status })

    // 4.5 每日教案：未生成时的空态 + 无 Key 时的两道守卫
    const emptyLesson = await must('lesson:get（未生成）', 'lesson:get', { dayId })
    record(
      'lesson:get 未生成 → empty 且无分节',
      emptyLesson.status === 'empty' && emptyLesson.sections.length === 0,
      { status: emptyLesson.status }
    )
    await expectError('lesson:generate 无 Key → NO_API_KEY', 'lesson:generate', { dayId }, 'NO_API_KEY')
    await expectError(
      'lesson:ask 未备课 → VALIDATION',
      'lesson:ask',
      { dayId, question: '今天这课重点是什么' },
      'VALIDATION'
    )

    // 5. 未配置 Key 时出题必须被拦住
    await expectError('exam:create 无 Key → NO_API_KEY', 'exam:create', { dayId }, 'NO_API_KEY')
    // 5.1 跳着做：最后一天既没解锁也没勾任务，一样能直接发起检测
    //（先撞到 Key 检查，说明「必须按顺序 / 必须勾完任务」的守卫已经移除）
    await expectError(
      '跳着做：任意 Day 直接检测不再被顺序拦（无 Key → NO_API_KEY）',
      'exam:create',
      { dayId: lastDayId },
      'NO_API_KEY'
    )

    // 6. 进度与统计
    const summary = await must('progress:summary', 'progress:summary', { goalId })
    record('进度 0% 且三段', summary.percent === 0 && summary.segments.length === 3, {
      percent: summary.percent,
      passedDays: summary.passedDays
    })
    const events = await must('progress:events', 'progress:events', { goalId, limit: 10 })
    record('进度事件数组', Array.isArray(events), { count: events.length })
    const stats = await must('stats:overview', 'stats:overview', {})
    record('统计 14 天', Array.isArray(stats.dailyMinutes) && stats.dailyMinutes.length === 14, {
      days: stats.dailyMinutes && stats.dailyMinutes.length
    })

    // 7. 复检：还没有考过的 Day，应给出明确错误
    await expectError('review:create 无机考记录 → NOT_FOUND', 'review:create', { goalId }, 'NOT_FOUND')

    // 8. 设置：主题切换 + 每日分钟
    const settings = await must('settings:update', 'settings:update', { theme: 'light', dailyMinutes: 45 })
    record('主题与每日分钟落库', settings.theme === 'light' && settings.dailyMinutes === 45, {
      theme: settings.theme,
      dailyMinutes: settings.dailyMinutes
    })
    await sleep(300)
    record('html data-theme 生效', document.documentElement.getAttribute('data-theme') === 'light', {
      theme: document.documentElement.getAttribute('data-theme')
    })
    await must('settings:update/还原', 'settings:update', { theme: 'dark', dailyMinutes: 60 })

    // 9. 导出 Markdown
    const exported = await must('export:markdown', 'export:markdown', { goalId })
    record('导出路径', typeof exported.path === 'string' && exported.path.length > 0, { path: exported.path })

    // 10. 渲染验收：#/ 看板、#/day/:id、#/plan/new、#/stats、#/settings
    location.hash = '#/'
    await sleep(900)
    screens.push(snapshot('dashboard'))

    location.hash = `#/day/${dayId}`
    await sleep(1800)
    screens.push(snapshot('day'))
    record(
      '已完成任务不再显示「进行中」',
      !Array.from(document.querySelectorAll('.today-task__flag')).length,
      { flags: document.querySelectorAll('.today-task__flag').length }
    )

    location.hash = '#/stats'
    await sleep(900)
    screens.push(snapshot('stats'))

    // 复检面板：没有考过的 Day 时，点按钮应给出可读提示而不是崩掉
    const reviewBtn = Array.from(document.querySelectorAll('button')).find((btn) =>
      (btn.textContent || '').includes('抽 2 题复检')
    )
    if (reviewBtn) {
      reviewBtn.click()
      await sleep(900)
    }
    record('复检入口存在且可点', Boolean(reviewBtn))
    record(
      '复检无记录时给出提示',
      (document.body.innerText || '').includes('还没有考过的学习日'),
      { text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 0) }
    )

    location.hash = '#/settings'
    await sleep(900)
    screens.push(snapshot('settings'))

    location.hash = '#/plan/new'
    await sleep(900)
    screens.push(snapshot('plan-new'))

    // 10.5 多目标 / 多计划：新建目标不会抢走旧目标的数据，切换靠 context:set
    const goal2 = await must('goal:create/第二个', 'goal:create', {
      title: '冒烟：英语口语',
      description: '验证多目标与多计划。',
      kind: 'skill',
      level: 'zero',
      dailyMinutes: 30,
      targetDate: null
    })
    let boot4 = await must('bootstrap/建第二个目标后', 'app:bootstrap')
    record(
      '新建目标后自动切到新目标',
      boot4.activeGoalId === goal2.id && boot4.goals.length === 2 && boot4.activePlan === null,
      { activeGoalId: boot4.activeGoalId, goals: boot4.goals.length }
    )

    const plan2 = await must('plan:save/第二个目标', 'plan:save', {
      goalId: goal2.id,
      plan: {
        title: '英语口语 · 2 天',
        summary: '多目标冒烟',
        totalDays: 2,
        days: [1, 2].map((index) => ({
          index,
          title: `第 ${index} 天：跟读练习 ${index}`,
          goal: `完成第 ${index} 组跟读`,
          estMinutes: 30,
          checkpoints: [`能跟读第 ${index} 段`],
          tasks: [{ title: `跟读第 ${index} 段`, kind: 'practice', estMinutes: 30 }]
        }))
      }
    })
    boot4 = await must('bootstrap/两个目标各有计划', 'app:bootstrap')
    record(
      '计划只属于它的目标',
      boot4.activeGoalId === goal2.id &&
        boot4.activePlan !== null &&
        boot4.activePlan.goalId === goal2.id &&
        boot4.plans.length === 1,
      { activeGoalId: boot4.activeGoalId, plans: boot4.plans.length }
    )

    // 2.2 缩减天数：2 天 → 1 天（尾部 Day 没有学习记录，允许删）
    const shrunk = await must('plan:update/缩减天数', 'plan:update', {
      planId: plan2.id,
      totalDays: 1
    })
    const goal2Days = await must('day:list（缩减后）', 'day:list', { goalId: goal2.id })
    record(
      'plan:update 缩减天数后 Day 跟着减少',
      shrunk.totalDays === 1 && goal2Days.length === 1,
      { planDays: shrunk.totalDays, dbDays: goal2Days.length }
    )

    // 切回第一个目标：计划、进度、今日 Day 都要跟着换
    let switched = await must('context:set 切回目标一', 'context:set', { goalId })
    record(
      '切换目标后计划与进度同步',
      switched.activeGoalId === goalId &&
        switched.activePlan !== null &&
        switched.activePlan.goalId === goalId &&
        switched.progress.percent === 0 &&
        switched.todayDay !== null,
      {
        activeGoalId: switched.activeGoalId,
        planGoalId: switched.activePlan && switched.activePlan.goalId,
        percent: switched.progress.percent
      }
    )

    // 直接指定计划：跨目标时会顺带切目标
    switched = await must('context:set 指定第二份计划', 'context:set', { planId: plan2.id })
    record(
      '指定计划会带上所属目标',
      switched.activeGoalId === goal2.id && switched.activePlan.id === plan2.id,
      { activeGoalId: switched.activeGoalId, planId: switched.activePlan && switched.activePlan.id }
    )

    // 删除第二个目标：上下文要回退到第一个目标，而不是悬空
    await must('goal:delete/第二个目标', 'goal:delete', { goalId: goal2.id })
    switched = await must('bootstrap/删目标后回退', 'app:bootstrap')
    record(
      '删除当前目标后回退到剩余目标',
      switched.goals.length === 1 &&
        switched.activeGoalId === goalId &&
        switched.activePlan !== null &&
        switched.activePlan.goalId === goalId,
      { goals: switched.goals.length, activeGoalId: switched.activeGoalId }
    )

    // 11. 清场
    await must('goal:delete', 'goal:delete', { goalId })
    const boot3 = await must('bootstrap/清场后', 'app:bootstrap')
    record('清场后无目标', (boot3.goals || []).length === 0, { goals: (boot3.goals || []).length })
    const statsAfter = await must('stats/清场后', 'stats:overview', {})
    record('清场后学习时长为 0（无孤儿数据）', statsAfter.totalMinutes === 0, {
      totalMinutes: statsAfter.totalMinutes
    })

    // 12. 账号：数据隔离、错误密码、改密码后旧密码失效
    await must('auth:logout', 'auth:logout')
    const guestStatus = await must('auth:status 登出后', 'auth:status')
    record('登出后未认证', guestStatus.authenticated === false)
    await must('auth:register 第二个账号', 'auth:register', {
      email: `smoke2-${Date.now()}@local.test`,
      password: 'smoke-pass-2',
      displayName: '冒烟二号'
    })
    const bootSecond = await must('bootstrap/第二账号', 'app:bootstrap')
    record('账号隔离：二号看不到一号的数据', (bootSecond.goals || []).length === 0, {
      goals: (bootSecond.goals || []).length
    })
    await must('auth:logout 二号', 'auth:logout')
    await expectError('auth:login 密码错误', 'auth:login', { email: accountEmail, password: 'wrong-pass' }, 'AUTH_FAILED')
    await must('auth:login 一号', 'auth:login', { email: accountEmail, password: accountPassword })
    const changed = await must('auth:changePassword', 'auth:changePassword', {
      oldPassword: accountPassword,
      newPassword: 'smoke-pass-1b'
    })
    record('改密码后仍在登录态', changed.authenticated === true)
    await must('auth:logout 改密后', 'auth:logout')
    await expectError('旧密码失效', 'auth:login', { email: accountEmail, password: accountPassword }, 'AUTH_FAILED')
    await must('新密码可登录', 'auth:login', { email: accountEmail, password: 'smoke-pass-1b' })
  } catch (error) {
    record('FAILED', false, String((error && error.message) || error))
  }

  const failed = results.filter((item) => !item.ok)
  return {
    ok: failed.length === 0,
    passed: results.filter((item) => item.ok).length,
    failed: failed.length,
    results,
    screens
  }
})()
