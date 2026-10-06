/**
 * v0.2.0-apo Release Smoke —— 用**准备发布的构建**驱动真实宿主处理器(与 Desktop UI 调用的
 * 同一条路由 `/dsh-prompt-optimizer/optimize`),覆盖 8 条用户路径 A–H。
 *
 * 说明:本脚本验证的是**产品代码 + 真实模型**的端到端行为(宿主 handler / 路由 / 分析 /
 * 编译 / 校验 / SSE 事件序)。真实 **GUI 点击**路径需由用户在 DSH Desktop 里确认
 * (浏览器信任围栏禁止外部注入),对应步骤写在 docs/release-smoke-v0.2.0-apo.md。
 *
 * 用法:node scripts/release-smoke-v0.2.0-apo.mjs
 * 凭据:只从 ~/.dsh/.credentials.yaml 读,绝不打印。
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
const KEY = /OPENCODE_API_KEY:\s*(\S+)/.exec(readFileSync(join(process.env.HOME ?? '', '.dsh', '.credentials.yaml'), 'utf8'))?.[1]

function makeLlm() {
  return {
    async *stream(options) {
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
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        stream: true,
      }
      const resp = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-opencode-session': 'dsh-apo-release-smoke' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: String(resp.status), message: (await resp.text()).slice(0, 160) } } }
        return
      }
      const reader = resp.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let index = 0
      let last = 'stop'
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let sep
        while ((sep = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, sep).trim()
          buf = buf.slice(sep + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const json = JSON.parse(payload)
            const choice = json.choices?.[0]
            if (choice?.delta?.content) yield { type: 'text-delta', index: index++, text: choice.delta.content }
            if (choice?.finish_reason && choice.finish_reason !== 'stop') last = choice.finish_reason
          } catch {
            /* ignore */
          }
        }
      }
      yield { type: 'finish', reason: { kind: last === 'length' ? 'max-tokens' : 'stop' } }
    },
    listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }],
    listModels: async () => [{ id: MODEL, provider: 'opencode-go', name: MODEL }],
    resolveModelInfo: async () => ({ id: MODEL, provider: 'opencode-go', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  }
}

const isMeta = (system) => /意图编译器分析器|intent compiler analyzer/.test(String(system ?? ''))

async function boot() {
  const routes = {}
  const calls = []
  const llmLog = []
  const ctx = new Context()
  ctx.provide('httpServer', {
    register(r) {
      routes[r.path] = r
      return () => {}
    },
  })
  ctx.provide('llm', {
    async *stream(options) {
      calls.push(options)
      const kind = isMeta(options.system) ? 'analysis' : 'compile'
      const entry = { kind, finish: 'stop', textLen: 0 }
      llmLog.push(entry)
      for await (const chunk of makeLlm().stream(options)) {
        if (chunk.type === 'text-delta') entry.textLen += chunk.text.length
        if (chunk.type === 'finish') entry.finish = chunk.reason?.kind ?? 'stop'
        yield chunk
      }
    },
    listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }],
    listModels: async () => [{ id: MODEL, provider: 'opencode-go', name: MODEL }],
    resolveModelInfo: async () => ({ id: MODEL, provider: 'opencode-go', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  })
  await ctx.plugin(plugin, {})
  return { routes, calls, llmLog }
}

async function call(routes, body) {
  const handler = routes['/dsh-prompt-optimizer/optimize'].handler
  const res = {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    on() {},
    writeHead(s, h) {
      res.status = s
      res.headers = h ?? {}
    },
    write(c) {
      res.body += c
      return true
    },
    end(p) {
      if (p) res.body += p
      res.writableEnded = true
    },
  }
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'
  req.headers = {}
  await handler(req, res)
  return res.body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      return line ? JSON.parse(line.slice(5).trim()) : null
    })
    .filter(Boolean)
}

/**
 * 走完整真实闭环(与 UI 一致):optimize → 最多 3 轮 Discovery 问答 → confirm → done。
 * 每一轮都把「新提出的问题」按推荐项回答(无选项的机械决策项用「按你的判断继续」)。
 */
async function runFullFlow(routes, text, { maxRounds = 3 } = {}) {
  const stages = []
  const calls = []
  let events = await call(routes, { text, provider: 'opencode-go', model: MODEL })
  calls.push(events)
  let discovery = events.find((e) => e.type === 'discovery_required')
  let confirmation = events.find((e) => e.type === 'requirement_confirmation')
  let done = events.find((e) => e.type === 'done')
  stages.push(discovery ? 'analyzing→discovery_required' : confirmation ? 'requirement_confirmation' : done ? 'compiling→validating→complete' : '(none)')
  let round = 0
  let ledger = discovery?.ledger ?? confirmation?.ledger ?? []
  let analysis = discovery?.analysis ?? confirmation?.analysis ?? null
  let asked = discovery?.asked ?? confirmation?.asked ?? []
  let questions = discovery?.questions ?? []
  let triage = discovery?.triage?.triage ?? confirmation?.triage?.triage ?? 'REBUILD'
  // +1:轮次上限用尽后仍需再走一次 confirm(否则停在确认页,无法进入编译)
  while (!done && (discovery || confirmation) && round < maxRounds + 1) {
    round += 1
    if (discovery) {
      const answers = (discovery.questions ?? []).map((q) => {
        const pick = q.options.find((o) => o.id === q.recommended_option_id) ?? q.options[0]
        return pick
          ? { key: q.key, option_id: pick.id, text: pick.label }
          : { key: q.key, text: '按你的判断继续', blind_trust: true }
      })
      events = await call(routes, {
        text,
        provider: 'opencode-go',
        model: MODEL,
        discovery: { mode: 'answer', round, triage, ledger, asked, questions, answers, analysis },
      })
    } else {
      events = await call(routes, {
        text,
        provider: 'opencode-go',
        model: MODEL,
        discovery: { mode: 'confirm', round, triage, ledger, asked, answers: [], questions: [], analysis },
      })
    }
    calls.push(events)
    done = events.find((e) => e.type === 'done')
    discovery = events.find((e) => e.type === 'discovery_required')
    confirmation = events.find((e) => e.type === 'requirement_confirmation')
    stages.push(done ? 'compiling→validating→complete' : discovery ? `discovery_required(round ${round + 1})` : confirmation ? 'requirement_confirmation' : '(none)')
    ledger = discovery?.ledger ?? confirmation?.ledger ?? ledger
    analysis = discovery?.analysis ?? confirmation?.analysis ?? analysis
    asked = discovery?.asked ?? confirmation?.asked ?? asked
    questions = discovery?.questions ?? []
  }
  return { calls, events, done, discovery, confirmation, stages, ledger, analysis, rounds: round }
}



