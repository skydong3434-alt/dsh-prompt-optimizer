/**
 * 产品定位纠偏 —— 真实模型验收(§二十二/§二十三)。
 *
 * 对每个语料用例驱动**真实宿主**(同一条 POST /dsh-prompt-optimizer/optimize)
 * 与**真实模型**,只检查**产品语义行为**(不比对措辞):
 *   · 是否进入 Discovery / Confirmation
 *   · 是否追问了执行期信息(视频内容/时长/MVP/生产流程…)
 *   · 核心语义是否正确(如 T1 = DSH → ComfyUI 的通用控制能力)
 *   · 允许未知(实现路线可保持未决)
 * 并记录性能:analysis / compile / discovery / confirmation 次数 + 延迟
 * (把**本地流程耗时**与**模型推理耗时**分开:模型耗时由 llmLog 的每次调用时长给出)。
 *
 * 用法:node scripts/simplification-smoke.mjs [--t1 5] [--each 2]
 */
import { Readable } from 'node:stream'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const MODEL = 'deepseek-v4-flash'
const KEY = /OPENCODE_API_KEY:\s*(\S+)/.exec(
  readFileSync(join(process.env.HOME ?? '', '.dsh', '.credentials.yaml'), 'utf8'),
)?.[1]

const ARGV = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = ARGV.indexOf(name)
  return i >= 0 ? Number(ARGV[i + 1]) : dflt
}
const T1_RUNS = argOf('--t1', 5)
const EACH_RUNS = argOf('--each', 2)

const isMeta = (system) => /意图编译器分析器|intent compiler analyzer/.test(String(system ?? ''))

function makeLlm(log) {
  return {
    async *stream(options) {
      const kind = isMeta(options.system) ? 'analysis' : 'compile'
      const entry = { kind, finish: 'stop', text: '', ms: 0 }
      log.push(entry)
      const started = Date.now()
      const body = {
        model: MODEL,
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          ...options.messages.map((m) => ({
            role: 'user',
            content: Array.isArray(m.content) ? m.content.map((c) => c.text ?? '').join('\n') : String(m.content ?? ''),
          })),
        ],
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0,
        stream: true,
      }
      const resp = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-opencode-session': 'dsh-apo-simplify' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        entry.finish = `http-${resp.status}`
        entry.ms = Date.now() - started
        yield { type: 'finish', reason: { kind: 'error', failure: { code: String(resp.status), message: (await resp.text()).slice(0, 120) } } }
        return
      }
      const reader = resp.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let i = 0
      let last = 'stop'
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let s
        while ((s = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, s).trim()
          buf = buf.slice(s + 1)
          if (!line.startsWith('data:')) continue
          const p = line.slice(5).trim()
          if (p === '[DONE]') continue
          try {
            const j = JSON.parse(p)
            const c = j.choices?.[0]
            if (c?.delta?.content) {
              entry.text += c.delta.content
              yield { type: 'text-delta', index: i++, text: c.delta.content }
            }
            if (c?.finish_reason && c.finish_reason !== 'stop') last = c.finish_reason
          } catch { /* ignore */ }
        }
      }
      entry.ms = Date.now() - started
      entry.finish = last === 'length' ? 'max-tokens' : 'stop'
      yield { type: 'finish', reason: { kind: last === 'length' ? 'max-tokens' : 'stop' } }
    },
    listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }],
    listModels: async () => [{ id: MODEL, provider: 'opencode-go', name: MODEL }],
    resolveModelInfo: async () => ({ id: MODEL, provider: 'opencode-go', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  }
}

async function boot() {
  const routes = {}
  const llmLog = []
  const ctx = new Context()
  ctx.provide('httpServer', { register(r) { routes[r.path] = r; return () => {} } })
  ctx.provide('llm', makeLlm(llmLog))
  await ctx.plugin(plugin, {})
  return { routes, llmLog }
}

async function call(routes, body) {
  const handler = routes['/dsh-prompt-optimizer/optimize'].handler
  const res = { status: 0, headers: {}, body: '', writableEnded: false, destroyed: false, on() {}, writeHead(s, h) { res.status = s; res.headers = h ?? {} }, write(c) { res.body += c; return true }, end(p) { if (p) res.body += p; res.writableEnded = true } }
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'
  req.headers = {}
  await handler(req, res)
  return res.body.split('\n\n').filter(Boolean).map((f) => {
    const l = f.split('\n').find((x) => x.startsWith('data:'))
    return l ? JSON.parse(l.slice(5).trim()) : null
  }).filter(Boolean)
}

const answersFor = (qs) => (qs ?? []).map((q) => {
  const pick = (q.options ?? [])[0]
  return pick ? { key: q.key, option_id: pick.id, text: pick.label } : { key: q.key, text: '保持未确定', blind_trust: true }
})

