/**
 * Host 半冒烟测试:真实 cordis Context + mock 的 llm/httpServer 服务,
 * 直接驱动插件注册的 HTTP handler,覆盖成功、错误与边界路径。
 *
 * 运行:先 `npm run build`,再 `node test/smoke.mjs`。
 */
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { isMetaAnalysisCall } from '../lib/core/analyze.js'

// Phase 4:general 已迁入 v2 契约,兜底路径同样使用四段协议(不再走 legacy ANALYSIS 格式)
const CANNED = [
  '<<<DIAGNOSIS>>>',
  '目标清晰度 | 目标模糊 | 明确产出物',
  '<<<EXPLICIT>>>',
  // 中性:不带 quote(共享 fixture 会被多个不同输入复用;伪造 quote 会被 Validator 回流)
  '(无)',
  '<<<CONTEXT>>>',
  '(无)',
  '<<<SUGGESTED>>>',
  '(无)',
  '<<<UNKNOWN>>>',
  '(无)',
  '<<<OPTIMIZED>>>',
  // v0.2.0-apo:PATCH 行为不变量要求保留原始语义单元且不得重建骨架,
  // 因此这里的产物是「原结构内局部补强」形态(仍含「资深代码评审」以覆盖既有断言)。
  '- 你是一名资深代码评审,请帮我看看这段代码。',
  '- 约束:只检查,不修改文件。',
  '- 输出格式:问题清单(Markdown)。',
  '<<<END>>>',
].join('\n')

function makeReq(body, method = 'POST', headers) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = method
  req.headers = headers ?? {}
  return req
}

/** 调用插件注册的 handler 并收集响应。raw 为字符串时按原样发送(用于畸形 JSON 用例);headers 供来源围栏用例透传。 */
async function call(handler, body, method, headers) {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    on() {},
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
      return res
    },
    write(chunk) {
      res.body += chunk
      return true
    },
    end(payload) {
      if (payload) res.body += payload
      res.writableEnded = true
    },
  }
  const req =
    typeof body === 'string'
      ? Object.assign(Readable.from([body]), { method: method ?? 'POST', headers: headers ?? {} })
      : makeReq(body, method, headers)
  await handler(req, res)
  return res
}

/** 解析 SSE 响应体中的全部事件帧。 */
function sseEvents(res) {
  return res.body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      return line ? JSON.parse(line.slice(5).trim()) : null
    })
    .filter(Boolean)
}

/** 成功响应(200 + SSE)中的 done 事件,等价于改版前的 JSON body。 */
function doneOf(res) {
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /text\/event-stream/)
  const done = sseEvents(res).find((e) => e.type === 'done')
  assert.ok(done, '应收到 done 事件')
  return done
}

