/**
 * execution 策略单元测试(P02-T03)。
 *
 * 运行:先 `npm run build`,再 `node test/strategies-execution.test.mjs`。
 * 覆盖:契约形状 / 15 段锚点 / 双语 buildSystem / buildUser 注入 / 守卫矩阵
 * (禁整项目重规划 · 不得以规划·分析段为主 · 必出段落 · Allowed·Forbidden Scope 与 Handoff
 * 强制段 · invariant A·B)/ 保真检查 / mock 编译产物抽查(聚焦当前任务 + 范围双段 + 交接齐备)。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import execution, {
  EXECUTION_MANDATORY_SECTIONS,
  EXECUTION_REQUIRED_SECTIONS,
  EXECUTION_STRATEGY_VERSION,
  FOCUS_CURRENT_TASK,
  HANDOFF_MANDATORY,
  SCOPE_BOUNDARY_REQUIRED,
  buildExecutionSystem,
  buildExecutionUser,
} from '../lib/core/strategies/execution.js'
import {
  INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH,
  INVARIANT_UNKNOWN_NOT_BLOCKING_ZH,
} from '../lib/core/strategies/_shared.js'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (rel) => readFileSync(join(here, rel), 'utf8')

const REAL_CASE =
  '按规划继续执行 P02-T03:实现 execution 策略并把单测跑通,只允许修改指定的策略文件与测试,不要动注册表、界面与 UI'

const EXPECTED_SECTIONS = [
  'Current Task',
  'Goal',
  'Preconditions',
  'Allowed Scope',
  'Forbidden Scope',
  'Inputs',
  'Executor',
  'Tools',
  'Exact Actions',
  'Tests',
  'Acceptance',
  'Failure Handling',
  'Git·State Rules',
  'Stop Conditions',
  'Handoff',
]

const emptyResult = { explicit_requirements: [], context_requirements: [] }
const guardIssues = (output, rawInput = '', result = emptyResult) =>
  execution.guards
    .map((guard) => guard.check(output, result, rawInput))
    .filter((issue) => issue !== null)
const guardById = (id) => execution.guards.find((guard) => guard.id === id)
const ruleById = (rules, id) => rules.find((rule) => rule.id === id)

/** 一份完整的合法编译产物:15 段齐全、范围双段与 Handoff 齐备、无整项目重规划。 */
const GOOD_EXECUTION_OUTPUT = [
  '## 明确要求',
  '- 按规划继续执行 P02-T03 [quote: 按规划继续执行 P02-T03]',
  '- 只允许改 execution.ts 与测试,不要动 registry 和 UI [quote: 不要动 registry 和 UI]',
  '## 上下文已确认',
  '- 用户希望按既定任务图推进 [quote: 按规划继续]',
  '## 优化器建议(可忽略)',
  '- 建议(可忽略) 提交前运行 typecheck 排除类型回归',
  '## 待补充',
  '- [待补充: 该 Task 是否需要在 P02 结束时做策略抽审]',
  '## 优化后的 Execution Prompt',
  '### Current Task（当前任务）',
  '- P02-T03 — Execution 策略 v0.1。',
  '### Goal（目标）',
  '- 产出 execution.ts 与单测并让门禁全绿。',
  '### Preconditions（前置条件）',
  '- P02-T01 共享规则段已完成。',
  '### Allowed Scope（允许范围）',
  '- src/core/strategies/execution.ts',
  '- test/strategies-execution.test.mjs',
  '### Forbidden Scope（禁止范围）',
  '- 其他策略 / registry / UI / Host 主路径',
  '- force push / reset --hard',
  '### Inputs（输入）',
  '- PLAN-v1 §7 execution 段落契约。',
  '### Executor（执行者）',
  '- 实现由 Claude Code 负责,验收由 DSH 负责。',
  '### Tools（工具）',
  '- node / tsc / node:test / git。',
  '### Exact Actions（具体动作）',
  '- 新增 src/core/strategies/execution.ts,导出 executionStrategy。',
  '- 新增 test/strategies-execution.test.mjs 并纳入 npm test。',
  '### Tests（测试）',
  '- node test/strategies-execution.test.mjs;npm test。',
  '### Acceptance（验收）',
  '- 单测全绿;15 段齐全;Forbidden Scope 与 Handoff 存在。',
  '### Failure Handling（失败处理）',
  '- 失败先回修,不绕过断言;3 次不过停止并上报。',
  '### Git·State Rules（Git 与状态规则）',
  '- 分支 phase/p02;commit 前缀 p02(t03):;一个内容提交 + 一个状态同步提交。',
  '### Stop Conditions（停止条件）',
  '- 需要触碰 Forbidden Scope 或命中 Human Gate 时立即停止等待裁决。',
  '### Handoff（交接）',
  '- 交给 P02-T04(diagnostic 策略);前置条件:本 Task 验收全绿。',
].join('\n')

