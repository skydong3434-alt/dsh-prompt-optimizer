/**
 * diagnostic 策略单元测试(P02-T04)。
 *
 * 运行:先 `npm run build`,再 `node test/strategies-diagnostic.test.mjs`。
 * 覆盖:契约形状 / 10 段锚点 / 双语 buildSystem / buildUser 注入 / 守卫矩阵
 * (修复必须带验证 · 不得先改后查 · 修复需回归测试 · 必出段落 · Hypotheses 与
 * Disprove-Verify 强制段 · 无证据根因强断言 · invariant A·B)/ 保真检查 /
 * mock 编译产物抽查(先证据后修改 + 修复带复测 + 回归测试齐备)。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import diagnostic, {
  DIAGNOSTIC_MANDATORY_SECTIONS,
  DIAGNOSTIC_REQUIRED_SECTIONS,
  DIAGNOSTIC_STRATEGY_VERSION,
  DISPROVE_VERIFY_MANDATORY,
  EVIDENCE_BEFORE_MODIFICATION,
  FIX_REQUIRES_VERIFICATION,
  HYPOTHESES_MANDATORY,
  buildDiagnosticSystem,
  buildDiagnosticUser,
} from '../lib/core/strategies/diagnostic.js'
import {
  INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH,
  INVARIANT_UNKNOWN_NOT_BLOCKING_ZH,
} from '../lib/core/strategies/_shared.js'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (rel) => readFileSync(join(here, rel), 'utf8')

const REAL_CASE =
  'P8-08 为什么一直超时?先别改代码,帮我收集证据定位根因,不要直接给我修复代码'

const EXPECTED_SECTIONS = [
  'Symptom',
  'Expected Behavior',
  'Actual Behavior',
  'Evidence Collection',
  'Reproduction',
  'Hypotheses',
  'Root Cause Analysis',
  'Disprove-Verify',
  'Fix Proposal',
  'Regression Test',
]

const emptyResult = { explicit_requirements: [], context_requirements: [] }
const guardIssues = (output, rawInput = '', result = emptyResult) =>
  diagnostic.guards
    .map((guard) => guard.check(output, result, rawInput))
    .filter((issue) => issue !== null)
const guardById = (id) => diagnostic.guards.find((guard) => guard.id === id)
const ruleById = (rules, id) => rules.find((rule) => rule.id === id)

/** 一份完整的合法编译产物:10 段齐全、先证据后修复、修复带复测、回归测试齐备。 */
const GOOD_DIAGNOSTIC_OUTPUT = [
  '## 明确要求',
  '- P8-08 一直超时,先别改代码 [quote: 先别改代码]',
  '- 要先收集证据定位根因,不要直接给修复代码 [quote: 不要直接给我修复代码]',
  '## 上下文已确认',
  '- 上次运行在 30 秒后超时 [quote: 30 秒后超时]',
  '## 优化器建议(可忽略)',
  '- 建议(可忽略) 先加临时耗时日志定位瓶颈,不影响现有逻辑',
  '## 待补充',
  '- [待补充: 超时阈值与运行环境版本]',
  '## 优化后的 Diagnostic Prompt',
  '### Symptom（症状）',
  '- P8-08 流水线反复超时。',
  '### Expected Behavior（期望行为）',
  '- 流水线应在阈值内正常结束。',
  '### Actual Behavior（实际行为）',
  '- 运行约 30 秒后超时退出。',
  '### Evidence Collection（证据收集）',
  '- 收集完整日志、超时时间戳、环境版本与最近一次改动。',
  '### Reproduction（复现）',
  '- 最小复现:运行 `npm test` 观察是否稳定在 30 秒超时。',
  '### Hypotheses（假设）',
  '- H1 待验证:某一步网络调用阻塞。',
  '- H2 待验证:重试策略导致总耗时翻倍。',
  '### Root Cause Analysis（根因分析）',
  '- 根因待验证:目前只有超时现象,尚无日志证据支持任何单一原因。',
  '### Disprove-Verify（证伪/验证）',
  '- 对 H1 做断网对照实验;若仍超时则证伪。',
  '- 对 H2 临时关闭重试并计时;若耗时不变则证伪。',
  '### Fix Proposal（修复建议）',
  '- 仅在 H1 被证实后,为网络调用设置超时与降级;',
  '- 修复后按 Regression Test 复测并对比耗时,确认不再超时。',
  '### Regression Test（回归测试）',
  '- 运行 `npm test` 与超时场景脚本,连续 3 次通过且耗时低于阈值。',
].join('\n')

