/**
 * v2 Release Candidate 验证器 —— 同语料跑 old v0.1.0 与 v2，产出可比较的 RC 报告。
 *
 * 用法:
 *   node scripts/rc-validate.mjs            # 全量 25 条,真实 LLM
 *   node scripts/rc-validate.mjs --limit 5  # 抽样(先验证链路)
 *   node scripts/rc-validate.mjs --mock     # 不联网:用确定性 stub(只验证管线)
 *
 * 边界:
 *   · old v0.1.0 从独立 git worktree(/tmp/apo-old,detached HEAD c88e922)**读取代码**,
 *     不修改 tag、不污染当前工作树;
 *   · 凭据只从 ~/.dsh/.credentials.yaml 读,绝不打印;
 *   · 产出 logs/rc/report-<ts>.json + .md(gitignore 内)。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RC_CORPUS } from '../test/rc/corpus.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const OLD_ROOT = '/tmp/apo-old'

const args = process.argv.slice(2)
const MOCK = args.includes('--mock')
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  return i >= 0 ? Number(args[i + 1]) : Infinity
})()
const CONCURRENCY = 3

// ── 凭据(只读,不打印) ─────────────────────────────────────────────────────
function apiKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY
  const path = join(process.env.HOME ?? '', '.dsh', '.credentials.yaml')
  if (!existsSync(path)) return undefined
  const match = /OPENCODE_API_KEY:\s*(\S+)/.exec(readFileSync(path, 'utf8'))
  return match?.[1]
}

const KEY = MOCK ? undefined : apiKey()
const ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions'
const MODEL = 'deepseek-v4-flash'
const SESSION_HEADER = 'dsh-apo-rc'

/** 结构化最小 LLM:实现 v2/old 都需要的 stream(options)。 */
function makeLlm() {
  if (MOCK) {
    return {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '{}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  }
  return {
    async *stream(options) {
      const body = {
        model: MODEL,
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          ...options.messages.map((m) => ({
            role: 'user',
            content: Array.isArray(m.content)
              ? m.content.map((c) => c.text ?? '').join('\n')
              : String(m.content ?? ''),
          })),
        ],
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0,
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        stream: true,
      }
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${KEY}`,
          'x-opencode-session': SESSION_HEADER,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      })
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '')
        yield { type: 'finish', reason: { kind: 'error', failure: { code: String(resp.status), message: detail.slice(0, 200) } } }
        return
      }
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let index = 0
      let lastFinish = 'stop'
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, sep).trim()
          buffer = buffer.slice(sep + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const json = JSON.parse(payload)
            const choice = json.choices?.[0]
            const delta = choice?.delta?.content
            if (delta) yield { type: 'text-delta', index: index++, text: delta }
            const reason = choice?.finish_reason
            if (reason && reason !== 'stop') lastFinish = reason
          } catch {
            /* 忽略非 JSON 行 */
          }
        }
      }
      yield { type: 'finish', reason: { kind: lastFinish === 'length' ? 'max-tokens' : 'stop' } }
    },
    listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }],
    listModels: async () => [{ id: MODEL, provider: 'opencode-go', name: MODEL }],
    // 镜像宿主:暴露推理档位表,让调用侧能钳到最低档(否则推理模型会把预算吃光)
    resolveModelInfo: async () => ({
      id: MODEL,
      provider: 'opencode-go',
      name: MODEL,
      reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'medium' }, { id: 'high' }] },
    }),
  }
}

// ── 加载两套管线 ───────────────────────────────────────────────────────────
const v2 = {
  analyze: (await import(join(ROOT, 'lib/core/analyze.js'))).analyzeViaLlm,
  parse: (await import(join(ROOT, 'lib/core/analyze.js'))).parseAnalysisResult,
  compilePrompt: (await import(join(ROOT, 'lib/core/compiler.js'))).compilePrompt,
  finalize: (await import(join(ROOT, 'lib/core/compiler.js'))).finalizeCompile,
  finalizeKeep: (await import(join(ROOT, 'lib/core/compiler.js'))).finalizeKeepResult,
  validate: (await import(join(ROOT, 'lib/core/validate.js'))).validateCompileResult,
  completeness: (await import(join(ROOT, 'lib/core/validation-flow.js'))).assessCompleteness,
  registry: (await import(join(ROOT, 'lib/core/registry.js'))).defaultStrategyRegistry,
}
const old = existsSync(join(OLD_ROOT, 'lib/core/compiler.js'))
  ? {
      classify: (await import(join(OLD_ROOT, 'lib/core/classify.js'))).classifyViaLlm,
      compilePrompt: (await import(join(OLD_ROOT, 'lib/core/compiler.js'))).compilePrompt,
      finalize: (await import(join(OLD_ROOT, 'lib/core/compiler.js'))).finalizeCompile,
      validate: (await import(join(OLD_ROOT, 'lib/core/validate.js'))).validateCompileResult,
      registry: (await import(join(OLD_ROOT, 'lib/core/registry.js'))).defaultStrategyRegistry,
      legacyGeneral: (await import(join(OLD_ROOT, 'lib/core/registry.js'))).isLegacyGeneral,
    }
  : null

const route = { provider: 'opencode-go', model: MODEL }

// ── 跑一条语料(v2) ────────────────────────────────────────────────────────
async function runV2(entry) {
  const llm = makeLlm()
  const started = Date.now()
  const analysisOutcome = await v2.analyze(llm, route, { raw_input: entry.text }, {
    language: 'zh',
    // 镜像宿主:默认钳到该模型最低推理档
    resolveLowestEffort: async () => 'low',
  })
  const analysis = analysisOutcome.result
  const plan = v2.compilePrompt({ raw_input: entry.text, analysis })
  // 与宿主一致:KEEP 分诊**不调用模型**,输出必须逐字等于输入
  if (analysis.triage.triage === 'KEEP') {
    const keep = v2.finalizeKeep(plan.strategy, {
      rawInput: entry.text,
      classifier: plan.classifier,
      analysis,
      missing: [],
    })
    return {
      ms: Date.now() - started,
      analysis: {
        prompt_type: analysis.prompt_type,
        intent: analysis.intent,
        target: analysis.target,
        triage: analysis.triage,
        gate: analysis.gate,
        ledger: analysis.ledger,
        decisions: analysis.decisions ?? [],
        questions: (analysis.questions ?? []).map((q) => ({ q: q.question, options: q.options.length })),
        usedFallback: analysisOutcome.usedFallback,
      },
      strategy: plan.strategy.type,
      contract: plan.strategy.type,
      optimized: keep.result.optimized_prompt,
      keepVerbatim: keep.result.optimized_prompt === entry.text,
      llmCalls: 1,
      provenanceOk: keep.result.provenance_ok,
      validationProblems: [],
      completeness: { criticalMissing: [], nonCriticalMissing: [], droppedUserRequirements: [] },
      explicit: 0,
      suggested: 0,
      unknowns: 0,
    }
  }
  const raw = await collect(llm, {
    provider: route.provider,
    model: route.model,
    system: plan.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: plan.user }] }],
    // 镜像宿主:autoMaxTokens = max(8192, estimate*2) 上限 32768
    maxTokens: Math.min(32768, Math.max(8192, entry.text.length * 2)),
    temperature: 0.2,
    reasoningEffort: 'low',
  })
  const outcome = v2.finalize(plan.strategy, raw.text, {
    rawInput: entry.text,
    contextTurns: [],
    classifier: plan.classifier,
    missing: plan.vars.missing_constraints,
    mode: 'full',
    language: 'zh',
    analysis,
  })
  const validation = v2.validate(outcome.result, {
    rawInput: entry.text,
    contextTurns: [],
    strategy: plan.strategy,
    rawOutput: raw.text,
  })
  const completeness = v2.completeness({
    optimizedPrompt: outcome.result.optimized_prompt,
    responsibilities: plan.strategy.informationResponsibilities,
    ledger: analysis.ledger,
    visualContract: plan.strategy.type === 'image' || plan.strategy.type === 'video',
  })
  return {
    ms: Date.now() - started,
    analysis: {
      prompt_type: analysis.prompt_type,
      intent: analysis.intent,
      target: analysis.target,
      triage: analysis.triage,
      gate: analysis.gate,
      ledger: analysis.ledger,
      decisions: analysis.decisions ?? [],
      questions: (analysis.questions ?? []).map((q) => ({ q: q.question, options: q.options.length })),
      usedFallback: analysisOutcome.usedFallback,
    },
    strategy: plan.strategy.type,
    contract: plan.strategy.type,
    optimized: outcome.result.optimized_prompt,
    provenanceOk: outcome.result.provenance_ok,
    validationProblems: validation.problems.map((p) => p.rule),
    completeness,
    explicit: outcome.result.explicit_requirements.length,
    suggested: outcome.result.suggested_requirements.length,
    unknowns: outcome.result.unknowns.length,
  }
}

// ── 跑一条语料(old v0.1.0) ────────────────────────────────────────────────
async function runOld(entry) {
  if (!old) return { skipped: 'old worktree missing' }
  const llm = makeLlm()
  const started = Date.now()
  const classifyOutcome = await old.classify(llm, route, { raw_input: entry.text }, {
    language: 'zh',
    resolveLowestEffort: async () => 'low',
  })
  const classifier = classifyOutcome.result
  const strategy = old.registry.get(classifier.prompt_type)
  const legacy = old.legacyGeneral(strategy)
  const plan = old.compilePrompt({
    raw_input: entry.text,
    classifier,
    language: 'zh',
    mode: 'full',
    legacy,
  })
  const raw = await collect(llm, {
    provider: route.provider,
    model: route.model,
    system: plan.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: plan.user }] }],
    // 镜像宿主:autoMaxTokens = max(8192, estimate*2) 上限 32768
    maxTokens: Math.min(32768, Math.max(8192, entry.text.length * 2)),
    temperature: 0.2,
    reasoningEffort: 'low',
  })
  const outcome = old.finalize(plan.strategy, raw.text, {
    rawInput: entry.text,
    contextTurns: [],
    classifier,
    missing: plan.vars.missing_constraints,
    mode: 'full',
    legacy,
    language: 'zh',
  })
  const validation = legacy
    ? { problems: [] }
    : old.validate(outcome.result, { rawInput: entry.text, contextTurns: [], strategy, rawOutput: raw.text })
  return {
    ms: Date.now() - started,
    analysis: { prompt_type: classifier.prompt_type, rationale: classifier.rationale, confidence: classifier.confidence_internal },
    strategy: strategy.type,
    legacy,
    optimized: outcome.result.optimized_prompt,
    provenanceOk: outcome.result.provenance_ok,
    validationProblems: validation.problems.map((p) => p.rule),
    explicit: outcome.result.explicit_requirements.length,
    suggested: outcome.result.suggested_requirements.length,
    unknowns: outcome.result.unknowns.length,
  }
}

async function collect(llm, options) {
  let text = ''
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      throw new Error(`LLM error: ${chunk.reason.failure?.message ?? 'unknown'}`)
    }
  }
  return { text }
}

// ── 机械质量指标(不把长度当质量分) ─────────────────────────────────────────
const clamp = (value) => Math.max(0, Math.min(1, value))

function metrics(entry, out) {
  const optimized = String(out.optimized ?? '')
  const raw = entry.text
  const lines = optimized.split('\n').filter((l) => l.trim())
  const headings = lines.filter((l) => /^#{1,6}\s|^\*\*[^*]+\*\*/.test(l))
  const placeholders = (optimized.match(/\[(?:待补充|TODO)\s*[:：]/g) ?? []).length
  const askingUser = (optimized.match(/请先回答|请你确认|请先补充/g) ?? []).length
  const rawNumbers = new Set((raw.match(/\d+(?:\.\d+)?%?/g) ?? []))
  const inventedNumbers = [...new Set((optimized.match(/\d+(?:\.\d+)?%?/g) ?? []))].filter((n) => !rawNumbers.has(n))
  // 结构膨胀:标题数 / 正文行数 与「信息责任数」比较
  const responsibilityCount = out.strategy ? (v2.registry.get(out.strategy).informationResponsibilities?.length ?? 0) : 0
  const structuralBloat = responsibilityCount > 0 ? clamp(headings.length / responsibilityCount - 1) : 0
  // 关键信息:用户明确约束(引号/数字/必须)是否保留
  const rawConstraints = (raw.match(/(?:必须|不得|不要|禁止|保持|只(?:检查|看)|仅限)[^。;；\n]{0,24}/g) ?? []).slice(0, 6)
  const keptConstraints = rawConstraints.filter((c) => optimized.includes(c.slice(0, 6))).length
  const missingCritical = rawConstraints.length > 0 ? 1 - keptConstraints / rawConstraints.length : 0
  return {
    chars: optimized.length,
    headings: headings.length,
    placeholders,
    askingUser,
    inventedNumbers,
    structuralBloat: Number(structuralBloat.toFixed(2)),
    missingCriticalRatio: Number(missingCritical.toFixed(2)),
    redundancy: Number((1 - new Set(lines.map((l) => l.trim())).size / Math.max(1, lines.length)).toFixed(2)),
    actionability: /(^|\n)\s*(?:#{1,6}\s|\d+[.、)]|[-*•])/.test(optimized) ? 1 : 0,
  }
}

// ── 主流程(并发 3) ─────────────────────────────────────────────────────────
const entries = RC_CORPUS.slice(0, LIMIT)
const results = []
let cursor = 0
async function worker() {
  while (cursor < entries.length) {
    const entry = entries[cursor++]
    const record = { id: entry.id, category: entry.category, expect: entry.expect }
    try {
      record.v2 = await runV2(entry)
    } catch (error) {
      record.v2 = { error: String(error?.message ?? error) }
    }
    try {
      record.old = await runOld(entry)
    } catch (error) {
      record.old = { error: String(error?.message ?? error) }
    }
    if (record.v2 && !record.v2.error) record.v2Metrics = metrics(entry, record.v2)
    if (record.old && !record.old.error) record.oldMetrics = metrics(entry, record.old)
    results.push(record)
    process.stderr.write(`  ✓ ${entry.id} (${results.length}/${entries.length})\n`)
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker()))

// ── 报告 ───────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = join(ROOT, 'logs', 'rc')
mkdirSync(outDir, { recursive: true })
const jsonPath = join(outDir, `report-${stamp}.json`)
writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), mock: MOCK, results }, null, 2))

const sum = (key, source) => results.reduce((acc, r) => acc + (r[source]?.[key] ?? 0), 0)
const countTriage = (source) => {
  const out = {}
  for (const r of results) {
    const t = source === 'v2' ? r.v2?.analysis?.triage?.triage : r.old?.analysis?.prompt_type
    if (!t) continue
    out[t] = (out[t] ?? 0) + 1
  }
  return out
}
const countTarget = () => {
  const out = {}
  for (const r of results) {
    const t = r.v2?.analysis?.target?.target
    if (!t) continue
    out[t] = (out[t] ?? 0) + 1
  }
  return out
}
const discoveryCount = results.filter((r) => r.v2?.analysis?.gate?.blocked).length

const md = []
md.push(`# v2 RC validation report (${MOCK ? 'MOCK' : 'real LLM'})`)
md.push('')
md.push(`- corpus: ${results.length} 条  generated: ${new Date().toISOString()}`)
md.push(`- v2 triage: ${JSON.stringify(countTriage('v2'))}`)
md.push(`- v2 target: ${JSON.stringify(countTarget())}`)
md.push(`- v2 discovery(blocked): ${discoveryCount}`)
md.push(`- 平均字符: v2 ${Math.round(sum('chars', 'v2Metrics') / Math.max(1, results.length))} / old ${Math.round(sum('chars', 'oldMetrics') / Math.max(1, results.length))}`)
md.push(`- 占位符总数: v2 ${sum('placeholders', 'v2Metrics')} / old ${sum('placeholders', 'oldMetrics')}`)
md.push(`- 反问用户总数: v2 ${sum('askingUser', 'v2Metrics')} / old ${sum('askingUser', 'oldMetrics')}`)
md.push(`- 结构膨胀(v2): ${JSON.stringify(results.map((r) => [r.id, r.v2Metrics?.structuralBloat]).filter(([, v]) => v > 0))}`)
md.push(`- 丢关键约束(v2): ${JSON.stringify(results.map((r) => [r.id, r.v2Metrics?.missingCriticalRatio]).filter(([, v]) => v > 0))}`)
md.push('')
for (const r of results) {
  md.push(`## ${r.id} — ${r.category}`)
  md.push(`- v2: triage=${r.v2?.analysis?.triage?.triage} target=${r.v2?.analysis?.target?.target} engine=${r.v2?.analysis?.target?.engine?.id ?? '-'} contract=${r.v2?.contract} chars=${r.v2Metrics?.chars} provOk=${r.v2?.provenanceOk} questions=${r.v2?.analysis?.questions?.length ?? 0} blocked=${r.v2?.analysis?.gate?.blocked}`)
  md.push(`- old: type=${r.old?.analysis?.prompt_type} legacy=${r.old?.legacy} chars=${r.oldMetrics?.chars} provOk=${r.old?.provenanceOk} placeholders=${r.oldMetrics?.placeholders}`)
  if (r.v2?.completeness?.criticalMissing?.length) md.push(`- v2 criticalMissing: ${r.v2.completeness.criticalMissing.join(' / ')}`)
  if (r.v2?.validationProblems?.length) md.push(`- v2 problems: ${r.v2.validationProblems.slice(0, 6).join(', ')}`)
  md.push('')
  md.push('```text')
  md.push(`RAW: ${r.id === 'rc23-long-prompt' ? entry0(r.id).slice(0, 300) + '…' : entry0(r.id).slice(0, 300)}`)
  md.push('--- v2 ---')
  md.push(String(r.v2?.optimized ?? r.v2?.error ?? '').slice(0, 1400))
  md.push('--- old ---')
  md.push(String(r.old?.optimized ?? r.old?.error ?? '').slice(0, 1400))
  md.push('```')
}
function entry0(id) {
  return RC_CORPUS.find((e) => e.id === id)?.text ?? ''
}
const mdPath = join(outDir, `report-${stamp}.md`)
writeFileSync(mdPath, md.join('\n'))
console.log(`\nRC report: ${mdPath}\nJSON: ${jsonPath}`)
console.log(md.slice(0, 12).join('\n'))
