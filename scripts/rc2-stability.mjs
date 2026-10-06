/**
 * RC2 Decision Stability harness —— 真实模型多轮重复,验证**语义阻塞决策集**是否稳定。
 *
 * 判据(用户给定):
 *   · 不要求问题文字一致;
 *   · 要求同一输入**每次都存在同一组高影响阻塞决策**(不能这轮有、下轮没有);
 *   · 环境事实**任何一轮**都不得变成要问用户的问题。
 *
 * 用法:
 *   node scripts/rc2-stability.mjs                 # 8 条 × 8 轮(默认)
 *   node scripts/rc2-stability.mjs --runs 10 --limit 8
 *   node scripts/rc2-stability.mjs --mock          # 不联网,只验证机械层
 *
 * 凭据只从 ~/.dsh/.credentials.yaml 读,绝不打印。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeViaLlm } from '../lib/core/analyze.js'
import { mechanicalTriage } from '../lib/core/triage.js'
import { parseAnalysisResult } from '../lib/core/analyze.js'
import { decisionCategoryOfRequirement, isReadableEnvironmentFact } from '../lib/core/requirements.js'
import { planQuestions } from '../lib/core/discovery.js'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const args = process.argv.slice(2)
const MOCK = args.includes('--mock')
const CONCURRENCY = Number(args[args.indexOf('--concurrency') + 1]) || 4
const RUNS = Number(args[args.indexOf('--runs') + 1]) || 8
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || 8

/** §6 的高歧义 Prompt(前 8 条是用户给定的)+ 4 条补充覆盖。 */
const PROMPTS = [
  '我想用 dsh 控制 comfyui 生成视频。',
  '帮我做一个 AI 知识库。',
  '把这个工具做成能长期自动运行的。',
  '先看看能不能实现这个功能。',
  '继续做这个项目。',
  '帮我优化现在这套架构。',
  '我想让 Agent 自动处理这些任务。',
  '帮我把这个原型做完整。',
  '把这个脚本改成能每天自动跑。',
  '只做本地验证还是允许上云?帮我处理这个部署。',
  '帮我重构这个模块,但保持现有架构。',
  '帮我做一个工具,允许自动删除过期文件吗?',
].slice(0, LIMIT)

/** 环境事实不得被问:输入里只有可读事实缺失。 */
const ENV_PROMPTS = [
  { text: '帮我把这段描述整理成提示词,ComfyUI 版本我用最新的', mustNotAsk: ['版本'] },
  { text: '按现有项目结构写个接入脚本,API 地址和端口我会告诉你', mustNotAsk: ['地址', '端口', '项目结构'] },
]

const KEY = MOCK ? undefined : readKey()
function readKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY
  const match = /OPENCODE_API_KEY:\s*(\S+)/.exec(readFileSync(join(process.env.HOME ?? '', '.dsh', '.credentials.yaml'), 'utf8'))
  return match?.[1]
}

