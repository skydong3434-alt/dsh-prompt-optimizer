import type { Context } from '@deepseek-ai/cordis'
import {
  buildV3Messages,
  parseV3Output,
  assessV3Safety,
  detectIntentExpansion,
  detectSpecialUsageTemplateDrift,
  conservativeOutput,
  stripProtocolMarkers,
} from './core/v3.js'
import { mechanicalTriage } from './core/triage.js'
import Schema from '@deepseek-ai/schemastery'
// 0.2.0 起设置改为宿主按插件 Config schema 自动生成表单(SettingsForms),
// 插件不再注册命名空间;0.1.x 线的两套 API 由下方运行时探测分派,类型只在本地声明。
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { capConversationContext, createThinkFilter, estimateTokens, type ConversationTurn, type OptimizerMode, type OutputLanguage } from './prompt.js'
/** 历史类型闭集:V3 不再据此路由,仅用于设置项校验提示(用户可见文案)。 */
const PROMPT_TYPES = ['general', 'research', 'planning', 'execution', 'diagnostic', 'review', 'creative'] as const

export const name = 'dsh-prompt-optimizer'
// 硬依赖只有 llm。HTTP 载体服务名在发布版间漂移过(npm 0.0.1-rc.x 类型包叫
// httpServer,0.1.0-rc.x 运行时叫 webServer),用 ctx.inject 双名等待,避免
// 静态 inject 声明错位时把整个 Harness 组合启动拖垮。
export const inject = ['llm']

export interface Config {
  /** 优化输出的语言('zh'/'en';其他值按 'zh' 处理)。 */
  language: string
  /** 固定模型,'provider/model' 形式;留空 = 跟随发起请求的会话当前选择。 */
  model?: string
  /** 回退模型('provider/model',留空 = 无);主路由在未产出任何内容就失败时自动换用。 */
  fallbackModel?: string
  /** 单次优化调用的最大输出 token 数。 */
  maxTokens: number
  /** 单次优化调用的超时时间(秒);超时后中止模型调用并通知客户端。 */
  timeoutSeconds: number
  /** 优化模式('full'/'fast';其他值按 'full' 处理)。 */
  mode: string
  /** V3 单次调用路径(默认开启;false 回退旧多阶段流程)。 */
  /** 推理强度('lowest'/'session';其他值按 'lowest' 处理)。默认钳最低档:优化是格式化元任务,高档推理只拉长首 token 前的空等。 */
  reasoningEffort: string
  /** 采样温度(0-2,默认 0.2);优化是格式化任务,低温输出更稳定。 */
  temperature: number
  /** 输出上限跟随输入长度(默认开):长草稿时按输入 token 估算提高 maxTokens,避免截断。 */
  autoMaxTokens: boolean
  /** 优化时携带会话近期对话作为上下文(默认开):方向更贴合;关闭后仅看草稿本身。 */
  includeContext: boolean
  /** 默认任务类型:'auto'(默认)= 每次自动识别;六个具体策略类型 = 客户端未显式指定时跳过分类直达该策略。 */
  promptType: string
  /** 分类小调用专用模型('provider/model',可选);留空 = 跟随主路由(分类是元任务,可用更小/更快的模型)。 */
  classifierModel?: string
}

// 枚举字段刻意用宽松 string 而非 union:设置文档持久化在 profile 补丁/旧版
// settings.yaml,旧版本写过的枚举值(如 mode: custom)若撞上严格 union 会让
// schema 校验抛错,整个配置解析失败。宽松接收 + 使用处归一化更稳。
// 全字段 .volatile():0.2.0 起宿主只把 volatile 字段投影成 Web 设置表单
// (SettingsForms.volatileForm),且这类字段经 Volatile 引用原位更新——
// 设置修改不重挂载插件;0.1.x 宿主忽略该标记,行为不变。
export const Config = Schema.object({
  language: Schema.string().default('zh').volatile(),
  model: Schema.string().volatile(),
  fallbackModel: Schema.string().volatile(),
  maxTokens: Schema.number().min(1024).max(32768).default(8192).volatile(),
  // v0.2.0-apo release blocker 修复:默认 120s 对**推理模型**不够 ——
  // 真实证据:analysis 已成功返回(HTTP 200 / 2974 字正文 / reasoning 6071 字 /
  // 1266 chunks / 3929 completion tokens),但整轮在 120s 超时 → error(无 compile 调用、
  // 无日志行)。正常用户路径因此高概率失败。默认提到 300s(范围与 UI 提示不变)。
  timeoutSeconds: Schema.number().min(10).max(600).default(300).volatile(),
  /** V3 单次调用路径(默认开启;关闭可回退旧多阶段流程)。 */
  mode: Schema.string().default('full').volatile(),
  reasoningEffort: Schema.string().default('lowest').volatile(),
  temperature: Schema.number().min(0).max(2).default(0.2).volatile(),
  autoMaxTokens: Schema.boolean().default(true).volatile(),
  includeContext: Schema.boolean().default(true).volatile(),
  promptType: Schema.string().default('auto').volatile(),
  classifierModel: Schema.string().volatile(),
})