async function setup({ config = {}, llmOverrides = {} } = {}) {
  const routes = {}
  let lastOptions = null
  const ctx = new Context()
  ctx.provide('httpServer', {
    register(r) {
      routes[r.path] = r
      return () => {}
    },
  })
  ctx.provide('llm', {
    async *stream(options) {
      lastOptions = options
      // v0.2.0-apo:PATCH 行为不变量要求产物保留原始语义单元。
      // 共享 fixture 被多个不同输入复用 → 把**用户草稿行**并入 OPTIMIZED 段,
      // 使产物对任何输入都满足「原始要求未被删除」(KEEP 路径不调用编译,不受影响)。
      const lastUser = [...(options.messages ?? [])].reverse().find((m) => m.role === 'user')
      const rawText = Array.isArray(lastUser?.content)
        ? lastUser.content.map((c) => c.text ?? '').join('\n')
        : String(lastUser?.content ?? '')
      const draftLines = rawText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^[<#`]/.test(l) && !/^(?:原始输入|用户输入|上下文|conversation-context|\/)/i.test(l))
        .slice(-6)
      const [head, ...tail] = CANNED.split('\n')
      const endIdx = tail.lastIndexOf('<<<END>>>')
      const body = endIdx >= 0 ? tail.slice(0, endIdx) : tail
      for (const line of head ? [head] : []) yield { type: 'text-delta', index: 0, text: line + '\n' }
      for (const line of body) yield { type: 'text-delta', index: 0, text: line + '\n' }
      for (const line of draftLines) yield { type: 'text-delta', index: 0, text: '- ' + line + '\n' }
      yield { type: 'text-delta', index: 0, text: '<<<END>>>\n' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek 官方' }],
    listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    ...llmOverrides,
  })
  await ctx.plugin(plugin, { ...config, v3: false })  // 旧多阶段路径测试:显式选择 legacy
  assert.ok(routes['/dsh-prompt-optimizer/optimize'], '插件应注册优化路由')
  assert.ok(routes['/dsh-prompt-optimizer/test-model'], '插件应注册测试路由')
  return {
    ctx,
    handler: routes['/dsh-prompt-optimizer/optimize'].handler,
    testHandler: routes['/dsh-prompt-optimizer/test-model'].handler,
    getOptions: () => lastOptions,
  }
}

// 1. 正常路径:分析 + 优化结果按标记解析
{
  const { handler } = await setup()
  // RC2:模糊目标会先进入 Discovery;基础路径用已明确输入(有约束/输出格式)
  const res = await call(handler, { text: '帮我看看这段代码。约束:只检查,不修改文件;输出格式:问题清单。', provider: 'session-p', model: 'session-m' })
  const data = doneOf(res)
  assert.ok(sseEvents(res).some((e) => e.type === 'delta'), '应先推送 delta 事件')
  assert.match(data.analysis, /目标清晰度/)
  assert.match(data.optimized, /资深代码评审/)
  assert.ok(!data.optimized.includes('ANALYSIS'), 'optimized 不应包含标记内容')
  assert.equal(data.provider, 'session-p')
  assert.equal(data.model, 'session-m')
  console.log('✓ 1 正常路径')
}

// 2. 设置里固定模型('provider/model')覆盖会话模型
{
  const { handler } = await setup({ config: { model: 'cfg-p/cfg-m' } })
  const res = await call(handler, { text: 'x', provider: 'session-p', model: 'session-m' })
  const data = doneOf(res)
  assert.equal(data.provider, 'cfg-p')
  assert.equal(data.model, 'cfg-m')
  console.log('✓ 2 设置固定模型优先')
}

// 2b. 回归:配置字段为空字符串时必须视为未设置(而不是错落到首个路由)
{
  const { handler } = await setup({ config: { model: '' } })
  const res = await call(handler, { text: 'x', provider: 'session-p', model: 'session-m' })
  const data = doneOf(res)
  assert.equal(data.provider, 'session-p')
  assert.equal(data.model, 'session-m')
  console.log('✓ 2b 空字符串配置视为未设置')
}

// 2c. 回归:固定值缺少 '/' 分隔时视为未配置,回落到会话选择
{
  const { handler } = await setup({ config: { model: 'cfg-p-only' } })
  const res = await call(handler, { text: 'x', provider: 'session-p', model: 'session-m' })
  const data = doneOf(res)
  assert.equal(data.provider, 'session-p')
  assert.equal(data.model, 'session-m')
  console.log('✓ 2c 畸形固定值回落会话')
}

// 3. 会话与设置都没给模型时,回退到第一个可用路由
{
  const { handler } = await setup()
  const res = await call(handler, { text: 'x' })
  const data = doneOf(res)
  assert.equal(data.provider, 'deepseek-official')
  assert.equal(data.model, 'deepseek-chat')
  console.log('✓ 3 回退到首个可用路由')
}

// 4. 完全无可用模型 → 409
{
  const { handler } = await setup({
    llmOverrides: { listProviders: () => [], listModels: async () => [] },
  })
  const res = await call(handler, { text: 'x' })
  assert.equal(res.status, 409)
  assert.equal(JSON.parse(res.body).ok, false)
  console.log('✓ 4 无模型 → 409')
}

// 5. 空文本 → 400;GET → 405
{
  const { handler } = await setup()
  const a = await call(handler, { text: '   ' })
  assert.equal(a.status, 400)
  const b = await call(handler, undefined, 'GET')
  assert.equal(b.status, 405)
  console.log('✓ 5 参数与方法校验')
}

// 5b. 畸形 JSON → 400;超大请求体 → 413(不再是笼统的 502)
{
  const { handler } = await setup()
  const bad = await call(handler, '{not json')
  assert.equal(bad.status, 400)
  assert.match(JSON.parse(bad.body).error, /JSON/)
  const big = await call(handler, JSON.stringify({ text: 'x'.repeat(300 * 1024) }))
  assert.equal(big.status, 413)
  console.log('✓ 5b 畸形 JSON → 400,超大请求体 → 413')
}

// 6. 模型终态错误 → SSE error 事件(进入流式阶段后无法再改状态码)
{
  const { handler } = await setup({
    llmOverrides: {
      async *stream() {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'API key is invalid' } } }
      },
    },
  })
  const res = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  assert.equal(res.status, 200)
  const err = sseEvents(res).find((e) => e.type === 'error')
  assert.ok(err, '应收到 error 事件')
  assert.match(err.error, /API key is invalid/)
  console.log('✓ 6 模型错误 → SSE error 事件')
}

