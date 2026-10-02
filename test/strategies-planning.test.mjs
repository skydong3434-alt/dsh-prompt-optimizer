/**
 * planning 策略单元测试(P02-T02)。
 *
 * 运行:先 `npm run build`,再 `node test/strategies-planning.test.mjs`。
 * 覆盖:契约形状 / 16 段锚点 / 双语 buildSystem / buildUser 注入 / 守卫矩阵
 * (禁执行证据 · 每阶段验收 · 必出段落 · invariant A·B)/ 保真检查 /
 * mock 编译产物抽查(只规划不执行 + 每阶段带头验收 + 失败/停止段齐备)。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import planning, {
  FAILURE_AND_STOP_REQUIRED,
  PHASE_REQUIRES_ACCEPTANCE,
  PLANNING_REQUIRED_SECTIONS,
  PLANNING_STRATEGY_VERSION,
  PLAN_ONLY_NOT_EXECUTE,
  buildPlanningSystem,
  buildPlanningUser,
} from '../lib/core/strategies/planning.js'
import {
  INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH,
  INVARIANT_UNKNOWN_NOT_BLOCKING_ZH,
} from '../lib/core/strategies/_shared.js'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (rel) => readFileSync(join(here, rel), 'utf8')

const REAL_CASE =
  '帮我规划一下把 dsh-adaptive-prompt-optimizer 升级成支持七种任务类型(P02-T02 起逐步实施),先出方案再分阶段实施,别直接动正式配置'

const EXPECTED_SECTIONS = [
  'Goal',
  'Why',
  'Preconditions',
  'Inputs',
  'Executor',
  'Tools',
  'Phases',
  'Tasks',
  'Dependencies',
  'Exact Steps',
  'Outputs',
  'Tests',
  'Acceptance Criteria',
  'Failure Handling',
  'Stop Conditions',
  'Next Step Condition',
]

const emptyResult = { explicit_requirements: [], context_requirements: [] }
const guardIssues = (output, rawInput = '', result = emptyResult) =>
  planning.guards
    .map((guard) => guard.check(output, result, rawInput))
    .filter((issue) => issue !== null)
const guardById = (id) => planning.guards.find((guard) => guard.id === id)
const ruleById = (rules, id) => rules.find((rule) => rule.id === id)

/** 一份完整的合法编译产物:16 段齐全、每阶段带 Acceptance、无执行证据。 */
const GOOD_PLANNING_OUTPUT = [
  '## 明确要求',
  '- 把优化器升级为支持七种任务类型 [quote: 支持七种任务类型]',
  '- 先出方案再分阶段实施,不得直接改正式配置 [quote: 别直接动正式配置]',
  '## 上下文已确认',
  '- 用户希望先看方案 [quote: 先出方案]',
  '## 优化器建议(可忽略)',
  '- 建议(可忽略) 为每阶段补充可判定的验收指标',
  '## 待补充',
  '- [待补充: 每阶段的验收人与截止时间]',
  '## 优化后的 Planning Prompt',
  '### Goal（目标）',
  '- 让插件稳定区分七种任务类型并各自使用独立策略。',
  '### Why（动机）',
  '- 规划类需求目前与通用改写混在一起,缺少可验收的分阶段计划。',
  '### Preconditions（前置条件）',
  '- 七策略共享规则段已完成。',
  '### Inputs（输入）',
  '- 用户诉求与现有策略基线。',
  '### Executor（执行者）',
  '- 实现由 Claude Code 负责,验收由 DSH 负责。',
  '### Tools（工具）',
  '- node / tsc / node:test / git。',
  '### Phases（阶段）',
  '#### Phase 1 — 策略实现',
  '- 目标:实现 planning/execution 等策略。',
  '- Acceptance（验收）:每个策略单测全绿且版本独立。',
  '#### Phase 2 — 注册表与回归',
  '- 目标:接入 registry 并跑通全量回归。',
  '- Acceptance（验收）:npm test 全绿且未破坏既有用例。',
  '### Tasks（任务）',
  '- 逐策略实现并各写单测。',
  '### Dependencies（依赖）',
  '- 注册表接入依赖各策略完成。',
  '### Exact Steps（具体步骤）',
  '- 运行 npm test 与 python3 scripts/apo_state.py 验证。',
  '### Outputs（产出物）',
  '- 各策略模块与单测文件。',
  '### Tests（测试）',
  '- node test/strategies-planning.test.mjs 与 npm test。',
  '### Acceptance Criteria（验收标准）',
  '- 每阶段验收标准可判定;未通过不得进入下一阶段。',
  '### Failure Handling（失败处理）',
  '- 失败先回修,不绕过断言;3 次不过即停止并上报。',
  '### Stop Conditions（停止条件）',
  '- 命中 Human Gate 或需要改动正式配置时,立即停止等待用户裁决。',
  '### Next Step Condition（下一步条件）',
  '- 当前阶段 Acceptance 全部满足后,方可进入下一阶段。',
].join('\n')