/** 0.2.0 volatile 字段的运行时形态:宿主原位更新的引用 cell(cosmokit Volatile)。 */
interface VolatileCell<T> {
  get(): T
}

/** volatile cell 按结构识别取值;普通值(0.1.x / 直调 apply)原样返回。 */
function unwrapCell<T>(value: T | VolatileCell<T>): T {
  return typeof (value as VolatileCell<T>)?.get === 'function' ? (value as VolatileCell<T>).get() : (value as T)
}

/** 把 apply 收到的 config 归一为普通值快照(0.2.0 的 volatile 字段是引用 cell)。 */
function readConfig(raw: Config): Config {
  return {
    language: unwrapCell(raw.language),
    model: unwrapCell(raw.model),
    fallbackModel: unwrapCell(raw.fallbackModel),
    maxTokens: unwrapCell(raw.maxTokens),
    timeoutSeconds: unwrapCell(raw.timeoutSeconds),
    mode: unwrapCell(raw.mode),
    reasoningEffort: unwrapCell(raw.reasoningEffort),
    temperature: unwrapCell(raw.temperature),
    autoMaxTokens: unwrapCell(raw.autoMaxTokens),
    includeContext: unwrapCell(raw.includeContext),
    promptType: unwrapCell(raw.promptType) ?? 'auto',
    classifierModel: unwrapCell(raw.classifierModel),
    // V3 单次调用:未显式关闭即开启(默认路径)
  }
}

// 0.1.2-rc.1 起 ns 直接传字符串,由 SettingsNamespaceInput 做小写-连字符校验。
const NS = 'prompt-optimizer' as const
const ROUTE_PATH = '/dsh-prompt-optimizer/optimize'
const TEST_ROUTE_PATH = '/dsh-prompt-optimizer/test-model'
const MAX_BODY_BYTES = 256 * 1024

// R27:宽 string schema 的配套告警(枚举值在用处处静默归一化,这里至少让用户
// 在日志里看到自己手填的值不被支持)。每个 非法字段=值 组合只提醒一次。
const warnedConfigValues = new Set<string>()
function warnUnknownEnum(value: string, allowed: readonly string[], label: string): void {
  const key = `${label}=${value}`
  if (!allowed.includes(value) && !warnedConfigValues.has(key)) {
    warnedConfigValues.add(key)
    console.warn(`[${name}] 配置 ${label}="${value}" 不是有效值(支持:${allowed.join('/')}),已按默认处理`)
  }
}

/** 对四个宽松枚举字段做非法值告警;归一化仍由各使用处完成。 */
function warnUnknownEnumConfig(cfg: Config): void {
  if (cfg.language !== 'zh' && cfg.language !== 'en') warnUnknownEnum(cfg.language, ['zh', 'en'], 'language')
  if (cfg.mode !== 'full' && cfg.mode !== 'fast') warnUnknownEnum(cfg.mode, ['full', 'fast'], 'mode')
  if (cfg.reasoningEffort !== 'lowest' && cfg.reasoningEffort !== 'session') {
    warnUnknownEnum(cfg.reasoningEffort, ['lowest', 'session'], 'reasoningEffort')
  }
  // promptType:'auto'(默认)或七个策略类型;其余值在使用处按 AUTO 处理。
  // V3 由模型判定用途,该字段只作历史兼容(不再影响流程)。
  if (cfg.promptType !== 'auto' && !PROMPT_TYPES.includes(cfg.promptType)) {
    warnUnknownEnum(cfg.promptType, ['auto', ...PROMPT_TYPES], 'promptType')
  }
}

interface OptimizeRequestBody {
  text?: unknown
  provider?: unknown
  model?: unknown
  reasoningEffort?: unknown
  context?: unknown
  previous?: unknown
  /** 手动类型覆盖(可选):缺省 = AUTO(先分类再编译);非法值按 AUTO 处理。 */
  promptType?: unknown
  /**
   * v2 Phase 3:Requirement Discovery 会话(客户端持有;宿主一律当**不可信输入**净化)。
   *  - mode='answer':提交本轮回答,宿主重新分析 + 解析回答 + 更新台账;
   *  - mode='confirm':用户点了「确认并优化」,宿主**不再调用分析**,直接进入编译;
   *  - 缺省:全新一次优化(首轮分析)。
   */
  discovery?: unknown
}

