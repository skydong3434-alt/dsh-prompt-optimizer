/**
 * Phase 3 验收演示:ComfyUI 案例的完整事件流(可直接运行,输出即证据)。
 *
 * 用法:先 `npm run build`,再 `node scripts/phase3-trace.mjs`
 *
 * 它复用 test/phase3-e2e.test.mjs 的 fixtures 与真实宿主 handler(不是伪事件),
 * 依次打印:optimize → discovery_required → user_answer → requirement_confirmation
 * → confirm → compile → done,并在末尾给出「分析调用总数 / 编译调用次数」,
 * 让人一眼看到 **Compiler 是在哪一步第一次被调用的**。
 */
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { isMetaAnalysisCall } from '../lib/core/analyze.js'
import { readFileSync } from 'node:fs'

// 复用测试里的 fixtures(ROUND1 / ROUND2 / COMPILE_OUTPUT)
const src = readFileSync(new URL('../test/phase3-e2e.test.mjs', import.meta.url), 'utf8')
const grab = (name, next) => src.slice(src.indexOf(`const ${name} = `), src.indexOf(next)).replace(`const ${name} = `, '').replace(/;\s*$/, '')
const ROUND1 = eval(grab('ROUND1', '/** 第二轮分析'))
const ROUND2 = eval(grab('ROUND2', 'const COMPILE_OUTPUT'))
const COMPILE_OUTPUT = eval(grab('COMPILE_OUTPUT', '// ═'))

const routes = {}
const ctx = new Context()
ctx.provide('httpServer', { register: (r) => { routes[r.path] = r; return () => {} } })
let ai = 0
ctx.provide('llm', {
  async *stream(o) {
    const text = isMetaAnalysisCall(o.system) ? [ROUND1, ROUND2][Math.min(ai++, 1)] : COMPILE_OUTPUT
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
  listProviders: () => [{ id: 'deepseek-official', name: 'x' }],
  listModels: async () => [{ id: 'deepseek-chat', provider: 'deepseek-official', name: 'x' }],
  resolveModelInfo: async () => ({ id: 'deepseek-chat', provider: 'deepseek-official', name: 'x' }),
})
await ctx.plugin(plugin, {})
const handler = routes['/dsh-prompt-optimizer/optimize'].handler

async function call(body) {
  const res = { status: 0, headers: {}, body: '', writableEnded: false, destroyed: false, on() {}, writeHead(s, h) { res.status = s; res.headers = h ?? {} }, write(c) { res.body += c; return true }, end(p) { if (p) res.body += p; res.writableEnded = true } }
  const req = Readable.from([JSON.stringify(body)]); req.method = 'POST'; req.headers = {}
  await handler(req, res)
  return res.body.split('\n\n').filter(Boolean).map((f) => { const l = f.split('\n').find((x) => x.startsWith('data:')); return l ? JSON.parse(l.slice(5).trim()) : null }).filter(Boolean)
}

let n = 0
const step = (label, events) => {
  console.log(`\n──── ${++n}. ${label}`)
  for (const e of events) {
    if (e.type === 'delta') continue
    const bits = []
    if (e.type === 'discovery_required') {
      bits.push(`round=${e.round}`, `blocked=${e.gate.blocked}`, `questions=${e.questions.length}`, `compile? no`)
      for (const q of e.questions) bits.push(`  Q: ${q.question} [选项 ${q.options.length}${q.recommended_option_id ? ', 有推荐' : ''}]`)
      bits.push(`  可自查(弱显示): ${(e.agent_researches ?? []).join(' / ')}`)
    }
    if (e.type === 'requirement_confirmation') {
      bits.push(`goal=${e.confirmation.goal}`)
      bits.push(`  你已确认: ${e.confirmation.confirmed.map((c) => c.text).join(' / ')}`)
      bits.push(`  Agent 自行调查: ${e.confirmation.agent_researches.join(' / ')}`)
      bits.push(`  暂定/条件: ${e.confirmation.provisional.map((p) => `${p.text}[${p.status}]`).join(' / ') || '(无)'}`)
    }
    if (e.type === 'meta') bits.push(`prompt_type=${e.prompt_type} contract=${e.contract ?? '-'} triage=${e.triage?.triage}`)
    if (e.type === 'done') bits.push(`contract=${e.contract} optimized=${String(e.optimized).length}字 triage=${e.triage?.triage}`)
    if (e.type === 'error') bits.push(e.error)
    console.log(`  ${e.type} ${bits.join(' | ')}`)
  }
  const dc = events.filter((e) => e.type === 'delta').length
  if (dc) console.log(`  (delta × ${dc})`)
}

const events1 = await call({ text: '我想用 dsh 控制 comfyui 生成视频。', provider: 'p', model: 'm' })
step('optimize(首次)', events1)
const r1 = events1[0]

const events2 = await call({ text: '我想用 dsh 控制 comfyui 生成视频。', provider: 'p', model: 'm', discovery: { mode: 'answer', round: 1, triage: 'PATCH', ledger: r1.ledger, asked: r1.asked, questions: r1.questions, answers: r1.questions.map((q) => ({ key: q.key, option_id: q.options[0]?.id, text: q.options[0]?.label ?? '按推荐' })), analysis: r1.analysis } })
step('user_answer(选择推荐项)', events2)
const c = events2[0]

const events3 = await call({ text: '我想用 dsh 控制 comfyui 生成视频。', provider: 'p', model: 'm', discovery: { mode: 'confirm', round: c.round, triage: 'PATCH', ledger: c.ledger, asked: c.asked, answers: [], questions: [], analysis: c.analysis } })
step('confirm(确认并优化)', events3)
console.log(`\n分析调用总数=${ai}  编译调用次数=${events3.some((e) => e.type === 'done') ? 1 : 0}`)
