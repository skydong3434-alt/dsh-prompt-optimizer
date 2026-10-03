/**
 * Client controller 纯逻辑测试:SSE 帧解析、合帧节流、状态流转、撤回、会话模型查询跳过。
 * 不依赖 DOM(controller 只用 fetch/AbortController/TextDecoder,Node ≥18 即可跑)。
 *
 * 运行:先 `npm run build`,再 `node test/controller.test.mjs`。
 */
import assert from 'node:assert/strict'
import {
  createOptimizerController,
  extractContextTurns,
  shouldAutoClose,
  splitCommandPrefix,
  MANUAL_PROMPT_TYPES,
  TYPE_OPTIONS,
} from '../lib/controller.js'
import { PROMPT_TYPES } from '../lib/core/classify.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = new TextEncoder()

/**
 * 构造最小可用的 ClientContext mock。
 * - modelDirectories:官方会话模型目录服务(controller 读取 current 作为会话模型),
 *   `noModelDirectories: true` 时整体缺席,验证回退路径。
 * - connection.api.sessions.history:旧版查询面(上游从未提供,插件按可选面调用),
 *   调用次数可通过 returned.stats 观察。
 */
function makeCtx({ historyImpl, noModelDirectories } = {}) {
  const stats = { modelDirCalls: 0, historyCalls: 0 }
  const ctx = {}
  if (!noModelDirectories) {
    ctx.modelDirectories = {
      directoryFor: () => ({
        load: async () => {
          stats.modelDirCalls += 1
          return {
            current: { provider: 'sess-p', model: 'sess-m' },
            groups: [],
            status: 'ready',
            error: null,
          }
        },
      }),
    }
  }
  ctx.connection = {
    api: {
      sessions: {
        history: async () => {
          stats.historyCalls += 1
          if (historyImpl) return historyImpl()
          return {
            ok: true,
            value: {
              hasMore: false,
              events: [
                { event: { type: 'user/message', seq: 0, time: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我写个周报' }] } } },
                { event: { type: 'assistant/message', seq: 1, time: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的,本周做了哪些事?' }] } } } },
                // 插件注入的 user 角色消息应被排除
                { event: { type: 'user/message', seq: 2, time: 3, data: { role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: '注入内容' }] } } },
                // 空壳 assistant 消息(仅承载 usage)应被跳过
                { event: { type: 'assistant/message', seq: 3, time: 4, data: { message: { role: 'assistant', content: [] } } } },
                // 工具事件与上下文无关
                { event: { type: 'tool/result', seq: 4, time: 5, data: { message: { role: 'user', content: [{ type: 'text', text: '工具结果' }] } } } },
              ],
            },
          }
        },
      },
    },
  }
  return { ctx, stats }
}

/** 把事件对象列表编码成 SSE Response。 */
function sseResponse(events) {
  const stream = new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 替换全局 fetch 跑一个用例;impl 收到 (body, signal)。 */
async function withFetch(impl, fn) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ body, signal: init.signal })
    return impl(body, init.signal)
  }
  try {
    await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

const DONE = {
  type: 'done',
  analysis: '分析内容',
  optimized: '优化后的提示词',
  wellFormed: true,
  truncated: false,
  provider: 'p',
  model: 'm',
  fallbackUsed: false,
}

// c1. 完整流式:delta → done,状态与结果字段正确
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  await withFetch(
    () => sseResponse([{ type: 'delta', text: '<<<ANALYSIS>>>\n分析内容\n' }, DONE]),
    async () => {
      await c.optimize('  草稿  ', 's1')
      const s = c.getSnapshot()
      assert.equal(s.status, 'done')
      assert.equal(s.result.optimized, '优化后的提示词')
      assert.equal(s.result.provider, 'p')
      assert.equal(typeof s.result.durationMs, 'number', 'done 应记录客户端实测耗时')
      assert.equal(s.live, null, 'done 后 live 应清空')
      assert.equal(s.last.text, '草稿', 'last 应存 trim 后的草稿')
      assert.equal(s.last.sessionId, 's1')
    },
  )
  console.log('✓ c1 完整流式 → done')
}