/** 客户端回传的 Discovery 会话(宽松解析;非法字段静默丢弃)。 */
function parseDiscoveryInput(value: unknown): {
  mode: 'answer' | 'confirm' | 'reoptimize'
  session: DiscoveryInput
  edited: { requirement_id: string; value: string; evidence: string }[]
  reopened: string[]
  analysis: unknown
} | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const mode = record.mode === 'confirm' ? 'confirm' : record.mode === 'reoptimize' ? 'reoptimize' : 'answer'
  const triage = asOptionalString(record.triage) as DiscoveryInput['triage'] | undefined
  const edited: { requirement_id: string; value: string; evidence: string }[] = []
  if (Array.isArray(record.edited)) {
    for (const item of record.edited) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      const requirementId = asOptionalString(entry.requirement_id)
      const nextValue = asOptionalString(entry.value)
      if (!requirementId || !nextValue) continue
      edited.push({
        requirement_id: requirementId,
        value: nextValue,
        evidence: asOptionalString(entry.evidence) ?? nextValue,
      })
    }
  }
  return {
    mode,
    session: {
      raw_input: '',
      triage: triage ?? 'PATCH',
      ledger: Array.isArray(record.ledger) ? (record.ledger as DiscoveryInput['ledger']) : [],
      asked: Array.isArray(record.asked) ? (record.asked as DiscoveryInput['asked']) : [],
      answers: Array.isArray(record.answers) ? (record.answers as DiscoveryInput['answers']) : [],
      questions: Array.isArray(record.questions) ? (record.questions as DiscoveryInput['questions']) : [],
      validationReturns: Array.isArray(record.validationReturns)
        ? (record.validationReturns as DiscoveryInput['validationReturns'])
        : [],
      round: typeof record.round === 'number' ? record.round : 1,
    },
    edited,
    reopened: Array.isArray(record.reopened)
      ? record.reopened.filter((id): id is string => typeof id === 'string')
      : [],
    analysis: record.analysis,
  }
}

/** 0.1.2+ settings.installSection 的回调包(仅类型面使用)。 */
interface SettingsHooks {
  setSource(source: () => Config): void
  onChange(): void
}

/** 跨版本传递给 settings API 的 schema 最小结构面(带 toJSON 的 schemastery 实例)。 */
interface SettingsSchemaLike {
  toJSON(): unknown
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * 校验客户端携带的会话上下文:只接受 {role:'user'|'assistant', text} 数组,
 * 坏条目静默丢弃,最终再过一遍预算收敛(防御性——客户端已按同一口径收敛过)。
 */
function parseContextInput(value: unknown): ConversationTurn[] | undefined {
  if (!Array.isArray(value)) return undefined
  const turns: ConversationTurn[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { role, text } = item as Record<string, unknown>
    if ((role === 'user' || role === 'assistant') && typeof text === 'string' && text.trim()) {
      turns.push({ role, text: text.trim() })
    }
  }
  return turns.length ? capConversationContext(turns) : undefined
}

function writeJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 浏览器来源围栏(本机服务的 CSRF / DNS rebinding 防线):
 * - 浏览器发出的 POST 必带 Origin 头:其 authority 必须与 Host 头一致,
 *   否则拒绝——恶意网页的跨站 text/plain POST(免预检)在此被挡下;
 * - Host 头必须是回环地址,或与本次连接的实际本地地址:端口一致——
 *   DNS rebinding 会伪造 Host=攻击域名,在此被挡下;
 * - 无 Origin 的请求(CLI / 服务端调用)放行:本插件的主要调用方是
 *   同源页面与命令行,前者 Origin 恒匹配,后者本就不带该头。
 * LAN 暴露(README 已声明)不受影响:直连 IP 访问时 Host=本机地址。
 */
function assertTrustedOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    originHost = ''
  }
  if (!host || originHost !== host) {
    writeJson(res, 403, { ok: false, error: '已拒绝跨站请求(Origin 与 Host 不符)' })
    return false
  }
  const hostName = host.replace(/:\d+$/, '')
  const hostPort = /:(\d+)$/.exec(host)?.[1] ?? '80'
  const loopback = hostName === 'localhost' || hostName === '127.0.0.1' || hostName === '[::1]' || hostName === '::1'
  if (!loopback) {
    // Host 不是回环时,必须恰好等于本次连接的本地地址:端口(直连 IP 的 LAN 访问);
    // 拿不到 socket 信息或对不上都拒绝(fail-closed,防 rebinding 伪造 Host)。
    const sock = (req as { socket?: { localAddress?: string; localPort?: number } }).socket
    if (!(sock?.localAddress && sock?.localPort && hostName === sock.localAddress && hostPort === String(sock.localPort))) {
      writeJson(res, 403, { ok: false, error: '请求的 Host 与本机服务地址不符(可能的 DNS rebinding),已拒绝' })
      return false
    }
  }
  return true
}

/** 请求体超过大小上限时抛出,用于映射 413(与 JSON 解析失败的 400 区分)。 */
class PayloadTooLargeError extends Error {}

/** 读取并解析 JSON 请求体,带大小上限。 */
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError('请求体超过 256KB 上限')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
}

