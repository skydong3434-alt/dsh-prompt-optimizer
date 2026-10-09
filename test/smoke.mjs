/**
 * Host 半冒烟测试(V3):真实 cordis Context + mock 的 llm/httpServer 服务,
 * 直接驱动插件注册的 HTTP handler,覆盖成功、错误与边界路径。
 *
 * 运行:先 `npm run build`,再 `node test/smoke.mjs`。
 *
 * 迁移说明:原文件驱动的是旧多阶段链路(标记协议 / 分析+编译两次调用)。
 * 旧链路删除后,本文件只保留**用户可见的宿主行为**断言:
 * 路由与参数校验、来源围栏、模型选择与回退、连接测试、超时、
 * 技术错误的显式呈现、V3 事件序、澄清问答、硬约束与用途映射。
 * 旧链路的内部协议断言(标记解析、策略 system 文案、自适应 maxTokens)
 * 属于旧实现细节,随旧代码删除,不再保留。
 */
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

/** V3 协议产物:正常优化。 */
const V3_DONE = JSON.stringify({
  status: 'optimized',
  usage: 'GENERAL',
  structured: false,
  output: '优化后的稿子:请审查这段代码,只检查、不修改文件。',
  question: '',
})

function makeReq(body, method = 'POST', headers) {
  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)])
  req.method = method
  req.headers = headers ?? {}
  return req
}

/** 调用插件注册的 handler 并收集响应。raw 为字符串时按原样发送(用于畸形 JSON 用例)。 */
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
  const req = makeReq(body, method, headers)
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

/** 成功响应(200 + SSE)中的 done 事件。 */
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
      yield { type: 'text-delta', index: 0, text: V3_DONE }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek 官方' }],
    listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    ...llmOverrides,
  })
  await ctx.plugin(plugin, config)
  assert.ok(routes['/dsh-prompt-optimizer/optimize'], '插件应注册优化路由')
  assert.ok(routes['/dsh-prompt-optimizer/test-model'], '插件应注册测试路由')
  return {
    ctx,
    handler: routes['/dsh-prompt-optimizer/optimize'].handler,
    testHandler: routes['/dsh-prompt-optimizer/test-model'].handler,
    getOptions: () => lastOptions,
  }
}

// 1. 正常路径:meta → validating → delta… → done;载荷含用途与产物
{
  const { handler } = await setup()
  const res = await call(handler, { text: '帮我看看这段代码。约束:只检查,不修改文件。', provider: 'session-p', model: 'session-m' })
  const events = sseEvents(res)
  const data = doneOf(res)
  // V3 单次调用:模型增量在调用期实时下发,判断结论(meta)在产物确定后才发。
  assert.equal(events[0].type, 'delta', 'V3 先推送模型增量')
  assert.ok(events.some((e) => e.type === 'meta'), '应有 meta 事件')
  assert.ok(events.some((e) => e.type === 'validating'), '应有 validating 事件')
  assert.equal(events[events.length - 1].type, 'done', 'done 必须是最后一个事件')
  assert.match(data.optimized, /审查这段代码/, 'done 应带优化产物')
  assert.equal(data.usage, 'GENERAL')
  assert.equal(data.provider, 'session-p')
  assert.equal(data.model, 'session-m')
  assert.ok(!data.optimized.includes('"status"'), '产物不得包含内部协议信封')
  console.log('✓ 1 正常路径:meta→validating→done')
}

// 2. 设置里固定模型('provider/model')覆盖会话模型
{
  const { handler } = await setup({ config: { model: 'cfg-p/cfg-m' } })
  const data = doneOf(await call(handler, { text: 'x', provider: 'session-p', model: 'session-m' }))
  assert.equal(data.provider, 'cfg-p')
  assert.equal(data.model, 'cfg-m')
  console.log('✓ 2 设置固定模型优先')
}

// 2b. 回归:配置字段为空字符串时必须视为未设置(而不是错落到首个路由)
{
  const { handler } = await setup({ config: { model: '' } })
  const data = doneOf(await call(handler, { text: 'x', provider: 'session-p', model: 'session-m' }))
  assert.equal(data.provider, 'session-p')
  assert.equal(data.model, 'session-m')
  console.log('✓ 2b 空字符串配置视为未设置')
}

// 2c. 回归:固定值缺少 '/' 分隔时视为未配置,回落到会话选择
{
  const { handler } = await setup({ config: { model: 'cfg-p-only' } })
  const data = doneOf(await call(handler, { text: 'x', provider: 'session-p', model: 'session-m' }))
  assert.equal(data.provider, 'session-p')
  assert.equal(data.model, 'session-m')
  console.log('✓ 2c 畸形固定值回落会话')
}

// 3. 会话与设置都没给模型时,回退到第一个可用路由
{
  const { handler } = await setup()
  const data = doneOf(await call(handler, { text: 'x' }))
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
  assert.equal((await call(handler, { text: '   ' })).status, 400)
  assert.equal((await call(handler, undefined, 'GET')).status, 405)
  console.log('✓ 5 参数与方法校验')
}