// 1. 契约形状:type / 独立版本 / 16 段锚点 / sections 顺序一致
{
  assert.equal(planning.type, 'planning')
  assert.equal(planning.version, PLANNING_STRATEGY_VERSION)
  assert.equal(planning.version, '0.1.0', '策略必须带独立版本号 0.1.0')
  assert.deepEqual(planning.required_sections, EXPECTED_SECTIONS)
  assert.equal(planning.required_sections.length, 16)
  assert.deepEqual(planning.outputContract.sections, EXPECTED_SECTIONS)
  assert.deepEqual(PLANNING_REQUIRED_SECTIONS, EXPECTED_SECTIONS)
  assert.ok(planning.purpose.length > 0)
  assert.equal(typeof planning.buildSystem, 'function')
  assert.equal(typeof planning.buildUser, 'function')
  console.log('✓ pl1 契约形状:type/version 0.1.0/16 段锚点')
}

// 2. 零 ctx / UI / Host import(纯数据 + 纯函数,可独立升级)
{
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const source = stripComments(readSource('../src/core/strategies/planning.ts'))
  assert.doesNotMatch(source, /ctx\.llm/, '策略不得依赖 ctx.llm')
  assert.doesNotMatch(source, /from ['"]@deepseek-ai/, '策略不得 import Harness 包')
  assert.doesNotMatch(source, /from ['"]react/, '策略不得 import react')
  assert.doesNotMatch(source, /client\//, '策略不得 import UI 代码')
  assert.doesNotMatch(source, /from ['"]\.\.\/(?:compiler|classify|registry)/, '策略不得依赖编译/分类实现')
  console.log('✓ pl2 零 ctx/UI/Host 依赖')
}

// 3. buildSystem('zh'):16 段全出现 + 规划铁律 + 共享不变式
{
  const sys = buildPlanningSystem('zh')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `zh system 缺少段落锚点 ${section}`)
  }
  assert.ok(sys.includes(PLAN_ONLY_NOT_EXECUTE), 'zh system 必须包含「只规划、不执行」')
  assert.ok(sys.includes(PHASE_REQUIRES_ACCEPTANCE), 'zh system 必须包含「每个阶段必须带验收标准」')
  assert.ok(sys.includes(FAILURE_AND_STOP_REQUIRED), 'zh system 必须包含「失败处理与停止条件必备」')
  assert.match(sys, /已开始实施/, 'zh system 必须点名执行证据范例')
  assert.match(sys, /待补充/)
  assert.match(sys, /建议\(可忽略\)/)
  assert.ok(sys.includes(INVARIANT_UNKNOWN_NOT_BLOCKING_ZH), 'zh system 必须含 invariant A')
  assert.ok(sys.includes(INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH), 'zh system 必须含 invariant B')
  console.log('✓ pl3 buildSystem(zh):16 段 + 规划铁律 + invariant A·B')
}

// 4. buildSystem('en'):同构英文版,16 段锚点仍全部出现
{
  const sys = buildPlanningSystem('en')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `en system 缺少段落锚点 ${section}`)
  }
  assert.match(sys, /Plan only, never execute/)
  assert.match(sys, /Every phase must carry Acceptance/)
  assert.match(sys, /TODO/)
  console.log('✓ pl4 buildSystem(en):双语同构 + 16 段')
}

// 5. buildUser:真实案例注入 + 16 段 + 缺口纪律 + 上下文/workspace/llm_derived
{
  const vars = {
    raw_input: REAL_CASE,
    context_turns: [
      { role: 'user', text: '先出方案,不要直接改正式配置' },
      { role: 'assistant', text: '可以先从策略注册表开始' },
    ],
    workspace_metadata: { cwd: '/Users/me/Projects/apo', workspace_name: 'apo' },
    missing_constraints: [
      { id: 'mc-1', label: '阶段验收人', reason: '决定每阶段何时算通过' },
    ],
    llm_derived: {
      user_goals: [
        {
          id: 'g1',
          text: '把优化器升级为七种任务类型',
          source: 'USER_EXPLICIT',
          evidence: ['支持七种任务类型'],
          confidence: 'high',
        },
      ],
      rejected_directions: [],
      known_constraints: [],
    },
  }
  const user = buildPlanningUser(vars)
  assert.ok(user.includes(REAL_CASE), 'user 载荷必须原样包含 raw_input')
  assert.match(user, /<prompt-draft>/)
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(user.includes(section), `user 载荷缺少段落锚点 ${section}`)
  }
  assert.match(user, /用户: 先出方案,不要直接改正式配置/)
  assert.match(user, /助手: 可以先从策略注册表开始/)
  assert.match(user, /apo/)
  assert.match(user, /阶段验收人/)
  assert.match(user, /\[待补充:/)
  assert.match(user, /\[quote: 支持七种任务类型\]/)
  console.log('✓ pl5 buildUser:真实案例 + 上下文/workspace/缺口/llm_derived')
}

// 6. buildUser 语言匹配:英文输入 → 英文载荷;中文输入 → 中文载荷
{
  const en = buildPlanningUser({
    raw_input: 'Plan the migration of the optimizer to seven task types',
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(en, /Here is my planning request/)
  assert.match(en, /<prompt-draft>/)
  assert.ok(!en.includes('以下是我的规划诉求'))

  const zh = buildPlanningUser({
    raw_input: REAL_CASE,
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(zh, /以下是我的规划诉求/)
  assert.ok(!zh.includes('Here is my planning request'))
  console.log('✓ pl6 buildUser 语言匹配(zh 优先)')
}

// 7. 守卫 1:执行证据触发(已开始实施 / 已修改文件 / 已完成实现 / 已提交)
{
  const guard = guardById('planning-no-execution-evidence')
  assert.ok(guard, '守卫 1 必须存在')

  for (const line of [
    '- 已开始实施第一阶段',
    '- 已修改文件 src/core/strategies/execution.ts',
    '- 已完成实现登录模块',
    '- 已提交到 main 分支',
    '- 已部署到测试环境',
    '- 正在实施第二阶段',
  ]) {
    assert.ok(guard.check(line, emptyResult, REAL_CASE), `应触发执行证据守卫:${line}`)
  }

  // 禁令 / 尚未发生措辞 → 放行
  assert.equal(guard.check('- 禁止出现「已开始实施」类执行证据', emptyResult, REAL_CASE), null)
  assert.equal(guard.check('- 尚未开始实施任何阶段,以下均为待执行步骤', emptyResult, REAL_CASE), null)
  // 计划性措辞(将 / 待执行)与普通完成条件 → 放行
  assert.equal(guard.check('- 阶段 1 将修改 src/core/strategies/planning.ts', emptyResult, REAL_CASE), null)
  assert.equal(guard.check('- 每个阶段完成后进入下一阶段', emptyResult, REAL_CASE), null)
  console.log('✓ pl7 守卫 1:执行证据触发 / 禁令与计划措辞放行')
}

// 8. 守卫 2:每阶段必须有 Acceptance
{
  const guard = guardById('planning-phase-requires-acceptance')
  assert.ok(guard, '守卫 2 必须存在')

  const good = [
    '## Phases（阶段）',
    '### Phase 1 — 准备',
    '- 目标:梳理现状',
    '- Acceptance（验收）:现状清单列出且经用户确认',
    '### Phase 2 — 实现',
    '- 目标:实现七策略',
    '- Acceptance（验收）:单测全绿且版本号独立',
  ].join('\n')
  assert.equal(guard.check(good, emptyResult, REAL_CASE), null, '每阶段带验收 → 不得触发')

  const missing = good.replace('- Acceptance（验收）:单测全绿且版本号独立', '- 目标:补齐剩余策略')
  assert.ok(guard.check(missing, emptyResult, REAL_CASE), '阶段缺验收 → 必须触发')

  assert.ok(
    guard.check('## Goal\n- 做某事', emptyResult, REAL_CASE),
    '无阶段声明 → 必须触发',
  )
  console.log('✓ pl8 守卫 2:阶段缺 Acceptance 触发 / 齐全放行')
}

// 9. 守卫 3:必出段落齐全(sectionPresence 工厂)
{
  const guard = guardById('planning-required-sections')
  assert.ok(guard, '守卫 3 必须存在')
  assert.equal(guard.check(buildPlanningSystem('zh'), emptyResult, ''), null, '16 段必须齐全')
  assert.ok(
    guard.check(buildPlanningSystem('zh').split('Stop Conditions').join(''), emptyResult, ''),
    '缺段 → 必须触发',
  )
  console.log('✓ pl9 守卫 3:必出段落齐全')
}

// 10. 跨策略不变式 A·B 已挂到 planning.guards(P02-T01 工厂)
{
  assert.ok(guardById('shared-unknown-not-blocking'), 'invariant A 守卫必须存在')
  assert.ok(guardById('shared-suggested-not-in-explicit'), 'invariant B 守卫必须存在')
  assert.ok(guardById('shared-suggested-not-upgraded'), 'invariant B(升级)守卫必须存在')

  // A:非阻塞未知放行;阻塞句式触发
  const unknown = guardById('shared-unknown-not-blocking')
  assert.equal(unknown.check('- [待补充: 阶段验收人]', emptyResult, ''), null)
  assert.ok(unknown.check('- 请先回答阶段验收人是谁,否则无法继续', emptyResult, ''))

  // B:建议以强约束句式出现在要求语境 → 触发
  const upgraded = guardById('shared-suggested-not-upgraded')
  const suggested = [{ text: '建议(可忽略) 为每阶段补充验收指标', source: 'OPTIMIZER_SUGGESTED' }]
  assert.ok(
    upgraded.check('- 必须为每阶段补充验收指标', { suggested_requirements: suggested }, ''),
    '建议升级为强约束 → 必须触发',
  )
  assert.equal(upgraded.check('- 计划为每阶段补充验收指标', { suggested_requirements: suggested }, ''), null)
  console.log('✓ pl10 invariant A·B 已挂载并生效')
}

// 11. 合法 mock 编译产物:守卫全过 + 无重复 id + 规则齐备
{
  const good = GOOD_PLANNING_OUTPUT
  assert.deepEqual(guardIssues(good, REAL_CASE), [], '合法产物不应触发任何守卫')

  const ids = planning.guards.map((guard) => guard.id)
  assert.equal(new Set(ids).size, ids.length, '守卫 id 必须唯一')
  const suggestionIds = planning.suggestionRules.map((rule) => rule.id)
  assert.equal(new Set(suggestionIds).size, suggestionIds.length)
  const provenanceIds = planning.provenanceRules.map((rule) => rule.id)
  assert.equal(new Set(provenanceIds).size, provenanceIds.length)
  const preservationIds = planning.preservationRules.map((rule) => rule.id)
  assert.equal(new Set(preservationIds).size, preservationIds.length)
  assert.ok(planning.suggestionRules.length >= 3)
  assert.ok(planning.provenanceRules.length >= 3)
  console.log('✓ pl11 合法产物零守卫问题 + 规则 id 唯一')
}

// 12. 保真检查:专有名词保留 / 语言匹配
{
  const subject = ruleById(planning.preservationRules, 'planning-preserve-subject-terms')
  assert.ok(subject?.check)
  const kept =
    'Goal: 为 dsh-adaptive-prompt-optimizer 的 P02-T02 及后续七个策略扩展做一份分阶段、可独立验收的实施计划,逐阶段写清验收标准、失败处理与停止条件,不直接改正式配置。'
  assert.equal(subject.check(kept, REAL_CASE, []), true)
  assert.equal(subject.check('Goal: 做一个计划', REAL_CASE, []), false, '丢失专有名词必须判定不保真')

  const language = ruleById(planning.preservationRules, 'planning-preserve-language')
  assert.ok(language?.check)
  assert.equal(language.check(kept, REAL_CASE, []), true)
  assert.equal(language.check('English-only output', REAL_CASE, []), false)
  assert.equal(language.check('', REAL_CASE, []), false)
  console.log('✓ pl12 保真检查:专有名词 + 语言匹配')
}

// 13. mock 编译产物抽查:只规划不执行 + 每阶段带验收 + 失败/停止段齐备
{
  const mockCompiled = GOOD_PLANNING_OUTPUT

  // 硬约束:不得出现动作已发生的执行证据
  assert.doesNotMatch(mockCompiled, /已开始实施|已修改文件|已完成实现|已提交|已部署/)
  // 必须暴露缺口 + 每阶段带验收 + 失败/停止段齐备
  assert.match(mockCompiled, /待补充/)
  assert.ok(mockCompiled.includes('Acceptance Criteria'))
  assert.ok(mockCompiled.includes('Failure Handling'))
  assert.ok(mockCompiled.includes('Stop Conditions'))
  // 守卫对合法产物零误报
  assert.deepEqual(guardIssues(mockCompiled, REAL_CASE), [])
  // 编译用 system/user 文案齐备
  assert.ok(buildPlanningSystem('zh').length > 0)
  assert.ok(
    planning
      .buildUser({ raw_input: REAL_CASE, context_turns: [], workspace_metadata: {}, missing_constraints: [] })
      .includes(REAL_CASE),
  )
  console.log('✓ pl13 mock 编译产物:只规划不执行 + 每阶段验收 + 守卫零误报')
}

console.log('\nstrategies-planning: all passed')