// c2. 合帧节流:delta 后 live 不立即更新,约 50ms 后合帧落一次
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  let sc
  const stream = new ReadableStream({ start(ctrl) { sc = ctrl } })
  await withFetch(
    () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    async () => {
      const pending = c.optimize('草稿', 's1')
      await sleep(0) // 让 optimize 推进到 fetch
      sc.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'delta', text: '<<<OPTIMIZED>>>\n第一段' })}\n\n`))
      assert.equal(c.getSnapshot().live?.optimized ?? '', '', 'delta 后不应同步落帧')
      await sleep(80)
      assert.equal(c.getSnapshot().live.optimized, '第一段', '合帧后 live 应可见')
      sc.enqueue(enc.encode(`data: ${JSON.stringify(DONE)}\n\n`))
      sc.close()
      await pending
      assert.equal(c.getSnapshot().status, 'done')
      assert.equal(c.getSnapshot().live, null)
    },
  )
  console.log('✓ c2 合帧节流')
}

// c3. SSE error 事件 → status error
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  await withFetch(
    () => sseResponse([{ type: 'error', error: '模型调用失败(AUTH): bad key' }]),
    async () => {
      await c.optimize('草稿', 's1')
      assert.equal(c.getSnapshot().status, 'error')
      assert.match(c.getSnapshot().error, /bad key/)
    },
  )
  console.log('✓ c3 error 事件')
}

// c4. 预校验失败(非 SSE,JSON 409)→ status error
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  await withFetch(
    () => new Response(JSON.stringify({ ok: false, error: '未找到可用模型' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }),
    async () => {
      await c.optimize('草稿', 's1')
      assert.equal(c.getSnapshot().status, 'error')
      assert.match(c.getSnapshot().error, /未找到可用模型/)
    },
  )
  console.log('✓ c4 预校验 JSON 错误')
}

// c5. 流结束但无终态事件 → 连接中断
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  await withFetch(
    () => sseResponse([{ type: 'delta', text: '半截' }]),
    async () => {
      await c.optimize('草稿', 's1')
      assert.equal(c.getSnapshot().status, 'error')
      assert.match(c.getSnapshot().error, /连接中断/)
    },
  )
  console.log('✓ c5 连接中断检测')
}

// c6. 设置固定模型时跳过会话模型查询 RPC
{
  const { ctx, stats } = makeCtx()
  const c = createOptimizerController(ctx, { isModelPinned: () => true, getSessionModelDirectories: () => ctx.modelDirectories })
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('草稿', 's1')
      assert.equal(stats.modelDirCalls, 0, '固定模型时不应查询会话模型目录')
      assert.equal(calls[0].body.provider, undefined, 'body 不带会话模型,交给 Host 固定值')
      assert.equal(c.getSnapshot().status, 'done')
    },
  )
  console.log('✓ c6 固定模型跳过 RPC')
}

// c6b. 跟随会话:目录服务的 current 随请求发出(provider/model)
{
  const { ctx, stats } = makeCtx()
  const c = createOptimizerController(ctx, { getSessionModelDirectories: () => ctx.modelDirectories })
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('草稿', 's1')
      assert.equal(stats.modelDirCalls, 1, '默认应查询一次会话模型目录')
      assert.equal(calls[0].body.provider, 'sess-p', 'body 带会话当前 provider')
      assert.equal(calls[0].body.model, 'sess-m', 'body 带会话当前 model')
      assert.equal(c.getSnapshot().status, 'done')
    },
  )
  console.log('✓ c6b 跟随会话模型随请求发出')
}

// c6c. 会话模型目录服务缺席(旧版宿主):回退到 Host 解析,请求不带会话模型
{
  const { ctx } = makeCtx({ noModelDirectories: true })
  const c = createOptimizerController(ctx)
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('草稿', 's1')
      assert.equal(calls[0].body.provider, undefined, '服务缺席时 body 不带会话模型')
      assert.equal(calls[0].body.model, undefined, '服务缺席时 body 不带会话模型 id')
      assert.equal(c.getSnapshot().status, 'done', '缺席只降级,不阻塞主流程')
    },
  )
  console.log('✓ c6c 模型目录服务缺席回退')
}

// c7. 撤回状态流转:markApplied → clearApplied → close 复位
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  await withFetch(
    () => sseResponse([DONE]),
    async () => {
      await c.optimize('草稿', 's1')
      c.markApplied({ backup: '原文', text: '优化后的提示词' })
      assert.deepEqual(c.getSnapshot().applied, { backup: '原文', text: '优化后的提示词' })
      c.clearApplied()
      assert.equal(c.getSnapshot().applied, null)
      c.markApplied({ backup: '原文', text: '优化后的提示词' })
      c.close()
      assert.equal(c.getSnapshot().applied, null, 'close 应复位 applied')
      assert.equal(c.getSnapshot().open, false)
      assert.equal(c.getSnapshot().status, 'idle')
    },
  )
  console.log('✓ c7 撤回状态流转')
}

// c8. retry 复用 last(同一份草稿重新发起)
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('我的草稿', 's1')
      c.retry()
      await sleep(10)
      assert.equal(calls.length, 2)
      assert.equal(calls[1].body.text, '我的草稿')
    },
  )
  console.log('✓ c8 retry 复用 last')
}

// c9. 进行中的请求被 close 中止:状态复位,不残留 loading
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  await withFetch(
    (_body, signal) =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            signal.addEventListener('abort', () => ctrl.close())
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    async () => {
      const pending = c.optimize('草稿', 's1')
      await sleep(0)
      assert.equal(c.getSnapshot().status, 'loading')
      c.close()
      await pending
      assert.equal(c.getSnapshot().status, 'idle', 'close 后不得残留 loading')
      assert.equal(c.getSnapshot().open, false)
    },
  )
  console.log('✓ c9 close 中止进行中请求')
}

// c10. 会话历史 → 上下文随请求发出:真实用户输入 + 助手回复;插件注入/空壳/工具事件被过滤
{
  const { ctx, stats } = makeCtx()
  const c = createOptimizerController(ctx)
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('草稿', 's1')
      assert.equal(stats.historyCalls, 1, '默认应拉取一次会话历史')
      assert.deepEqual(calls[0].body.context, [
        { role: 'user', text: '帮我写个周报' },
        { role: 'assistant', text: '好的,本周做了哪些事?' },
      ])
      assert.equal(c.getSnapshot().status, 'done')
    },
  )
  console.log('✓ c10 上下文随请求发出')
}

// c11. 会话历史查询失败:静默降级为无上下文,主流程不受影响
{
  const { ctx } = makeCtx({
    historyImpl: async () => {
      throw new Error('rpc boom')
    },
  })
  const c = createOptimizerController(ctx)
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('草稿', 's1')
      assert.equal(calls[0].body.context, undefined, '历史失败时应无上下文')
      assert.equal(c.getSnapshot().status, 'done')
    },
  )
  console.log('✓ c11 历史查询失败降级')
}

// c12. 设置关闭「携带上下文」:跳过历史查询,请求不带 context
{
  const { ctx, stats } = makeCtx()
  const c = createOptimizerController(ctx, { isContextEnabled: () => false })
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('草稿', 's1')
      assert.equal(stats.historyCalls, 0, '关闭时不应查询会话历史')
      assert.equal(calls[0].body.context, undefined)
      assert.equal(c.getSnapshot().status, 'done')
    },
  )
  console.log('✓ c12 关闭上下文跳过查询')
}

// c13. 斜杠命令前缀拆分:只优化正文,前缀记入 last;路径与普通文本不拆;
//      O11:只有命令没有正文时直接落提示态、不发请求
{
  assert.deepEqual(splitCommandPrefix('/goal 帮我写个目标'), { prefix: '/goal', body: '帮我写个目标' })
  assert.deepEqual(splitCommandPrefix('/goal'), { body: '/goal', commandOnly: true }, '只敲命令没有正文时标记 commandOnly')
  assert.deepEqual(splitCommandPrefix('/path/to/file 帮我看看'), { body: '/path/to/file 帮我看看' }, '路径不是命令')
  assert.deepEqual(splitCommandPrefix('  普通草稿  '), { body: '普通草稿' })

  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)

  // O11:commandOnly → 提示态且零网络请求
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('/goal', 's1')
      assert.equal(c.getSnapshot().status, 'error')
      assert.match(c.getSnapshot().error, /正文/)
      assert.equal(calls.length, 0, '只有命令没有正文不应发出网络请求')
    },
  )

  // 正常路径:只发正文,last 记住前缀供替换时拼回
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('/goal 帮我写个请假条', 's1')
      assert.equal(calls[0].body.text, '帮我写个请假条', '发给 Host 的应只有正文')
      assert.equal(c.getSnapshot().last.prefix, '/goal', 'last 应记住前缀供替换时拼回')
    },
  )
  console.log('✓ c13 斜杠命令前缀')
}

// c14. 轻量记忆链:同会话改稿再优化带上轮结果;同文 retry / 首轮不带
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('原始草稿', 's1')
      assert.equal(calls[0].body.previous, undefined, '首轮不带 previous')
      // 同文 retry:重新生成,不是迭代
      c.retry()
      await sleep(10)
      assert.equal(calls[1].body.previous, undefined, '同文 retry 不带 previous')
      // 用户在优化产物上修改后再优化:带上一轮结果
      await c.optimize('优化后的提示词,再补上对空输入的处理', 's1')
      assert.equal(calls[2].body.previous, '优化后的提示词', '改稿再优化应带上轮结果')
      // 换会话:不带
      await c.optimize('另一会话的草稿', 's2')
      assert.equal(calls[3].body.previous, undefined, '跨会话不带 previous')
    },
  )
  console.log('✓ c14 轻量记忆链')
}

// c15. 记忆链门槛:上轮格式退化(wellFormed=false)或关闭「携带上下文」时不带 previous
{
  const DEGRADED = { ...DONE, wellFormed: false }
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  await withFetch(
    () => sseResponse([DEGRADED]),
    async (calls) => {
      await c.optimize('原始草稿', 's1')
      await c.optimize('改过的草稿', 's1')
      assert.equal(calls[1].body.previous, undefined, '格式退化的上轮结果不得进入记忆链')
    },
  )
  const off = createOptimizerController(makeCtx().ctx, { isContextEnabled: () => false })
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await off.optimize('原始草稿', 's1')
      await off.optimize('改过的草稿', 's1')
      assert.equal(calls[1].body.previous, undefined, '关闭携带上下文后不带 previous')
    },
  )
  console.log('✓ c15 记忆链门槛')
}

// c16. 发送即关闭判定(纯函数):草稿清空 / running 翻转 / 入队;loading 与未打开不关
{
  const base = { open: true, status: 'done', draft: '还有内容', prevRunning: false, running: false, prevQueued: 0, queued: 0 }
  assert.equal(shouldAutoClose(base), false, '无信号时不关')
  assert.equal(shouldAutoClose({ ...base, draft: '' }), true, '草稿清空应关')
  assert.equal(shouldAutoClose({ ...base, draft: '   ' }), true, '草稿只剩空白应关')
  assert.equal(shouldAutoClose({ ...base, running: true }), true, 'running 翻转应关')
  assert.equal(shouldAutoClose({ ...base, prevRunning: true, running: true }), false, 'running 持续为真不算翻转')
  assert.equal(shouldAutoClose({ ...base, queued: 1 }), true, '入队应关')
  assert.equal(shouldAutoClose({ ...base, queued: 1, prevQueued: 1 }), false, '队列长度没变不关')
  assert.equal(shouldAutoClose({ ...base, status: 'loading', draft: '' }), false, '优化中不关')
  assert.equal(shouldAutoClose({ ...base, open: false, draft: '' }), false, '未打开不关')
  console.log('✓ c16 发送即关闭判定')
}

// c17. 上下文取样:agentic 会话(assistant 碎片远多于用户消息)中用户消息保底 4 条
{
  const ev = (type, i, role, text, kind = 'user') => ({
    event: {
      type,
      seq: i,
      time: i,
      data: type === 'user/message' ? { role, source: { kind }, content: [{ type: 'text', text }] } : { message: { role, content: [{ type: 'text', text }] } },
    },
  })
  // 12 条:u1 a1 a2 a3 u2 a4 a5 u3 a6 a7 u4 a8(纯按时间取最近 8 条会丢掉 u1 u2)
  const events = [
    ev('user/message', 0, 'user', '第一个需求'),
    ev('assistant/message', 1, 'assistant', '步骤一'),
    ev('assistant/message', 2, 'assistant', '步骤二'),
    ev('assistant/message', 3, 'assistant', '步骤三'),
    ev('user/message', 4, 'user', '第二个需求'),
    ev('assistant/message', 5, 'assistant', '步骤四'),
    ev('assistant/message', 6, 'assistant', '步骤五'),
    ev('user/message', 7, 'user', '第三个需求'),
    ev('assistant/message', 8, 'assistant', '步骤六'),
    ev('assistant/message', 9, 'assistant', '步骤七'),
    ev('user/message', 10, 'user', '第四个需求'),
    ev('assistant/message', 11, 'assistant', '步骤八'),
  ]
  const turns = extractContextTurns(events)
  const userTexts = turns.filter((t) => t.role === 'user').map((t) => t.text)
  assert.deepEqual(userTexts, ['第一个需求', '第二个需求', '第三个需求', '第四个需求'], '全部 4 条用户消息必须保底')
  assert.ok(turns.length <= 8, '总量不超 8 条')
  assert.ok(turns[0].text === '第一个需求' && turns.at(-1).text === '步骤八', '保持原始时间顺序')
  console.log('✓ c17 上下文取样用户消息保底')
}

// c18. O2 取消:loading 中 cancel() 中止请求但保留已生成部分,面板定格
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  let sc
  await withFetch(
    (_body, signal) =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            sc = ctrl
            signal.addEventListener('abort', () => ctrl.close())
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    async () => {
      const pending = c.optimize('草稿', 's1')
      await sleep(0)
      sc.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'delta', text: '<<<OPTIMIZED>>>\n第一段' })}\n\n`))
      await sleep(80) // 等合帧落一次
      c.cancel()
      await pending
      const s = c.getSnapshot()
      assert.equal(s.status, 'cancelled', '取消后应进入 cancelled 态(而非 idle/error)')
      assert.equal(s.open, true, '面板保持打开,展示已生成部分')
      assert.equal(s.live?.optimized, '第一段', '已生成的流式内容应保留')
      // 取消后可关闭复位
      c.close()
      assert.equal(c.getSnapshot().status, 'idle')
      assert.equal(c.getSnapshot().live, null)
    },
  )
  console.log('✓ c18 cancel 保留已生成部分')
}