// 1. 契约形状:type / 独立版本 / 10 段锚点 / sections 顺序一致
{
  assert.equal(diagnostic.type, 'diagnostic')
  assert.equal(diagnostic.version, DIAGNOSTIC_STRATEGY_VERSION)
  assert.equal(diagnostic.version, '0.1.0', '策略必须带独立版本号 0.1.0')
  assert.deepEqual(diagnostic.required_sections, EXPECTED_SECTIONS)
  assert.equal(diagnostic.required_sections.length, 10)
  assert.deepEqual(diagnostic.outputContract.sections, EXPECTED_SECTIONS)
  assert.deepEqual(DIAGNOSTIC_REQUIRED_SECTIONS, EXPECTED_SECTIONS)
  assert.deepEqual(DIAGNOSTIC_MANDATORY_SECTIONS, [
    'Symptom',
    'Evidence Collection',
    'Reproduction',
    'Hypotheses',
    'Disprove-Verify',
    'Fix Proposal',
    'Regression Test',
  ])
  assert.ok(
    DIAGNOSTIC_MANDATORY_SECTIONS.includes('Hypotheses'),
    'Hypotheses 必须是强制段',
  )
  assert.ok(
    DIAGNOSTIC_MANDATORY_SECTIONS.includes('Disprove-Verify'),
    'Disprove-Verify 必须是强制段',
  )
  assert.ok(diagnostic.purpose.length > 0)
  assert.equal(typeof diagnostic.buildSystem, 'function')
  assert.equal(typeof diagnostic.buildUser, 'function')
  console.log('✓ dg1 契约形状:type/version 0.1.0/10 段锚点/强制段')
}