// 1. 契约形状:type / 独立版本 / 15 段锚点 / sections 顺序一致
{
  assert.equal(execution.type, 'execution')
  assert.equal(execution.version, EXECUTION_STRATEGY_VERSION)
  assert.equal(execution.version, '0.1.0', '策略必须带独立版本号 0.1.0')
  assert.deepEqual(execution.required_sections, EXPECTED_SECTIONS)
  assert.equal(execution.required_sections.length, 15)
  assert.deepEqual(execution.outputContract.sections, EXPECTED_SECTIONS)
  assert.deepEqual(EXECUTION_REQUIRED_SECTIONS, EXPECTED_SECTIONS)
  assert.deepEqual(EXECUTION_MANDATORY_SECTIONS, [
    'Current Task',
    'Allowed Scope',
    'Forbidden Scope',
    'Handoff',
  ])
  assert.ok(execution.purpose.length > 0)
  assert.equal(typeof execution.buildSystem, 'function')
  assert.equal(typeof execution.buildUser, 'function')
  console.log('✓ ex1 契约形状:type/version 0.1.0/15 段锚点')
}

// 2. 零 ctx / UI / Host import(纯数据 + 纯函数,可独立升级)
{
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const source = stripComments(readSource('../src/core/strategies/execution.ts'))
  assert.doesNotMatch(source, /ctx\.llm/, '策略不得依赖 ctx.llm')
  assert.doesNotMatch(source, /from ['"]@deepseek-ai/, '策略不得 import Harness 包')
  assert.doesNotMatch(source, /from ['"]react/, '策略不得 import react')
  assert.doesNotMatch(source, /client\//, '策略不得 import UI 代码')
  assert.doesNotMatch(source, /from ['"]\.\.\/(?:compiler|classify|registry)/, '策略不得依赖编译/分类实现')
  console.log('✓ ex2 零 ctx/UI/Host 依赖')
}

// 3. buildSystem('zh'):15 段全出现 + 执行铁律 + 共享不变式
{
  const sys = buildExecutionSystem('zh')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `zh system 缺少段落锚点 ${section}`)
  }
  assert.ok(sys.includes(FOCUS_CURRENT_TASK), 'zh system 必须包含「聚焦当前任务,不重新规划整个项目」')
  assert.ok(sys.includes(SCOPE_BOUNDARY_REQUIRED), 'zh system 必须包含「Allowed/Forbidden Scope 双段必备」')
  assert.ok(sys.includes(HANDOFF_MANDATORY), 'zh system 必须包含「Handoff 交接段必备」')
  assert.match(sys, /重新规划整个项目/, 'zh system 必须点名整项目重规划范例')
  assert.match(sys, /待补充/)
  assert.match(sys, /建议\(可忽略\)/)
  assert.ok(sys.includes(INVARIANT_UNKNOWN_NOT_BLOCKING_ZH), 'zh system 必须含 invariant A')
  assert.ok(sys.includes(INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH), 'zh system 必须含 invariant B')
  console.log('✓ ex3 buildSystem(zh):15 段 + 执行铁律 + invariant A·B')
}

// 4. buildSystem('en'):同构英文版,15 段锚点仍全部出现
{
  const sys = buildExecutionSystem('en')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `en system 缺少段落锚点 ${section}`)
  }
  assert.match(sys, /Focus on the current task only/)
  assert.match(sys, /Allowed Scope and Forbidden Scope are both mandatory/)
  assert.match(sys, /Handoff is mandatory/)
  assert.match(sys, /re-plan the entire project/)
  assert.match(sys, /TODO/)
  console.log('✓ ex4 buildSystem(en):双语同构 + 15 段')
}

// 5. buildUser:真实案例注入 + 15 段 + 缺口纪律 + 上下文/workspace/llm_derived
{
  const vars = {
    raw_input: REAL_CASE,
    context_turns: [
      { role: 'user', text: '按任务图继续,不要重新规划整个项目' },
      { role: 'assistant', text: '可以先做 execution 策略' },
    ],
    workspace_metadata: { cwd: '/Users/me/Projects/apo', workspace_name: 'apo' },
    missing_constraints: [
      { id: 'mc-1', label: 'P02 抽审时间', reason: '决定策略何时送 G-2' },
    ],
    llm_derived: {
      user_goals: [
        {
          id: 'g1',
          text: '继续执行 P02-T03',
          source: 'USER_EXPLICIT',
          evidence: ['按规划继续执行 P02-T03'],
          confidence: 'high',
        },
      ],
      rejected_directions: [],
      known_constraints: [],
    },
  }
  const user = buildExecutionUser(vars)
  assert.ok(user.includes(REAL_CASE), 'user 载荷必须原样包含 raw_input')
  assert.match(user, /<prompt-draft>/)
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(user.includes(section), `user 载荷缺少段落锚点 ${section}`)
  }
  assert.match(user, /用户: 按任务图继续/)
  assert.match(user, /助手: 可以先做 execution 策略/)
  assert.match(user, /apo/)
  assert.match(user, /P02 抽审时间/)
  assert.match(user, /\[待补充:/)
  assert.match(user, /\[quote: 按规划继续执行 P02-T03\]/)
  console.log('✓ ex5 buildUser:真实案例 + 上下文/workspace/缺口/llm_derived')
}

// 6. buildUser 语言匹配:英文输入 → 英文载荷;中文输入 → 中文载荷
{
  const en = buildExecutionUser({
    raw_input: 'Continue executing P02-T03: implement the execution strategy with unit tests',
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(en, /Here is my execution request/)
  assert.match(en, /<prompt-draft>/)
  assert.ok(!en.includes('以下是我的执行诉求'))

  const zh = buildExecutionUser({
    raw_input: REAL_CASE,
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(zh, /以下是我的执行诉求/)
  assert.ok(!zh.includes('Here is my execution request'))
  console.log('✓ ex6 buildUser 语言匹配(zh 优先)')
}

// 7. 守卫 1:整项目重规划语言触发(重新规划整个项目 / 全项目路线图 / 分阶段总规划)
{
  const guard = guardById('execution-no-project-replanning')
  assert.ok(guard, '守卫 1 必须存在')

  for (const line of [
    '- 先重新规划整个项目,再决定本任务怎么做',
    '- 产出全项目路线图与分阶段总规划',
    '- 分阶段规划整个项目后再动手',
    '- Overall plan: re-planning the entire project first',
  ]) {
    assert.ok(guard.check(line, emptyResult, REAL_CASE), `应触发整项目重规划守卫:${line}`)
  }

  // 禁令 / 约束措辞 → 放行
  assert.equal(guard.check('- 不得重新规划整个项目,只执行当前任务', emptyResult, REAL_CASE), null)
  assert.equal(guard.check('- 禁止产出全项目路线图', emptyResult, REAL_CASE), null)
  // 待补充占位 → 放行
  assert.equal(guard.check('- [待补充: 是否需要全项目规划]', emptyResult, REAL_CASE), null)
  // 交接指针(提到后续 Task)与普通执行语言 → 放行
  assert.equal(guard.check('- NEXT_TASK: P02-T04 — 按任务图继续执行', emptyResult, REAL_CASE), null)
  assert.equal(guard.check('- Handoff: 完成后交给 P02-T04', emptyResult, REAL_CASE), null)
  console.log('✓ ex7 守卫 1:整项目重规划触发 / 禁令与交接放行')
}

// 8. 守卫 2:输出不得以规划/分析段落为主
{
  const guard = guardById('execution-not-planning-dominated')
  assert.ok(guard, '守卫 2 必须存在')

  const planningDominated = [
    '### Phases（阶段）',
    '- Phase 1 准备',
    '### Tasks（任务）',
    '- 任务 A',
    '### Dependencies（依赖）',
    '- 依赖 B',
    '### Current Task（当前任务）',
    '- P02-T03',
  ].join('\n')
  assert.ok(guard.check(planningDominated, emptyResult, REAL_CASE), '规划段为主 → 必须触发')

  const analysisDominated = [
    '### 分析',
    '- 先做一轮现状分析',
    '### Current Task（当前任务）',
    '- P02-T03',
  ].join('\n')
  assert.ok(guard.check(analysisDominated, emptyResult, REAL_CASE), '分析段与执行段持平 → 必须触发')

  const noExecution = ['### Goal（目标）', '- 做某事', '### Phases（阶段）', '- Phase 1'].join('\n')
  assert.ok(guard.check(noExecution, emptyResult, REAL_CASE), '没有任何执行段 → 必须触发')

  const executionHeavy = [
    '### Current Task（当前任务）',
    '- P02-T03',
    '### Exact Actions（具体动作）',
    '- 实现策略',
    '### Handoff（交接）',
    '- 交给 P02-T04',
    '### 分析',
    '- 仅一句风险提示',
  ].join('\n')
  assert.equal(guard.check(executionHeavy, emptyResult, REAL_CASE), null, '执行段为主 → 放行')
  console.log('✓ ex8 守卫 2:规划/分析为主触发 / 执行段为主放行')
}

// 9. 守卫 3:必出段落齐全(sectionPresence 工厂)
{
  const guard = guardById('execution-required-sections')
  assert.ok(guard, '守卫 3 必须存在')
  assert.equal(guard.check(buildExecutionSystem('zh'), emptyResult, ''), null, '15 段必须齐全')
  assert.ok(
    guard.check(buildExecutionSystem('zh').split('Stop Conditions').join(''), emptyResult, ''),
    '缺段 → 必须触发',
  )
  console.log('✓ ex9 守卫 3:必出段落齐全')
}

// 10. 守卫 4:Allowed / Forbidden Scope 与 Handoff 强制段
{
  const guard = guardById('execution-mandatory-scope-and-handoff')
  assert.ok(guard, '守卫 4 必须存在')
  assert.equal(guard.check(buildExecutionSystem('zh'), emptyResult, ''), null, '强制段齐全 → 放行')

  const missingForbidden = [
    '## Current Task',
    '- P02-T03',
    '## Allowed Scope',
    '- src/core/strategies/execution.ts',
    '## Handoff',
    '- P02-T04',
  ].join('\n')
  assert.ok(guard.check(missingForbidden, emptyResult, ''), '缺 Forbidden Scope → 必须触发')

  const missingHandoff = [
    '## Current Task',
    '- P02-T03',
    '## Allowed Scope',
    '- execution.ts',
    '## Forbidden Scope',
    '- registry / UI',
  ].join('\n')
  assert.ok(guard.check(missingHandoff, emptyResult, ''), '缺 Handoff → 必须触发')
  console.log('✓ ex10 守卫 4:Allowed/Forbidden Scope 与 Handoff 强制段')
}

// 11. 跨策略不变式 A·B 已挂到 execution.guards(P02-T01 工厂)
{
  assert.ok(guardById('shared-unknown-not-blocking'), 'invariant A 守卫必须存在')
  assert.ok(guardById('shared-suggested-not-in-explicit'), 'invariant B 守卫必须存在')
  assert.ok(guardById('shared-suggested-not-upgraded'), 'invariant B(升级)守卫必须存在')

  // A:非阻塞未知放行;阻塞句式触发
  const unknown = guardById('shared-unknown-not-blocking')
  assert.equal(unknown.check('- [待补充: P02 抽审时间]', emptyResult, ''), null)
  assert.ok(unknown.check('- 请先回答 P02 抽审时间,否则无法继续', emptyResult, ''))

  // B:建议以强约束句式出现在要求语境 → 触发
  const upgraded = guardById('shared-suggested-not-upgraded')
  const suggested = [{ text: '建议(可忽略) 提交前运行 typecheck', source: 'OPTIMIZER_SUGGESTED' }]
  assert.ok(
    upgraded.check('- 必须提交前运行 typecheck', { suggested_requirements: suggested }, ''),
    '建议升级为强约束 → 必须触发',
  )
  assert.equal(
    upgraded.check('- 计划提交前运行 typecheck', { suggested_requirements: suggested }, ''),
    null,
  )
  console.log('✓ ex11 invariant A·B 已挂载并生效')
}

// 12. 合法 mock 编译产物:守卫全过 + 无重复 id + 规则齐备
{
  const good = GOOD_EXECUTION_OUTPUT
  assert.deepEqual(guardIssues(good, REAL_CASE), [], '合法产物不应触发任何守卫')

  const ids = execution.guards.map((guard) => guard.id)
  assert.equal(new Set(ids).size, ids.length, '守卫 id 必须唯一')
  const suggestionIds = execution.suggestionRules.map((rule) => rule.id)
  assert.equal(new Set(suggestionIds).size, suggestionIds.length)
  const provenanceIds = execution.provenanceRules.map((rule) => rule.id)
  assert.equal(new Set(provenanceIds).size, provenanceIds.length)
  const preservationIds = execution.preservationRules.map((rule) => rule.id)
  assert.equal(new Set(preservationIds).size, preservationIds.length)
  assert.ok(execution.suggestionRules.length >= 3)
  assert.ok(execution.provenanceRules.length >= 3)
  console.log('✓ ex12 合法产物零守卫问题 + 规则 id 唯一')
}

// 13. 保真检查:Task 编号与专有名词保留 / 语言匹配
{
  const subject = ruleById(execution.preservationRules, 'execution-preserve-subject-terms')
  assert.ok(subject?.check)
  const kept =
    '当前任务:P02-T03 Execution 策略 v0.1;允许范围仅限指定策略文件与测试,禁止范围包含注册表、界面与 UI。'
  assert.equal(subject.check(kept, REAL_CASE, []), true)
  assert.equal(subject.check('Current Task: 实现一个策略', REAL_CASE, []), false, '丢失 Task 编号与 UI 必须判定不保真')

  const language = ruleById(execution.preservationRules, 'execution-preserve-language')
  assert.ok(language?.check)
  assert.equal(language.check(kept, REAL_CASE, []), true)
  assert.equal(language.check('English-only output', REAL_CASE, []), false)
  assert.equal(language.check('', REAL_CASE, []), false)

  const scope = ruleById(execution.preservationRules, 'execution-preserve-scope-boundaries')
  assert.ok(scope, '范围边界保真规则必须存在')
  console.log('✓ ex13 保真检查:Task 编号/专有名词 + 语言匹配 + 范围边界')
}

// 14. mock 编译产物抽查:聚焦当前任务 + 范围双段 + Handoff 齐备 + 无重规划
{
  const mockCompiled = GOOD_EXECUTION_OUTPUT

  // 硬约束:不得出现整项目重规划语言
  assert.doesNotMatch(mockCompiled, /重新规划整个项目|全项目路线图|整体规划项目/)
  // 聚焦当前任务 + 范围双段 + 交接段齐备
  assert.ok(mockCompiled.includes('Current Task'))
  assert.ok(mockCompiled.includes('Allowed Scope'))
  assert.ok(mockCompiled.includes('Forbidden Scope'))
  assert.ok(mockCompiled.includes('Handoff'))
  assert.match(mockCompiled, /P02-T03/)
  // 守卫对合法产物零误报
  assert.deepEqual(guardIssues(mockCompiled, REAL_CASE), [])
  // 编译用 system/user 文案齐备
  assert.ok(buildExecutionSystem('zh').length > 0)
  assert.ok(
    execution
      .buildUser({ raw_input: REAL_CASE, context_turns: [], workspace_metadata: {}, missing_constraints: [] })
      .includes(REAL_CASE),
  )
  console.log('✓ ex14 mock 编译产物:聚焦当前任务 + 范围双段 + Handoff + 守卫零误报')
}

console.log('\nstrategies-execution: all passed')