/** 读取请求体并直接应答解析错误(400/413);成功返回 body,失败返回 undefined(响应已写)。 */
async function readBodyOrReply(req: IncomingMessage, res: ServerResponse): Promise<OptimizeRequestBody | undefined> {
  try {
    return (await readJsonBody(req)) as OptimizeRequestBody
  } catch (error) {
    // 请求体问题是客户端错误(400/413),不是上游模型失败(502)。
    if (error instanceof PayloadTooLargeError) {
      writeJson(res, 413, { ok: false, error: error.message })
    } else {
      writeJson(res, 400, { ok: false, error: '请求体不是合法的 JSON' })
    }
    return undefined
  }
}

/** 折叠流式输出为纯文本;finish 为 error/aborted 时抛出,max-tokens 标记截断。onDelta 逐段回调增量(用于 SSE 透传)。 */
async function collectText(
  stream: AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>,
  onDelta?: (text: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  let deltas = ''
  const blocks = new Map<number, string>()
  let truncated = false
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        deltas += chunk.text
        onDelta?.(chunk.text)
        break
      case 'block-end':
        if (chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text)
        break
      case 'finish': {
        const reason = chunk.reason
        if (reason.kind === 'error' || reason.kind === 'aborted') {
          throw new Error(`模型调用失败(${reason.failure.code}): ${reason.failure.message}`)
        }
        // 优化调用不带工具,模型请求工具说明路由/适配异常,明确报错而非当成功展示。
        if (reason.kind === 'tool-calls') {
          throw new Error('模型意外请求工具调用(优化调用不提供工具),请检查模型路由配置')
        }
        if (reason.kind === 'max-tokens') truncated = true
        break
      }
      default:
        break
    }
  }
  // 优先使用增量(delta 是协议主通道);某些适配器只发 block-end 时降级。
  const text = deltas || [...blocks.entries()].sort(([a], [b]) => a - b).map(([, t]) => t).join('')
  return { text, truncated }
}

/**
 * 解析指定路由支持的最低推理强度(「最低档」配置用)。
 * 优先按常见低档关键词匹配 effort 的 id/name;匹配不到取适配器展示顺序首位。
 * 目录查询失败或模型不支持推理时返回 undefined,调用方回退到会话选择。
 */
async function resolveLowestEffort(
  llm: Context['llm'],
  provider: string,
  model: string,
): Promise<string | undefined> {
  try {
    // reasoning 只在精确路由元数据上,listModels 的目录项没有。
    const efforts = (await llm.resolveModelInfo(provider, model)).reasoning?.efforts
    if (!efforts?.length) return undefined
    const keyworded = efforts.find((e) => /none|minimal|low|低/i.test(`${e.id} ${e.name}`))
    return String((keyworded ?? efforts[0]).id)
  } catch {
    return undefined
  }
}

// 路由 → 最低档 effort 缓存的生存期(实例级,挂在 apply 闭包内,见下)。
const EFFORT_CACHE_TTL = 10 * 60 * 1000

/**
 * 模型路由解析:设置里固定的 'provider/model' → 请求方会话当前选择 → 第一个可用路由。
 * 空字符串视为未设置;provider 路由键不含 '/',模型 id 可以含。无可用路由时返回 undefined。
 */
async function resolveRoute(
  llm: Context['llm'],
  pinnedModel: string | undefined,
  bodyProvider: string | undefined,
  bodyModel: string | undefined,
): Promise<{ provider: string; model: string } | undefined> {
  let provider: string | undefined
  let model: string | undefined
  const pinned = asOptionalString(pinnedModel)
  if (pinned) {
    const slash = pinned.indexOf('/')
    if (slash > 0 && slash < pinned.length - 1) {
      provider = pinned.slice(0, slash)
      model = pinned.slice(slash + 1)
    }
  }
  provider ??= bodyProvider
  model ??= bodyModel
  if (!provider || !model) {
    const first = llm.listProviders()[0]
    if (!provider && first) provider = first.id
    if (provider && !model) {
      try {
        model = (await llm.listModels(provider))[0]?.id
      } catch {
        // 目录查询失败不代表路由不可用,留空往下走到明确报错。
      }
    }
  }
  return provider && model ? { provider, model } : undefined
}

/** HTTP 载体服务的最小依赖面(webServer / httpServer 两个名字共用同一形状)。 */
interface WebRouteService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export function apply(ctx: Context, config: Config) {
  // 路由 → 最低档 effort 的实例级缓存:每次优化点击都会解析一遍,而模型的推理
  // 档位表极少变化。仅缓存成功结果,失败不缓存——下次点击重试,避免一次目录
  // 抖动永久挡住钳档。挂在 apply 闭包内:随插件实例生灭,测试间天然隔离。
  const effortCache = new Map<string, { effort: string; at: number }>()
  const resolveLowestEffortCached = async (llm: Context['llm'], provider: string, model: string): Promise<string | undefined> => {
    const key = `${provider}/${model}`
    const hit = effortCache.get(key)
    if (hit && Date.now() - hit.at < EFFORT_CACHE_TTL) return hit.effort
    const effort = await resolveLowestEffort(llm, provider, model)
    if (effort !== undefined) effortCache.set(key, { effort, at: Date.now() })
    return effort
  }