// ── C / E 重复取证(≥5 次/条) ───────────────────────────────────────────────
const MESSY = [
  '帮我做个小工具,要求是能读 csv 然后汇总,输出格式要 markdown 表格,输出格式要 markdown 表格,',
  '另外要快一点别卡,另外要快一点别卡,字段要能自动识别,字段要能自动识别,不用装数据库,不用装数据库,',
  '最好支持中文列名,最好支持中文列名,跑完给个总数,跑完给个总数,别的先不用管,别的先不用管。',
].join(' ')
const IMAGE_INPUT = '二次元女孩坐在未来 AI 工作台前,三栏桌面布局,冷蓝色屏幕光,帮我生成生图提示词。'
const ROUNDS = Number(process.env.APO_CE_ROUNDS ?? 5)
const rows = []
for (let i = 1; i <= ROUNDS; i += 1) {
  // C
  {
    const { routes, llmLog } = await boot()
    const flow = await runFullFlow(routes, MESSY)
    const out = String(flow.done?.optimized ?? '')
    const noNewGoals = !/(微服务|数据库集群|权限系统|多用户|部署到云)/.test(out)
    const pass = flow.done?.triage?.triage === 'RESTRUCTURE' && noNewGoals && out.length > 0
    const t = terminalOf(flow.calls[flow.calls.length - 1], llmLog)
    rows.push({ round: i, path: 'C', pass, verdict: pass ? 'PASS' : classify(flow.calls[flow.calls.length - 1], llmLog), terminal: t.lastEvent, seq: t.sequence, err: t.errorCode, ret: t.returnedCode, llm: t.llm, chars: out.length })
    console.log(`C round ${i}: ${pass ? 'PASS' : 'FAIL'} | 终态=${t.lastEvent} | seq=${t.sequence} | err=${t.errorCode ?? '-'} | ret=${t.returnedCode ?? '-'} | llm=${t.llm} | 定性=${pass ? 'PASS' : classify(flow.calls[flow.calls.length - 1], llmLog)}`)
  }
  // E
  {
    const { routes, llmLog } = await boot()
    const flow = await runFullFlow(routes, IMAGE_INPUT)
    const out = String(flow.done?.optimized ?? '')
    const noTaskTemplate = !/(^|\n)\s*#{0,6}\s*\**\s*(Goal|Phase|Tasks?|Acceptance|Definition of Done)\b/im.test(out)
    const pass = flow.done?.contract === 'image' && noTaskTemplate && out.length > 0
    const t = terminalOf(flow.calls[flow.calls.length - 1], llmLog)
    rows.push({ round: i, path: 'E', pass, verdict: pass ? 'PASS' : classify(flow.calls[flow.calls.length - 1], llmLog), terminal: t.lastEvent, seq: t.sequence, err: t.errorCode, ret: t.returnedCode, llm: t.llm, chars: out.length })
    console.log(`E round ${i}: ${pass ? 'PASS' : 'FAIL'} | 终态=${t.lastEvent} | seq=${t.sequence} | err=${t.errorCode ?? '-'} | ret=${t.returnedCode ?? '-'} | llm=${t.llm} | 定性=${pass ? 'PASS' : classify(flow.calls[flow.calls.length - 1], llmLog)}`)
  }
}
const summary = { C: rows.filter((r) => r.path === 'C'), E: rows.filter((r) => r.path === 'E') }
for (const key of ['C', 'E']) {
  const list = summary[key]
  const pass = list.filter((r) => r.pass).length
  const productFail = list.filter((r) => !r.pass && r.verdict === 'PRODUCT_DEFECT').length
  const provider = list.filter((r) => !r.pass && r.verdict === 'PROVIDER_TRANSIENT').length
  console.log(`${key}: PASS ${pass}/${list.length} | PRODUCT_DEFECT ${productFail} | PROVIDER_TRANSIENT ${provider}`)
}
mkdirSync(join(ROOT, 'logs', 'release'), { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outPath = join(ROOT, 'logs', 'release', `smoke-cE-${stamp}.json`)
writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), baseline: '895feeb', rounds: ROUNDS, rows }, null, 2))
console.log(`JSON: ${outPath}`)
