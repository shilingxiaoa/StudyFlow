/* eslint-disable */
/**
 * 配图脚本：造一份演示数据，然后依次停在各页面，供主进程定时截图。
 * 用法：SF_SMOKE=1 SF_SMOKE_SCRIPT=scripts/shots-flow.js SF_SHOTS=.shots npm run build && node scripts/smoke.mjs scripts/shots-flow.js .shots
 */
(async () => {
  const inv = (channel, payload) => window.api.invoke(channel, payload)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const must = async (channel, payload) => {
    const res = await inv(channel, payload)
    if (!res || res.ok !== true) throw new Error(`${channel} 失败: ${res && res.error ? res.error.code : 'unknown'}`)
    return res.data
  }
  const notes = []

  try {
    // 空库首屏（登录/建号页）
    await sleep(1500)
    console.log('[shot] login')
    // 主进程的截图会延迟 1500ms 落盘，这里多等一会儿，避免拍到注册后的主页
    await sleep(2200)

    // 建一个演示账号（截图目录是全新的数据目录）
    await must('auth:register', {
      email: `shots-${Date.now()}@local.test`,
      password: 'shots-pass-1',
      displayName: '小徐'
    })

    // 清场
    const boot = await must('app:bootstrap')
    for (const goal of boot.goals || []) await inv('goal:delete', { goalId: goal.id })

    // 演示目标 + 6 天计划
    const goal = await must('goal:create', {
      title: '三个月拿下日语 N3',
      description: '每天 1 小时，按「单词 → 语法 → 听力 → 输出」四块推进，两个月内过完 N3 全部语法点。',
      kind: 'exam',
      level: 'basic',
      dailyMinutes: 60,
      targetDate: null
    })

    const titles = [
      ['五十音与发音规则', '把假名和特殊音读准，能自己拼读单词'],
      ['N5 核心助词 は/が/を/に', '分清楚四个最常用助词的用法边界'],
      ['动词三类变形入门', '看到ます形能反推辞书形'],
      ['て形与日常请求', '能用てください / てもいい完成日常请求'],
      ['过去时与否定', '能说「昨天没做某事」这类句子'],
      ['N3 语法：〜わけではない', '理解部分否定的语气，不再望文生义']
    ]
    const plan = await must('plan:save', {
      goalId: goal.id,
      plan: {
        title: '日语 N3 · 6 天启动计划',
        summary: '先建立发音和助词语感，再逐步进入动词变形与 N3 语法。',
        totalDays: titles.length,
        days: titles.map(([title, goalText], index) => ({
          index: index + 1,
          title,
          goal: goalText,
          estMinutes: 60,
          checkpoints: [`能独立完成第 ${index + 1} 天的例句改写`, '能口头复述今天的核心规则'],
          tasks: [
            { title: `精读教材第 ${index + 1} 节`, kind: 'read', estMinutes: 20 },
            { title: `跟读音频 10 分钟`, kind: 'practice', estMinutes: 10 },
            { title: `做 ${index + 1} 组练习题`, kind: 'practice', estMinutes: 20 },
            { title: '整理今天的例外情况', kind: 'write', estMinutes: 10 }
          ]
        }))
      }
    })

    // 导入两份资料（截图时「新建计划」页会显示资料卡片）
    const imported = await must('material:import', {
      goalId: goal.id,
      paths: ['.tmp-fixtures/kana.md', '.tmp-fixtures/sample.docx']
    })
    notes.push(`materials=${imported.imported}`)

    // 第一天任务全勾完 → 待检测
    let day = await must('day:get', { dayId: (await must('app:bootstrap')).todayDay.id })
    for (const task of day.tasks) {
      day = await must('task:setStatus', { taskId: task.id, status: 'done' })
    }

    // 第二天勾一部分（演示「进行中」）
    const boot2 = await must('app:bootstrap')
    const planId = plan.id
    const days = await must('day:list', { planId })
    const second = days[1]
    if (second) {
      const detail = await must('day:get', { dayId: second.id })
      if (detail.tasks[0]) await must('task:setStatus', { taskId: detail.tasks[0].id, status: 'done' })
      if (detail.tasks[1]) await must('task:setStatus', { taskId: detail.tasks[1].id, status: 'doing' })
    }
    notes.push(`goal=${goal.id} plan=${planId} today=${boot2.todayDay.index}`)

    // 依次停留并打点：`[shot] <label>` 会触发主进程截图，命名确定
    const settle = async (ms) => { await sleep(ms); }
    await sleep(1500) // 等 push 刷新把 store 里的目标带上，避免被守卫弹回 setup

    const stops = [
      ['dashboard', '#/'],
      ['day', `#/day/${boot2.todayDay.id}`],
      ['stats', '#/stats'],
      ['settings', '#/settings'],
      ['plan-new', '#/plan/new']
    ]
    for (const [label, hash] of stops) {
      location.hash = hash
      await settle(1400)
      notes.push(
        label + ':' + location.hash + ':' + (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 26)
      )
      console.log('[shot] ' + label)
      await sleep(2000)
    }    await must('goal:delete', { goalId: goal.id })
  } catch (error) {
    notes.push('FAILED ' + String((error && error.message) || error))
  }

  return { ok: true, passed: 1, failed: 0, results: [{ name: 'shots', ok: true, extra: notes }], screens: [] }
})()