/** 跑到终态(含语义澄清 → 回答 → 确认 → 编译),记录各阶段次数。 */
async function runCase(routes, text, { context, maxSteps = 6 } = {}) {
  const t0 = Date.now()
  const stages = []
  const askedQuestions = []
  let discoveryCount = 0
  let confirmationCount = 0
  let events = await call(routes, { text, provider: 'opencode-go', model: MODEL, ...(context ? { context } : {}) })
  stages.push(events.filter((e) => e.type !== 'delta').map((e) => e.type).join(','))
  let ledger = [], analysis = null, asked = [], questions = [], triage = 'REBUILD'
  for (let step = 1; step <= maxSteps; step += 1) {
    const done = events.find((e) => e.type === 'done')
    if (done) return { done, events, stages, askedQuestions, discoveryCount, confirmationCount, totalMs: Date.now() - t0 }
    const d = events.find((e) => e.type === 'discovery_required')
    const c = events.find((e) => e.type === 'requirement_confirmation')
    if (!d && !c) return { done: null, events, stages, askedQuestions, discoveryCount, confirmationCount, totalMs: Date.now() - t0 }
    ledger = d?.ledger ?? c?.ledger ?? ledger
    analysis = d?.analysis ?? c?.analysis ?? analysis
    asked = d?.asked ?? c?.asked ?? asked
    questions = d?.questions ?? questions
    triage = d?.triage?.triage ?? c?.triage?.triage ?? triage
    if (d) {
      discoveryCount += 1
      askedQuestions.push(...(d.questions ?? []).map((q) => String(q.question ?? '')))
      events = await call(routes, { text, provider: 'opencode-go', model: MODEL, ...(context ? { context } : {}), discovery: { mode: 'answer', round: step, triage, ledger, asked, questions, answers: answersFor(d.questions), analysis } })
    } else {
      confirmationCount += 1
      events = await call(routes, { text, provider: 'opencode-go', model: MODEL, ...(context ? { context } : {}), discovery: { mode: 'confirm', round: step, triage, ledger, asked, answers: [], questions: [], analysis } })
    }
    stages.push(events.filter((e) => e.type !== 'delta').map((e) => e.type).join(','))
  }
  return { done: null, events, stages, askedQuestions, discoveryCount, confirmationCount, totalMs: Date.now() - t0 }
}

// ── 语料与判据 ──────────────────────────────────────────────────────────────
const CASES = {
  T1: {
    text: '我想用 dsh 控制 comfyui 生成视频。',
    check: (r) => {
      const out = r.done?.optimized ?? ''
      return {
        // ★ 产品语义行为(与模型措辞无关,必须全绿)
        noDiscovery: r.discoveryCount === 0,
        noConfirmation: r.confirmationCount === 0,
        noExecutionQuestions: !/时长|测试片|正式片|MVP|最小链路|生产流程|文生视频|图生视频/.test(r.askedQuestions.join(' ')),
        // 交付成功时:核心语义 = DSH 控制 ComfyUI 的通用能力;实现路线允许未决;
        // 不得把「某一个具体视频」当成任务核心(否定式表述不算违规)
        coreMeaning: !r.done || (/dsh/i.test(out) && /comfyui/i.test(out)),
        allowedUnknown: !r.done || /尚未确定|未确定|后续|调研|评估|自行确认|执行方确认/.test(out) || (r.done?.unknowns ?? []).length > 0 || (r.done?.missing_resolution ?? []).some((i) => !i.blocking),
        notAboutOneVideo: !r.done || (!/[0-9]+\s*秒/.test(out) && !/^\s*时长[:：]/m.test(out) && !/测试片还是正式/.test(out)),
        // 交付与否单独记录:未交付 = 模型侧空/无效响应(安全终态),不是产品语义失败
        completed: Boolean(r.done),
      }
    },
  },
  T2: { text: '我想做一个 AI 知识库。', check: (r) => ({ noDiscovery: r.discoveryCount === 0, completed: Boolean(r.done) }) },
  T3: { text: '我想做一个语言交换 App。', check: (r) => ({ noDiscovery: r.discoveryCount === 0, completed: Boolean(r.done) }) },
  T4: { text: '先看看能不能实现这个功能。', context: [{ role: 'user', text: '我在做一个 CSV 汇总工具' }], check: (r) => ({ noDiscovery: r.discoveryCount === 0, completed: Boolean(r.done) }) },
  T5: { text: '继续做这个项目。', context: [{ role: 'user', text: '我们在做一个爬虫项目' }], check: (r) => ({ noDiscovery: r.discoveryCount === 0, completed: Boolean(r.done) }) },
  T8: {
    text: '1. 先跑一遍测试\n2. 再看失败日志\n3. 输出 Markdown 表格',
    check: (r) => ({
      triagePatch: r.done?.triage?.triage === 'PATCH',
      keptAll: ['先跑一遍测试', '失败日志', 'Markdown'].every((k) => (r.done?.optimized ?? '').includes(k)) ||
        ['失败日志', 'Markdown'].every((k) => (r.done?.optimized ?? '').includes(k)),
      completed: Boolean(r.done),
    }),
  },
  T11: {
    text: '写一个二次元女孩的生图提示词。',
    check: (r) => ({
      imageTarget: r.done?.target?.target === 'image_generation' || r.done?.contract === 'image',
      noTaskTemplate: !/(^|\n)\s*#{0,6}\s*\**\s*(Goal|Phase|Tasks?|Acceptance|Definition of Done)\b/im.test(r.done?.optimized ?? ''),
      completed: Boolean(r.done),
    }),
  },
  T12: {
    text: '帮我写一个可灵首帧图生视频提示词。',
    check: (r) => ({
      videoTarget: r.done?.target?.target === 'video_generation' || r.done?.contract === 'video',
      noTaskTemplate: !/(^|\n)\s*#{0,6}\s*\**\s*(Goal|Phase|Tasks?|Acceptance|Definition of Done)\b/im.test(r.done?.optimized ?? ''),
      completed: Boolean(r.done),
    }),
  },
  T13: {
    text: '根据上面的方案,现在开始实现。',
    context: [{ role: 'user', text: '方案:先做 CLI,再补 Web 界面' }],
    check: (r) => ({ noDiscovery: r.discoveryCount === 0, completed: Boolean(r.done) }),
  },
}

