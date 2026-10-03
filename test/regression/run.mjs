#!/usr/bin/env node
/**
 * P07-T02 — Behavioral / Effect Regression runner（双通道 + 开销测量 + 报告）。
 *
 * 契约来源：PLAN-v1 §11.2 / §13 P07、PLAN-v1.1 **R-2**、`docs/regression.md` §3/§4/§5。
 *
 * 设计纪律（不要在本文件里放松）：
 *   1. deterministic 层是**唯一硬 Gate**：逐条执行 fixture 的 `require` / `prohibit`，
 *      任一违反 = 该例 FAIL；
 *   2. model-assisted（`intent-fidelity-v1`）只是**参考线**：temperature 0、固定提示词 id、
 *      失败重跑一次、重跑不一致不计 PASS、逐条带理由；**绝不允许把 deterministic FAIL
 *      翻成 PASS**（`overall` 只由 deterministic 决定）；
 *   3. 阈值纪律（R-2）：本文件不设任何数值通过阈值；报告 `threshold: null` +
 *      `threshold_status: "DEFERRED_TO_P07_CALIBRATION"`；
 *   4. G-2 追加要求 A：每次 classify / compile 调用分别测量
 *      system prompt token / context token / total input token / latency，
 *      按 strategy 聚合 min/avg/max；**不预防性删策略内容**（数据说话）。
 *
 * 用法：
 *   node test/regression/run.mjs                       # deterministic + mock（离线机制冒烟）
 *   node test/regression/run.mjs --mode all            # + evaluator 参考线
 *   node test/regression/run.mjs --fixture <id>[,<id>] # 只跑部分语料
 *   node test/regression/run.mjs --adapter live        # 真实 LLM（R1：必须显式 --provider/--model/--base-url/--api-key-env，缺则 fail fast）
 *   node test/regression/run.mjs --adapter external --external ./my-adapter.mjs
 *   node test/regression/run.mjs --report <path>       # 自定义报告路径
 *   node test/regression/run.mjs --no-report           # 不写报告
 *
 * 本文件是回归机制，不是效果判定：真实效果结论由 P07-T03 用真实模型跑完 + Human G-5 判定。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defaultStrategyRegistry, isLegacyGeneral } from '../../lib/core/registry.js'
import {
  COMPILE_MARKERS,
  compilePrompt,
  finalizeCompile,
  parseCompileOutput,
} from '../../lib/core/compiler.js'
import { classifyViaLlm, manualClassifierResult } from '../../lib/core/classify.js'
import { validateCompileResult } from '../../lib/core/validate.js'
import { estimateTokens, stripThinkBlocks } from '../../lib/prompt.js'

const here = dirname(fileURLToPath(import.meta.url))

export const EVALUATOR_PROMPT_ID = 'intent-fidelity-v1'
export const REPORT_SCHEMA = 'apo-regression-report-v1'
export const DEFAULT_REPORT_DIR = here
export const FIXTURES_DIR = join(here, 'fixtures')

/** R-2：阈值语义必须显式为「延后校准」，runner 不得擅自规定数值线。 */
export const THRESHOLD_STATUS = 'DEFERRED_TO_P07_CALIBRATION'

/** 阻塞句式（UNKNOWN 不得写成阻塞式前置问题；与 schema.test / 语料 prohibition 同口径）。 */
const BLOCKING_RE =
  /请先回答|必须先确认|必须先补充|否则无法继续|回答后才能继续|确认后才能继续|等你确认|待你确认/

/** 证据强度 / 可复现性提示（冲突证据加权展示的最低机械要求）。 */
const WEIGHT_HINT_RE = /证据强度|可复现|权威|一手来源|官方|强度|可信度|reproducib|authorit/i

/** 历史设定被当前指令覆盖的措辞（用于 explicit-priority 检查）。 */
const OVERRIDE_RE = /改为|换成|覆盖|取代|不再|废弃|以当前|以本轮|当前明确/

const PROMPT_TYPES = [
  'research',
  'planning',
  'execution',
  'diagnostic',
  'review',
  'creative',
  'general',
]

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// ─────────────────────────────────────────────────────────────────────────────
// fixture 加载 / context 归一化
// ─────────────────────────────────────────────────────────────────────────────

/** 字符串 = 历史 user 消息；对象必须显式 role。与 schema.test.mjs 同口径。 */
export function normalizeFixtureContext(context) {
  const list = Array.isArray(context) ? context : []
  return list.map((entry) => {
    if (typeof entry === 'string') return { role: 'user', text: entry }
    return { role: entry?.role === 'assistant' ? 'assistant' : 'user', text: String(entry?.text ?? '') }
  })
}

