/**
 * Release Blocker Diagnostics —— 只做**观察**,不改产品逻辑。
 *
 * 目的(用户 §一):拿到三个完整证据
 *   A. E 的 suggestion-upgrade trigger(完整建议文本 / 原始分组 / recovery 后 provenance /
 *      正文对应文本 / validator 命中句 / 判定 SAFE_SYNTHESIS vs BINDING_SUGGESTION)
 *   B. [r-3] 的 provenance trace(claimed evidence / claimed provenance / 机械解析 / 最终分类)
 *   C. B 的 mechanical / model / final triage + 实际改动范围
 *
 * 用法:
 *   node scripts/release-diag.mjs --case E --runs 3
 *   node scripts/release-diag.mjs --case B --runs 3
 *   node scripts/release-diag.mjs --selftest          # 证明 diag JSON 真的含所需字段
 *
 * 输出:logs/release-blockers/diag/<case>/<ts>.json(完整,不过滤)
 */
import { Readable } from 'node:stream'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { mechanicalTriage, decideTriage } from '../lib/core/triage.js'
import { parseCompileOutput } from '../lib/core/compiler.js'
import { parseAnalysisResult } from '../lib/core/analyze.js'
import { resolveQuoteSource } from '../lib/core/provenance.js'
import { decisionCategoryOfRequirement } from '../lib/core/requirements.js'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const MODEL = 'deepseek-v4-flash'
const KEY = /OPENCODE_API_KEY:\s*(\S+)/.exec(readFileSync(join(process.env.HOME ?? '', '.dsh', '.credentials.yaml'), 'utf8'))?.[1]

const ARGV = process.argv.slice(2)
const CASE = (() => {
  const i = ARGV.indexOf('--case')
  return i >= 0 ? ARGV[i + 1].toUpperCase() : null
})()
const RUNS = (() => {
  const i = ARGV.indexOf('--runs')
  return i >= 0 ? Number(ARGV[i + 1]) : 1
})()
const SELFTEST = ARGV.includes('--selftest')

// ── host 日志捕获(不过滤;用于拿 recovery 审计与 validator trigger) ──────────
const HOST_LOGS = []
const origLog = console.log
const origErr = console.error
console.log = (...a) => { HOST_LOGS.push(`LOG ${a.join(' ')}`); origLog(...a) }
console.error = (...a) => { HOST_LOGS.push(`ERR ${a.join(' ')}`); origErr(...a) }
const hostLines = (re) => HOST_LOGS.filter((l) => re.test(l)).map((l) => l.replace(/^\[dsh-prompt-optimizer\]\s*/, '').replace(/^(LOG|ERR) /, ''))

const isMeta = (system) => /意图编译器分析器|intent compiler analyzer/.test(String(system ?? ''))

