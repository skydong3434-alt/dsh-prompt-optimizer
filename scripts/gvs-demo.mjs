#!/usr/bin/env node
/**
 * G-VS Human UX Gate 真实验收脚本（2026-10-03）。
 *
 * 用真实 DeepSeek API + 插件自己的提示词构建/解析/校验链路，跑一遍完整
 * AUTO → classify → research strategy → compile → provenance 验证，
 * 输入为用户的真实需求案例，输出 CompileResult（JSON + 可读报告）。
 *
 * 用法: node scripts/gvs-demo.mjs（凭据从 ~/.dsh/.credentials.yaml 读取，
 *       不打印、不入库任何密钥）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createStrategyRegistry } from '../lib/core/registry.js'
import {
  buildClassifierSystem,
  buildClassifierUser,
  parseClassifierResult,
} from '../lib/core/classify.js'
import {
  buildCompilePayload,
  finalizeCompile,
} from '../lib/core/compiler.js'
import { normalizeInput } from '../lib/core/context.js'
import { researchStrategy } from '../lib/core/strategies/research.js'

const CREDENTIALS = '/Users/dongshaoyu/.dsh/.credentials.yaml'
const API_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'

/** 从 credentials.yaml 提取 DEEPSEEK_API_KEY（只读取，不外泄）。 */
function readApiKey() {
  const text = readFileSync(CREDENTIALS, 'utf8')
  const m = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
  if (!m) throw new Error('credentials.yaml 中未找到 DEEPSEEK_API_KEY')
  return m[1].replace(/['"]/g, '')
}

async function callLLM(system, user, { temperature, maxTokens }) {
  const key = readApiKey()
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content ?? ''
  return { content, usage: data.usage ?? null }
}

const RAW_INPUT =
  '帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频，我看到黑鹤001低显流，还有 H3。'

async function main() {
  const lang = 'zh'
  const log = []
  const push = (name, value) => { log.push({ name, value }); console.log(`[${name}]`, value) }

  // ── 阶段 1: Intent Classification ──────────────────────────────────────────
  push('STEP', '1/3 classify: 构建分类提示词 → 真实 LLM')
  const clsSystem = buildClassifierSystem(lang)
  const clsUser = buildClassifierUser({ raw_input: RAW_INPUT, context_turns: [] }, lang)
  const clsRaw = await callLLM(clsSystem, clsUser, { temperature: 0, maxTokens: 512 })
  const classifier = parseClassifierResult(clsRaw.content)
  push('classifier', JSON.stringify(classifier, null, 1))

  // ── 阶段 2: Strategy → Compile ─────────────────────────────────────────────
  push('STEP', '2/3 compile: research 策略 → 真实 LLM（四段协议）')
  const registry = createStrategyRegistry()
  const strategy = registry.get(classifier.prompt_type)
  push('strategy', `${strategy.type} v${strategy.version}（registry.get(${classifier.prompt_type})）`)

  const ctx = normalizeInput({ raw_input: RAW_INPUT, turns: [], workspace_metadata: {} })
  const compileVars = { raw_input: ctx.raw_input, context_turns: ctx.bounded_turns, workspace_metadata: ctx.workspace_metadata }
  const missing = classifier.missing_constraints.map((label) => ({ label }))
  const payload = buildCompilePayload(strategy, compileVars, {
    language: lang,
    classifier,
    missing,
  })
  const compRaw = await callLLM(payload.system, payload.user, { temperature: 0.2, maxTokens: 4096 })
  const { result, wellFormed, problems } = finalizeCompile(strategy, compRaw.content, {
    language: lang,
    classifier,
    missing,
    rawInput: RAW_INPUT,
    contextTurns: ctx.bounded_turns,
  })

  // ── 阶段 3: 输出 ───────────────────────────────────────────────────────────
  push('STEP', '3/3 输出 CompileResult + 校验')
  const report = {
    meta: { raw_input: RAW_INPUT, prompt_type: result.prompt_type, confidence_level: result.confidence_level, strategy_version: result.strategy_version, provenance_ok: result.provenance_ok, wellFormed, problems },
    diagnosis: result.diagnosis,
    explicit_requirements: result.explicit_requirements.map((r) => ({ text: r.text, evidence: r.evidence, source: r.source })),
    context_requirements: result.context_requirements.map((r) => ({ text: r.text, source: r.source })),
    suggested_requirements: result.suggested_requirements.map((r) => ({ text: r.text })),
    unknowns: result.unknowns.map((r) => ({ text: r.text })),
    missing_constraints: result.missing_constraints.map((m) => m.label),
    optimized_prompt: result.optimized_prompt,
  }
  writeFileSync('/tmp/gvs-result.json', JSON.stringify(report, null, 2), 'utf8')
  writeFileSync('docs/gvs-result.md', renderMarkdown(report, classifier), 'utf8')
  console.log('---')
  console.log('provenance_ok:', result.provenance_ok, '| wellFormed:', wellFormed)
  console.log('problems:', JSON.stringify(problems, null, 1))
  console.log('报告已写: docs/gvs-result.md + /tmp/gvs-result.json')
}

function renderMarkdown(report, classifier) {
  const lines = []
  lines.push('# G-VS 真实验收结果（真实 DeepSeek API + 插件全链路）')
  lines.push('')
  lines.push(`> 原始需求：${report.meta.raw_input}`)
  lines.push('')
  lines.push('## 任务类型与把握')
  lines.push(`- 类型：**${report.meta.prompt_type}**（confidence_internal=${classifier.confidence_internal} → UI 显示 ${report.meta.confidence_level}）`)
  lines.push(`- 理由：${classifier.rationale ?? ''}`)
  lines.push(`- 策略版本：${report.meta.strategy_version}｜provenance_ok=${report.meta.provenance_ok}｜wellFormed=${report.meta.wellFormed}`)
  lines.push('')
  lines.push('## 需求诊断')
  lines.push('')
  lines.push(report.diagnosis || '（无）')
  lines.push('')
  lines.push('## 来自你的明确要求（USER_EXPLICIT）')
  report.explicit_requirements.forEach((r) => lines.push(`- ${r.text}（evidence: ${r.evidence.join(' / ') || '无'}）`))
  lines.push('')
  lines.push('## 从上下文确认（CONTEXT_EXPLICIT）')
  if (!report.context_requirements.length) lines.push('（无会话上下文输入）')
  report.context_requirements.forEach((r) => lines.push(`- ${r.text}`))
  lines.push('')
  lines.push('## 优化器建议补充（OPTIMIZER_SUGGESTED，可忽略）')
  report.suggested_requirements.forEach((r) => lines.push(`- ↩ ${r.text}`))
  if (!report.suggested_requirements.length) lines.push('（无）')
  lines.push('')
  lines.push('## 仍需补充 / 不确定（UNKNOWN）')
  report.unknowns.forEach((r) => lines.push(`- ? ${r.text}`))
  report.missing_constraints.forEach((m) => lines.push(`- [待补充: ${m}]`))
  if (!report.unknowns.length && !report.missing_constraints.length) lines.push('（无）')
  lines.push('')
  lines.push('## 优化后的完整 Prompt')
  lines.push('')
  lines.push('```markdown')
  lines.push(report.optimized_prompt)
  lines.push('```')
  lines.push('')
  lines.push('## 校验问题（problems）')
  const problems = report.meta.problems ?? []
  if (!problems.length) lines.push('无。')
  problems.forEach((p) => lines.push(`- [${p.severity}] ${p.rule}: ${p.detail}`))
  return lines.join('\n')
}

main().catch((err) => { console.error('G-VS demo failed:', err); process.exit(1) })