// 7. max-tokens 截断:正常返回内容并带 truncated 标记
{
  const { handler } = await setup({
    llmOverrides: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '<<<OPTIMIZED>>>\n写到一半被截断的' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      },
    },
  })
  const res = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  const data = doneOf(res)
  assert.equal(data.truncated, true)
  assert.match(data.optimized, /截断/)
  console.log('✓ 7 max-tokens 截断标记')
}

// 7b. 推理模型 <think> 块:思考内容不进 SSE 增量,done 取思考后真实标记段
{
  const { handler } = await setup({
    llmOverrides: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '<think>\n推理:应输出 <<<OPTIMIZED>>> ... <<<END>>>' }
        yield { type: 'text-delta', index: 0, text: '再想想 <<<OPTIMIZED>>> 碎片 <<<END>>>' }
        yield { type: 'text-delta', index: 0, text: '</think>' }
        yield { type: 'text-delta', index: 0, text: '<<<DIAGNOSIS>>>\n简要分析\n' }
        yield { type: 'text-delta', index: 0, text: '<<<OPTIMIZED>>>\n## Request（请求要点）\n- 真正的优化结果\n## Context & Inputs（上下文与输入）\n- 用户草稿\n## Constraints & Exclusions（约束与排除）\n- (无)\n## Deliverable Shape（产出形态）\n- 文本\n<<<END>>>\n' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const res = await call(handler, { text: 'x' })
  const done = doneOf(res)
  assert.doesNotMatch(res.body, /推理:应输出/, '思考内容不得进入 SSE 增量')
  assert.doesNotMatch(res.body, /再想想/, '思考里的标记复述不得进入增量')
  assert.equal(sseEvents(res).filter((e) => e.type === 'delta' && /思考|碎片/.test(e.text)).length, 0, '增量里无思考片段')
  assert.match(done.optimized, /真正的优化结果/, 'done 取思考后的真实标记段')
  assert.equal(done.analysis, '简要分析')
  assert.equal(done.wellFormed, true)
  console.log('✓ 7b 推理思考块剥离')
}

// 8. 超时:模型挂死时中止流并推送 error 事件(慢用例,约 10s)
{
  const { handler } = await setup({
    config: { timeoutSeconds: 10 },
    llmOverrides: {
      stream(options) {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', index: 0, text: '<<<ANALYSIS>>>\n卡在分析阶段' }
            await new Promise((_, reject) => {
              options.signal.addEventListener('abort', () => reject(new Error('aborted')))
            })
          },
        }
      },
    },
  })
  const res = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  const err = sseEvents(res).find((e) => e.type === 'error')
  assert.ok(err, '超时后应收到 error 事件')
  assert.match(err.error, /超时/)
  console.log('✓ 8 超时中止并通知(慢)')
}