// 2. 零 ctx / UI / Host import(纯数据 + 纯函数,可独立升级)
{
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const source = stripComments(readSource('../src/core/strategies/diagnostic.ts'))
  assert.doesNotMatch(source, /ctx\.llm/, '策略不得依赖 ctx.llm')
  assert.doesNotMatch(source, /from ['"]@deepseek-ai/, '策略不得 import Harness 包')
  assert.doesNotMatch(source, /from ['"]react/, '策略不得 import react')
  assert.doesNotMatch(source, /client\//, '策略不得 import UI 代码')
  assert.doesNotMatch(source, /from ['"]\.\.\/(?:compiler|classify|registry)/, '策略不得依赖编译/分类实现')
  console.log('✓ dg2 零 ctx/UI/Host 依赖')
}

// 3. buildSystem('zh'):10 段全出现 + 诊断铁律 + 共享不变式
{
  const sys = buildDiagnosticSystem('zh')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `zh system 缺少段落锚点 ${section}`)
  }
  assert.ok(sys.includes(EVIDENCE_BEFORE_MODIFICATION), 'zh system 必须包含「验证先于修改」')
  assert.ok(sys.includes(HYPOTHESES_MANDATORY), 'zh system 必须包含「假设段必备且待验证」')
  assert.ok(sys.includes(DISPROVE_VERIFY_MANDATORY), 'zh system 必须包含「证伪/验证段必备」')
  assert.ok(sys.includes(FIX_REQUIRES_VERIFICATION), 'zh system 必须包含「修复必须含验证/复测」')
  assert.match(sys, /未验证不修改/)
  assert.match(sys, /不得编造/)
  assert.match(sys, /待补充/)
  assert.match(sys, /建议\(可忽略\)/)
  assert.ok(sys.includes(INVARIANT_UNKNOWN_NOT_BLOCKING_ZH), 'zh system 必须含 invariant A')
  assert.ok(sys.includes(INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH), 'zh system 必须含 invariant B')
  console.log('✓ dg3 buildSystem(zh):10 段 + 诊断铁律 + invariant A·B')
}

// 4. buildSystem('en'):同构英文版,10 段锚点仍全部出现
{
  const sys = buildDiagnosticSystem('en')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `en system 缺少段落锚点 ${section}`)
  }
  assert.match(sys, /Verification before modification/)
  assert.match(sys, /Hypotheses are mandatory/)
  assert.match(sys, /Disprove-Verify is mandatory/)
  assert.match(sys, /Fix Proposal must include verification/)
  assert.match(sys, /TODO/)
  console.log('✓ dg4 buildSystem(en):双语同构 + 10 段')
}

// 5. buildUser:真实案例注入 + 10 段 + 缺口纪律 + 上下文/workspace/llm_derived
{
  const vars = {
    raw_input: REAL_CASE,
    context_turns: [
      { role: 'user', text: '先收集日志证据,不要直接改代码' },
      { role: 'assistant', text: '可以先看 30 秒超时那一段' },
    ],
    workspace_metadata: { cwd: '/Users/me/Projects/apo', workspace_name: 'apo' },
    missing_constraints: [
      { id: 'mc-1', label: '复现条件与环境版本', reason: '决定假设如何证伪' },
    ],
    llm_derived: {
      user_goals: [
        {
          id: 'g1',
          text: '定位 P8-08 超时根因',
          source: 'USER_EXPLICIT',
          evidence: ['P8-08 为什么一直超时'],
          confidence: 'high',
        },
      ],
      rejected_directions: [],
      known_constraints: [],
    },
  }
  const user = buildDiagnosticUser(vars)
  assert.ok(user.includes(REAL_CASE), 'user 载荷必须原样包含 raw_input')
  assert.match(user, /<prompt-draft>/)
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(user.includes(section), `user 载荷缺少段落锚点 ${section}`)
  }
  assert.match(user, /用户: 先收集日志证据/)
  assert.match(user, /助手: 可以先看 30 秒超时那一段/)
  assert.match(user, /apo/)
  assert.match(user, /复现条件与环境版本/)
  assert.match(user, /\[待补充:/)
  assert.match(user, /\[quote: P8-08 为什么一直超时\]/)
  console.log('✓ dg5 buildUser:真实案例 + 上下文/workspace/缺口/llm_derived')
}

// 6. buildUser 语言匹配:英文输入 → 英文载荷;中文输入 → 中文载荷
{
  const en = buildDiagnosticUser({
    raw_input: 'Why does P8-08 keep timing out? Collect evidence first, do not change code yet',
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(en, /Here is my troubleshooting request/)
  assert.match(en, /<prompt-draft>/)
  assert.ok(!en.includes('以下是我的排障诉求'))

  const zh = buildDiagnosticUser({
    raw_input: REAL_CASE,
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(zh, /以下是我的排障诉求/)
  assert.ok(!zh.includes('Here is my troubleshooting request'))
  console.log('✓ dg6 buildUser 语言匹配(zh 优先)')
}

// 7. 守卫 1:Fix Proposal 必须含验证 / 复测步骤(任务契约点名 error)
{
  const guard = guardById('diagnostic-fix-requires-verification')
  assert.ok(guard, '守卫 1 必须存在')

  // 只给改动、没有验证 / 复测 → error
  const unverifiedFix = [
    '### Evidence Collection（证据收集）',
    '- 收集日志',
    '### Reproduction（复现）',
    '- 运行命令即可复现',
    '### Hypotheses（假设）',
    '- H1 待验证',
    '### Disprove-Verify（证伪/验证）',
    '- 对照实验',
    '### Fix Proposal（修复建议）',
    '- 把超时时间改成 60 秒',
    '### Regression Test（回归测试）',
    '- 运行 npm test',
  ].join('\n')
  assert.ok(
    guard.check(unverifiedFix, emptyResult, REAL_CASE),
    '修复建议无验证 / 复测步骤 → 必须触发 error',
  )

  // 修复建议段为空 → error
  const emptyFix = [
    '### Fix Proposal（修复建议）',
    '### Regression Test（回归测试）',
    '- 运行 npm test',
  ].join('\n')
  assert.ok(guard.check(emptyFix, emptyResult, REAL_CASE), '修复段为空 → 必须触发')

  // 含复测 / 指向回归测试 → 放行
  const verifiedFix = [
    '### Fix Proposal（修复建议）',
    '- 修复后按 Regression Test 复测并对比耗时',
    '### Regression Test（回归测试）',
    '- 运行 npm test',
  ].join('\n')
  assert.equal(guard.check(verifiedFix, emptyResult, REAL_CASE), null, '含复测 → 放行')

  // 无 Fix Proposal 段 → 交给 required-sections 守卫,不重复报
  assert.equal(guard.check('### Symptom\n- 超时', emptyResult, REAL_CASE), null)
  console.log('✓ dg7 守卫 1:修复无验证触发 / 含复测放行')
}

// 8. 守卫 2:验证先于修改 —— Fix Proposal 不得出现在证据 / 复现 / 假设 / 证伪之前
{
  const guard = guardById('diagnostic-no-fix-before-evidence')
  assert.ok(guard, '守卫 2 必须存在')

  const fixFirst = [
    '### Fix Proposal（修复建议）',
    '- 改成 60 秒,改完按 Regression Test 复测',
    '### Evidence Collection（证据收集）',
    '- 收集日志',
    '### Reproduction（复现）',
    '- 运行 npm test',
    '### Hypotheses（假设）',
    '- H1 待验证',
    '### Disprove-Verify（证伪/验证）',
    '- 对照实验',
  ].join('\n')
  assert.ok(guard.check(fixFirst, emptyResult, REAL_CASE), '修复段先于证据段 → 必须触发')

  const fixBeforeHypotheses = [
    '### Evidence Collection（证据收集）',
    '- 收集日志',
    '### Reproduction（复现）',
    '- 运行 npm test',
    '### Fix Proposal（修复建议）',
    '- 改成 60 秒,改完复测',
    '### Hypotheses（假设）',
    '- H1 待验证',
    '### Disprove-Verify（证伪/验证）',
    '- 对照实验',
  ].join('\n')
  assert.ok(guard.check(fixBeforeHypotheses, emptyResult, REAL_CASE), '修复段先于假设段 → 必须触发')

  assert.equal(guard.check(GOOD_DIAGNOSTIC_OUTPUT, emptyResult, REAL_CASE), null, '先证据后修复 → 放行')
  assert.equal(guard.check('### Symptom\n- 超时', emptyResult, REAL_CASE), null, '无修复段 → 放行')
  console.log('✓ dg8 守卫 2:修复先于证据触发 / 先证据后修复放行')
}

// 9. 守卫 3:修复建议必须能落到 Regression Test(回归测试不得缺位或为空)
{
  const guard = guardById('diagnostic-fix-needs-regression-test')
  assert.ok(guard, '守卫 3 必须存在')

  const noRegression = ['### Fix Proposal（修复建议）', '- 改成 60 秒,改完复测'].join('\n')
  assert.ok(guard.check(noRegression, emptyResult, REAL_CASE), '缺回归测试段 → 必须触发')

  const emptyRegression = [
    '### Fix Proposal（修复建议）',
    '- 改成 60 秒,改完复测',
    '### Regression Test（回归测试）',
  ].join('\n')
  assert.ok(guard.check(emptyRegression, emptyResult, REAL_CASE), '回归测试段为空 → 必须触发')

  assert.equal(guard.check(GOOD_DIAGNOSTIC_OUTPUT, emptyResult, REAL_CASE), null, '回归测试齐备 → 放行')
  console.log('✓ dg9 守卫 3:修复需回归测试')
}

// 10. 守卫 4:必出段落齐全(sectionPresence 工厂)
{
  const guard = guardById('diagnostic-required-sections')
  assert.ok(guard, '守卫 4 必须存在')
  assert.equal(guard.check(buildDiagnosticSystem('zh'), emptyResult, ''), null, '10 段必须齐全')
  assert.ok(
    guard.check(buildDiagnosticSystem('zh').split('Regression Test').join(''), emptyResult, ''),
    '缺段 → 必须触发',
  )
  console.log('✓ dg10 守卫 4:必出段落齐全')
}

// 11. 守卫 5:Hypotheses 与 Disprove-Verify 强制段(任务契约点名)
{
  const guard = guardById('diagnostic-mandatory-hypotheses-disprove-verify')
  assert.ok(guard, '守卫 5 必须存在')
  assert.equal(guard.check(GOOD_DIAGNOSTIC_OUTPUT, emptyResult, REAL_CASE), null, '强制段齐全 → 放行')

  const missingHypotheses = GOOD_DIAGNOSTIC_OUTPUT.replace(/Hypotheses/g, 'Hypo')
  assert.ok(guard.check(missingHypotheses, emptyResult, REAL_CASE), '缺 Hypotheses → 必须触发')

  const missingDisprove = GOOD_DIAGNOSTIC_OUTPUT.replace(/Disprove-Verify/g, 'DV')
  assert.ok(guard.check(missingDisprove, emptyResult, REAL_CASE), '缺 Disprove-Verify → 必须触发')
  console.log('✓ dg11 守卫 5:Hypotheses / Disprove-Verify 强制段')
}

// 12. 守卫 6:无证据根因强断言(已确认 / 已定位 / 确定 必须有逐字证据)
{
  const guard = guardById('diagnostic-no-unproven-root-cause')
  assert.ok(guard, '守卫 6 必须存在')

  assert.ok(
    guard.check('### Root Cause Analysis\n- 根因已确认:是网络阻塞', emptyResult, ''),
    '无证据「已确认」根因 → 必须触发',
  )
  assert.equal(
    guard.check('### Root Cause Analysis\n- 根因待验证:可能是网络阻塞', emptyResult, ''),
    null,
    '待验证假设 → 放行',
  )
  console.log('✓ dg12 守卫 6:无证据根因强断言')
}

// 13. 跨策略不变式 A·B 已挂到 diagnostic.guards(P02-T01 工厂)
{
  assert.ok(guardById('shared-unknown-not-blocking'), 'invariant A 守卫必须存在')
  assert.ok(guardById('shared-suggested-not-in-explicit'), 'invariant B 守卫必须存在')
  assert.ok(guardById('shared-suggested-not-upgraded'), 'invariant B(升级)守卫必须存在')

  const unknown = guardById('shared-unknown-not-blocking')
  assert.equal(unknown.check('- [待补充: 超时阈值与环境版本]', emptyResult, ''), null)
  assert.ok(unknown.check('- 请先回答超时阈值与环境版本,否则无法继续', emptyResult, ''))

  const upgraded = guardById('shared-suggested-not-upgraded')
  const suggested = [{ text: '建议(可忽略) 先加临时耗时日志', source: 'OPTIMIZER_SUGGESTED' }]
  assert.ok(
    upgraded.check('- 必须先加临时耗时日志', { suggested_requirements: suggested }, ''),
    '建议升级为强约束 → 必须触发',
  )
  assert.equal(
    upgraded.check('- 计划先加临时耗时日志', { suggested_requirements: suggested }, ''),
    null,
  )
  console.log('✓ dg13 invariant A·B 已挂载并生效')
}

// 14. 合法 mock 编译产物:守卫全过 + 无重复 id + 规则齐备
{
  assert.deepEqual(guardIssues(GOOD_DIAGNOSTIC_OUTPUT, REAL_CASE), [], '合法产物不应触发任何守卫')

  const ids = diagnostic.guards.map((guard) => guard.id)
  assert.equal(new Set(ids).size, ids.length, '守卫 id 必须唯一')
  const suggestionIds = diagnostic.suggestionRules.map((rule) => rule.id)
  assert.equal(new Set(suggestionIds).size, suggestionIds.length)
  const provenanceIds = diagnostic.provenanceRules.map((rule) => rule.id)
  assert.equal(new Set(provenanceIds).size, provenanceIds.length)
  const preservationIds = diagnostic.preservationRules.map((rule) => rule.id)
  assert.equal(new Set(preservationIds).size, preservationIds.length)
  assert.ok(diagnostic.suggestionRules.length >= 3)
  assert.ok(diagnostic.provenanceRules.length >= 3)
  assert.ok(diagnostic.preservationRules.length >= 3)
  console.log('✓ dg14 合法产物零守卫问题 + 规则 id 唯一')
}

// 15. 保真检查:根因信号(P8-08)与专有名词保留 / 语言匹配
{
  const subject = ruleById(diagnostic.preservationRules, 'diagnostic-preserve-error-signals')
  assert.ok(subject?.check)
  const kept = '当前症状:P8-08 一直超时;先收集证据,根因待验证,再给修复与回归测试。'
  assert.equal(subject.check(kept, REAL_CASE, []), true)
  assert.equal(subject.check('当前症状:一个流水线一直超时', REAL_CASE, []), false, '丢失 P8-08 必须判定不保真')

  const language = ruleById(diagnostic.preservationRules, 'diagnostic-preserve-language')
  assert.ok(language?.check)
  assert.equal(language.check(kept, REAL_CASE, []), true)
  assert.equal(language.check('English-only output', REAL_CASE, []), false)
  assert.equal(language.check('', REAL_CASE, []), false)

  assert.ok(ruleById(diagnostic.preservationRules, 'diagnostic-preserve-evidence-verbatim'))
  assert.ok(ruleById(diagnostic.preservationRules, 'diagnostic-preserve-symptom-boundary'))
  console.log('✓ dg15 保真检查:P8-08 保留 + 语言匹配 + 证据/症状边界')
}

// 16. mock 编译产物抽查:先证据后修复链 + 修复带复测 + 回归测试齐备
{
  const mockCompiled = GOOD_DIAGNOSTIC_OUTPUT

  // 铁律:修复段必须晚于证据 / 复现 / 假设 / 证伪段
  const fixIndex = mockCompiled.indexOf('### Fix Proposal')
  for (const anchor of [
    '### Evidence Collection',
    '### Reproduction',
    '### Hypotheses',
    '### Disprove-Verify',
  ]) {
    assert.ok(mockCompiled.indexOf(anchor) < fixIndex, `${anchor} 必须早于 Fix Proposal`)
  }
  // 修复建议含复测,且回归测试段非空
  assert.match(mockCompiled.slice(fixIndex), /复测/)
  assert.match(mockCompiled, /### Regression Test（回归测试）\n- 运行 `npm test`/)
  // 守卫对合法产物零误报
  assert.deepEqual(guardIssues(mockCompiled, REAL_CASE), [])
  // 编译用 system/user 文案齐备
  assert.ok(buildDiagnosticSystem('zh').length > 0)
  assert.ok(
    diagnostic
      .buildUser({ raw_input: REAL_CASE, context_turns: [], workspace_metadata: {}, missing_constraints: [] })
      .includes(REAL_CASE),
  )
  console.log('✓ dg16 mock 产物:先证据后修复 + 修复带复测 + 回归测试 + 守卫零误报')
}

console.log('\nstrategies-diagnostic: all passed')