/** 读取 fixtures 目录下全部 JSON（按文件名排序；不做 schema 校验——那是 schema.test 的职责）。 */
export function loadFixtures(dir = FIXTURES_DIR) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixture = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      return { ...fixture, context: normalizeFixtureContext(fixture.context) }
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI 参数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析 CLI 参数（纯函数，便于单测）。
 * 支持 `--key value` 与 `--flag`；未知参数抛错（避免静默跑错模式）。
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: 'deterministic',
    fixtures: [],
    adapter: 'mock',
    external: null,
    // R1：不再默认 DeepSeek——provider/model/apiKeyEnv 留空，由 live/external 显式提供
    provider: '',
    model: '',
    apiKeyEnv: '',
    credentials: null,
    report: null,
    writeReport: true,
    language: 'zh',
    timeoutMs: 60000,
    verbose: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${arg} 缺少取值`)
      i += 1
      return value
    }
    switch (arg) {
      case '--mode': {
        const value = next()
        if (value !== 'deterministic' && value !== 'all') {
          throw new Error(`--mode 只支持 deterministic|all，收到 ${value}`)
        }
        options.mode = value
        break
      }
      case '--fixture':
      case '--fixtures':
        options.fixtures.push(...next().split(',').map((item) => item.trim()).filter(Boolean))
        break
      case '--adapter': {
        const value = next()
        if (!['mock', 'live', 'external'].includes(value)) {
          throw new Error(`--adapter 只支持 mock|live|external，收到 ${value}`)
        }
        options.adapter = value
        break
      }
      case '--external':
        options.external = next()
        break
      case '--provider':
        options.provider = next()
        break
      case '--model':
        options.model = next()
        break
      case '--api-key-env':
        options.apiKeyEnv = next()
        break
      case '--credentials':
        options.credentials = next()
        break
      case '--report':
        options.report = next()
        break
      case '--no-report':
        options.writeReport = false
        break
      case '--language': {
        const value = next()
        if (value !== 'zh' && value !== 'en') throw new Error(`--language 只支持 zh|en`)
        options.language = value
        break
      }
      case '--timeout-ms':
        options.timeoutMs = Number(next())
        break
      case '--verbose':
        options.verbose = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`未知参数 ${arg}（--help 查看用法）`)
    }
  }
  if (options.adapter === 'external' && !options.external) {
    throw new Error('--adapter external 必须同时提供 --external <module path>')
  }
  return options
}

export const USAGE = `用法: node test/regression/run.mjs [--mode deterministic|all] [--fixture id,id]
  [--adapter mock|live|external] [--external <path>] [--provider p] [--model m]
  [--api-key-env NAME] [--credentials <yaml>] [--report <path>] [--no-report] [--verbose]`

// ─────────────────────────────────────────────────────────────────────────────
// 确定性文本面 + invariant / invariant_checks 判定
// ─────────────────────────────────────────────────────────────────────────────

/**
 * deterministic 断言的文本面 = 模型四段协议原文 + 最终优化稿。
 * 依据 docs/regression.md §3：默认面是 `optimized_prompt`，而四段协议类断言
 * （如 `planning-override-contract` 的 `<<<EXPLICIT>>>`）需要原始协议文本；
 * 两者都是编译产物，合并判定可同时覆盖「交付稿漂移」与「协议段落漂移」。
 */
export function deterministicSurface(rawOutput, result) {
  return [String(rawOutput ?? ''), String(result?.optimized_prompt ?? '')]
    .filter((text) => text.trim().length > 0)
    .join('\n')
}

/** 逐条执行 fixture `invariants`（require 必须命中 / prohibit 不得命中）。 */
export function evaluateInvariant(invariant, surface) {
  const hasRequire = Object.prototype.hasOwnProperty.call(invariant ?? {}, 'require')
  const key = hasRequire ? 'require' : 'prohibit'
  const pattern = invariant?.[key]
  const base = { desc: String(invariant?.desc ?? ''), kind: key, pattern: String(pattern ?? '') }
  let regex
  try {
    regex = new RegExp(String(pattern))
  } catch (error) {
    return { ...base, ok: false, detail: `非法正则: ${error.message}` }
  }
  const match = String(surface ?? '').match(regex)
  if (key === 'require') {
    return match
      ? { ...base, ok: true, detail: `命中「${match[0]}」` }
      : { ...base, ok: false, detail: 'require 未命中（交付稿缺少应出现的内容）' }
  }
  return match
    ? { ...base, ok: false, detail: `prohibit 命中「${match[0]}」` }
    : { ...base, ok: true, detail: 'prohibit 未命中' }
}

/** 仅保留 ASCII 关键 token；没有时退回 CJK 连续片段（≥2 字）。 */
function distinctiveTokens(text) {
  const value = String(text ?? '')
  const ascii = [...value.matchAll(/[A-Za-z][A-Za-z0-9.+#_-]{1,}/g)].map((match) => match[0])
  if (ascii.length) return ascii
  return [...value.matchAll(/[\u4e00-\u9fff]{2,}/g)].map((match) => match[0])
}

const unknownTextOf = (result) =>
  [
    ...(result.unknowns ?? []).map((record) => String(record.text ?? '')),
    ...(result.missing_constraints ?? []).map((item) => String(item.label ?? '')),
  ]
    .map((text) => text.trim())
    .filter(Boolean)

/**
 * `invariant_checks` 运行期判定（canonical id 与 docs/regression.md §4 一一对应）。
 * 返回 `{ id, desc, ok, detail }`；未知 id 视为 FAIL（fail-closed，防静默跳过）。
 */
export function runInvariantCheck(check, ctx) {
  const id = String(check?.id ?? '')
  const desc = String(check?.desc ?? '')
  const params = check?.params ?? {}
  const { fixture, result, plan, rawOutput, problems } = ctx
  const surface = ctx.surface
  const fail = (detail) => ({ id, desc, ok: false, detail })
  const pass = (detail) => ({ id, desc, ok: true, detail })
  const rules = (problems ?? []).map((problem) => String(problem.rule ?? ''))

  switch (id) {
    case 'unknown-not-blocking': {
      const hit = surface.match(BLOCKING_RE)
      if (hit) return fail(`出现阻塞句式「${hit[0]}」`)
      if (params.expect_provenance_ok === true && result.provenance_ok !== true) {
        return fail('UNKNOWN 不应导致阻塞：期望 provenance_ok=true，实际 false')
      }
      return pass('无阻塞句式；UNKNOWN 未被当作阻塞前置')
    }

    case 'suggested-not-upgraded': {
      const suggested = (result.suggested_requirements ?? []).map((record) => String(record.text ?? ''))
      const requirementText = [...(result.explicit_requirements ?? []), ...(result.context_requirements ?? [])]
        .map((record) => String(record.text ?? ''))
        .join('\n')
      const leaked = suggested.filter((text) => text && requirementText.includes(text))
      const ruleHit =
        rules.includes('VALIDATION_SUGGESTED_IN_REQUIREMENTS') ||
        rules.includes('VALIDATION_SUGGESTED_UPGRADED')
      if (leaked.length) return fail(`建议文本出现在 explicit/context 组:${leaked.join('；')}`)
      if (ruleHit) return fail(`校验规则命中建议升级:${rules.filter((rule) => /SUGGESTED/.test(rule)).join('、')}`)
      return pass('建议保持建议身份，未升级为要求')
    }

    case 'unknown-semantic-dedup': {
      const aliases = Array.isArray(params.aliases) ? params.aliases.map(String) : []
      const entries = [...new Set(unknownTextOf(result))]
      const duplicates = aliases.filter(
        (alias) => entries.filter((entry) => entry.includes(alias)).length > 1,
      )
      const matched = entries.filter((entry) => aliases.some((alias) => entry.includes(alias)))
      const topicKeywords = String(params.topic ?? '')
        .split(/[与和及、\s/]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
      const joined = entries.join('\n')
      const topicRetained =
        matched.length > 0 ||
        (topicKeywords.length > 0 && topicKeywords.every((token) => joined.includes(token)))
      if (duplicates.length) {
        return fail(`语义重复的 UNKNOWN 未合并（同一措辞出现在多条）:${duplicates.join('、')}`)
      }
      if (!topicRetained) return fail('去重后未保留该话题（预算 / 工期缺失信息丢失）')
      return pass(`UNKNOWN 已去重且保留话题「${params.topic ?? ''}」`)
    }

    case 'partial-quote-not-user-explicit': {
      const claimed = String(params.claimed_requirement ?? '')
      const over = (result.explicit_requirements ?? []).filter((record) =>
        String(record.text ?? '').includes(claimed),
      )
      if (over.length) {
        return fail(`部分匹配 quote 支撑了整条扩写要求:${over.map((record) => record.text).join('；')}`)
      }
      return pass('无「片段 quote → 整条 USER_EXPLICIT」的过度归因')
    }

    case 'conflicting-evidence-weighted': {
      const tokensA = distinctiveTokens(params.conflict_a)
      const tokensB = distinctiveTokens(params.conflict_b)
      const sideA = tokensA.some((token) => surface.includes(token))
      const sideB = tokensB.some((token) => surface.includes(token))
      const weighted = WEIGHT_HINT_RE.test(surface)
      if (!sideA || !sideB) {
        return fail(`冲突证据未并列呈现（A=${sideA ? '有' : '缺'}，B=${sideB ? '有' : '缺'}）`)
      }
      if (!weighted) return fail('缺少证据强度 / 可复现性加权提示')
      return pass('冲突双方并列 + 加权提示均在场')
    }

    case 'planning-override-contract': {
      if (fixture.manual_override !== 'planning') return fail('fixture 未声明 manual_override=planning')
      if (!plan.overridden || plan.classifier.prompt_type !== 'planning') {
        return fail('手动 override 未被严格尊重（发生 AUTO 分类或类型不符）')
      }
      const optimized = String(result.optimized_prompt ?? '')
      const missingSections = (params.sections ?? []).filter(
        (section) => !optimized.includes(String(section)),
      )
      if (missingSections.length) return fail(`优化稿缺少契约段落:${missingSections.join('、')}`)
      const markers = [
        COMPILE_MARKERS.explicit,
        COMPILE_MARKERS.context,
        COMPILE_MARKERS.suggested,
        COMPILE_MARKERS.unknown,
        COMPILE_MARKERS.optimized,
      ]
      const fourPart =
        markers.every((marker) => String(rawOutput ?? '').includes(marker)) ||
        /##\s*明确要求/.test(String(rawOutput ?? ''))
      if (!fourPart) return fail('四段协议标记不完整（无法机械解析来源）')
      if (params.expect_provenance_ok === true && result.provenance_ok !== true) {
        return fail(`期望 provenance_ok=true，实际 ${result.provenance_ok}`)
      }
      return pass('override 契约 / 16 段 / 四段协议 / provenance 全部满足')
    }

    case 'explicit-priority-current-over-historical': {
      const current = String(params.current_override ?? '')
      const historical = String(params.historical_fact ?? '')
      const explicitText = (result.explicit_requirements ?? [])
        .map((record) => String(record.text ?? ''))
        .join('\n')
      const contextText = (result.context_requirements ?? [])
        .map((record) => String(record.text ?? ''))
        .join('\n')
      const optimized = String(result.optimized_prompt ?? '')
      if (!optimized.includes(current) && !explicitText.includes(current)) {
        return fail(`当前明确指令「${current}」未被采用`)
      }
      if (historical && explicitText.includes(historical)) {
        return fail(`历史设定「${historical}」被错误标记为当前明确要求（优先级倒置）`)
      }
      const historicalPresent = surface.includes(historical)
      const attributedToHistory = historical && contextText.includes(historical)
      if (historicalPresent && !attributedToHistory && !OVERRIDE_RE.test(surface)) {
        return fail(`历史设定「${historical}」出现但未标注为历史 / 未声明被当前指令覆盖`)
      }
      return pass('CURRENT USER EXPLICIT > HISTORICAL USER EXPLICIT 优先级成立')
    }

    default:
      return fail(`未实现的 canonical 检查 id:${id}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 开销测量（G-2 追加要求 A）
