/**
 * RC 证据 A + B:ComfyUI 案例的**真实**端到端流程(真实 LLM)。
 *
 * 与宿主同构:analyze → (blocked) Discovery → 用户回答 → requirement_confirmation
 *            → 用户确认 → 编译 → 校验 → done。
 *
 * 输出:A) confirmation 实际文案  B) optimized_prompt 全文
 * 用法:node scripts/rc-comfyui.mjs
 */
import { readFileSync } from 'node:fs'
import { analyzeViaLlm, analysisToClassifier, ANALYSIS_MAX_TOKENS } from '../lib/core/analyze.js'
import { planQuestions, resolveAnswers, buildConfirmation } from '../lib/core/discovery.js'
import { evaluateSufficiency } from '../lib/core/discovery.js'
import { compilePrompt, finalizeCompile } from '../lib/core/compiler.js'
import { validateCompileResult } from '../lib/core/validate.js'
import { assessCompleteness } from '../lib/core/validation-flow.js'
import { computeAnalysisGate } from '../lib/core/requirements.js'

const RAW = '我想用 dsh 控制 comfyui 生成视频。'
const key = /OPENCODE_API_KEY:\s*(\S+)/.exec(readFileSync(process.env.HOME + '/.dsh/.credentials.yaml', 'utf8'))[1]
const MODEL = 'deepseek-v4-flash'

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
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0,
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        stream: true,
      }
      const resp = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-opencode-session': 'dsh-apo-rc' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: String(resp.status), message: (await resp.text()).slice(0, 200) } } }
        return
      }
      const reader = resp.body.getReader()
      const dec = new TextDecoder()
      let buf = line0('')
      let out = ''
      let idx = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let s
        while ((s = buf.indexOf('\n')) !== -1) {
          const l = buf.slice(0, s).trim()
          buf = buf.slice(s + 1)
          if (!l.startsWith('data:')) continue
          const p = l.slice(5).trim()
          if (p === '[DONE]') continue
          try {
            const j = JSON.parse(p)
            const d = j.choices?.[0]?.delta?.content
            if (d) { out += d; yield { type: 'text-delta', index: idx++, text: d } }
          } catch { /* ignore */ }
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listModels: async () => [{ id: MODEL, provider: 'opencode-go', name: MODEL }],
    resolveModelInfo: async () => ({ id: MODEL, provider: 'opencode-go', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  }
}
function line0(v) { return v }

const llm = makeLlm()
const route = { provider: 'opencode-go', model: MODEL }
const head = (t) => { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

// ① 分析
const analysisOutcome = await analyzeViaLlm(llm, route, { raw_input: RAW }, {
  language: 'zh',
  resolveLowestEffort: async () => 'low',
})
let analysis = analysisOutcome.result
head('① 分析(真实模型)')
console.log('usedFallback=', analysisOutcome.usedFallback, '| failure=', analysisOutcome.failure ?? '-')
console.log('primary=', analysis.intent.primary, '| work_mode=', analysis.intent.work_mode, '| triage=', analysis.triage.triage)
console.log('target=', analysis.target.target, '| engine=', analysis.target.engine?.id ?? '-')
console.log('gate.blocked=', analysis.gate.blocked)
console.log('blocking:', JSON.stringify(analysis.gate.blocking_items.map((b) => [b.classification, b.impact, b.text])))
console.log('可自查:', JSON.stringify(analysis.missing_resolution.filter((m) => m.classification === 'AGENT_DISCOVERABLE').map((m) => m.text)))

// ② Discovery:提问
head('② Discovery:提问(只问只有用户能决定的高影响项)')
const planned = planQuestions({
  blocking: analysis.gate.blocking_items,
  ledger: analysis.ledger,
  asked: [],
  round: 1,
})
console.log(`gate.blocked=${analysis.gate.blocked} → 提出 ${planned.questions.length} 个问题`)
if (planned.questions.length === 0) {
  console.log('本轮没有「只有用户能决定且影响高」的项目 → 不打断用户,直接进入编译(这是正确行为,不是漏问)')
}
for (const q of planned.questions) {
  console.log(`\nQ: ${q.question}`)
  for (const o of q.options) console.log(`   ${o.id === q.recommended_option_id ? '★' : ' '} ${o.id}: ${o.label}`)
  if (q.recommendation_reason) console.log(`   推荐理由: ${q.recommendation_reason}`)
  console.log(`   为什么问: ${q.why}`)
}

// ③ 用户回答(选推荐项 —— 模拟「按推荐继续」)
const answers = planned.questions.map((q) => {
  const pick = q.options.find((o) => o.id === q.recommendation_option_id) ?? q.options[0]
  // RC2:机械安全层补的决策项不编造选项 → 用「按你的判断继续」这条显式安全出口
  return pick
    ? { key: q.key, option_id: pick.id, text: pick.label }
    : { key: q.key, text: '按你的判断继续', blind_trust: true }
})
const resolved = answers.length > 0
  ? resolveAnswers({ raw_input: RAW, ledger: analysis.ledger, questions: planned.questions, answers })
  : { ledger: analysis.ledger }
analysis = { ...analysis, ledger: resolved.ledger }
const sufficiency = evaluateSufficiency({ analysis, ledger: resolved.ledger })
console.log(`\n充分性:ready=${sufficiency.ready} liveBlocking=${sufficiency.liveBlocking.length} relaxed=${sufficiency.relaxed.length} reason=${sufficiency.reason}`)
console.log('→ 决策完备则进入 Requirement Confirmation;仍有 liveBlocking 则继续追问')

// ④ Confirmation(真实文案)
head('A. requirement_confirmation 实际文案')
const confirmation = buildConfirmation({ analysis, ledger: resolved.ledger, raw_input: RAW, liveBlocking: sufficiency.liveBlocking })
console.log('本轮目标:')
console.log(`  ${confirmation.goal}`)
console.log('\n你已确认:')
for (const c of confirmation.confirmed) console.log(`  - ${c.text}${c.label && c.label !== c.text ? `   (对应需求:${c.label})` : ''}`)
console.log('\nAgent 自行调查(不需要你回答):')
for (const a of confirmation.agent_researches) console.log(`  - ${a}`)
console.log('\n暂定 / 条件:')
console.log(confirmation.provisional.length ? confirmation.provisional.map((p) => `  - ${p.text}[${p.status}]`).join('\n') : '  (无)')

// ⑤ 编译(用户确认后,Compiler 第一次运行)
head('B. optimized_prompt 全文(确认后编译)')
const plan = compilePrompt({ raw_input: RAW, analysis })
let raw = ''
for await (const chunk of llm.stream({
  provider: route.provider,
  model: route.model,
  system: plan.system,
  messages: [{ role: 'user', content: [{ type: 'text', text: plan.user }] }],
  maxTokens: Math.min(32768, Math.max(8192, RAW.length * 2)),
  temperature: 0.2,
  reasoningEffort: 'low',
})) {
  if (chunk.type === 'text-delta') raw += chunk.text
}
const outcome = finalizeCompile(plan.strategy, raw, {
  rawInput: RAW,
  contextTurns: [],
  classifier: plan.classifier,
  missing: plan.vars.missing_constraints,
  mode: 'full',
  language: 'zh',
  analysis,
})
const validation = validateCompileResult(outcome.result, { rawInput: RAW, contextTurns: [], strategy: plan.strategy, rawOutput: raw })
const completeness = assessCompleteness({
  optimizedPrompt: outcome.result.optimized_prompt,
  responsibilities: plan.strategy.informationResponsibilities,
  ledger: analysis.ledger,
  visualContract: false,
})
console.log(`契约=${plan.strategy.type} | 字数=${outcome.result.optimized_prompt.length} | wellFormed=${outcome.wellFormed} | provenance_ok=${outcome.result.provenance_ok}`)
console.log(`校验问题=${validation.problems.map((p) => p.rule).join(',') || '(无)'}`)
console.log(`完整性:critical=${JSON.stringify(completeness.criticalMissing)} nonCritical=${JSON.stringify(completeness.nonCriticalMissing)}`)
console.log('\n----- optimized_prompt -----')
console.log(outcome.result.optimized_prompt)
console.log('\n----- 编译载荷里的分诊纪律(节选) -----')
const disc = plan.user.split('# 编辑分诊纪律:')[1]
console.log(disc ? `# 编辑分诊纪律:${disc.split('\n').slice(0, 4).join('\n')}` : '(未注入)')