// 9. 快速模式:系统提示词不含分析段要求,解析仍走标记通道;无标记输出判 wellFormed=true
{
  const { handler, getOptions } = await setup({ config: { mode: 'fast' } })
  const res = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  const data = doneOf(res)
  assert.ok(!getOptions().system.includes('ANALYSIS'), 'fast 模式不应要求 ANALYSIS 段')
  assert.ok(getOptions().system.includes('OPTIMIZED'), 'fast 模式仍用 OPTIMIZED 标记')
  assert.match(data.optimized, /资深代码评审/)
  assert.equal(data.wellFormed, true, '带标记输出在 fast 模式下 wellFormed')
  // 无标记输出(free 模型常见):fast 模式单段落,整段即结果,不应误报格式退化
  const markerless = await setup({
    config: { mode: 'fast' },
    llmOverrides: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '直接输出的优化稿,没有任何标记。\n' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const res2 = await call(markerless.handler, { text: 'x', provider: 'p', model: 'm' })
  const data2 = doneOf(res2)
  assert.equal(data2.wellFormed, true, 'fast 模式无标记不应误报 wellFormed=false')
  assert.match(data2.optimized, /直接输出的优化稿/)
  console.log('✓ 9 快速模式提示词')
}

// 9b. 默认完整模式:提示词要求诊断 + 优化稿双段(Phase 4:general 走 v2 四段协议)
{
  const { handler, getOptions } = await setup()
  await call(handler, { text: 'x', provider: 'p', model: 'm' })
  assert.ok(getOptions().system.includes('DIAGNOSIS'))
  assert.ok(getOptions().system.includes('OPTIMIZED'))
  console.log('✓ 9b 默认完整模式提示词')
}

// 10. 推理强度默认钳最低档(不显式配置时):钳到 resolveModel 暴露的最低 effort,覆盖会话值
{
  const { handler, getOptions } = await setup({
    llmOverrides: {
      resolveModelInfo: async () => ({
        provider: 'p',
        id: 'm',
        name: 'M',
        reasoning: {
          efforts: [
            { id: 'high', name: 'High' },
            { id: 'low', name: 'Low' },
          ],
        },
      }),
    },
  })
  await call(handler, { text: 'x', provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal(getOptions().reasoningEffort, 'low', '默认应钳到最低档而非会话的 high')
  console.log('✓ 10 推理强度默认钳最低档')
}

// 10b. 显式配置「跟随会话」:会话的 reasoningEffort 原样透传;模型不暴露推理时不乱发
{
  const { handler, getOptions } = await setup({
    config: { reasoningEffort: 'session' },
    llmOverrides: { resolveModelInfo: async () => ({ provider: 'p', id: 'm', name: 'M' }) },
  })
  await call(handler, { text: 'x', provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal(getOptions().reasoningEffort, 'high')
  console.log('✓ 10b 显式跟随会话透传')
}

// 10c. 「最低档」但模型不支持推理:回退会话值,不冒险构造无效 effort
{
  const { handler, getOptions } = await setup({
    config: { reasoningEffort: 'lowest' },
    llmOverrides: { resolveModelInfo: async () => ({ provider: 'p', id: 'm', name: 'M' }) },
  })
  await call(handler, { text: 'x', provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal(getOptions().reasoningEffort, 'high')
  console.log('✓ 10c 不支持推理时回退会话值')
}

// 11. 回归:旧版设置文档残留的非法枚举值(mode: custom 等)不得让 schema 校验抛错
// ——那会导致整个命名空间注册失败、设置页卡片消失。宽松接收 + 使用处归一化。
{
  const resolved = plugin.Config({ language: 'fr', mode: 'custom', reasoningEffort: 'weird', maxTokens: 8192, timeoutSeconds: 120 })
  // 0.4.0 起字段带 .volatile():校验产物是 Volatile 引用 cell(0.2.0 宿主原位更新,
  // 读取经 .get() 展开);0.1.x 宿主无此包装,直取普通值。
  const plain = (v) => (v && typeof v.get === 'function' ? v.get() : v)
  assert.equal(plain(resolved.mode), 'custom', 'schema 应宽松接收未知枚举值')
  const { handler, getOptions } = await setup({ config: { language: 'fr', mode: 'custom', reasoningEffort: 'weird' } })
  const res = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  doneOf(res)
  assert.ok(getOptions().system.includes('DIAGNOSIS'), '未知 mode 应按完整模式处理')
  assert.match(getOptions().system, /General 通用 Prompt 编译器/, '未知 language 应按中文处理')
  console.log('✓ 11 旧版非法枚举值归一化')
}

// 12. 模型连接测试:成功返回 ok + 实际路由 + 耗时;探活调用 32 token 封顶
{
  const { testHandler, getOptions } = await setup()
  const res = await call(testHandler, {})
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(data.provider, 'deepseek-official')
  assert.equal(data.model, 'deepseek-chat')
  assert.equal(typeof data.latencyMs, 'number')
  assert.equal(getOptions().maxTokens, 32, '探活调用应 32 token 封顶')
  console.log('✓ 12 连接测试成功路径')
}

// 12b. 连接测试:模型失败 → 200 + ok:false(路由可达,结果在载荷里)
{
  const { testHandler } = await setup({
    llmOverrides: {
      async *stream() {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }
      },
    },
  })
  const res = await call(testHandler, { provider: 'p', model: 'm' })
  const data = JSON.parse(res.body)
  assert.equal(data.ok, false)
  assert.match(data.error, /bad key/)
  console.log('✓ 12b 连接测试失败透传')
}

// 13. 回退模型链:主路由零产出失败 → 自动换备用路由,done 带 fallbackUsed
{
  const { handler } = await setup({
    config: { fallbackModel: 'good-p/good-m' },
    llmOverrides: {
      async *stream(options) {
        if (options.provider === 'bad-p') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'DOWN', message: 'provider down' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: '<<<OPTIMIZED>>>\n回退路由产出\n<<<END>>>\n' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const res = await call(handler, { text: 'x', provider: 'bad-p', model: 'bad-m' })
  const data = doneOf(res)
  assert.equal(data.provider, 'good-p')
  assert.equal(data.model, 'good-m')
  assert.equal(data.fallbackUsed, true)
  // O12:回退原因随 done 下发,供客户端徽章 tooltip 展示
  assert.match(String(data.fallbackReason), /provider down/)
  assert.match(data.optimized, /回退路由产出/)
  console.log('✓ 13 主路由失败自动回退')
}

// 13b. 已向客户端推送过 delta 后失败 → 不回退(避免双模型拼接),直接 error 事件
{
  let calls = 0
  // 元任务调用(意图分析)与编译调用的尝试次数分开计:本用例只关心编译阶段
  // 「已产出内容后不得回退重试」,分析失败回退 general 属预期行为。
  // 判据用 system 文案锚点(分析阶段预算从 512 改为 1024,maxTokens 不再是判据)。
  let compileCalls = 0
  const { handler } = await setup({
    config: { fallbackModel: 'good-p/good-m' },
    llmOverrides: {
      async *stream(options) {
        calls++
        if (!isMetaAnalysisCall(options.system)) compileCalls++
        if (options.provider === 'bad-p') {
          yield { type: 'text-delta', index: 0, text: '<<<ANALYSIS>>>\n半截输出' }
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'mid-stream boom' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: '<<<OPTIMIZED>>>\n不应走到这\n<<<END>>>\n' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const res = await call(handler, { text: 'x', provider: 'bad-p', model: 'bad-m' })
  const events = sseEvents(res)
  assert.ok(!events.some((e) => e.type === 'done'), '不应有 done')
  assert.match(events.find((e) => e.type === 'error')?.error ?? '', /mid-stream boom/)
  assert.equal(compileCalls, 1, '已产出内容后不得回退重试')
  assert.equal(calls, 2, 'AUTO = 分析调用 1 次 + 编译调用 1 次')
  console.log('✓ 13b 半截失败后不回退')
}

// 14. 采样温度:默认 0.2(格式化任务求稳),可被配置覆盖
{
  const a = await setup()
  await call(a.handler, { text: 'x', provider: 'p', model: 'm' })
  assert.equal(a.getOptions().temperature, 0.2)
  const b = await setup({ config: { temperature: 0.7 } })
  await call(b.handler, { text: 'x', provider: 'p', model: 'm' })
  assert.equal(b.getOptions().temperature, 0.7)
  console.log('✓ 14 温度默认 0.2 且可配')
}

// 15. finish 为 tool-calls(优化调用不带工具)→ 明确报错而非当成功展示
{
  const { handler } = await setup({
    llmOverrides: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '给我调个工具' }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      },
    },
  })
  const res = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  const err = sseEvents(res).find((e) => e.type === 'error')
  assert.ok(err, '应收到 error 事件')
  assert.match(err.error, /工具调用/)
  console.log('✓ 15 tool-calls finish 防御')
}

// 16. 输出上限跟随输入长度:长草稿自动抬升 maxTokens,32768 封顶;可关
{
  // RC2:必须有明确约束/格式,否则会先进入 Discovery(不编译)
  const longDraft = '约束:保持原格式;输出格式:Markdown 列表。' + '一'.repeat(5000) // 长草稿 → ×2 抬升上限
  const a = await setup()
  await call(a.handler, { text: longDraft, provider: 'p', model: 'm' })
  // 抬升公式:max(8192, estimate×2);加了约束前缀后 ≈10034,只断言「> 默认 8192 且未封顶」
  assert.ok(a.getOptions().maxTokens > 8192, '长输入应抬升输出上限')
  assert.ok(a.getOptions().maxTokens <= 32768, '不得超过 32768 封顶')
  const huge = await setup()
  await call(huge.handler, { text: '约束:保持原格式。' + '一'.repeat(20000), provider: 'p', model: 'm' })
  assert.equal(huge.getOptions().maxTokens, 32768, '超大输入应 32768 封顶')
  const off = await setup({ config: { autoMaxTokens: false } })
  await call(off.handler, { text: longDraft, provider: 'p', model: 'm' })
  assert.equal(off.getOptions().maxTokens, 8192, '关闭自适应后保持配置值')
  console.log('✓ 16 输出上限跟随输入长度')
}

// 17. 会话上下文:随请求携带时进入模型消息(上下文在前、草稿在后);坏条目被过滤
{
  const { handler, getOptions } = await setup()
  const res = await call(handler, {
    // RC2:必须已明确(否则先进入 Discovery,拿不到编译调用)
    text: '我的草稿。约束:只做本地方案;输出格式:Markdown 列表。',
    provider: 'p',
    model: 'm',
    context: [
      { role: 'user', text: '帮我写个爬虫' },
      { role: 'assistant', text: '用什么语言?' },
      { role: 'hacker', text: '坏条目' }, // 非法 role 应被丢弃
      { role: 'user', text: '   ' }, // 空文本应被丢弃
      'not-an-object',
    ],
  })
  doneOf(res)
  const sent = getOptions().messages[0].content[0].text
  assert.match(sent, /<conversation-context>/)
  assert.match(sent, /用户: 帮我写个爬虫/)
  assert.match(sent, /助手: 用什么语言\?/)
  assert.ok(!sent.includes('坏条目'), '非法条目不得进入提示词')
  assert.ok(sent.indexOf('conversation-context') < sent.indexOf('<prompt-draft>'), '上下文必须置于草稿之前')
  assert.match(getOptions().system, /提炼用户的真实目的/, '有上下文应走 intent 策略(提炼目的 + 润色)')
  console.log('✓ 17 上下文进入模型消息')
}

// 17b. 设置关闭「携带上下文」:即使请求带了 context 也忽略(Host 侧硬开关)
{
  const { handler, getOptions } = await setup({ config: { includeContext: false } })
  const res = await call(handler, {
    text: '我的草稿。约束:只做本地方案;输出格式:Markdown 列表。',
    provider: 'p',
    model: 'm',
    context: [{ role: 'user', text: '帮我写个爬虫' }],
    previous: '上一轮结果',
  })
  doneOf(res)
  const sent = getOptions().messages[0].content[0].text
  assert.ok(!sent.includes('conversation-context'), '关闭后不得出现上下文段')
  assert.ok(!sent.includes('previous-optimized'), '关闭后不得出现记忆链段')
  // Phase 4:general 走 v2 载荷(处置说明 + 模式说明 + 草稿),不再有 legacy 单行格式
  assert.ok(sent.includes('我的草稿'), '关闭后应直接以草稿为主体')
  assert.doesNotMatch(sent, /-\s*\[待补充:/, 'v2:载荷不得以占位符形式列出缺口')
  assert.match(getOptions().system, /信息责任清单|信息责任/, '无上下文应走 template 策略(信息责任清单)')
  console.log('✓ 17b 关闭后忽略上下文')
}

// 18. 轻量记忆链:previous 进入模型消息(上下文之后、草稿之前);超长截断
{
  const { handler, getOptions } = await setup()
  const res = await call(handler, {
    text: '改过的草稿。约束:只做本地方案;输出格式:Markdown 列表。',
    provider: 'p',
    model: 'm',
    context: [{ role: 'user', text: '前文' }],
    previous: '上一轮的优化结果',
  })
  doneOf(res)
  const sent = getOptions().messages[0].content[0].text
  assert.match(sent, /<previous-optimized>\n上一轮的优化结果\n<\/previous-optimized>/)
  assert.ok(sent.indexOf('previous-optimized') < sent.indexOf('<prompt-draft>'), 'previous 必须置于草稿之前')

  const big = await setup()
  await call(big.handler, { text: 'x', provider: 'p', model: 'm', previous: '长'.repeat(3000) })
  const sentBig = big.getOptions().messages[0].content[0].text
  assert.ok(!sentBig.includes('长'.repeat(1600)), 'previous 应被截断到 1500 字符级')
  console.log('✓ 18 记忆链进入模型消息')
}

// 19. 来源围栏:跨站 Origin 拒绝;无 Origin(CLI)与同源 Origin 放行
{
  const { handler } = await setup()
  // 恶意网页跨站 text/plain POST(免预检):Origin 与 Host 不符 → 403,不触达 llm
  const csrf = await call(handler, { text: 'x' }, 'POST', { origin: 'https://evil.example', host: '127.0.0.1:3080' })
  assert.equal(csrf.status, 403, '跨站 Origin 必须被拒绝')
  assert.match(csrf.body, /已拒绝跨站请求/)
  // DNS rebinding:Origin 与 Host 一致但 Host 不是回环/本机地址 → 403
  const rebind = await call(handler, { text: 'x' }, 'POST', {
    origin: 'http://evil.example:3080',
    host: 'evil.example:3080',
  })
  assert.equal(rebind.status, 403, '伪造 Host(rebinding)必须被拒绝')
  // 正常调用方:CLI 不带 Origin → 放行
  const cli = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  assert.equal(cli.status, 200, '无 Origin 的命令行调用应放行')
  // 正常调用方:同源页面(Origin == Host == 回环)→ 放行
  const same = await call(handler, { text: 'x', provider: 'p', model: 'm' }, 'POST', {
    origin: 'http://127.0.0.1:3080',
    host: '127.0.0.1:3080',
  })
  assert.equal(same.status, 200, '同源调用应放行')
  // 探活路由同样受围栏保护
  const { testHandler } = await setup()
  const testCsrf = await call(testHandler, {}, 'POST', { origin: 'https://evil.example', host: '127.0.0.1:3080' })
  assert.equal(testCsrf.status, 403, 'test-model 同样拒绝跨站请求')
  console.log('✓ 19 来源围栏(CSRF / rebinding)')
}

// 20. AUTO 两阶段编排:SSE 事件序 meta → delta… → done;meta 携带类型 / 置信度 / 理由
{
  const { handler } = await setup()
  // RC2:已明确输入(否则会先进入 Discovery,拿不到 meta→delta→done 事件序)
  const res = await call(handler, { text: '帮我看看这段代码。约束:只检查,不修改文件;输出格式:问题清单。', provider: 'p', model: 'm' })
  const events = sseEvents(res)
  const metaIndex = events.findIndex((e) => e.type === 'meta')
  const firstDelta = events.findIndex((e) => e.type === 'delta')
  const doneIndex = events.findIndex((e) => e.type === 'done')
  assert.equal(metaIndex, 0, 'meta 必须是第一个事件')
  assert.ok(firstDelta > metaIndex, 'delta 必须在 meta 之后')
  assert.ok(doneIndex > firstDelta, 'done 必须在 delta 之后')
  const meta = events[metaIndex]
  assert.equal(meta.prompt_type, 'general', '分类失败应回退 general')
  assert.equal(meta.confidence_level, 'Low', '回退 general 必须低置信')
  assert.match(String(meta.rationale), /分类|通用|手动/)
  assert.ok(Array.isArray(meta.missing_constraints))
  // done 扩展字段:四组来源结构齐备(此处为空)+ 策略版本 + provenance_ok(向后兼容)
  const done = events[doneIndex]
  assert.equal(done.prompt_type, 'general')
  assert.deepEqual(done.explicit_requirements, [])
  assert.deepEqual(done.context_requirements, [])
  assert.deepEqual(done.suggested_requirements, [])
  assert.deepEqual(done.unknowns, [])
  assert.equal(done.provenance_ok, true)
  assert.equal(typeof done.strategy_version, 'string')
  console.log('✓ 20 AUTO 两阶段:meta→delta→done 事件序')
}

console.log('\nsmoke: all passed')