// ─────────────────────────────────────────────────────────────────────────────

function stat(values) {
  if (!values.length) return { min: null, avg: null, max: null }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length
  return { min, avg: Math.round(avg * 100) / 100, max }
}

/** 每次调用一条记录；token 用项目自身 `estimateTokens`（不依赖分词器）。 */
export function measureCall({ fixture, strategy, phase, system, user, latencyMs, usage }) {
  const systemTokens = estimateTokens(String(system ?? ''))
  const contextTokens = estimateTokens(String(user ?? ''))
  const estimatedTotal = systemTokens + contextTokens
  const actualTotal =
    usage && Number.isFinite(usage.prompt_tokens) ? Number(usage.prompt_tokens) : null
  return {
    fixture_id: fixture?.id ?? null,
    strategy: strategy ?? null,
    phase,
    system_tokens: systemTokens,
    context_tokens: contextTokens,
    total_input_tokens: actualTotal ?? estimatedTotal,
    estimated_total_input_tokens: estimatedTotal,
    actual_prompt_tokens: actualTotal,
    completion_tokens:
      usage && Number.isFinite(usage.completion_tokens) ? Number(usage.completion_tokens) : null,
    latency_ms: Math.round(Number(latencyMs ?? 0) * 100) / 100,
    usage_available: Boolean(usage),
  }
}