  // 设置页命名空间:组合层配置作为 base,用户在 设置→插件配置 中的修改实时生效。
  // 按能力探测分派,保证同一份构建跨版本:
  //  - 0.2.0 起 ctx.settings 是 SettingsForms:按插件导出的 Config schema 自动
  //    生成配置表单(namespace = 组合行 id)。volatile 字段经引用 cell 原位更新,
  //    插件不重挂载——current() 在读取时展开 cell 即可,无需注册命名空间。
  //    这里同时关闭宿主的原生自动表单(auto:false),避免与设置卡重复;
  //  - settings.installSection 是函数(0.1.2-alpha.5+ / 0.1.2-rc.1)→ 新 API;
  //  - 否则(0.1.0-rc.x / 0.1.1-rc.x)→ 旧独立函数的等价内联
  //    (register{base} + setSource + watch + 卸载回落 entry,对照 0.1.0-rc.7 实现);
  //  - settings 服务整体缺席 → current 保持组合层配置,行为与更早版本一致。
  let current = (): Config => readConfig(config)
  ctx.inject(['settings'], (sctx) => {
    const settings = (sctx as unknown as {
      settings?: {
        configure?: (presentation: { auto?: boolean }, owner?: unknown) => () => void
        installSection?: (c: Context, ns: string, schema: SettingsSchemaLike, base: Config, hooks: SettingsHooks) => void
        register?: (ns: string, schema: SettingsSchemaLike, opts: { base: Config }) => { get(): Config; watch(fn: () => void): () => void }
      }
    }).settings
    if (!settings) return
    if (typeof settings.configure === 'function') {
      // 0.2.0:插件自带设置卡,关闭宿主按 Config schema 生成的原生表单页。
      ctx.effect(() => settings.configure!({ auto: false }, (ctx as unknown as { fiber?: unknown }).fiber))
    }
    if (typeof settings.installSection === 'function') {
      settings.installSection(ctx, NS, Config, config, {
        setSource: (source) => {
          current = () => readConfig(source())
        },
        onChange: () => {},
      })
      return
    }
    if (typeof settings.register !== 'function') return // 0.2.0:配置由 volatile cell 承载
    const scope = settings.register(NS, Config, { base: config })
    current = () => readConfig(scope.get())
    const disposeWatch = scope.watch(() => {
      current = () => readConfig(scope.get())
    })
    ctx.effect(() => () => {
      disposeWatch()
      current = () => readConfig(config)
    })
  })
  // 启动即对初始配置做一次非法枚举告警;请求期配置可能被实时改写,handler 内还会复查。
  warnUnknownEnumConfig(current())

  let mounted = false
  const mount = (server: WebRouteService | undefined) => {
    if (!server || mounted) return
    mounted = true
    ctx.effect(() => {
      const disposeOptimize = server.register({ kind: 'exact', path: ROUTE_PATH, handler })
      const disposeTest = server.register({ kind: 'exact', path: TEST_ROUTE_PATH, handler: testHandler })
      return () => {
        disposeOptimize()
        disposeTest()
      }
    })
    console.log(`[${name}] loaded, POST ${ROUTE_PATH}`)
  }
  ctx.inject(['webServer'], (sctx) => mount((sctx as unknown as { webServer?: WebRouteService }).webServer))
  ctx.inject(['httpServer'], (sctx) => mount((sctx as unknown as { httpServer?: WebRouteService }).httpServer))
  ctx.effect(() => {
    const timer = setTimeout(() => {
      if (!mounted) {
        console.error(`[${name}] 未找到 webServer/httpServer 服务,路由未注册——当前 dsh 版本可能不兼容`)
      }
    }, 10_000)
    return () => clearTimeout(timer)
  })