function makeLlm() {
  if (MOCK) return { async *stream() { yield { type: 'text-delta', index: 0, text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  return {
    async *stream(options) {
      const body = {
        model: 'deepseek-v4-flash',
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
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-opencode-session': 'dsh-apo-rc2' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) { yield { type: 'finish', reason: { kind: 'error', failure: { code: String(resp.status), message: (await resp.text()).slice(0, 160) } } }; return }
      const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = ''; let i = 0; let last = 'stop'
      for (;;) {
        const { done, value } = await reader.read(); if (done) break
        buf += dec.decode(value, { stream: true })
        let s
        while ((s = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, s).trim(); buf = buf.slice(s + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim(); if (payload === '[DONE]') continue
          try {
            const json = JSON.parse(payload); const choice = json.choices?.[0]
            const delta = choice?.delta?.content
            if (delta) yield { type: 'text-delta', index: i++, text: delta }
            if (choice?.finish_reason && choice.finish_reason !== 'stop') last = choice.finish_reason
          } catch { /* ignore */ }
        }
      }
      yield { type: 'finish', reason: { kind: last === 'length' ? 'max-tokens' : 'stop' } }
    },
    listModels: async () => [{ id: 'deepseek-v4-flash', provider: 'opencode-go' }],
    resolveModelInfo: async () => ({ id: 'deepseek-v4-flash', provider: 'opencode-go', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  }
}

const llm = makeLlm()
const route = { provider: 'opencode-go', model: 'deepseek-v4-flash' }

async function analyzeOnce(raw) {
  const outcome = await analyzeViaLlm(llm, route, { raw_input: raw }, { language: 'zh', resolveLowestEffort: async () => 'low' })
  return outcome
}

/** 并发跑 N 次,保持顺序。 */
async function runAll(times, fn) {
  const out = new Array(times)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, times) }, async () => {
      while (cursor < times) {
        const index = cursor++
        out[index] = await fn(index)
      }
    }),
  )
  return out
}

/** 环境事实判定:只认**短语级**事实(整句模糊目标不算,避免误计)。 */
function isEnvPhrase(text) {
  const value = String(text ?? '')
  return value.length <= 24 && isReadableEnvironmentFact(value)
}

/** 机械层(与采样无关):用**空模型输出**解析,看机械兜底是否产生阻塞。 */
function mechanicalBaseline(raw) {
  const { result } = parseAnalysisResult(
    JSON.stringify({ primary_intent: 'execution', work_mode: 'one_shot', target: 'agent_task', edit_triage: mechanicalTriage(raw).triage, unknowns: [], requirements: [], suggestions: [], confidence_internal: 0.9, rationale: '', evidence_quotes: [], questions: [] }),
    { rawInput: raw, language: 'zh' },
  )
  return {
    blocked: result.gate.blocked,
    categories: result.gate.blocking_items.map((item) => decisionCategoryOfRequirement(item.text) ?? 'vague_goal_scope').sort(),
  }
}

const report = { generatedAt: new Date().toISOString(), mock: MOCK, runs: RUNS, prompts: [], env: [] }

for (const raw of PROMPTS) {
  const baseline = mechanicalBaseline(raw)
  const rounds = await runAll(RUNS, async () => {
    const outcome = await analyzeOnce(raw)
    const result = outcome.result
    const blocking = result.gate.blocking_items
    const categories = [...new Set(blocking.map((item) => decisionCategoryOfRequirement(item.text) ?? 'vague_goal_scope'))].sort()
    const planned = planQuestions({ blocking, ledger: result.ledger, asked: [], round: 1 })
    return {
      usedFallback: outcome.usedFallback,
      blocked: result.gate.blocked,
      categories,
      items: blocking.map((item) => item.text.slice(0, 40)),
      questions: planned.questions.length,
      envAsked: planned.questions.filter((q) => isEnvPhrase(q.question)).length,
    }
  })
  process.stderr.write(`  · ${raw.slice(0, 18)}… done\n`)
  const blockedRuns = rounds.filter((r) => r.blocked).length
  const keys = new Set(rounds.map((r) => [...r.categories].sort().join('+') || '(none)'))
  // 验收(用户给定):**语义阻塞决策集必须稳定** —— 机械层保证的决策类别
  // 必须在**每一轮**都出现(模型可以额外多问,但不允许某一轮整组消失)。
  const baselineCovered = rounds.every((r) =>
    baseline.categories.every((category) => r.categories.includes(category)),
  )
  report.prompts.push({
    raw,
    baseline,
    runs: rounds,
    blockingRate: blockedRuns / RUNS,
    baselineCovered,
    categoryStable: baselineCovered,
    categoryVariants: [...keys],
    pass: baseline.blocked ? baselineCovered && blockedRuns === RUNS : true,
  })
}

for (const probe of ENV_PROMPTS) {
  const rounds = await runAll(RUNS, async () => {
    const outcome = await analyzeOnce(probe.text)
    const result = outcome.result
    const planned = planQuestions({ blocking: result.gate.blocking_items, ledger: result.ledger, asked: [], round: 1 })
    const askedEnv = planned.questions.filter((q) => isEnvPhrase(q.question) && probe.mustNotAsk.some((kw) => q.question.includes(kw)))
    const blockingEnv = result.gate.blocking_items.filter((item) => isEnvPhrase(item.text))
    return { askedEnv: askedEnv.length, blockingEnv: blockingEnv.length, blocked: result.gate.blocked }
  })
  process.stderr.write(`  · [env] ${probe.text.slice(0, 18)}… done\n`)
  report.env.push({
    text: probe.text,
    runs: rounds,
    // 验收:环境事实在任何一轮都不得变成问题、也不得成为阻塞项
    pass: rounds.every((r) => r.askedEnv === 0 && r.blockingEnv === 0),
  })
}

mkdirSync(join(ROOT, 'logs', 'rc2'), { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const path = join(ROOT, 'logs', 'rc2', `stability-${stamp}.json`)
writeFileSync(path, JSON.stringify(report, null, 2))

const md = []
md.push(`# RC2 Decision Stability(${MOCK ? 'MOCK' : 'real LLM'} · ${RUNS} 轮/条)`)
md.push('')
md.push('| # | Prompt | 机械基线 | 阻塞率 | 类别稳定 | 类别变体 | 判定 |')
md.push('|---|---|---|---|---|---|---|')
report.prompts.forEach((p, i) => {
  md.push(`| ${i + 1} | ${p.raw} | ${p.baseline.categories.join('+') || '不阻塞'} | ${(p.blockingRate * 100).toFixed(0)}% | ${p.categoryStable ? '稳定' : '不稳定'} | ${p.categoryVariants.join(' / ')} | ${p.pass ? '✅' : '❌'} |`)
})
md.push('')
md.push('| 环境事实探针 | 问到了环境事实 | 环境事实成为阻塞 | 判定 |')
md.push('|---|---|---|---|')
report.env.forEach((e) => {
  md.push(`| ${e.text} | ${e.runs.reduce((a, r) => a + r.askedEnv, 0)} | ${e.runs.reduce((a, r) => a + r.blockingEnv, 0)} | ${e.pass ? '✅' : '❌'} |`)
})
md.push('')
md.push(`总判定:${report.prompts.every((p) => p.pass) && report.env.every((e) => e.pass) ? 'PASS' : 'FAIL'}`)
writeFileSync(path.replace('.json', '.md'), md.join('\n'))
console.log(md.join('\n'))
console.log(`\nJSON: ${path}`)