/** 按 strategy → phase 聚合 min/avg/max（分 classify / compile；evaluator 另计）。 */
export function summarizeCosts(records) {
  const byStrategy = {}
  const ensure = (strategy, phase) => {
    byStrategy[strategy] ??= {}
    byStrategy[strategy][phase] ??= {
      calls: 0,
      system_tokens: [],
      context_tokens: [],
      total_input_tokens: [],
      latency_ms: [],
      actual_prompt_tokens: [],
    }
    return byStrategy[strategy][phase]
  }
  for (const record of records) {
    const bucket = ensure(record.strategy ?? 'unknown', record.phase ?? 'unknown')
    bucket.calls += 1
    bucket.system_tokens.push(record.system_tokens)
    bucket.context_tokens.push(record.context_tokens)
    bucket.total_input_tokens.push(record.total_input_tokens)
    bucket.latency_ms.push(record.latency_ms)
    if (record.actual_prompt_tokens !== null) bucket.actual_prompt_tokens.push(record.actual_prompt_tokens)
  }
  const out = {}
  for (const [strategy, phases] of Object.entries(byStrategy)) {
    out[strategy] = {}
    for (const [phase, bucket] of Object.entries(phases)) {
      out[strategy][phase] = {
        calls: bucket.calls,
        system_tokens: stat(bucket.system_tokens),
        context_tokens: stat(bucket.context_tokens),
        total_input_tokens: stat(bucket.total_input_tokens),
        latency_ms: stat(bucket.latency_ms),
        actual_prompt_tokens: bucket.actual_prompt_tokens.length
          ? stat(bucket.actual_prompt_tokens)
          : null,
      }
    }
    // strategy 级合计（classify + compile；evaluator 单独可查）。
    const totals = Object.values(out[strategy])
    out[strategy]._total = {
      calls: totals.reduce((sum, item) => sum + item.calls, 0),
      system_tokens: stat(bucketValues(phases, 'system_tokens')),
      context_tokens: stat(bucketValues(phases, 'context_tokens')),
      total_input_tokens: stat(bucketValues(phases, 'total_input_tokens')),
      latency_ms: stat(bucketValues(phases, 'latency_ms')),
    }
  }
  return out
}

function bucketValues(phases, key) {
  const values = []
  for (const bucket of Object.values(phases)) {
    values.push(...bucket[key])
  }
  return values
}

// ─────────────────────────────────────────────────────────────────────────────
// adapter 接口 + 内置 mock adapter
// ─────────────────────────────────────────────────────────────────────────────

/** 把任意 adapter 包装成带测量 + 可复用的统一入口。 */
export function instrumentAdapter(adapter, sink, label) {
  return {
    name: adapter.name ?? label ?? 'adapter',
    async call(ctx) {
      const started = Date.now()
      const res = await adapter.call(ctx)
      const latencyMs = Date.now() - started
      sink.push(
        measureCall({
          fixture: ctx.fixture,
          strategy: ctx.strategy,
          phase: ctx.phase,
          system: ctx.system,
          user: ctx.user,
          latencyMs,
          usage: res?.usage,
        }),
      )
      return res
    },
  }
}