  async function handler(req: IncomingMessage, res: ServerResponse) {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'Method Not Allowed' })
        return
      }
      if (!assertTrustedOrigin(req, res)) return
      // 客户端在响应结束前断开连接时,中止模型调用。
      // 注意:必须用 res 的 close;req 的 close 在请求体读完就会触发,不代表断连。
      const abort = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) abort.abort()
      })

      try {
        const body = await readBodyOrReply(req, res)
        if (!body) return
        const text = asOptionalString(body.text)
        if (!text) {
          writeJson(res, 400, { ok: false, error: '提示词内容为空' })
          return
        }

        // v2 Phase 3:Discovery 会话(客户端持有 → 宿主净化;不可信输入)
        const discoveryReq = parseDiscoveryInput((body as Record<string, unknown>).discovery)

        const cfg = current()
        // 宽松 schema 的配套归一化:未知枚举值一律回落默认,保证旧版设置文档可用
        //(非法值会先告警一次,见 warnUnknownEnumConfig)。
        warnUnknownEnumConfig(cfg)
        const language: OutputLanguage = cfg.language === 'en' ? 'en' : 'zh'
        const mode: OptimizerMode = cfg.mode === 'fast' ? 'fast' : 'full'
        void mode
        const route = await resolveRoute(ctx.llm, cfg.model, asOptionalString(body.provider), asOptionalString(body.model))
        if (!route) {
          writeJson(res, 409, {
            ok: false,
            error: '未找到可用模型:请先在 设置 → 模型 中配置提供方,或在 设置的插件页「提示词优化」 中固定一个模型',
          })
          return
        }
        // 回退模型链:设置里配了 fallbackModel('provider/model')时追加一条备用路由。
        // 仅当某次尝试还没向客户端推送过任何 delta 就失败时才换路由重试——
        // 客户端已经看到部分内容后再换路由,输出会变成两个模型的拼接。
        const routes = [route]
        const fallbackRaw = asOptionalString(cfg.fallbackModel)
        if (fallbackRaw) {
          const slash = fallbackRaw.indexOf('/')
          if (slash > 0 && slash < fallbackRaw.length - 1) {
            const fb = { provider: fallbackRaw.slice(0, slash), model: fallbackRaw.slice(slash + 1) }
            if (fb.provider !== route.provider || fb.model !== route.model) routes.push(fb)
          }
        }

        // 分类小调用专用路由:设置里配了 classifierModel('provider/model')时,分类走该
        // 路由,而编译仍走上方主路由/回退链。非法格式不冒险构造无效路由,回退主路由。
        const classifierRaw = asOptionalString(cfg.classifierModel)
        let classifierRoute = route
        if (classifierRaw) {
          const slash = classifierRaw.indexOf('/')
          if (slash > 0 && slash < classifierRaw.length - 1) {
            classifierRoute = { provider: classifierRaw.slice(0, slash), model: classifierRaw.slice(slash + 1) }
          } else {
            console.warn(`[${name}] classifierModel="${classifierRaw}" 不是 'provider/model' 形式,分类调用改用主路由`)
          }
        }

        // 设置里关掉「携带上下文」时,即使客户端带了 context 也忽略(Host 侧硬开关)。
        const context = cfg.includeContext === false ? undefined : parseContextInput(body.context)
        // 轻量记忆链:上一轮优化结果,截断到 1500 字符(它只是延续参考,不是优化对象)。
        // 与 context 一样跟随「携带上下文」开关——关闭后不带任何会话衍生材料。
        const previousRaw = cfg.includeContext === false ? undefined : asOptionalString(body.previous)
        const previous = previousRaw ? (previousRaw.length > 1500 ? `${previousRaw.slice(0, 1500)}…` : previousRaw) : undefined
        // 输出上限跟随输入长度:优化结果体量与草稿正相关(完整模式还多一段分析),
        // 长草稿撞固定上限会被截断。取配置值与「输入估算 × 模式系数」的较大者,32768 封顶。
        const maxTokens =
          cfg.autoMaxTokens === false
            ? cfg.maxTokens
            : Math.min(32768, Math.max(cfg.maxTokens, Math.ceil(estimateTokens(text) * (mode === 'fast' ? 1.5 : 2))))
        // 推理强度:默认钳到该模型支持的最低档(优化是格式化元任务,高推理只会拉长
        // 首 token 前的空等),按路由逐次解析;仅显式配置 'session' 时透传会话选择。
        // 无法确定最低档(目录失败/模型不暴露推理)时回退到会话值,不冒险乱发。
        const sessionEffort = asOptionalString(body.reasoningEffort)
        // 宽松 schema 的配套归一化:仅 'session' 视为跟随会话,其余(含缺省)都钳最低档。
        const preferSessionEffort = cfg.reasoningEffort === 'session'

        // 阶段二:流式响应。delta 逐段推送(SSE),done 携带最终解析结果;
        // 此阶段响应头已发出,模型错误也走事件通道,无法再改状态码。
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        })
        const send = (event: Record<string, unknown>) => {
          if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
        }
        // 超时兜底:模型挂死时中止调用并通知客户端(timedOut 与客户端断连共用 abort,靠标志位区分)。
        const timeoutSec = cfg.timeoutSeconds ?? 120
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          abort.abort()
        }, timeoutSec * 1000)
        try {
          // ══════════════════════════════════════════════════════════════════
          // V3 单次调用路径(自适应提示词优化器)
          //   理解意图 / 判断用途 / 判断关键歧义 / 生成结果 **同一次模型处理**,
          //   不再串行 analysis → discovery → confirmation → compile → validate。
          //   本地只做**机械**安全检查(协议标记 / 空产出 / 硬约束),不再调用模型。
          // ══════════════════════════════════════════════════════════════════
          const v3Route = routes[0]!
          const effort = preferSessionEffort
            ? sessionEffort
            : ((await resolveLowestEffortCached(ctx.llm, v3Route.provider, v3Route.model)) ?? sessionEffort)
          // 用户对上一轮提问的回答(客户端以 answers 回传)
          const v3Answer = (() => {
            const answers = discoveryReq && 'answers' in discoveryReq.session
              ? (discoveryReq.session.answers ?? [])
              : []
            const first = answers.find((a) => String(a?.text ?? '').trim())
            return first ? String(first.text).trim() : ''
          })()
          const v3Questions = (() => {
            const asked = discoveryReq && 'asked' in discoveryReq.session ? (discoveryReq.session.asked ?? []) : []
            const last = [...asked].reverse().find((a) => String(a?.question ?? '').trim())
            return last ? String(last.question).trim() : ''
          })()
          const messages = buildV3Messages({
            rawInput: text,
            ...(context ? { contextTurns: context } : {}),
            ...(v3Answer ? { clarification: { question: v3Questions, answer: v3Answer } } : {}),
            language,
          })
          let v3Raw = ''
          let v3Failure: string | null = null
          try {
            const v3Options = {
              provider: v3Route.provider,
              model: v3Route.model,
              messages: messages.map((m: { role: string; content: string }) => ({
                id: `prompt-optimizer-${crypto.randomUUID()}`,
                role: m.role,
                content: [{ type: 'text', text: m.content }],
                source: { kind: 'plugin', plugin: name },
              })) as unknown as Message[],
              maxTokens: cfg.maxTokens,
              temperature: cfg.temperature,
              ...(effort ? { reasoningEffort: effort as NonNullable<GenerateOptions['reasoningEffort']> } : {}),
              signal: abort.signal,
            }
            const collected = await collectText(ctx.llm.stream(v3Options), (delta) => {
              send({ type: 'delta', text: delta })
            })
            v3Raw = collected.text
            if (collected.truncated) v3Failure = 'truncated'
          } catch (error) {
            v3Failure = error instanceof Error ? error.message : String(error)
          }
          if (abort.signal.aborted) {
            // 超时:必须显式下发 error 终态。外层 catch 在 signal.aborted 时会静默返回
            // (那是给「客户端断连」准备的),若在此处 throw,用户既拿不到产物也拿不到错误。
            if (timedOut && !res.writableEnded) {
              send({
                type: 'error',
                error: `优化超时:${timeoutSec} 秒内未生成完毕。可在 设置的插件页「提示词优化」 中调高「超时时间」。`,
                reason_code: 'VF_TIMEOUT',
              })
              res.end()
            }
            return
          }
          let v3 = parseV3Output(v3Raw, text)
          // 机械保证:用户已经回答过(或选择「保持未确定」)→ 本轮必须继续输出,不得再问。
          // 模型采样不稳定时,这一层防止「回答后仍反复追问」。
          if (v3Answer && v3.status === 'needs_clarification') {
            console.warn('[dsh-prompt-optimizer] V3 已收到用户回答,禁止再次提问 → 继续输出')
            v3 = { status: 'optimized', usage: v3.usage, structured: v3.structured, output: conservativeOutput(text), question: '' }
          }
          if (v3.status === 'needs_clarification' && v3.question) {
            // 关键歧义:只问 1 个问题;用户可「保持未确定,直接优化」
            send({
              type: 'discovery_required',
              status: 'needs_clarification',
              v3: true,
              usage: v3.usage,
              questions: [
                {
                  key: `v3-${Date.now()}`,
                  question: v3.question,
                  options: [],
                  why: '这是理解你这句话所必需的信息',
                  depends_on: [],
                  allow_blind_trust: true,
                },
              ],
              asked: [],
              ledger: [],
              gate: { blocked: true, blocking_items: [{ text: v3.question }], discoverable_items: [], optional_items: [], reason: '关键歧义' },
              triage: { triage: mechanicalTriage(text).triage, reasons: ['V3:按输入复杂度判定'], signals: [], keep_safe: false },
              intent: { primary: 'general', supporting: [], work_mode: 'one_shot', rationale: 'V3 单次调用' },
              target: { target: 'general', modality: 'text', engine: null, confidence: 'high', evidence: [], rationale: 'V3 单次调用' },
              analysis: null,
            })
            res.end()
            return
          }
          let output = stripProtocolMarkers(v3.output)
          // 机械纠偏(本地,无额外模型调用):优化稿不得擅自扩展任务方向
          // (目标描述→规划任务 / 想法交流→执行任务)。命中则保守退回用户原文。
          const v3Expansion = detectIntentExpansion(text, output)
          if (v3Expansion.expanded) {
            console.warn(
              `[dsh-prompt-optimizer] V3 意图扩展已拦截:${v3Expansion.phrases.join(',')} → 保守回退原文`,
            )
            output = stripProtocolMarkers(conservativeOutput(text))
          }
          // 机械纠偏:图片/视频/音频提示词不得被写成执行任务模板(用户要求保护的内容)
          const v3Drift = detectSpecialUsageTemplateDrift(v3.usage, output)
          if (v3Drift.drifted) {
            console.warn(
              `[dsh-prompt-optimizer] V3 特殊用途模板漂移已拦截:${v3.usage} → 保守回退原文`,
            )
            output = stripProtocolMarkers(conservativeOutput(text))
          }
          if (!output.trim()) {
            // 技术错误独立显示:绝不伪装成业务澄清状态
            send({
              type: 'error',
              error: `模型没有产出可用内容${v3Failure ? `(${v3Failure})` : ''};可直接重试。`,
              reason_code: 'VF_EMPTY_OUTPUT',
            })
            res.end()
            return
          }
          // 机械安全(本地,无额外模型调用):硬约束是否保留
          const v3Safety = assessV3Safety({ rawInput: text, optimizedPrompt: output })
          const v3Triage = mechanicalTriage(text)
          const usageToTarget: Record<string, string> = {
            GENERAL: 'general',
            IMAGE: 'image_generation',
            VIDEO: 'video_generation',
            AUDIO: 'audio_generation',
            AGENT: 'agent_task',
          }
          const v3Target = usageToTarget[v3.usage] ?? 'general'
          send({
            type: 'meta',
            v3: true,
            intent: { primary: v3.usage === 'AGENT' ? 'execution' : 'general', supporting: [], work_mode: 'one_shot', rationale: 'V3 单次调用' },
            target: { target: v3Target, modality: v3.usage === 'IMAGE' ? 'image' : v3.usage === 'VIDEO' ? 'video' : 'text', engine: null, confidence: 'high', evidence: [], rationale: `V3 用途:${v3.usage}` },
            triage: { triage: v3Triage.triage, reasons: ['V3:按输入复杂度判定'], signals: v3Triage.signals, keep_safe: v3Triage.keep_safe, mechanical: v3Triage.triage },
            gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: 'V3:无需阻塞' },
            ledger: [],
            usage: v3.usage,
            structured: v3.structured,
            prompt_type: v3.usage.toLowerCase(),
          })
          send({ type: 'validating' })
          send({
            type: 'done',
            v3: true,
            usage: v3.usage,
            structured: v3.structured,
            optimized: output,
            analysis: `用途:${v3.usage}${v3.structured ? ' · 结构化' : ''}`,
            wellFormed: true,
            truncated: false,
            provider: v3Route.provider,
            model: v3Route.model,
            fallbackUsed: false,
            prompt_type: v3.usage.toLowerCase(),
            confidence_level: 'High',
            diagnosis: `V3 单次调用 · 用途 ${v3.usage}`,
            explicit_requirements: [],
            context_requirements: [],
            suggested_requirements: [],
            unknowns: [],
            missing_constraints: [],
            provenance_ok: v3Safety.hardConstraintKept,
            triage: { triage: v3Triage.triage, reasons: ['V3:按输入复杂度判定'], signals: v3Triage.signals, keep_safe: v3Triage.keep_safe, mechanical: v3Triage.triage },
            ledger: [],
            missing_resolution: [],
            target: { target: v3Target, modality: 'text', engine: null, confidence: 'high', evidence: [], rationale: `V3 用途:${v3.usage}` },
            intent: { primary: v3.usage === 'AGENT' ? 'execution' : 'general', supporting: [], work_mode: 'one_shot', rationale: 'V3 单次调用' },
          })
          res.end()
          return
        } finally {
          clearTimeout(timer)
        }
        res.end()
      } catch (error) {
        if (abort.signal.aborted) return // 客户端已断开,无需应答
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[${name}] optimize failed:`, error)
        writeJson(res, 502, { ok: false, error: message })
      }
  }

  /** 模型连通性测试:按同一套路由解析发一个 32 token 封顶的探活调用,20s 超时。结果(含失败)一律 200 返回,ok 标志区分。 */
  async function testHandler(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    if (!assertTrustedOrigin(req, res)) return
    const body = await readBodyOrReply(req, res)
    if (!body) return
    const cfg = current()
    const route = await resolveRoute(ctx.llm, cfg.model, asOptionalString(body.provider), asOptionalString(body.model))
    if (!route) {
      writeJson(res, 409, {
        ok: false,
        error: '未找到可用模型:请先在 设置 → 模型 中配置提供方,或在 设置的插件页「提示词优化」 中固定一个模型',
      })
      return
    }
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, 20_000)
    const started = Date.now()
    try {
      // 同上:插件署名的消息源以结构断言跨版本。
      const message = {
        id: `prompt-optimizer-test-${crypto.randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: 'ping' }],
        source: { kind: 'plugin', plugin: name },
      } as unknown as Message
      const result = await collectText(
        ctx.llm.stream({ provider: route.provider, model: route.model, messages: [message], maxTokens: 32, signal: abort.signal }),
      )
      writeJson(res, 200, {
        ok: true,
        provider: route.provider,
        model: route.model,
        latencyMs: Date.now() - started,
        reply: result.text.slice(0, 80),
      })
    } catch (error) {
      if (timedOut) {
        writeJson(res, 200, { ok: false, error: '连接测试超时(20s 无响应)' })
      } else if (!abort.signal.aborted) {
        writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