const rows = []
const runOne = async (id, spec) => {
  const { routes, llmLog } = await boot()
  const r = await runCase(routes, spec.text, { context: spec.context })
  const checks = spec.check(r)
  const pass = Object.values(checks).every((v) => v === true)
  const analysisCalls = llmLog.filter((l) => l.kind === 'analysis')
  const compileCalls = llmLog.filter((l) => l.kind === 'compile')
  const row = {
    case: id,
    pass,
    checks,
    stages: r.stages,
    discovery: r.discoveryCount,
    confirmation: r.confirmationCount,
    asked: r.askedQuestions,
    analysisCalls: analysisCalls.length,
    compileCalls: compileCalls.length,
    modelMs: llmLog.reduce((sum, l) => sum + l.ms, 0),
    totalMs: r.totalMs,
    optimizedLen: r.done?.optimized?.length ?? 0,
    optimized: r.done?.optimized ?? null,
  }
  rows.push(row)
  console.log(
    `${pass ? 'PASS' : 'FAIL'} ${id} | discovery=${r.discoveryCount} confirmation=${r.confirmationCount} ` +
      `| llm=${analysisCalls.length}+${compileCalls.length} | model=${(row.modelMs / 1000).toFixed(1)}s total=${(row.totalMs / 1000).toFixed(1)}s ` +
      `| ${JSON.stringify(checks)}`,
  )
  if (r.askedQuestions.length) console.log(`      追问:${JSON.stringify(r.askedQuestions)}`)
  return row
}

for (let i = 1; i <= T1_RUNS; i += 1) {
  console.log(`--- T1 run ${i}/${T1_RUNS} ---`)
  await runOne('T1', CASES.T1)
}
for (const id of ['T2', 'T3', 'T4', 'T5', 'T8', 'T11', 'T12', 'T13']) {
  for (let i = 1; i <= EACH_RUNS; i += 1) {
    console.log(`--- ${id} run ${i}/${EACH_RUNS} ---`)
    await runOne(id, CASES[id])
  }
}

const summary = {}
for (const row of rows) {
  summary[row.case] = summary[row.case] ?? { runs: 0, pass: 0, discovery: 0, confirmation: 0 }
  summary[row.case].runs += 1
  if (row.pass) summary[row.case].pass += 1
  summary[row.case].discovery += row.discovery
  summary[row.case].confirmation += row.confirmation
}
console.log('\n=== 汇总 ===')
for (const [id, s] of Object.entries(summary)) {
  console.log(`${id}: PASS ${s.pass}/${s.runs} | discovery ${s.discovery} | confirmation ${s.confirmation}`)
}
const t1 = rows.filter((r) => r.case === 'T1')
if (t1.length) {
  const avg = (f) => t1.reduce((sum, r) => sum + f(r), 0) / t1.length
  console.log(
    `T1 性能:平均 model ${(avg((r) => r.modelMs) / 1000).toFixed(1)}s / total ${(avg((r) => r.totalMs) / 1000).toFixed(1)}s ` +
      `| 平均 LLM 调用 ${avg((r) => r.analysisCalls + r.compileCalls).toFixed(1)} 次(analysis ${avg((r) => r.analysisCalls).toFixed(1)} + compile ${avg((r) => r.compileCalls).toFixed(1)})`,
  )
}
mkdirSync(join(ROOT, 'logs', 'simplification'), { recursive: true })
const out = join(ROOT, 'logs', 'simplification', `real-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL, rows, summary }, null, 2))
console.log(`JSON: ${out}`)
