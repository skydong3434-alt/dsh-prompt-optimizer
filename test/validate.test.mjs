/**
 * P04-T02 输出守卫单元测试(v1..v14)。
 *
 * 覆盖 PLAN-v1 §9 三层 anti-drift 机械校验 + 策略 guards 汇总:
 *   v1  导出面 / 三层与 rule id 稳定契约 / 纯函数(零 ctx.llm·Harness·React·DOM);
 *   v2  Preservation:explicit 无证据 → error;
 *   v3  assistant 证据 → warn(不得升格为用户意图);warn 不改变 ok;
 *   v4  WORKSPACE_FACT 豁免(零证据放行 / 不可验证仅 warn);
 *   v5  required_sections 齐全性;
 *   v6  术语 / 型号漂移(用户要求的一部分 → error,其余 → warn);
 *   v7  suggested 混入 explicit/context 来源组 → error(invariant B);
 *   v8  suggested 无标注混入优化稿正文 → error;带建议前缀 → 豁免;
 *   v9  无证据强断言(不可行/最终/确定) → error;候选/疑问/有证据 → 豁免;
 *   v10 无证据量化(预算/时间/平台/模型) → error;有证据/占位符 → 豁免;
 *   v11 Unknown(Phase 2):[待补充:] 已退役,未决项走执行前须知 / 分支条件 / 省略;
 *   v12 策略 guards 汇总(research 强断言守卫同步触发)+ 总入口 provenance_ok 语义;
 *   v13 provenance_ok 联动:validateCompileResult 与 finalizeCompile / compilePrompt 骨架一致;
 *   v14 便捷判定 + 分层结构完备。
 *
 * 运行:先 `npm run build`,再 `node test/validate.test.mjs`。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import research from '../lib/core/strategies/research.js'
import { defaultStrategyRegistry } from '../lib/core/registry.js'
import { COMPILE_MARKERS, compilePrompt, finalizeCompile } from '../lib/core/compiler.js'
import {
  VALIDATION_LAYERS,
  VALIDATION_RULE,
  collectStrategyGuardProblems,
  isCompileResultValid,
  validateCompileResult,
  validateInferenceAndSuggestion,
  validatePreservation,
  validateUnknowns,
} from '../lib/core/validate.js'

const REAL_CASE =
  '帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频,我看到黑鹤001低显流,还有 H3……'

// ─────────────────────────────────────────────────────────────────────────────
// 测试夹具(全部本项目独立撰写)
// ─────────────────────────────────────────────────────────────────────────────

function makeResult(overrides = {}) {
  return {
    prompt_type: 'research',
    confidence_level: 'High',
    diagnosis: '',
    explicit_requirements: [],
    context_requirements: [],
    suggested_requirements: [],
    unknowns: [],
    missing_constraints: [],
    optimized_prompt: '',
    strategy_version: 'test',
    provenance_ok: true,
    ...overrides,
  }
}

function rec(text, source, evidence = [], extra = {}) {
  return { id: `${source}:${text}`, text, source, evidence, confidence: 'high', ...extra }
}

const rules = (problems) => problems.map((p) => p.rule)
const byRule = (problems, rule) => problems.filter((p) => p.rule === rule)

// research 15 段全量正文(用于 v5 / v13 的「契约齐全」场景)。
const RESEARCH_SECTIONS = defaultStrategyRegistry.get('research').required_sections
const FULL_BODY = [
  '## Background（背景）',
  '- 用户机器为 Mac M1 Pro 32GB,使用 ComfyUI 做 AI 视频',
  '## Research Goal（研究目标）',
  '- 研究 Mac M1 Pro 32GB 上用 ComfyUI 做 AI 视频的可执行路径',
  '## Existing Knowledge（已知信息）',
  '- 用户提到黑鹤001低显流与 H3,二者均为线索',
  '## Constraints（约束）',
  '- 目标平台与导出格式:由执行方在动手前确认并按其约束出稿',
  '## Candidate Approaches（候选方案）',
  '- 黑鹤001:候选,待验证',
  '- H3:候选,待验证',
  '## Research Questions（研究问题）',
  '- ComfyUI 在 Mac M1 Pro 上有哪些可用工作流?',
  '## Assumptions To Verify（待验证假设）',
  '- 假设低显存方案可运行,需实测验证',
  '## Evidence Requirements（证据要求）',
  '- 每类结论需官方文档或可复现实测',
  '## Source Priority（来源优先级）',
  '- 官方文档优先于社区转述',
  '## Conflicting Evidence（冲突证据）',
  '- 冲突说法需并列呈现,不得擅自裁决',
  '## Evidence Gaps（证据缺口）',
  '- 是否已有 Mac 实测案例:存在则优先复用其实验配置,否则按自建路径处理',
  '## Continue-search Conditions（继续检索条件）',
  '- 只有单一来源时继续检索',
  '## Comparison Dimensions（对比维度）',
  '- 兼容性 / 性能 / 成本 / 维护性',
  '## Human Decision Points（人工决策点）',
  '- 是否采用某候选由用户决定',
  '## Research Completion Criteria（研究完成标准）',
  '- 关键问题均有证据支撑时结束本轮研究',
].join('\n')

// ─────────────────────────────────────────────────────────────────────────────
// v1. 导出面 / 稳定契约 / 纯函数依赖面
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.deepEqual([...VALIDATION_LAYERS], ['preservation', 'inference-suggestion', 'unknown'])
  assert.equal(new Set(Object.values(VALIDATION_RULE)).size, Object.keys(VALIDATION_RULE).length)
  for (const id of Object.values(VALIDATION_RULE)) assert.match(id, /^VALIDATION_[A-Z_]+$/)

  for (const fn of [
    validatePreservation,
    validateInferenceAndSuggestion,
    validateUnknowns,
    collectStrategyGuardProblems,
    validateCompileResult,
    isCompileResultValid,
  ]) {
    assert.equal(typeof fn, 'function')
  }

  const source = readFileSync(new URL('../src/core/validate.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/ctx\.llm/.test(code), 'validate.ts 不得依赖 ctx.llm')
  assert.ok(!/@deepseek-ai\//.test(code), 'validate.ts 不得依赖 Harness 包')
  assert.ok(!/\bfrom\s+['"]react/.test(code), 'validate.ts 不得依赖 React')
  assert.ok(!/document\.|window\./.test(code), 'validate.ts 不得依赖 DOM')
  assert.ok(source.includes('export function validateCompileResult'), 'validateCompileResult 必须导出')
  console.log('✓ v1 导出面 / 三层契约 / 纯函数零 Host·UI·LLM 依赖')
}

// ─────────────────────────────────────────────────────────────────────────────
// v2. Preservation:explicit 无证据 → error
// ─────────────────────────────────────────────────────────────────────────────
{
  const bare = makeResult({
    explicit_requirements: [rec('研究 Mac 方案', 'USER_EXPLICIT', [])],
    optimized_prompt: '## Background\n- 研究 Mac 方案',
  })
  const report = validateCompileResult(bare, { rawInput: REAL_CASE })
  assert.equal(report.provenance_ok, false)
  assert.ok(report.problems.some((p) => p.severity === 'error' && /EVIDENCE/.test(p.rule)))
  assert.ok(report.layers[0].problems.some((p) => /EVIDENCE/.test(p.rule)))

  const ok = makeResult({
    explicit_requirements: [rec('研究 Mac 方案', 'USER_EXPLICIT', ['Mac M1 Pro 32GB'])],
    optimized_prompt: '## Background\n- 研究 Mac M1 Pro 32GB 方案',
  })
  assert.equal(validateCompileResult(ok, { rawInput: REAL_CASE }).provenance_ok, true)
  console.log('✓ v2 explicit 无证据 → error;有逐字 quote → 通过')
}

// ─────────────────────────────────────────────────────────────────────────────
// v3. assistant 证据 → warn(不得升格为用户意图);warn 不改变 ok
// ─────────────────────────────────────────────────────────────────────────────
{
  const assistantOnly = makeResult({
    explicit_requirements: [rec('使用 Runway 方案', 'USER_EXPLICIT', ['建议用 Runway'])],
    optimized_prompt: '## Background\n- 使用 Runway 做研究',
  })
  const report = validateCompileResult(assistantOnly, {
    rawInput: '帮我研究 Mac',
    contextTurns: [{ role: 'assistant', text: '建议用 Runway' }],
  })
  assert.ok(
    report.problems.some((p) => p.rule === 'PROVENANCE_ASSISTANT_ONLY_EVIDENCE' && p.severity === 'warn'),
    'assistant-only 证据必须是 warn',
  )
  assert.ok(
    !report.problems.some((p) => p.rule === 'PROVENANCE_EVIDENCE_NOT_IN_RAW'),
    'assistant-only 不得叠加 error(该记录不校验为 explicit)',
  )
  assert.equal(report.provenance_ok, true, 'warn 不改变 provenance_ok')
  console.log('✓ v3 assistant 证据 → warn 且不升格')
}

// ─────────────────────────────────────────────────────────────────────────────
// v4. WORKSPACE_FACT 豁免
// ─────────────────────────────────────────────────────────────────────────────
{
  const ws = makeResult({
    context_requirements: [
      rec('工作目录 /repo', 'WORKSPACE_FACT', []),
      rec('工作目录 /repo 的运行时未验证', 'WORKSPACE_FACT', ['这句不可验证']),
    ],
    optimized_prompt: '## Background\n- 工作目录 /repo',
  })
  const report = validateCompileResult(ws, { rawInput: 'hello' })
  assert.ok(
    !report.problems.some(
      (p) => p.severity === 'error' && /EVIDENCE/.test(p.rule) && /WORKSPACE/.test(p.detail),
    ),
    'WORKSPACE_FACT 零证据必须豁免',
  )
  assert.ok(
    report.problems.some((p) => p.rule === 'PROVENANCE_WORKSPACE_EVIDENCE_UNVERIFIED' && p.severity === 'warn'),
    '不可验证的 WORKSPACE_FACT 仅 warn',
  )
  assert.equal(report.provenance_ok, true)
  console.log('✓ v4 WORKSPACE_FACT 豁免 / 仅 warn')
}

// ─────────────────────────────────────────────────────────────────────────────
// v5. required_sections 齐全性
// ─────────────────────────────────────────────────────────────────────────────
{
  const partial = makeResult({ optimized_prompt: '## Background（背景）\n- 已提供' })
  const partialReport = validateCompileResult(partial, {
    rawInput: REAL_CASE,
    strategy: research,
  })
  const missing = byRule(partialReport.problems, VALIDATION_RULE.requiredSectionMissing)
  assert.equal(missing.length, RESEARCH_SECTIONS.length - 1, '缺 N-1 段必须逐段报错')
  assert.ok(missing.every((p) => p.severity === 'error'))
  assert.equal(partialReport.layers[0].ok, false)

  const full = makeResult({
    explicit_requirements: [rec('研究 Mac 上用 ComfyUI 做 AI 视频', 'USER_EXPLICIT', ['ComfyUI'])],
    optimized_prompt: FULL_BODY,
  })
  const fullReport = validateCompileResult(full, { rawInput: REAL_CASE, strategy: research })
  assert.deepEqual(byRule(fullReport.problems, VALIDATION_RULE.requiredSectionMissing), [])
  console.log('✓ v5 required_sections 齐全性')
}

// ─────────────────────────────────────────────────────────────────────────────
// v6. 术语 / 型号漂移(用户要求的一部分 → error,其余 → warn)
// ─────────────────────────────────────────────────────────────────────────────
{
  const drift = makeResult({
    optimized_prompt: '## Background\n- 只保留 ComfyUI',
  })
  const report = validateCompileResult(drift, { rawInput: REAL_CASE })
  const warns = byRule(report.problems, VALIDATION_RULE.termDrift)
  assert.ok(warns.length >= 3, 'M1/32GB/AI/H3 等术语缺失应逐条 warn')
  assert.ok(warns.every((p) => p.severity === 'warn'))
  assert.equal(report.provenance_ok, true, 'raw-only 术语缺失是 warn,不阻断')

  const userBacked = makeResult({
    explicit_requirements: [rec('在 Mac M1 Pro 32GB 上研究', 'USER_EXPLICIT', ['Mac M1 Pro 32GB'])],
    optimized_prompt: '## Background\n- 研究方案',
  })
  const backed = validateCompileResult(userBacked, { rawInput: REAL_CASE })
  const errors = byRule(backed.problems, VALIDATION_RULE.termDrift).filter(
    (p) => p.severity === 'error',
  )
  assert.ok(errors.length >= 1, '用户要求中的术语丢失必须是 error')
  assert.equal(backed.provenance_ok, false)
  console.log('✓ v6 术语漂移分级(warn / error)')
}

// ─────────────────────────────────────────────────────────────────────────────
// v7. suggested 混入 explicit/context 来源组 → error(invariant B)
// ─────────────────────────────────────────────────────────────────────────────
{
  const mixed = makeResult({
    explicit_requirements: [rec('补充目标产出形式', 'USER_EXPLICIT', ['补充目标产出形式'])],
    suggested_requirements: [rec('补充目标产出形式', 'OPTIMIZER_SUGGESTED', [])],
    optimized_prompt: '## Background\n- 补充目标产出形式',
  })
  const report = validateCompileResult(mixed, { rawInput: '补充目标产出形式' })
  assert.ok(
    byRule(report.problems, VALIDATION_RULE.suggestedInRequirements).length >= 1,
    '建议出现在 explicit 来源组必须 error',
  )
  assert.equal(report.provenance_ok, false)
  console.log('✓ v7 suggested 不得混入 explicit/context 来源组')
}

// ─────────────────────────────────────────────────────────────────────────────
// v8. 【v0.2.0-apo 契约变更】suggested 出现在 optimized 正文 → 不再算 provenance 违规;
//     只有混入 explicit / context **来源组**才是违规(用户裁决:正文不是 provenance source group)
{
  const inBody = makeResult({
    suggested_requirements: [rec('补充受众定位', 'OPTIMIZER_SUGGESTED', [])],
    optimized_prompt: '## Constraints\n- 补充受众定位',
  })
  const okBody = validateCompileResult(inBody, { rawInput: '帮我写个方案' })
  assert.equal(
    byRule(okBody.problems, VALIDATION_RULE.suggestedInRequirements).length,
    0,
    '★ 建议出现在正文不得判为 provenance 升级',
  )

  const inExplicit = makeResult({
    explicit_requirements: [rec('补充受众定位', 'USER_EXPLICIT', [])],
    suggested_requirements: [rec('补充受众定位', 'OPTIMIZER_SUGGESTED', [])],
    optimized_prompt: '## Constraints\n- x',
  })
  const badExplicit = validateCompileResult(inExplicit, { rawInput: '帮我写个方案' })
  assert.ok(
    byRule(badExplicit.problems, VALIDATION_RULE.suggestedInRequirements).length >= 1,
    '★ 建议混入 explicit 来源组必须仍然报错(红线未放松;规则 id = SUGGESTED_IN_REQUIREMENTS)',
  )
  assert.equal(badExplicit.provenance_ok, false)
}

// ─────────────────────────────────────────────────────────────────────────────
// v8b. 【契约变更】建议出现在正文(无论是否带前缀)都不再是 provenance 违规
{
  for (const body of ['## Constraints\n- 补充受众定位', '## Constraints\n- 建议(可忽略) 补充受众定位']) {
    const r = makeResult({
      suggested_requirements: [rec('补充受众定位', 'OPTIMIZER_SUGGESTED', [])],
      optimized_prompt: body,
    })
    const v = validateCompileResult(r, { rawInput: '帮我写个方案' })
    assert.deepEqual(
      byRule(v.problems, VALIDATION_RULE.suggestedInRequirements),
      [],
      '★ 正文出现建议不得判为来源组违规',
    )
  }
  console.log('✓ v8b 正文出现建议 → 不再违规(正文不是 provenance 来源组)')
}

// ─────────────────────────────────────────────────────────────────────────────
// v9. 无证据强断言(不可行/最终/确定) → error;候选/疑问/有证据 → 豁免
// ─────────────────────────────────────────────────────────────────────────────
{
  const claim = makeResult({
    optimized_prompt: '## Candidate Approaches\n- H3 最终确定,直接淘汰',
  })
  const bad = validateCompileResult(claim, { rawInput: REAL_CASE })
  assert.ok(byRule(bad.problems, VALIDATION_RULE.unprovenStrongClaim).length >= 1)
  assert.equal(bad.provenance_ok, false)

  const candidate = makeResult({
    optimized_prompt: '## Candidate Approaches\n- H3:候选,待验证,尚未确定',
  })
  const exempt = validateCompileResult(candidate, { rawInput: REAL_CASE })
  assert.deepEqual(byRule(exempt.problems, VALIDATION_RULE.unprovenStrongClaim), [])

  const question = makeResult({
    optimized_prompt: '## Research Questions\n- H3 是否可行?需要哪些证据确定?',
  })
  const asked = validateCompileResult(question, { rawInput: REAL_CASE })
  assert.deepEqual(byRule(asked.problems, VALIDATION_RULE.unprovenStrongClaim), [])

  const backed = makeResult({
    optimized_prompt: '## Background\n- 结论:该方案不可行',
  })
  const ok = validateCompileResult(backed, { rawInput: '该方案不可行,已实测确认' })
  assert.deepEqual(byRule(ok.problems, VALIDATION_RULE.unprovenStrongClaim), [])
  console.log('✓ v9 强断言证据门禁 + 候选/疑问/有证据豁免')
}

// ─────────────────────────────────────────────────────────────────────────────
// v10. 无证据量化(预算/时间/平台/模型) → error;有证据/占位符 → 豁免
// ─────────────────────────────────────────────────────────────────────────────
{
  const invented = makeResult({
    optimized_prompt: [
      '## Constraints（约束）',
      '- 预算 5000 元',
      '- 预计耗时 2 小时',
      '- 目标平台 Windows',
      '- 选用模型 Runway',
    ].join('\n'),
  })
  const bad = validateCompileResult(invented, { rawInput: REAL_CASE })
  const quant = byRule(bad.problems, VALIDATION_RULE.unevidencedQuantification)
  assert.equal(quant.length, 4, '预算/时间/平台/模型四类无证据量化都要报错')
  assert.ok(quant.every((p) => p.severity === 'error'))
  assert.equal(bad.provenance_ok, false)

  const evidencedRaw = '预算 5000 元,耗时 2 小时,平台 Windows,模型 Runway'
  const evidenced = makeResult({ optimized_prompt: invented.optimized_prompt })
  const good = validateCompileResult(evidenced, { rawInput: evidencedRaw })
  assert.deepEqual(byRule(good.problems, VALIDATION_RULE.unevidencedQuantification), [])

  const placeholder = makeResult({
    optimized_prompt: '## Constraints（约束）\n- 预算 [待补充: 上限]\n- 目标平台 [待补充: 未说明]',
  })
  const todo = validateCompileResult(placeholder, { rawInput: REAL_CASE })
  assert.deepEqual(byRule(todo.problems, VALIDATION_RULE.unevidencedQuantification), [])
  console.log('✓ v10 无证据量化门禁 + 证据/占位符豁免')
}

// ─────────────────────────────────────────────────────────────────────────────
// v11. Unknown(Phase 2 契约):[待补充:] 已退役;未决项走执行前须知 / 分支条件 / 省略
{
  // ① 旧占位符出现即 error(I-1)
  const legacyPlaceholder = makeResult({
    optimized_prompt: '## Constraints（约束）\n- 预算 [待补充: 上限]\n- 目标平台 [待补充: 未说明]',
  })
  const retired = validateCompileResult(legacyPlaceholder, { rawInput: REAL_CASE })
  assert.equal(byRule(retired.problems, VALIDATION_RULE.retiredPlaceholder).length, 1, 'I-1:占位符出现即 error')
  assert.equal(retired.provenance_ok, false)

  // ② 面向用户的追问 → error(I-2:UNKNOWN ≠ ASK_USER)
  const asking = makeResult({
    optimized_prompt: '## 执行前须知\n- 请先回答预算上限,否则无法继续',
  })
  const question = validateCompileResult(asking, { rawInput: REAL_CASE })
  assert.equal(byRule(question.problems, VALIDATION_RULE.userFacingQuestion).length, 1, 'I-2:不得反问用户')
  assert.equal(question.provenance_ok, false)

  // ③ 缺口未写入正文 → **合法**(省略是契约允许的处置;可见性由台账 / 面板承担)
  const uncovered = makeResult({
    unknowns: [rec('Mac 实测案例', 'UNKNOWN', [])],
    missing_constraints: [{ id: 'mc-1', label: '期望的视频时长' }],
    optimized_prompt: '## Background\n- 已有内容',
  })
  const bare = validateCompileResult(uncovered, { rawInput: REAL_CASE })
  assert.deepEqual(
    bare.problems.filter((p) => p.severity === 'error'),
    [],
    '合法省略不得产生 error',
  )
  assert.equal(bare.provenance_ok, true, '省略是合法处置:可见性由台账 / 面板承担')

  // ④ 责任说明块存在 → 视为已定位,零问题
  const covered = makeResult({
    unknowns: [rec('Mac 实测案例', 'UNKNOWN', [])],
    missing_constraints: [{ id: 'mc-1', label: '期望的视频时长' }],
    optimized_prompt:
      '## Evidence Gaps（证据缺口）\n- 证据要求:需官方文档或实测\n\n## 执行前须知（由执行方自行确认，不需要询问用户）\n- 动手前先确认:本机可用的生成链路与依赖版本',
  })
  const good = validateCompileResult(covered, { rawInput: REAL_CASE })
  assert.deepEqual(byRule(good.problems, VALIDATION_RULE.retiredPlaceholder), [])
  assert.equal(good.provenance_ok, true)
  console.log('✓ v11 Phase 2 未决项:I-1 占位符退役 / I-2 不得反问 / 未定位仅 warn')
}

// ─────────────────────────────────────────────────────────────────────────────
// v12. 策略 guards 汇总 + 总入口 provenance_ok 语义
// ─────────────────────────────────────────────────────────────────────────────
{
  const drift = makeResult({
    optimized_prompt: '## Evidence Gaps（证据缺口）\n- H3 不可行,直接淘汰\n- 是否已有 Mac 实测案例:存在则复用,否则自建',
  })
  const output = drift.optimized_prompt
  const guardProblems = collectStrategyGuardProblems(research, drift, output, REAL_CASE)
  assert.ok(guardProblems.length >= 1)
  assert.ok(guardProblems.every((p) => p.rule.startsWith('research-')))
  assert.ok(guardProblems.some((p) => p.rule === 'research-no-unfounded-strong-assertion'))

  const report = validateCompileResult(drift, { rawInput: REAL_CASE, strategy: research })
  assert.ok(report.strategyGuards.length >= 1)
  assert.ok(report.problems.some((p) => p.rule === 'research-no-unfounded-strong-assertion'))
  assert.ok(report.problems.some((p) => p.rule === VALIDATION_RULE.unprovenStrongClaim))
  assert.equal(report.provenance_ok, report.ok)
  assert.equal(report.provenance_ok, false)

  assert.deepEqual(collectStrategyGuardProblems(null, drift, output, REAL_CASE), [])
  console.log('✓ v12 策略 guards 汇总 + provenance_ok = ok')
}

// ─────────────────────────────────────────────────────────────────────────────
// v13. provenance_ok 联动:validateCompileResult ↔ finalizeCompile / compilePrompt 骨架
// ─────────────────────────────────────────────────────────────────────────────
{
  const M = COMPILE_MARKERS
  const classifier = {
    prompt_type: 'research',
    confidence_internal: 0.86,
    missing_constraints: ['期望的视频时长'],
    rationale: '研究诉求',
    evidence_quotes: ['Mac M1 Pro 32GB'],
  }
  const missing = [{ id: 'mc-classifier-1', label: '期望的视频时长' }]
  const goodRaw = [
    M.diagnosis,
    '目标清晰度:目标明确',
    M.explicit,
    '- 研究 Mac 上用 ComfyUI 做 AI 视频 [quote: Mac M1 Pro 32GB] [quote: ComfyUI]',
    M.context,
    '- (无)',
    M.suggested,
    '- 建议(可忽略) 补充目标产出形式',
    M.unknown,
    '- 期望的视频时长:由执行方在动手前确认(动作式)',
    M.optimized,
    '## 执行前须知（由执行方自行确认，不需要询问用户）',
    '- 动手前先确认:期望的视频时长',
    FULL_BODY,
    M.end,
  ].join('\n')

  const outcome = finalizeCompile(research, goodRaw, {
    rawInput: REAL_CASE,
    contextTurns: [],
    classifier,
    missing,
    mode: 'full',
  })
  assert.equal(outcome.result.provenance_ok, true, 'finalize 侧应通过(既有语义)')

  const validated = validateCompileResult(outcome.result, {
    rawInput: REAL_CASE,
    contextTurns: [],
    strategy: research,
    rawOutput: goodRaw,
  })
  assert.equal(
    validated.provenance_ok,
    outcome.result.provenance_ok,
    'validate.ts 的 provenance_ok 必须与 finalizeCompile 联动一致(通过)',
  )
  assert.equal(validated.ok, true)

  // 伪造 quote → 两侧同时 false。
  const fakeRaw = goodRaw.replace(
    '[quote: Mac M1 Pro 32GB] [quote: ComfyUI]',
    '[quote: 这句根本不在输入里]',
  )
  const badOutcome = finalizeCompile(research, fakeRaw, {
    rawInput: REAL_CASE,
    contextTurns: [],
    classifier,
    missing,
    mode: 'full',
  })
  const badValidated = validateCompileResult(badOutcome.result, {
    rawInput: REAL_CASE,
    contextTurns: [],
    strategy: research,
    rawOutput: fakeRaw,
  })
  assert.equal(badOutcome.result.provenance_ok, false)
  assert.equal(badValidated.provenance_ok, false)
  assert.equal(badValidated.provenance_ok, badOutcome.result.provenance_ok)

  // compilePrompt 骨架(optimized_prompt 空、provenance_ok=false)→ validate 也必须 false。
  const plan = compilePrompt({
    raw_input: REAL_CASE,
    classifier,
    registry: defaultStrategyRegistry,
  })
  assert.equal(plan.result.provenance_ok, false, 'validate 之前骨架必须 false')
  const skeleton = validateCompileResult(plan.result, {
    rawInput: REAL_CASE,
    strategy: plan.strategy,
  })
  assert.equal(skeleton.provenance_ok, false)
  assert.equal(skeleton.provenance_ok, plan.result.provenance_ok)
  console.log('✓ v13 provenance_ok 联动(finalizeCompile / compilePrompt 骨架)')
}

// ─────────────────────────────────────────────────────────────────────────────
// v14. 便捷判定 + 分层结构完备
// ─────────────────────────────────────────────────────────────────────────────
{
  const clean = makeResult({
    explicit_requirements: [rec('研究 Mac 上用 ComfyUI 做 AI 视频', 'USER_EXPLICIT', ['ComfyUI'])],
    unknowns: [rec('Mac 实测案例', 'UNKNOWN', [])],
    missing_constraints: [{ id: 'mc-1', label: 'Mac 实测案例' }],
    optimized_prompt: `${FULL_BODY}\n\n## 执行前须知（由执行方自行确认，不需要询问用户）\n- 动手前先确认:Mac 实测案例来源与依赖版本`,
  })
  const report = validateCompileResult(clean, { rawInput: REAL_CASE, strategy: research })
  assert.deepEqual(report.layers.map((l) => l.layer), [...VALIDATION_LAYERS])
  assert.ok(report.layers.every((l) => typeof l.ok === 'boolean' && Array.isArray(l.problems)))
  assert.equal(isCompileResultValid(clean, { rawInput: REAL_CASE, strategy: research }), report.ok)

  const broken = makeResult({ optimized_prompt: '## Background\n- 无证据量化:预算 9999 元' })
  assert.equal(isCompileResultValid(broken, { rawInput: REAL_CASE }), false)
  console.log('✓ v14 便捷判定 + 分层结构完备')
}

console.log('\nvalidate: all passed')
