/**
 * P05-T02 兼容性回归:settings 双版本能力探测 + HTTP 载体双名 + volatile cell 读取。
 *
 * 只读验证:以 mock 服务驱动插件注册/分派路径,断言跨版本行为,不改任何产品代码。
 * 覆盖:
 *  - 0.2.0 SettingsForms(`configure({auto:false})`,volatile 字段引用 cell)
 *  - 0.1.2+ `settings.installSection(ctx, ns, schema, base, hooks)` → setSource 生效
 *  - 0.1.0-rc.x `settings.register(ns, schema, {base})` → get()/watch() 生效
 *  - settings 服务缺席 → 组合层配置生效(不抛错)
 *  - HTTP 载体双名 webServer / httpServer,双提供只挂载一次
 *
 * 运行:先 `npm run build`,再 `node test/compat-settings.test.mjs`。
 */
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

const CANNED = [
  '<<<ANALYSIS>>>',
  '目标清晰度 | 目标模糊 | 明确产出物',
  '<<<OPTIMIZED>>>',
  '你是一名资深代码评审。请审查以下 PR……',
  '<<<END>>>',
].join('\n')

/** 组合层配置的普通值快照(模拟 0.1.x / 直调 apply 收到的形态)。 */
const BASE = {
  language: 'zh',
  model: undefined,
  fallbackModel: undefined,
  maxTokens: 8192,
  timeoutSeconds: 120,
  mode: 'full',
  reasoningEffort: 'lowest',
  temperature: 0.2,
  autoMaxTokens: true,
  includeContext: true,
  promptType: 'auto',
  classifierModel: undefined,
}

function makeLlm(onStream) {
  return {
    async *stream(options) {
      onStream?.(options)
      for (const line of CANNED.split('\n')) {
        yield { type: 'text-delta', index: 0, text: line + '\n' }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ provider: 'p', id: 'm', name: 'M' }],
  }
}

/** 启动插件实例;返回路由、最后一次 llm.stream 选项与各服务调用记录。 */
async function boot({ settings, config = {}, carriers = ['httpServer'] } = {}) {
  const ctx = new Context()
  const routes = {}
  const routeRegistrations = []
  let lastOptions = null
  const allOptions = []
  for (const carrier of carriers) {
    ctx.provide(carrier, {
      register(route) {
        routes[route.path] = route
        routeRegistrations.push(route.path)
        return () => {}
      },
    })
  }
  ctx.provide('llm', makeLlm((options) => { lastOptions = options; allOptions.push(options) }))
  if (settings) ctx.provide('settings', settings)
  await ctx.plugin(plugin, config)
  assert.ok(routes['/dsh-prompt-optimizer/optimize'], '插件应注册 optimize 路由')
  return {
    ctx,
    routes,
    routeRegistrations,
    handler: routes['/dsh-prompt-optimizer/optimize'].handler,
    getOptions: () => lastOptions,
    getCalls: () => allOptions,
  }
}

/** 调用 handler 并收集 SSE 响应体。 */
async function call(handler, body) {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
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
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', headers: {} })
  await handler(req, res)
  return res
}

function done(res) {
  return eventsOf(res).find((e) => e.type === 'done')
}

/** 解析 SSE 响应体为事件数组(meta/delta/done/error)。 */
function eventsOf(res) {
  return res.body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      return line ? JSON.parse(line.slice(5).trim()) : null
    })
    .filter(Boolean)
}

// cs1. 0.2.0 SettingsForms:configure({auto:false}) 被调用;无 register/installSection 误判;
// volatile 字段引用 cell 经 readConfig 解包 → 请求期读到配置值。
{
  const configureCalls = []
  const { handler, getOptions } = await boot({
    config: { temperature: 0.6 },
    settings: {
      configure(presentation, owner) {
        configureCalls.push({ presentation, owner })
        return () => {}
      },
    },
  })
  assert.equal(configureCalls.length, 1, '0.2.0 应恰好调用一次 configure')
  assert.deepEqual(configureCalls[0].presentation, { auto: false }, '应关闭宿主原生自动表单避免重复')
  const res = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  done(res)
  assert.equal(getOptions().temperature, 0.6, 'volatile cell 配置值应被原样读出')
  console.log('✓ cs1 0.2.0 SettingsForms(configure + volatile cell 读取)')
}