/** 把 adapter 适配为 classifyViaLlm 需要的结构化 LLM（stream + resolveModelInfo）。 */
export function adapterAsClassifierLlm(adapter, ctxBase) {
  return {
    stream(options) {
      const system = String(options?.system ?? '')
      const user = extractMessagesText(options?.messages)
      return (async function* generate() {
        const res = await adapter.call({
          ...ctxBase,
          phase: 'classify',
          system,
          user,
          maxTokens: options?.maxTokens,
          temperature: options?.temperature,
          signal: options?.signal,
        })
        yield { type: 'text-delta', text: String(res?.text ?? '') }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    async resolveModelInfo() {
      return undefined
    },
  }
}

/** 从 classifyViaLlm 的最小 Message 结构里取纯文本。 */
export function extractMessagesText(messages) {
  const list = Array.isArray(messages) ? messages : []
  return list
    .map((message) => {
      const content = message?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
          .join('\n')
      }
      return ''
    })
    .join('\n')
}

/** mock 分类 JSON（只做机制冒烟；不声称任何真实分类准确率）。 */
export function mockClassifierJson(fixture) {
  return JSON.stringify({
    prompt_type: fixture.manual_override ?? fixture.expected_type,
    confidence_internal: 0.9,
    missing_constraints: ['mock 适配器占位：本轮未明确、但影响执行的关键信息'],
    rationale: `mock 适配器按 fixture 期望类型返回 ${fixture.expected_type}`,
    evidence_quotes: [],
  })
}

/** 句子切分（中文标点 + 换行；mock 用，不参与真实判定）。 */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[。！？；\n])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

/** mock 优化稿：只复述用户输入 + 策略段落骨架 + 缺口占位，不发明任何事实。 */
export function mockCompileOutput({ fixture, plan, legacy }) {
  const sections = plan?.strategy?.required_sections ?? []
  const missing = plan?.result?.missing_constraints ?? []
  const body = [
    `## ${sections[0] ?? 'Task'}`,
    `- 依据用户输入推进：${fixture.raw_input}`,
    ...sections.slice(1).map((section) => `## ${section}\n- 基于用户输入推进，无额外发明。`),
  ].join('\n')
  if (legacy) {
    return ['ANALYSIS:', 'mock legacy 路径：基于用户输入与既有上下文。', 'OPTIMIZED:', body].join('\n')
  }
  const explicit = splitSentences(fixture.raw_input).map((sentence) => `- ${sentence} [quote: ${sentence}]`)
  const context = (fixture.context ?? [])
    .filter((turn) => turn.role === 'user')
    .map((turn) => `- ${turn.text} [quote: ${turn.text}]`)
  const unknown = missing.map((item) => `- [待补充: ${item.label}]`)
  return [
    COMPILE_MARKERS.diagnosis,
    'mock 诊断：目标与约束来自用户输入，无新增假设。',
    COMPILE_MARKERS.explicit,
    ...(explicit.length ? explicit : ['- (无)']),
    COMPILE_MARKERS.context,
    ...(context.length ? context : ['- (无)']),
    COMPILE_MARKERS.suggested,
    '- (无)',
    COMPILE_MARKERS.unknown,
    ...(unknown.length ? unknown : ['- (无)']),
    COMPILE_MARKERS.optimized,
    body,
    COMPILE_MARKERS.end,
  ].join('\n')
}

/**
 * 内置 mock adapter：仅供离线机制冒烟与 runner 单测。
 * `evaluate` 依据 ctx.deterministic_ok 给出稳定答案（便于反复重跑一致）。
 */
export function createMockAdapter() {
  return {
    name: 'mock',
    async call(ctx) {
      if (ctx.phase === 'classify') return { text: mockClassifierJson(ctx.fixture) }
      if (ctx.phase === 'compile') {
        return { text: mockCompileOutput({ fixture: ctx.fixture, plan: ctx.plan, legacy: ctx.legacy }) }
      }
      if (ctx.phase === 'evaluator') {
        const yes = ctx.deterministic_ok === true
        return {
          text: JSON.stringify({
            answer: yes ? 'yes' : 'no',
            reason: yes ? 'mock：deterministic 已通过' : 'mock：deterministic 未通过',
          }),
        }
      }
      throw new Error(`mock adapter 不支持的 phase:${ctx.phase}`)
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluator（intent-fidelity-v1，参考线；绝不作硬 Gate）
// ─────────────────────────────────────────────────────────────────────────────

export function buildEvaluatorSystem(language = 'zh') {
  if (language === 'en') {
    return [
      `You are the "${EVALUATOR_PROMPT_ID}" regression evaluator (reference line only).`,
      'Judge ONLY from the evidence provided; never assume facts that are absent.',
      'Output a single JSON object: {"answer":"yes"|"no","reason":"one short sentence"}.',
      'Do not score, rank, or output anything else.',
    ].join('\n')
  }
  return [
    `你是「${EVALUATOR_PROMPT_ID}」回归评估器（仅作参考线，不作为发布标准）。`,
    '只依据给定证据判断，不得引入证据之外的事实或假设。',
    '只输出一个 JSON 对象：{"answer":"yes"|"no","reason":"一句话理由"}。',
    '不要打分、排序或输出任何多余内容。',
  ].join('\n')
}

export function buildEvaluatorUser({ fixture, result, question, language = 'zh' }) {
  const context = (fixture.context ?? [])
    .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}: ${turn.text}`)
    .join('\n')
  if (language === 'en') {
    return [
      '# User raw input',
      fixture.raw_input,
      context ? `# Earlier conversation\n${context}` : '',
      '# Optimized prompt',
      String(result.optimized_prompt ?? ''),
      '# Question',
      question,
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  return [
    '# 用户本轮原始输入',
    fixture.raw_input,
    context ? `# 历史会话\n${context}` : '',
    '# 优化后的 Prompt',
    String(result.optimized_prompt ?? ''),
    '# 判定问题',
    question,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 解析 evaluator 输出：只认 JSON `{answer}`，解析不出返回 `unknown`。 */
export function parseEvaluatorAnswer(text) {
  const clean = stripThinkBlocks(String(text ?? '')).trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(clean.slice(start, end + 1))
      const answer = String(parsed?.answer ?? '').toLowerCase()
      if (answer === 'yes' || answer === 'no') {
        return { answer, reason: String(parsed?.reason ?? '') }
      }
    } catch {
      // 落回文本匹配
    }
  }
  if (/^\s*(yes|是|通过)\b/i.test(clean)) return { answer: 'yes', reason: clean.slice(0, 120) }
  if (/^\s*(no|否|不通过)\b/i.test(clean)) return { answer: 'no', reason: clean.slice(0, 120) }
  return { answer: 'unknown', reason: clean.slice(0, 120) }
}

/**
 * 单问评估 + 重跑纪律：
 *   - 第一次为 yes → pass；
 *   - 否则重跑一次；两次不一致（含 unknown）→ inconsistent（不计 PASS）；
 *   - 两次都 no → fail。
 */
export async function evaluateQuestion(
  adapter,
  { fixture, result, question, language, strategy, deterministicOk },
) {
  const ask = () =>
    adapter.call({
      phase: 'evaluator',
      fixture,
      strategy,
      deterministic_ok: deterministicOk,
      system: buildEvaluatorSystem(language),
      user: buildEvaluatorUser({ fixture, result, question, language }),
      temperature: 0,
      maxTokens: 256,
    })
  const attempts = []
  const first = parseEvaluatorAnswer((await ask())?.text)
  attempts.push({ ...first, raw_attempt: 1 })
  if (first.answer === 'yes') {
    return { question, verdict: 'pass', stable: true, attempts }
  }
  const second = parseEvaluatorAnswer((await ask())?.text)
  attempts.push({ ...second, raw_attempt: 2 })
  if (second.answer === first.answer) {
    return { question, verdict: first.answer === 'no' ? 'fail' : 'unparsed', stable: true, attempts }
  }
  return { question, verdict: 'inconsistent', stable: false, attempts }
}

export async function runEvaluator(
  adapter,
  { fixture, result, language, strategy, deterministicOk },
) {
  const questions = fixture.effect?.questions ?? []
  if (!questions.length) return null
  const items = []
  for (const question of questions) {
    items.push(
      await evaluateQuestion(adapter, {
        fixture,
        result,
        question,
        language,
        strategy,
        deterministicOk,
      }),
    )
  }
  const verdict = items.some((item) => item.verdict === 'inconsistent')
    ? 'inconsistent'
    : items.some((item) => item.verdict === 'fail')
      ? 'fail'
      : items.some((item) => item.verdict === 'unparsed')
        ? 'unparsed'
        : 'pass'
  return { evaluator_prompt_id: EVALUATOR_PROMPT_ID, temperature: 0, verdict, questions: items }
}

// ─────────────────────────────────────────────────────────────────────────────
// 单例执行：classify → compile → finalize → validate → deterministic → evaluator
// ─────────────────────────────────────────────────────────────────────────────

/** 分类是否被接受：manual override 必须精确；AUTO 允许 type_alternatives。 */
export function classificationAccepted(fixture, plan) {
  if (fixture.manual_override) {
    return {
      ok: plan.overridden === true && plan.classifier.prompt_type === fixture.manual_override,
      detail: plan.overridden
        ? `manual override=${plan.classifier.prompt_type}`
        : 'manual override 未被识别',
    }
  }
  const accepted = new Set([fixture.expected_type, ...(fixture.type_alternatives ?? [])])
  const ok = accepted.has(plan.classifier.prompt_type)
  return {
    ok,
    detail: ok
      ? `classified=${plan.classifier.prompt_type}（期望 ${fixture.expected_type}）`
      : `classified=${plan.classifier.prompt_type} 不在期望集合 ${[...accepted].join('|')}`,
  }
}

/**
 * 跑单例（纯编排；adapter 可注入）。
 * 返回结构化结果，供报告与 run.test.mjs 断言复用。
 */
export async function runFixture(fixture, { adapter, mode = 'deterministic', language = 'zh', timeoutMs = 60000 } = {}) {
  const problems = []
  const contextTurns = fixture.context ?? []
  const strategyLabel = fixture.manual_override ?? fixture.expected_type
  const base = { fixture_id: fixture.id, expected_type: fixture.expected_type, strategy: strategyLabel }

  // 1. 分类：manual override 函数级旁路；AUTO 走 classifyViaLlm（真实调用面）。
  let classifier
  let classification = null
  if (fixture.manual_override) {
    classifier = manualClassifierResult(fixture.manual_override)
  } else {
    const llm = adapterAsClassifierLlm(adapter, { fixture, strategy: strategyLabel })
    const outcome = await classifyViaLlm(
      llm,
      { provider: adapter.name, model: adapter.name },
      { raw_input: fixture.raw_input, context_turns: contextTurns },
      { language, timeoutMs },
    )
    classifier = outcome.result
    if (outcome.usedFallback) {
      problems.push({
        severity: 'warn',
        rule: 'REGRESSION_CLASSIFY_FALLBACK',
        detail: outcome.reason ?? outcome.failure,
      })
    }
  }

  // 2. 编译编排 + 编译调用（测量 compile 开销）。
  const plan = compilePrompt({
    raw_input: fixture.raw_input,
    turns: contextTurns,
    promptType: fixture.manual_override,
    classifier: fixture.manual_override ? undefined : classifier,
    registry: defaultStrategyRegistry,
    language,
    mode: 'full',
    legacy: isLegacyGeneral(defaultStrategyRegistry.get(strategyLabel)),
  })
  const compileCall = await adapter.call({
    phase: 'compile',
    fixture,
    strategy: plan.strategy.type,
    system: plan.system,
    user: plan.user,
    plan,
    legacy: plan.legacy,
    temperature: 0,
  })
  const rawOutput = String(compileCall?.text ?? '')

  // 3. finalize + validate（与 host 同序：非 legacy 以三层校验覆盖 provenance_ok）。
  const outcome = finalizeCompile(plan.strategy, rawOutput, {
    rawInput: fixture.raw_input,
    contextTurns,
    classifier: plan.classifier,
    missing: plan.result.missing_constraints,
    mode: 'full',
    legacy: plan.legacy,
    language,
  })
  let validation = null
  if (!plan.legacy) {
    validation = validateCompileResult(outcome.result, {
      rawInput: fixture.raw_input,
      contextTurns,
      strategy: plan.strategy,
      rawOutput,
    })
    outcome.result.provenance_ok = validation.provenance_ok
  }

  classification = classificationAccepted(fixture, plan)

  // 4. deterministic 层：invariants（硬 Gate）+ invariant_checks（运行期强制）。
  const surface = deterministicSurface(rawOutput, outcome.result)
  const invariantResults = (fixture.invariants ?? []).map((invariant) =>
    evaluateInvariant(invariant, surface),
  )
  const ctx = {
    fixture,
    result: outcome.result,
    plan,
    rawOutput,
    surface,
    problems: [...outcome.problems, ...(validation?.problems ?? [])],
  }
  const checkResults = (fixture.invariant_checks ?? []).map((check) => runInvariantCheck(check, ctx))
  const deterministicOk = invariantResults.every((item) => item.ok) && checkResults.every((item) => item.ok)

  // 5. evaluator 层（仅 --mode all；参考线，绝不覆盖 deterministic）。
  let evaluator = null
  if (mode === 'all') {
    evaluator = await runEvaluator(adapter, {
      fixture,
      result: outcome.result,
      language,
      strategy: plan.strategy.type,
      deterministicOk,
    })
  }

  const deterministic = {
    ok: deterministicOk,
    invariants: invariantResults,
    invariant_checks: checkResults,
    violations: [...invariantResults, ...checkResults].filter((item) => !item.ok).length,
  }

  const allProblems = [...outcome.problems, ...(validation?.problems ?? [])]
  const seen = new Set()
  const problems2 = []
  for (const problem of allProblems) {
    const key = `${problem.severity}|${problem.rule}|${problem.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    problems2.push(problem)
  }

  return {
    ...base,
    resolved_type: plan.strategy.type,
    overridden: plan.overridden,
    legacy: plan.legacy,
    wellFormed: outcome.wellFormed,
    provenance_ok: outcome.result.provenance_ok,
    classification,
    // 硬 Gate：overall 只看 deterministic；evaluator 仅参考。
    overall: deterministicOk ? 'PASS' : 'FAIL',
    evaluator_used: evaluator !== null,
    evaluator,
    reference_mismatch: Boolean(evaluator && deterministicOk && evaluator.verdict !== 'pass'),
    deterministic,
    result: outcome.result,
    problems: problems2,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 总编排 + 报告
// ─────────────────────────────────────────────────────────────────────────────

/** 跑一批 fixture（adapter 必传；测试与被测逻辑共用同一入口）。 */
export async function runRegression({
  fixtures,
  adapter,
  mode = 'deterministic',
  language = 'zh',
  timeoutMs = 60000,
} = {}) {
  if (!adapter) throw new Error('runRegression 需要 adapter')
  const costRecords = []
  const instrumented = instrumentAdapter(adapter, costRecords, adapter.name)
  const results = []
  for (const fixture of fixtures) {
    results.push(await runFixture(fixture, { adapter: instrumented, mode, language, timeoutMs }))
  }
  const deterministicPass = results.filter((item) => item.deterministic.ok).length
  const evaluatorItems = results.flatMap((item) => item.evaluator?.questions ?? [])
  return {
    results,
    costRecords,
    costs: summarizeCosts(costRecords),
    totals: {
      fixtures: results.length,
      deterministic_pass: deterministicPass,
      deterministic_fail: results.length - deterministicPass,
      classification_pass: results.filter((item) => item.classification.ok).length,
      evaluator_used: mode === 'all',
      evaluator_questions: evaluatorItems.length,
      evaluator_pass: evaluatorItems.filter((item) => item.verdict === 'pass').length,
      evaluator_inconsistent: evaluatorItems.filter((item) => item.verdict === 'inconsistent').length,
    },
  }
}

export function buildReport({ mode, adapterName, run, generatedAt = new Date().toISOString() }) {
  return {
    schema: REPORT_SCHEMA,
    generated_at: generatedAt,
    mode,
    adapter: adapterName,
    evaluator_prompt_id: EVALUATOR_PROMPT_ID,
    // R-2：未校准前不设任何数值阈值；deterministic 是唯一硬 Gate。
    threshold: null,
    threshold_status: THRESHOLD_STATUS,
    gate: 'deterministic',
    totals: run.totals,
    costs: run.costs,
    results: run.results.map((item) => ({
      fixture_id: item.fixture_id,
      expected_type: item.expected_type,
      resolved_type: item.resolved_type,
      overridden: item.overridden,
      legacy: item.legacy,
      wellFormed: item.wellFormed,
      provenance_ok: item.provenance_ok,
      classification: item.classification,
      overall: item.overall,
      deterministic: item.deterministic,
      evaluator_used: item.evaluator_used,
      evaluator: item.evaluator,
      reference_mismatch: item.reference_mismatch,
      problems: item.problems.map((problem) => ({
        severity: problem.severity,
        rule: problem.rule,
        detail: problem.detail,
      })),
    })),
  }
}

export function defaultReportPath(date = new Date()) {
  const iso = date.toISOString().slice(0, 10)
  return join(DEFAULT_REPORT_DIR, `report-${iso}.json`)
}

// ─────────────────────────────────────────────────────────────────────────────
// external adapter 加载（--adapter external --external <path>）
// ─────────────────────────────────────────────────────────────────────────────

export async function loadExternalAdapter(modulePath, options = {}) {
  const url = pathToFileURL(resolve(modulePath)).href
  const mod = await import(url)
  const factory = mod.createAdapter ?? mod.default
  if (typeof factory !== 'function') {
    throw new Error(`external adapter ${modulePath} 必须导出 createAdapter() 或 default()`)
  }
  const adapter = await factory(options)
  if (!adapter || typeof adapter.call !== 'function') {
    throw new Error(`external adapter ${modulePath} 返回值必须实现 call(ctx)`)
  }
  return { name: adapter.name ?? modulePath, call: adapter.call.bind(adapter) }
}

// ─────────────────────────────────────────────────────────────────────────────
// live adapter（DeepSeek；凭据只从 env / 显式路径读取，绝不默认读 ~/.dsh）
// ─────────────────────────────────────────────────────────────────────────────

function readApiKeyFromEnv(envName) {
  const key = process.env[envName] ?? process.env.DSH_REGRESSION_API_KEY
  return key ? String(key).trim() : null
}

function readApiKeyFromYaml(path, envName) {
  const text = readFileSync(path, 'utf8')
  // 按指定 envName 精确匹配 credentials.yaml 的「两空格缩进 KEY: 值」行；
  // 不使用 api_key 泛化备选（避免误取 DEEPSEEK_API_KEY 行——R1 修复）。
  const match = text.match(new RegExp(`^\\s{2}${envName}:\\s*(\\S+)`, 'm'))
  return match ? match[1].replace(/['"]/g, '') : null
}

/**
 * 真实模型 adapter（P07-T03 用）。
 * R1（2026-10-04 用户裁决）：不再默认 DeepSeek（provider/model/baseUrl/apiKeyEnv）。
 * Real-LLM regression 必须显式提供 adapter/provider 配置，否则 fail fast——
 * 禁止隐式回落任何付费 Provider（DeepSeek Official / OpenCode Go / 其它）。
 */
export function createLiveAdapter(options = {}) {
  const {
    provider = '',
    model = '',
    apiKeyEnv = '',
    credentials = null,
    baseUrl = '',
    timeoutMs = 60000,
  } = options
  const missing = []
  if (!provider) missing.push('provider')
  if (!model) missing.push('model')
  if (!baseUrl) missing.push('baseUrl')
  if (!apiKeyEnv && !credentials) missing.push('apiKeyEnv 或 credentials')
  if (missing.length) {
    throw new Error(
      'Real-LLM regression requires an explicit adapter/provider configuration.'
        + ` 缺少: ${missing.join(', ')}`
        + '（--provider/--model/--base-url / --api-key-env 或 --credentials 必须显式给出；'
        + '不默认 DeepSeek 或任何付费 Provider）',
    )
  }
  const apiKey = credentials ? readApiKeyFromYaml(credentials, apiKeyEnv) : readApiKeyFromEnv(apiKeyEnv)
  if (!apiKey) {
    throw new Error(
      `live adapter 缺少凭据：设置 env ${apiKeyEnv}，或显式传入 --credentials <yaml>（不默认读 ~/.dsh）`,
    )
  }
  return {
    name: `live:${provider}/${model}`,
    async call(ctx) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(baseUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: ctx.phase === 'evaluator' ? 0 : 0,
            max_tokens: ctx.maxTokens ?? 2048,
            messages: [
              { role: 'system', content: String(ctx.system ?? '') },
              { role: 'user', content: String(ctx.user ?? '') },
            ],
          }),
          signal: controller.signal,
        })
        if (!res.ok) {
          throw new Error(`live adapter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
        }
        const data = await res.json()
        return {
          text: String(data?.choices?.[0]?.message?.content ?? ''),
          usage: data?.usage ?? undefined,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function selectFixtures(all, ids) {
  if (!ids.length) return all
  const wanted = new Set(ids)
  const selected = all.filter((fixture) => wanted.has(fixture.id))
  const missing = [...wanted].filter((id) => !all.some((fixture) => fixture.id === id))
  if (missing.length) throw new Error(`未找到 fixture:${missing.join(', ')}`)
  return selected
}

async function createAdapter(options) {
  if (options.adapter === 'external') return loadExternalAdapter(options.external, options)
  if (options.adapter === 'live') return createLiveAdapter(options)
  return createMockAdapter()
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const all = loadFixtures()
  const fixtures = selectFixtures(all, options.fixtures)
  const adapter = await createAdapter(options)
  const run = await runRegression({ fixtures, adapter, mode: options.mode, language: options.language, timeoutMs: options.timeoutMs })
  const report = buildReport({ mode: options.mode, adapterName: adapter.name, run })

  for (const item of run.results) {
    const mark = item.overall === 'PASS' ? '✓' : '✗'
    const evaluator =
      item.evaluator_used && item.evaluator ? ` evaluator=${item.evaluator.verdict}` : ''
    console.log(
      `${mark} ${item.fixture_id} [${item.resolved_type}${item.overridden ? ', override' : ''}]` +
        ` deterministic=${item.deterministic.ok ? 'PASS' : 'FAIL'}` +
        ` (${item.deterministic.invariants.filter((i) => i.ok).length}/${item.deterministic.invariants.length} invariants,` +
        ` ${item.deterministic.invariant_checks.filter((i) => i.ok).length}/${item.deterministic.invariant_checks.length} checks)` +
        `${evaluator}`,
    )
    for (const violation of [...item.deterministic.invariants, ...item.deterministic.invariant_checks].filter((i) => !i.ok)) {
      console.log(`    - [${violation.kind ?? 'check'}] ${violation.desc}: ${violation.detail}`)
    }
  }
  console.log(
    `\nregression(mode=${options.mode} adapter=${adapter.name}): deterministic ` +
      `${run.totals.deterministic_pass}/${run.totals.fixtures} PASS` +
      (options.mode === 'all'
        ? `；evaluator 参考线 ${run.totals.evaluator_pass}/${run.totals.evaluator_questions}（inconsistent ${run.totals.evaluator_inconsistent}）`
        : '') +
      `；threshold=${THRESHOLD_STATUS}`,
  )
  if (adapter.name === 'mock') {
    console.log(
      '注意：mock adapter 只验证 runner 机制（调用/测量/报告），不代表模型效果；' +
        '真实效果回归（P07-T03）请用 --adapter live 或 --adapter external。',
    )
  }

  if (options.writeReport) {
    const reportPath = options.report ? resolve(options.report) : defaultReportPath()
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(`报告已写入: ${reportPath}`)
  }

  return run.totals.deterministic_fail === 0 ? 0 : 1
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`[regression] ${error?.stack ?? error}`)
      process.exitCode = 1
    },
  )
}