// 5b. 畸形 JSON → 400;超大请求体 → 413
{
  const { handler } = await setup()
  const bad = await call(handler, '{not json')
  assert.equal(bad.status, 400)
  assert.match(JSON.parse(bad.body).error, /JSON/)
  assert.equal((await call(handler, JSON.stringify({ text: 'x'.repeat(300 * 1024) }))).status, 413)
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
  assert.ok(!sseEvents(res).some((e) => e.type === 'done'), '错误终态不得下发 done')
  console.log('✓ 6 模型错误 → SSE error 事件')
}

// 7. 空产出 → 显式技术错误(绝不伪装成澄清提问)
{
  const { handler } = await setup({
    llmOverrides: {
      async *stream() {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const res = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  const events = sseEvents(res)
  assert.ok(!events.some((e) => e.type === 'discovery_required'), '空产出不得变成提问')
  const err = events.find((e) => e.type === 'error')
  assert.ok(err, '空产出应是显式错误终态')
  assert.equal(err.reason_code, 'VF_EMPTY_OUTPUT')
  console.log('✓ 7 空产出 → 技术错误(VF_EMPTY_OUTPUT)')
}

// 7b. 被截断的协议信封不得泄漏为产物
{
  const { handler } = await setup({
    llmOverrides: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '{"status":"needs_clarification","usage":"GENERAL","structured":false,"output":"","question":"「那个旧的」具体指什么？' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const events = sseEvents(await call(handler, { text: '把那个旧的换掉。', provider: 'p', model: 'm' }))
  const err = events.find((e) => e.type === 'error')
  assert.ok(err, '截断协议信封应是技术错误')
  assert.equal(err.reason_code, 'VF_EMPTY_OUTPUT')
  assert.ok(!JSON.stringify(events).includes('"status"'), '协议信封不得进入任何下发事件')
  console.log('✓ 7b 截断协议信封 → 技术错误,不泄漏')
}

// 8. 关键歧义 → 恰好 1 个问题 + 允许「保持未确定」
{
  const { handler } = await setup({
    llmOverrides: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ status: 'needs_clarification', usage: 'GENERAL', structured: false, output: '', question: '「那个旧的」具体指什么?' }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const res = await call(handler, { text: '把那个旧的换掉。', provider: 'p', model: 'm' })
  assert.equal(res.status, 200)
  const ev = sseEvents(res).find((e) => e.type === 'discovery_required')
  assert.ok(ev, '关键歧义应下发 discovery_required')
  assert.equal(ev.questions.length, 1, '只问一个问题')
  assert.equal(ev.questions[0].allow_blind_trust, true, '必须允许「保持未确定」')
  assert.ok(!sseEvents(res).some((e) => e.type === 'done'), '提问轮不得同时下发产物')
  console.log('✓ 8 关键歧义 → 1 个问题')
}

// 8b. 已回答 → 本轮必须继续输出,不得再问
{
  let rounds = 0
  const { handler } = await setup({
    llmOverrides: {
      async *stream() {
        rounds++
        yield {
          type: 'text-delta',
          index: 0,
          text:
            rounds === 1
              ? JSON.stringify({ status: 'needs_clarification', usage: 'GENERAL', structured: false, output: '', question: '「那个旧的」指什么?' })
              : JSON.stringify({ status: 'needs_clarification', usage: 'GENERAL', structured: false, output: '', question: '还是不知道,请再说一次' }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const res = await call(handler, {
    text: '把那个旧的换掉。',
    provider: 'p',
    model: 'm',
    discovery: { mode: 'answer', answers: [{ text: '指旧的首页配色' }], asked: [{ question: '「那个旧的」指什么?' }], round: 1 },
  })
  const data = doneOf(res)
  assert.ok(!sseEvents(res).some((e) => e.type === 'discovery_required'), '已回答后不得再次提问')
  assert.ok(data.optimized.length > 0, '已回答后必须给出产物')
  console.log('✓ 8b 已回答 → 继续输出(不再追问)')
}

// 9. 超时:模型挂死时中止流并推送 error 事件(慢用例,约 10s)
{
  const { handler } = await setup({
    config: { timeoutSeconds: 10 },
    llmOverrides: {
      stream(options) {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', index: 0, text: '半截' }
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
  console.log('✓ 9 超时中止并通知(慢)')
}

// 10. 采样温度:默认 0.2(格式化任务求稳),可被配置覆盖
{
  const a = await setup()
  await call(a.handler, { text: 'x', provider: 'p', model: 'm' })
  assert.equal(a.getOptions().temperature, 0.2)
  const b = await setup({ config: { temperature: 0.7 } })
  await call(b.handler, { text: 'x', provider: 'p', model: 'm' })
  assert.equal(b.getOptions().temperature, 0.7)
  console.log('✓ 10 温度默认 0.2 且可配')
}

// 11. 回归:旧版设置文档残留的非法枚举值不得让 schema 校验抛错
{
  const resolved = plugin.Config({ language: 'fr', mode: 'custom', reasoningEffort: 'weird', maxTokens: 8192, timeoutSeconds: 120 })
  const plain = (v) => (v && typeof v.get === 'function' ? v.get() : v)
  assert.equal(plain(resolved.mode), 'custom', 'schema 应宽松接收未知枚举值')
  const { handler } = await setup({ config: { language: 'fr', mode: 'custom', reasoningEffort: 'weird' } })
  doneOf(await call(handler, { text: 'x', provider: 'p', model: 'm' }))
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
  const data = JSON.parse((await call(testHandler, { provider: 'p', model: 'm' })).body)
  assert.equal(data.ok, false)
  assert.match(data.error, /bad key/)
  console.log('✓ 12b 连接测试失败透传')
}

// 13. 来源围栏:跨站 Origin 拒绝;无 Origin(CLI)与同源 Origin 放行
{
  const { handler } = await setup()
  const csrf = await call(handler, { text: 'x' }, 'POST', { origin: 'https://evil.example', host: '127.0.0.1:3080' })
  assert.equal(csrf.status, 403, '跨站 Origin 必须被拒绝')
  assert.match(csrf.body, /已拒绝跨站请求/)
  const rebind = await call(handler, { text: 'x' }, 'POST', {
    origin: 'http://evil.example:3080',
    host: 'evil.example:3080',
  })
  assert.equal(rebind.status, 403, '伪造 Host(rebinding)必须被拒绝')
  assert.equal((await call(handler, { text: 'x', provider: 'p', model: 'm' })).status, 200, '无 Origin 的命令行调用应放行')
  const same = await call(handler, { text: 'x', provider: 'p', model: 'm' }, 'POST', {
    origin: 'http://127.0.0.1:3080',
    host: '127.0.0.1:3080',
  })
  assert.equal(same.status, 200, '同源调用应放行')
  const { testHandler } = await setup()
  const testCsrf = await call(testHandler, {}, 'POST', { origin: 'https://evil.example', host: '127.0.0.1:3080' })
  assert.equal(testCsrf.status, 403, 'test-model 同样拒绝跨站请求')
  console.log('✓ 13 来源围栏(CSRF / rebinding)')
}

// 14. 会话上下文进入 V3 消息;坏条目被过滤
{
  const { handler, getOptions } = await setup()
  const res = await call(handler, {
    text: '我的草稿。约束:只做本地方案。',
    provider: 'p',
    model: 'm',
    context: [
      { role: 'user', text: '帮我写个爬虫' },
      { role: 'assistant', text: '用什么语言?' },
      { role: 'hacker', text: '坏条目' },
      { role: 'user', text: '   ' },
      'not-an-object',
    ],
  })
  doneOf(res)
  const sent = getOptions().messages.map((m) => m.content?.[0]?.text ?? '').join('\n')
  assert.match(sent, /帮我写个爬虫/, '合法上下文应进入消息')
  assert.match(sent, /用什么语言/, '助手轮应进入消息')
  assert.ok(!sent.includes('坏条目'), '非法条目不得进入提示词')
  console.log('✓ 14 上下文进入模型消息')
}

// 14b. 设置关闭「携带上下文」:即使请求带了 context 也忽略(Host 侧硬开关)
{
  const { handler, getOptions } = await setup({ config: { includeContext: false } })
  doneOf(await call(handler, {
    text: '我的草稿。约束:只做本地方案。',
    provider: 'p',
    model: 'm',
    context: [{ role: 'user', text: '帮我写个爬虫' }],
  }))
  const sent = getOptions().messages.map((m) => m.content?.[0]?.text ?? '').join('\n')
  assert.ok(!sent.includes('帮我写个爬虫'), '关闭后不得出现上下文')
  assert.ok(sent.includes('我的草稿'), '关闭后应直接以草稿为主体')
  console.log('✓ 14b 关闭后忽略上下文')
}

// 15. 硬约束不丢失:输入里的硬约束必须原样保留在产物中
{
  const { handler } = await setup({
    llmOverrides: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ status: 'optimized', usage: 'GENERAL', structured: false, output: '请审查这个模块。只检查,不修改任何文件。', question: '' }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const data = doneOf(await call(handler, { text: '只检查,不修改任何文件。请审查这个模块。', provider: 'p', model: 'm' }))
  assert.match(data.optimized, /不修改任何文件/, '硬约束必须保留')
  assert.equal(data.provenance_ok, true, '硬约束保留应标记 provenance_ok')
  console.log('✓ 15 硬约束不丢失')
}

// 16. 用途 → 目标映射:显式生图提示词请求 → IMAGE / image_generation
{
  const { handler } = await setup({
    llmOverrides: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ status: 'optimized', usage: 'IMAGE', structured: false, output: '一只在雪地奔跑的柴犬,低角度,浅景深', question: '' }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const data = doneOf(await call(handler, { text: '帮我写一个生图提示词:柴犬在雪地奔跑。', provider: 'p', model: 'm' }))
  assert.equal(data.usage, 'IMAGE')
  assert.equal(data.target.target, 'image_generation')
  console.log('✓ 16 用途 → 目标映射')
}

console.log('\nsmoke: all passed')