// c19. done/error 后再按 Esc 是 close;cancel 仅在 loading 生效
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  await withFetch(
    () => sseResponse([DONE]),
    async () => {
      await c.optimize('草稿', 's1')
      assert.equal(c.getSnapshot().status, 'done')
      c.cancel() // 非 loading 态,cancel 应为 no-op
      assert.equal(c.getSnapshot().status, 'done', '非 loading 时 cancel 不改变状态')
    },
  )
  console.log('✓ c19 cancel 仅在 loading 生效')
}

// c20. R21 客户端看门狗:Host 挂死(流永不结束也不响应事件)时超时落 error
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx, { getWatchdogMs: () => 1_200 })
  await withFetch(
    (_body, signal) =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            signal.addEventListener('abort', () => ctrl.close())
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    async () => {
      const pending = c.optimize('草稿', 's1')
      await pending
      const s = c.getSnapshot()
      assert.equal(s.status, 'error', '看门狗应把挂死请求落为 error')
      assert.match(s.error, /请求超时/)
      assert.equal(s.live, null)
    },
  )
  console.log('✓ c20 客户端超时看门狗')
}

// c21. 快速模式无标记模型:原始流实时预览;缓冲出现「<<<」时不兜底(防半个标记闪现)
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx, { isFastMode: () => true })
  let sc
  const stream = new ReadableStream({ start(ctrl) { sc = ctrl } })
  await withFetch(
    () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    async () => {
      const pending = c.optimize('草稿', 's1')
      await sleep(0)
      // 无标记 delta:应直接作为优化稿实时预览
      sc.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'delta', text: '第一段优化内容' })}\n\n`))
      await sleep(80)
      assert.equal(c.getSnapshot().live?.optimized, '第一段优化内容', '无标记流应实时预览')
      // 出现半个标记:兜底让位,不把「<<<OPT」闪进预览
      sc.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'delta', text: ',<<<OPT' })}\n\n`))
      await sleep(80)
      assert.equal(c.getSnapshot().live?.optimized ?? '', '', '标记形成中不得兜底预览')
      // 标记完成:恢复正常解析
      sc.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'delta', text: 'IMIZED>>>\n正式内容' })}\n\n`))
      await sleep(80)
      assert.equal(c.getSnapshot().live?.optimized, '正式内容', '标记完成后回到正常解析')
      sc.enqueue(enc.encode(`data: ${JSON.stringify(DONE)}\n\n`))
      sc.close()
      await pending
      assert.equal(c.getSnapshot().status, 'done')
    },
  )
  console.log('✓ c21 快速模式无标记实时预览')
}

// c22. 任务类型 / 置信度 / 四组 provenance:meta 先落盘,done 结构化
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  const META = {
    type: 'meta',
    prompt_type: 'research',
    confidence_level: 'High',
    missing_constraints: [{ id: 'mc-1', label: '期望时长' }],
    rationale: '研究诉求',
    provenance_ok: true,
  }
  const DONE_R = {
    ...DONE,
    prompt_type: 'research',
    confidence_level: 'High',
    diagnosis: '诊断',
    explicit_requirements: [{ id: 'r-1', text: '研究目标', source: 'USER_EXPLICIT', evidence: ['帮我研究'], confidence: 'high' }],
    context_requirements: [],
    suggested_requirements: [{ id: 'r-2', text: '补充时长', source: 'OPTIMIZER_SUGGESTED', evidence: [], confidence: 'medium' }],
    unknowns: [{ id: 'r-3', text: '时长', source: 'UNKNOWN', evidence: [], confidence: 'low' }],
    missing_constraints: [{ id: 'mc-1', label: '期望时长' }],
    strategy_version: '0.1.4',
    provenance_ok: true,
  }
  await withFetch(
    () => sseResponse([META, { type: 'delta', text: '<<<OPTIMIZED>>>\n优化稿' }, DONE_R]),
    async () => {
      await c.optimize('草稿', 's1')
      const s = c.getSnapshot()
      assert.equal(s.status, 'done')
      assert.equal(s.meta.promptType, 'research', 'meta 应落盘类型')
      assert.equal(s.meta.confidenceLevel, 'High')
      assert.equal(s.result.promptType, 'research')
      assert.equal(s.result.confidenceLevel, 'High')
      assert.equal(s.result.provenanceOk, true)
      assert.equal(s.result.explicitRequirements.length, 1)
      assert.equal(s.result.suggestedRequirements[0].source, 'OPTIMIZER_SUGGESTED')
      assert.equal(s.result.unknowns.length, 1)
      assert.equal(s.result.missingConstraints[0].label, '期望时长')
      assert.equal(s.result.strategyVersion, '0.1.4')
    },
  )
  console.log('✓ c22 meta + 四组 provenance 落盘')
}

// c23. AUTO 下拉:选项集完整且顺序固定;auto 不发 promptType;手动覆盖随请求发出并跨 close 保留
{
  // 选项集是「AUTO + 六个真实类型」:general 是 AUTO 兜底,契约上不进下拉。
  assert.equal(TYPE_OPTIONS[0], 'auto', 'AUTO 必须排在下拉首位')
  assert.deepEqual(TYPE_OPTIONS.slice(1), [...MANUAL_PROMPT_TYPES], '手动项应与 MANUAL_PROMPT_TYPES 一致')
  assert.deepEqual(
    [...MANUAL_PROMPT_TYPES],
    PROMPT_TYPES.filter((t) => t !== 'general'),
    '下拉手动项必须覆盖除 general 外的全部 PromptType(与 classify 闭集对齐)',
  )
  assert.equal(new Set(TYPE_OPTIONS).size, TYPE_OPTIONS.length, '下拉取值不得重复')
  assert.equal(TYPE_OPTIONS.includes('general'), false, 'general 兜底类型不得出现在下拉里')

  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  assert.equal(c.getSnapshot().typeSelection, 'auto', '默认应为 AUTO')
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('草稿', 's1')
      assert.equal(calls[0].body.promptType, undefined, 'auto 不应携带 promptType')
    },
  )
  c.setTypeSelection('research')
  assert.equal(c.getSnapshot().typeSelection, 'research')
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('草稿', 's1')
      assert.equal(calls[0].body.promptType, 'research', '手动覆盖应随请求发出')
      c.close()
      assert.equal(c.getSnapshot().typeSelection, 'research', 'close 后保留下拉选择')
    },
  )
  console.log('✓ c23 AUTO 下拉 / 手动覆盖')
}

// c24. 每种手动类型都可直达请求体;「重新优化」沿用所选类型;切回 AUTO 后不再携带
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)

  // 逐个手动类型:选择 → 优化 → 请求体携带该类型
  for (const type of MANUAL_PROMPT_TYPES) {
    c.setTypeSelection(type)
    assert.equal(c.getSnapshot().typeSelection, type, `选择 ${type} 后 state 应立即生效`)
    await withFetch(
      () => sseResponse([DONE]),
      async (calls) => {
        await c.optimize(`${type} 草稿`, 's1')
        assert.equal(calls[0].body.promptType, type, `${type} 应随请求发出`)
      },
    )
  }

  // 重新优化(retry)沿用「当前」所选类型,而不是首轮使用的类型
  c.setTypeSelection('planning')
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('规划草稿', 's1')
      assert.equal(calls[0].body.promptType, 'planning', '首轮携带所选类型')
      c.setTypeSelection('diagnostic')
      c.retry()
      await sleep(10)
      assert.equal(calls.length, 2, 'retry 应重新发起一次请求')
      assert.equal(calls[1].body.promptType, 'diagnostic', '重新优化沿用当前所选类型')
      assert.equal(calls[1].body.text, '规划草稿', 'retry 复用同一草稿')
    },
  )

  // 切回 AUTO:后续请求不再携带 promptType(回到分类器路径)
  c.setTypeSelection('auto')
  await withFetch(
    () => sseResponse([DONE]),
    async (calls) => {
      await c.optimize('草稿', 's1')
      assert.equal(calls[0].body.promptType, undefined, '切回 AUTO 后不应携带 promptType')
    },
  )
  console.log('✓ c24 各手动类型 + 重新优化沿用所选')
}

// c25. P06-T02:ResultDock 四组渲染所依赖的数据面——
// 诊断 / WORKSPACE_FACT 来源标记 / 无证据条目降级依据 / 缺口清单与 unknowns 分离 /
// Low 提示触发 / provenance_ok=false 警示 + 替换·撤回状态机不受影响(回归)。
{
  const { ctx } = makeCtx()
  const c = createOptimizerController(ctx)
  const META_LOW = {
    type: 'meta',
    prompt_type: 'planning',
    confidence_level: 'Low',
    missing_constraints: [{ id: 'mc-1', label: '输出格式', reason: '决定交付形态' }],
    rationale: '疑似规划兼执行',
    provenance_ok: true,
  }
  const DONE_LOW = {
    ...DONE,
    prompt_type: 'planning',
    confidence_level: 'Low',
    // analysis 兼容字段与 diagnosis 同源;诊断段消费 diagnosis(缺省回落 analysis)。
    diagnosis: '目标清晰,但未给出输出格式',
    explicit_requirements: [
      { id: 'r-1', text: '整理一份清单', source: 'USER_EXPLICIT', evidence: ['整理一份清单'], confidence: 'high' },
      // 无逐字证据的 explicit 条目:UI 需「缺证据」降级展示(provenance_ok=false 的对应物)。
      { id: 'r-2', text: '顺带补一个无证据要求', source: 'USER_EXPLICIT', evidence: [], confidence: 'low' },
    ],
    context_requirements: [
      // WORKSPACE_FACT 是确定性事实:无 quote 但不算缺证据;UI 需标来源。
      { id: 'r-3', text: '工作区名为 demo', source: 'WORKSPACE_FACT', evidence: [], confidence: 'high' },
      { id: 'r-4', text: '上文确认的约束', source: 'CONTEXT_EXPLICIT', evidence: ['之前说的'], confidence: 'medium' },
    ],
    suggested_requirements: [
      { id: 'r-5', text: '补充验收标准', source: 'OPTIMIZER_SUGGESTED', evidence: [], confidence: 'medium' },
    ],
    // unknowns 与缺口清单必须能同时存在,互不遮蔽。
    unknowns: [{ id: 'r-6', text: '[待补充: 检索范围]', source: 'UNKNOWN', evidence: [], confidence: 'low' }],
    missing_constraints: [{ id: 'mc-1', label: '输出格式', reason: '决定交付形态' }],
    provenance_ok: false,
  }
  await withFetch(
    () => sseResponse([META_LOW, { type: 'delta', text: '<<<OPTIMIZED>>>\n优化稿' }, DONE_LOW]),
    async () => {
      await c.optimize('草稿', 's1')
      const s = c.getSnapshot()
      assert.equal(s.status, 'done')
      // Low 提示:meta(loading 期)与 done 两处都必须能触发黄条。
      assert.equal(s.meta.confidenceLevel, 'Low', 'meta 低置信度应落盘')
      assert.equal(s.result.confidenceLevel, 'Low', 'done 低置信度应落盘')
      // 诊断段:优先取 done.diagnosis。
      assert.equal(s.result.diagnosis, '目标清晰,但未给出输出格式')
      // 四组渲染数据齐备且各自独立。
      assert.equal(s.result.explicitRequirements.length, 2)
      assert.equal(s.result.contextRequirements.length, 2)
      assert.equal(s.result.suggestedRequirements.length, 1)
      assert.equal(s.result.unknowns.length, 1)
      // 来源标记:WORKSPACE_FACT 必须原样透传到 UI 侧。
      assert.equal(s.result.contextRequirements[0].source, 'WORKSPACE_FACT')
      assert.equal(s.result.contextRequirements[1].source, 'CONTEXT_EXPLICIT')
      // 降级展示依据:explicit 无证据条目 evidence 为空。
      assert.deepEqual(s.result.explicitRequirements[1].evidence, [])
      // 缺口清单与 unknowns 分离:unknowns 非空时 missing 仍完整保留。
      assert.equal(s.result.missingConstraints.length, 1)
      assert.equal(s.result.missingConstraints[0].label, '输出格式')
      assert.equal(s.result.missingConstraints[0].reason, '决定交付形态')
      // provenance_ok=false → UI 顶部警示。
      assert.equal(s.result.provenanceOk, false)
      // 替换/撤回回归:provenance 失败不阻塞替换,撤回依据保持纯状态机语义。
      c.markApplied({ backup: '草稿', text: '优化稿' })
      assert.deepEqual(c.getSnapshot().applied, { backup: '草稿', text: '优化稿' })
      c.clearApplied()
      assert.equal(c.getSnapshot().applied, null)
      assert.equal(c.getSnapshot().status, 'done', '撤回后结果面板仍在')
    },
  )
  console.log('✓ c25 四组渲染数据 + 缺口清单分离 + Low 提示 + provenance 警示 + 替换/撤回回归')
}

console.log('\ncontroller: all passed')
