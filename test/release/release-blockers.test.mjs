/**
 * v0.2.0-apo Release Blocker Regression —— 发布冒烟发现的真实缺陷的固定断言。
 * 全部用 mock LLM(确定性、不联网):
 *   R1/R2  confirm 的两个死循环(轮次上限后永久拒绝 / 复用确认前的快照 gate)
 *   R3     re-optimize 只改措辞:STILL_VALID 保留 + 不重复询问 + 到达 complete
 *   R4     re-optimize 改变目标 → CONFLICTING(REJECTED)
 *   R5     re-optimize 更换 Prompt Target → INVALIDATED(NOT_APPLICABLE)
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../../lib/index.js'

const M = { DIAGNOSIS: '<<<DIAGNOSIS>>>', EXPLICIT: '<<<EXPLICIT>>>', CONTEXT: '<<<CONTEXT>>>', SUGGESTED: '<<<SUGGESTED>>>', UNKNOWN: '<<<UNKNOWN>>>', OPTIMIZED: '<<<OPTIMIZED>>>', END: '<<<END>>>' }

const analysisFor = ({ target = 'agent_task', decision = '复用现有 workflow 还是新建', n = 1 } = {}) =>
  JSON.stringify({
    primary_intent: 'planning', work_mode: 'exploratory', target, edit_triage: 'REBUILD',
    unknowns: [{ text: decision, classification: 'USER_REQUIRED', blocking: true, impact: 'high', rationale: '取舍' }],
    // 真实场景:模型会把用户目标抽成带逐字证据的 requirement(→ CONFIRMED USER_EXPLICIT)
    requirements: [{ text: '用 dsh 控制 comfyui 生成视频', quote: '用 dsh 控制 comfyui 生成视频' }],
    suggestions: [], confidence_internal: 0.9, rationale: 'r', evidence_quotes: ['用 dsh 控制 comfyui 生成视频'],
    questions: [{ requirement_id: `unknown-${n}`, question: `${decision}?`, options: [{ id: 'a', label: '方案A' }, { id: 'b', label: '方案B' }], why: '取舍', depends_on: [] }],
  })

const COMPILE_OUT = [M.DIAGNOSIS, 'd', M.EXPLICIT, '(无)', M.CONTEXT, '(无)', M.SUGGESTED, '(无)', M.UNKNOWN, '(无)', M.OPTIMIZED, '## 目标', '做点事', '## 执行前须知', '- 动手前先确认:现状', M.END].join('\n')

async function boot({ alwaysNewDecision = false, analysis = null } = {}) {
  const routes = {}
  let n = 0
  let compileCalls = 0
  const ctx = new Context()
  ctx.provide('httpServer', { register(r) { routes[r.path] = r; return () => {} } })
  ctx.provide('llm', {
    async *stream(options) {
      const meta = /意图编译器分析器|intent compiler analyzer/.test(String(options.system ?? ''))
      let text
      if (meta) {
        if (analysis) text = analysis
        else { n += 1; text = analysisFor({ n, decision: alwaysNewDecision ? `第${n}个只有用户能决定的取舍:方案A还是方案B` : '复用现有 workflow 还是新建' }) }
      } else { compileCalls += 1; text = COMPILE_OUT }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'p', name: 'p' }],
    listModels: async () => [{ id: 'm', provider: 'p', name: 'm' }],
    resolveModelInfo: async () => ({ id: 'm', provider: 'p', reasoning: { efforts: [{ id: 'low' }] } }),
  })
  await ctx.plugin(plugin, {})
  return { routes, compileCalls: () => compileCalls }
}

async function call(routes, body) {
  const handler = routes['/dsh-prompt-optimizer/optimize'].handler
  const res = { status: 0, headers: {}, body: '', writableEnded: false, destroyed: false, on() {}, writeHead(s, h) { res.status = s; res.headers = h ?? {} }, write(c) { res.body += c; return true }, end(p) { if (p) res.body += p; res.writableEnded = true } }
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'; req.headers = {}
  await handler(req, res)
  return res.body.split('\n\n').filter(Boolean).map((f) => { const l = f.split('\n').find((x) => x.startsWith('data:')); return l ? JSON.parse(l.slice(5).trim()) : null }).filter(Boolean)
}

const answersFor = (questions) => (questions ?? []).map((q) => {
  const pick = (q.options ?? []).find((o) => o.id === q.recommended_option_id) ?? (q.options ?? [])[0]
  return pick ? { key: q.key, option_id: pick.id, text: pick.label } : { key: q.key, text: '按你的判断继续', blind_trust: true }
})

async function runToTerminal(routes, text, { maxSteps = 6 } = {}) {
  let events = await call(routes, { text, provider: 'p', model: 'm' })
  const steps = [events.filter((e) => e.type !== 'delta').map((e) => e.type).join(',')]
  let ledger = [], analysis = null, asked = [], triage = 'REBUILD'
  for (let step = 1; step <= maxSteps; step += 1) {
    const done = events.find((e) => e.type === 'done')
    if (done) return { done, events, steps }
    const d = events.find((e) => e.type === 'discovery_required')
    const c = events.find((e) => e.type === 'requirement_confirmation')
    if (!d && !c) return { done: null, events, steps }
    ledger = d?.ledger ?? c?.ledger ?? ledger
    analysis = d?.analysis ?? c?.analysis ?? analysis
    asked = d?.asked ?? c?.asked ?? asked
    triage = d?.triage?.triage ?? c?.triage?.triage ?? triage
    events = d
      ? await call(routes, { text, provider: 'p', model: 'm', discovery: { mode: 'answer', round: step, triage, ledger, asked, questions: d.questions, answers: answersFor(d.questions), analysis } })
      : await call(routes, { text, provider: 'p', model: 'm', discovery: { mode: 'confirm', round: step, triage, ledger, asked, answers: [], questions: [], analysis } })
    steps.push(events.filter((e) => e.type !== 'delta').map((e) => e.type).join(','))
  }
  return { done: null, events, steps }
}

// R1 + R2
{
  const { routes, compileCalls } = await boot({ alwaysNewDecision: true })
  const TEXT = '帮我做一个 AI 知识库,不知道是先做个能跑的最小版本,还是直接做成以后长期用的工具。'
  const { done, steps } = await runToTerminal(routes, TEXT)
  assert.ok(done, `★ R1/R2:必须到达 complete,实际步骤:${steps.join(' → ')}`)
  assert.ok(done.optimized.length > 0, 'R1/R2:必须产出优化稿')
  assert.equal(compileCalls(), 1, '★ R1/R2:Compiler 只在 confirm 之后调用一次')
  assert.ok(steps.some((s) => s.includes('requirement_confirmation')) && steps.some((s) => s.includes('done')), 'R1/R2:必须出现 requirement_confirmation → done')
  console.log('✓ R1/R2 confirm 两个死循环已修:到达 complete,编译仅 1 次')
}

// R3
{
  const { routes } = await boot({ analysis: analysisFor({ decision: '复用现有 workflow 还是新建' }) })
  const T1 = '我想用 dsh 控制 comfyui 生成视频,已经有 workflow,先验证控制链路。'
  const first = await runToTerminal(routes, T1)
  assert.ok(first.done, 'R3:第一次优化必须 complete')
  const ledger = first.done.ledger ?? []
  assert.ok(ledger.length > 0, 'R3:第一次 complete 必须带回台账')
  const T2 = '我想用 dsh 控制 comfyui 生成视频,已经有 workflow,先验证控制链路,谢谢。'
  const re = await call(routes, { text: T2, provider: 'p', model: 'm', discovery: { mode: 'reoptimize', round: 2, triage: 'REBUILD', ledger, asked: [], answers: [], questions: [], analysis: null } })
  const reDone = re.find((e) => e.type === 'done')
  const reDiscovery = re.find((e) => e.type === 'discovery_required')
  assert.ok(reDone, '★ R3:只改措辞的 re-optimize 必须直接 complete')
  assert.equal(reDiscovery, undefined, '★ R3:不得重复询问同一决定')
  const confirmed = (reDone.ledger ?? []).filter((e) => e.status === 'CONFIRMED').length
  assert.ok(confirmed > 0, '★ R3:已确认要求必须保留(CONFIRMED > 0)')
  console.log(`✓ R3 re-optimize 只改措辞:CONFIRMED=${confirmed}、零重复询问、直达 complete`)
}

// R4
{
  const { routes } = await boot({ analysis: analysisFor({ decision: '复用现有 workflow 还是新建' }) })
  const first = await runToTerminal(routes, '我想用 dsh 控制 comfyui 生成视频,已经有 workflow,先验证控制链路。')
  const ledger = first.done?.ledger ?? []
  const re = await call(routes, { text: '现在改成建立长期自动化流程,谢谢。', provider: 'p', model: 'm', discovery: { mode: 'reoptimize', round: 2, triage: 'REBUILD', ledger, asked: [], answers: [], questions: [], analysis: null } })
  const ev = re.find((e) => e.type === 'done') ?? re.find((e) => e.type === 'discovery_required') ?? re.find((e) => e.type === 'requirement_confirmation')
  const rejected = (ev?.ledger ?? []).filter((e) => e.status === 'REJECTED').length
  assert.ok(rejected > 0, '★ R4:改变目标 → REJECTED')
  console.log(`✓ R4 re-optimize 改变目标:CONFLICTING 生效(REJECTED=${rejected})`)
}

// R5(单元级,确定性):更换 Prompt Target → INVALIDATED
{
  const { reconcileLedger } = await import('../../lib/core/ledger-reconcile.js')
  const previous = [
    { id: 'ledger-a', text: '用 dsh 控制 comfyui 生成视频', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['用 dsh 控制 comfyui 生成视频'], confidence: 'high' },
  ]
  const analysis = {
    intent: { primary: 'execution', supporting: [], work_mode: 'one_shot', rationale: '' },
    target: { target: 'image_generation', modality: 'image', engine: null, confidence: 'high', evidence: [], rationale: '' },
    triage: { triage: 'PATCH', reasons: [], signals: [], keep_safe: false },
    missing_resolution: [], gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: '' },
    ledger: [], confidence_internal: 0.9, rationale: '', evidence_quotes: [], prompt_type: 'execution', missing_constraints: [],
  }
  const r = reconcileLedger({ previous, analysis, rawInput: '帮我生成 Midjourney 图片提示词。', previousTarget: 'agent_task' })
  assert.equal(r.ledger[0].status, 'NOT_APPLICABLE', '★ R5:更换 Target → 旧要求失效(NOT_APPLICABLE)')
  assert.equal(r.invalidated.length, 1)
  console.log('✓ R5 re-optimize 更换 Target:INVALIDATED 生效(NOT_APPLICABLE=1)')
}

// R6:协议标记剥离必须覆盖**行内**标记(交付稿不得含 <<<...>>>)
{
  const { stripProtocolMarkers } = await import('../../lib/core/compiler.js')
  assert.equal(stripProtocolMarkers('<<<DIAGNOSIS>>>\n正文'), '正文', 'R6:整行标记')
  assert.equal(stripProtocolMarkers('正文 <<<END>>> 结束'), '正文 结束', '★ R6:行内标记必须就地剥离')
  assert.equal(stripProtocolMarkers('前 <<<OPTIMIZED>>> 后'), '前 后', '★ R6:行内 OPTIMIZED')
  assert.doesNotMatch(stripProtocolMarkers('a <<<UNKNOWN>>> b <<<END>>>'), /<<<[A-Z_]+>>>/, 'R6:不得残留任何标记')
  console.log('✓ R6 协议标记剥离覆盖行内标记(防 VF_PROTOCOL_LEAK)')
}

console.log('release-blockers.test.mjs: ALL PASS')