function makeLlm(log) {
  return {
    async *stream(options) {
      const kind = isMeta(options.system) ? 'analysis' : 'compile'
      const entry = { kind, finish: 'stop', text: '' }
      log.push(entry)
      const body = {
        model: MODEL,
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          ...options.messages.map((m) => ({ role: 'user', content: Array.isArray(m.content) ? m.content.map((c) => c.text ?? '').join('\n') : String(m.content ?? '') })),
        ],
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0,
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        stream: true,
      }
      const resp = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-opencode-session': 'dsh-apo-diag' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) { entry.finish = `http-${resp.status}`; yield { type: 'finish', reason: { kind: 'error', failure: { code: String(resp.status), message: (await resp.text()).slice(0, 160) } } }; return }
      const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = ''; let i = 0; let last = 'stop'
      for (;;) {
        const { done, value } = await reader.read(); if (done) break
        buf += dec.decode(value, { stream: true })
        let s
        while ((s = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, s).trim(); buf = buf.slice(s + 1)
          if (!line.startsWith('data:')) continue
          const p = line.slice(5).trim(); if (p === '[DONE]') continue
          try {
            const j = JSON.parse(p); const c = j.choices?.[0]
            if (c?.delta?.content) { entry.text += c.delta.content; yield { type: 'text-delta', index: i++, text: c.delta.content } }
            if (c?.finish_reason && c.finish_reason !== 'stop') last = c.finish_reason
          } catch { /* ignore */ }
        }
      }
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
  req.method = 'POST'; req.headers = {}
  await handler(req, res)
  return res.body.split('\n\n').filter(Boolean).map((f) => { const l = f.split('\n').find((x) => x.startsWith('data:')); return l ? JSON.parse(l.slice(5).trim()) : null }).filter(Boolean)
}

const answersFor = (qs) => (qs ?? []).map((q) => {
  const pick = (q.options ?? []).find((o) => o.id === q.recommended_option_id) ?? (q.options ?? [])[0]
  return pick ? { key: q.key, option_id: pick.id, text: pick.label } : { key: q.key, text: '按你的判断继续', blind_trust: true }
})

async function runFullFlow(routes, text, maxSteps = 5) {
  const steps = []
  let events = await call(routes, { text, provider: 'opencode-go', model: MODEL })
  steps.push(events.filter((e) => e.type !== 'delta').map((e) => e.type).join(','))
  let ledger = [], analysis = null, asked = [], questions = [], triage = 'REBUILD'
  for (let step = 1; step <= maxSteps; step += 1) {
    const done = events.find((e) => e.type === 'done')
    if (done) return { done, events, steps, ledger }
    const d = events.find((e) => e.type === 'discovery_required')
    const c = events.find((e) => e.type === 'requirement_confirmation')
    if (!d && !c) return { done: null, events, steps, ledger }
    ledger = d?.ledger ?? c?.ledger ?? ledger
    analysis = d?.analysis ?? c?.analysis ?? analysis
    asked = d?.asked ?? c?.asked ?? asked
    questions = d?.questions ?? questions
    triage = d?.triage?.triage ?? c?.triage?.triage ?? triage
    events = d
      ? await call(routes, { text, provider: 'opencode-go', model: MODEL, discovery: { mode: 'answer', round: step, triage, ledger, asked, questions, answers: answersFor(d.questions), analysis } })
      : await call(routes, { text, provider: 'opencode-go', model: MODEL, discovery: { mode: 'confirm', round: step, triage, ledger, asked, answers: [], questions: [], analysis } })
    steps.push(events.filter((e) => e.type !== 'delta').map((e) => e.type).join(','))
  }
  return { done: null, events, steps, ledger }
}

// ── 证据组装 ────────────────────────────────────────────────────────────────
const CASES = {
  B: '1. 先跑一遍测试\n2. 再看失败日志\n3. 输出格式:Markdown 表格',
  E: '二次元女孩坐在未来 AI 工作台前,三栏桌面布局,冷蓝色屏幕光,帮我生成生图提示词。',
}

/** SAFE_SYNTHESIS vs BINDING_SUGGESTION(用户 §四 的机械判据)。 */
function classifySuggestion(text) {
  const category = decisionCategoryOfRequirement(text)
  if (category) return { verdict: 'BINDING_SUGGESTION', category }
  return { verdict: 'SAFE_SYNTHESIS', category: null }
}

function buildDiag({ caseId, run, rawInput, llmLog, flow, hostLogs }) {
  const analysisText = llmLog.filter((l) => l.kind === 'analysis').map((l) => l.text).join('\n---\n')
  const compileText = llmLog.filter((l) => l.kind === 'compile').map((l) => l.text).join('\n---\n')
  const parsed = compileText ? parseCompileOutput(compileText) : null
  const mech = mechanicalTriage(rawInput)
  let modelTriage = null
  let mergedTriage = null
  if (analysisText) {
    const a = parseAnalysisResult(analysisText, { rawInput, contextTurns: [] })
    modelTriage = a.result?.triage?.triage ?? null
    mergedTriage = a.result?.triage?.triage ?? null
  }
  const decided = decideTriage({ raw_input: rawInput, advised: modelTriage ?? undefined })
  const evidenceTrace = (parsed?.explicit_requirements ?? []).map((r) => {
    const quote = r.evidence[0] ?? ''
    const resolution = quote ? resolveQuoteSource(quote, rawInput, []) : { valid: false, matchedIn: 'none' }
    return {
      id: r.id,
      text: r.text,
      claimedProvenance: r.source,
      evidenceQuote: quote,
      mechanicalResolution: { valid: resolution.valid, matchedIn: resolution.matchedIn },
      inOptimized: Boolean(parsed?.optimized_prompt?.includes(r.text)),
    }
  })
  const suggestions = [
    ...(parsed?.suggested_requirements ?? []).map((r) => ({ text: r.text, where: 'suggested-section' })),
  ].map((s) => ({ ...s, ...classifySuggestion(s.text) }))
  return {
    case: caseId,
    run,
    timestamp: new Date().toISOString(),
    model: MODEL,
    inputHash: String(rawInput.length) + ':' + rawInput.slice(0, 12),
    rawInput,
    triage: {
      mechanical: mech.triage,
      mechanicalReasons: mech.reasons,
      modelOrMerged: modelTriage,
      decideTriageAgain: decided.triage,
      finalFromDone: flow.done?.triage?.triage ?? null,
    },
    llm: llmLog.map((l) => ({ kind: l.kind, finish: l.finish, textLen: l.text.length })),
    analysisRaw: analysisText,
    compileRaw: compileText,
    parsedGroups: parsed ? {
      explicit: parsed.explicit_requirements.map((r) => ({ id: r.id, text: r.text, source: r.source, evidence: r.evidence })),
      context: parsed.context_requirements.map((r) => ({ id: r.id, text: r.text, source: r.source, evidence: r.evidence })),
      suggested: parsed.suggested_requirements.map((r) => ({ id: r.id, text: r.text, source: r.source })),
      unknowns: parsed.unknowns.map((r) => ({ id: r.id, text: r.text, source: r.source })),
      optimizedPrompt: parsed.optimized_prompt,
    } : null,
    evidenceTrace,
    suggestions,
    hostValidatorLines: hostLogs(/validation return|validation hard error/),
    hostRecoveryLines: hostLogs(/provenance 对账/),
    hostOtherLines: hostLogs(/truncated|fallback|KEEP|reconcile|再优化对账/),
    terminal: {
      steps: flow.steps,
      done: Boolean(flow.done),
      optimizedLen: flow.done?.optimized?.length ?? 0,
      ledgerSize: (flow.done?.ledger ?? flow.ledger ?? []).length,
      confirmedCount: (flow.done?.ledger ?? flow.ledger ?? []).filter((e) => e.status === 'CONFIRMED').length,
    },
  }
}

// ── self-test:证明 diag JSON 真含所需字段 ───────────────────────────────────
if (SELFTEST) {
  const fake = buildDiag({
    caseId: 'SELFTEST', run: 0,
    rawInput: '做个工具,不要引入新依赖',
    llmLog: [
      { kind: 'analysis', finish: 'stop', text: JSON.stringify({ primary_intent: 'execution', work_mode: 'one_shot', target: 'general', edit_triage: 'PATCH', unknowns: [], requirements: [], suggestions: [], confidence_internal: 0.9, rationale: 'r', evidence_quotes: [], questions: [] }) },
      { kind: 'compile', finish: 'stop', text: ['<<<DIAGNOSIS>>>', 'd', '<<<EXPLICIT>>>', '- 不要引入新依赖 [quote: 不要引入新依赖]', '<<<CONTEXT>>>', '(无)', '<<<SUGGESTED>>>', '- 建议增加缓存', '<<<UNKNOWN>>>', '(无)', '<<<OPTIMIZED>>>', '## Request', '- 不要引入新依赖', '<<<END>>>'].join('\n') },
    ],
    flow: { steps: ['meta,validating,done'], done: { triage: { triage: 'PATCH' }, optimized: '## Request\n- 不要引入新依赖', ledger: [] }, ledger: [] },
    hostLogs: (re) => (re.test('validation return (RETURN_TO_MISSING_RESOLUTION/VF_SUGGESTION_UPGRADED): x') ? ['validation return (…): x'] : []),
  })
  const required = ['rawInput', 'triage', 'analysisRaw', 'compileRaw', 'parsedGroups', 'evidenceTrace', 'suggestions', 'hostValidatorLines', 'terminal']
  const missing = required.filter((k) => !(k in fake))
  const check = {
    keysPresent: missing.length === 0,
    missing,
    triageHasThree: ['mechanical', 'modelOrMerged', 'finalFromDone'].every((k) => k in fake.triage),
    evidenceHasResolution: fake.evidenceTrace.length > 0 && 'mechanicalResolution' in fake.evidenceTrace[0],
    suggestionClassified: fake.suggestions.length > 0 && ['SAFE_SYNTHESIS', 'BINDING_SUGGESTION'].includes(fake.suggestions[0].verdict),
    hasOptimized: Boolean(fake.parsedGroups?.optimizedPrompt),
    hostValidatorCaptured: fake.hostValidatorLines.length > 0,
  }
  console.log(JSON.stringify(check, null, 2))
  const ok = Object.values(check).every((v) => v === true || Array.isArray(v))
  console.log(ok ? 'SELFTEST PASS:diag JSON 含全部所需字段' : 'SELFTEST FAIL')
  process.exitCode = ok ? 0 : 1
  process.exit()
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
if (!CASE || !CASES[CASE]) {
  console.error('用法:node scripts/release-diag.mjs --case B|E [--runs N] | --selftest')
  process.exit(1)
}
const raw = CASES[CASE]
const outDir = join(ROOT, 'logs', 'release-blockers', 'diag', CASE)
mkdirSync(outDir, { recursive: true })
for (let run = 1; run <= RUNS; run += 1) {
  HOST_LOGS.length = 0
  const { routes, llmLog } = await boot()
  const flow = await runFullFlow(routes, raw)
  const diag = buildDiag({ caseId: CASE, run, rawInput: raw, llmLog, flow, hostLogs: hostLines })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(join(outDir, `run${run}-${stamp}.json`), JSON.stringify(diag, null, 2))
  console.log(`\n[diag] ${CASE} run${run}: done=${diag.terminal.done} len=${diag.terminal.optimizedLen} triage(mech/model/final)=${diag.triage.mechanical}/${diag.triage.modelOrMerged}/${diag.triage.finalFromDone}`)
  console.log(`  validator: ${JSON.stringify(diag.hostValidatorLines)}`)
  console.log(`  recovery : ${JSON.stringify(diag.hostRecoveryLines)}`)
  if (diag.suggestions.length) console.log(`  suggestions: ${JSON.stringify(diag.suggestions.map((s) => [s.verdict, s.category, s.text.slice(0, 40)]))}`)
  console.log(`  → ${join(outDir, `run${run}-${stamp}.json`)}`)
}