// cs2. 0.1.2+ installSection:五参签名(ns 字符串)被调用;setSource 回灌的配置实时生效。
{
  let captured = null
  const { handler, getOptions } = await boot({
    config: { temperature: 0.2 },
    settings: {
      installSection(...args) {
        captured = args
      },
    },
  })
  assert.ok(captured, '0.1.2+ 应走 installSection 分支')
  assert.equal(captured.length, 5, '应传 5 个参数(ctx, ns, schema, base, hooks)')
  assert.equal(captured[1], 'prompt-optimizer', '命名空间必须是 prompt-optimizer')
  assert.equal(typeof captured[2].toJSON, 'function', '第 3 参应为可序列化 schema')
  assert.equal(typeof captured[4].setSource, 'function', '第 5 参应含 setSource hook')
  captured[4].setSource(() => ({ ...BASE, temperature: 0.5 }))
  const res = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  done(res)
  assert.equal(getOptions().temperature, 0.5, 'setSource 回灌配置应实时生效')
  console.log('✓ cs2 0.1.2+ installSection(setSource 生效)')
}

// cs3. 0.1.0-rc.x register:register(ns, schema, {base}) 被调用;get() 生效;watch() 触发重读。
{
  let registered = null
  let listener = null
  let value = { ...BASE, temperature: 0.3 }
  const { handler, getOptions } = await boot({
    config: { temperature: 0.2 },
    settings: {
      register(ns, schema, opts) {
        registered = { ns, schema, opts }
        return {
          get: () => value,
          watch: (fn) => {
            listener = fn
            return () => {
              listener = null
            }
          },
        }
      },
    },
  })
  assert.ok(registered, '0.1.0-rc.x 应走 register 分支')
  assert.equal(registered.ns, 'prompt-optimizer')
  assert.equal(typeof registered.schema.toJSON, 'function')
  assert.ok(registered.opts?.base, 'register 应带组合层 base 配置')
  assert.equal(typeof listener, 'function', 'watch 应订阅变更')
  const first = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  done(first)
  assert.equal(getOptions().temperature, 0.3, 'scope.get() 的配置应生效')
  value = { ...BASE, temperature: 0.8 }
  listener()
  const second = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  done(second)
  assert.equal(getOptions().temperature, 0.8, 'watch 触发后应重读 scope 配置')
  console.log('✓ cs3 0.1.0-rc.x register(get + watch 生效)')
}

// cs4. settings 服务缺席:插件正常加载,组合层配置生效(与更早版本一致)。
{
  const { handler, getOptions, routeRegistrations } = await boot({ config: { temperature: 0.45 } })
  assert.equal(routeRegistrations.filter((p) => p === '/dsh-prompt-optimizer/optimize').length, 1)
  const res = await call(handler, { text: 'x', provider: 'p', model: 'm' })
  done(res)
  assert.equal(getOptions().temperature, 0.45, '缺席 settings 时应读组合层配置')
  console.log('✓ cs4 settings 缺席回落组合层配置')
}

// cs5. HTTP 载体双名:webServer(0.1.0-rc.x)/ httpServer(npm 0.0.1-rc.x)各自可挂载。
{
  const viaWeb = await boot({ carriers: ['webServer'] })
  const res = await call(viaWeb.handler, { text: 'x', provider: 'p', model: 'm' })
  done(res)
  const viaHttp = await boot({ carriers: ['httpServer'] })
  const res2 = await call(viaHttp.handler, { text: 'x', provider: 'p', model: 'm' })
  done(res2)
  console.log('✓ cs5 HTTP 载体双名(webServer / httpServer)')
}

// cs6. 双载体同时存在:mount 幂等,两个路由各只注册一次(不重复挂载)。
{
  const { routeRegistrations } = await boot({ carriers: ['webServer', 'httpServer'] })
  assert.equal(routeRegistrations.filter((p) => p === '/dsh-prompt-optimizer/optimize').length, 1, 'optimize 路由只挂载一次')
  assert.equal(routeRegistrations.filter((p) => p === '/dsh-prompt-optimizer/test-model').length, 1, 'test-model 路由只挂载一次')
  console.log('✓ cs6 双载体并存只挂载一次')
}

console.log('\ncompat-settings: all passed')
