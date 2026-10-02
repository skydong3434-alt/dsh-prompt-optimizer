/**
 * general 策略单元测试(P02-T07)。
 *
 * 运行:先 `npm run build`,再 `node test/strategies-general.test.mjs`。
 * 覆盖:契约形状 / 八板块锚点 / 双语 buildSystem / template·intent 双模式 /
 * buildUser 注入 / 强制板块 Task Goal·Success Criteria / 无证据硬约束守卫 /
 * 无证据强断言 / invariant A·B / 保真检查 / mock 编译产物抽查。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import general, {
  GENERAL_FIDELITY_RULE,
  GENERAL_MANDATORY_SECTIONS,
  GENERAL_NO_INVENTED_CONSTRAINTS,
  GENERAL_REQUIRED_SECTIONS,
  GENERAL_STRATEGY_VERSION,
  buildGeneralSystem,
  buildGeneralUser,
  resolveGeneralMode,
} from '../lib/core/strategies/general.js'
import {
  INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH,
  INVARIANT_UNKNOWN_NOT_BLOCKING_ZH,
} from '../lib/core/strategies/_shared.js'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (rel) => readFileSync(join(here, rel), 'utf8')

const REAL_CASE =
  '帮我把下面这段需求整理成给下游 agent 的提示词:用 Node 写个 CLI,统计错误并输出 Markdown 报告,不要引入新依赖'

const EXPECTED_SECTIONS = [
  'Role',
  'Task Goal',
  'Input Materials',
  'Output Format',
  'Content Requirements',
  'Style',
  'Constraints',
  'Success Criteria',
]

const emptyResult = { explicit_requirements: [], context_requirements: [] }
const guardIssues = (output, rawInput = '', result = emptyResult) =>
  general.guards
    .map((guard) => guard.check(output, result, rawInput))
    .filter((issue) => issue !== null)
const guardById = (id) => general.guards.find((guard) => guard.id === id)
const ruleById = (rules, id) => rules.find((rule) => rule.id === id)

/** 一份完整的合法编译产物:八板块齐全、无凭空硬约束、建议独立成段。 */
const GOOD_GENERAL_OUTPUT = [
  '## 明确要求',
  '- 把草稿整理成给下游 Agent 的提示词并保留原意 [quote: 帮我把下面这段需求整理成给下游 agent 的提示词]',
  '- 不要引入新依赖 [quote: 不要引入新依赖]',
  '## 上下文已确认',
  '- (无)',
  '## 优化器建议(可忽略)',
  '- 建议(可忽略) 先补齐输出篇幅与目标受众',
  '## 待补充',
  '- [待补充: 期望的输出篇幅与受众]',
  '## 优化后的 Prompt',
  '### Role（角色）',
  '- [待补充: 角色定位]',
  '### Task Goal（任务目标）',
  '- 把用户需求整理成给下游 Agent 的提示词。',
  '### Input Materials（输入材料）',
  '- 用户草稿与 workspace 事实。',
  '### Output Format（输出格式）',
  '- Markdown 报告。',
  '### Content Requirements（内容要求）',
  '- 用 Node 编写 CLI,统计错误数量并给出 Markdown 报告。',
  '### Style（风格）',
  '- [待补充: 表达风格]',
  '### Constraints（约束）',
  '- 不引入新依赖,不得替换草稿中的术语。',
  '### Success Criteria（成功标准）',
  '- 草稿中的每个原子信息在优化稿中都有对应;不引入新依赖;输出为 Markdown。',
].join('\n')

// 1. 契约形状:type / 独立版本 / 8 板块锚点 / 强制板块
{
  assert.equal(general.type, 'general')
  assert.equal(general.version, GENERAL_STRATEGY_VERSION)
  assert.equal(general.version, '0.1.0', '策略必须带独立版本号 0.1.0')
  assert.deepEqual(general.required_sections, EXPECTED_SECTIONS)
  assert.equal(general.required_sections.length, 8)
  assert.deepEqual(general.outputContract.sections, EXPECTED_SECTIONS)
  assert.deepEqual(GENERAL_REQUIRED_SECTIONS, EXPECTED_SECTIONS)
  assert.deepEqual(GENERAL_MANDATORY_SECTIONS, ['Task Goal', 'Success Criteria'])
  assert.ok(GENERAL_MANDATORY_SECTIONS.includes('Task Goal'), 'Task Goal 必须是强制板块')
  assert.ok(GENERAL_MANDATORY_SECTIONS.includes('Success Criteria'), 'Success Criteria 必须是强制板块')
  assert.ok(general.purpose.length > 0)
  assert.equal(typeof general.buildSystem, 'function')
  assert.equal(typeof general.buildUser, 'function')
  console.log('✓ gn1 契约形状:type/version 0.1.0/8 板块锚点/强制板块')
}

// 2. 零 ctx / UI / Host import(纯数据 + 纯函数,可独立升级)
{
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const source = stripComments(readSource('../src/core/strategies/general.ts'))
  assert.doesNotMatch(source, /ctx\.llm/, '策略不得依赖 ctx.llm')
  assert.doesNotMatch(source, /from ['"]@deepseek-ai/, '策略不得 import Harness 包')
  assert.doesNotMatch(source, /from ['"]react/, '策略不得 import react')
  assert.doesNotMatch(source, /client\//, '策略不得 import UI 代码')
  assert.doesNotMatch(
    source,
    /from ['"]\.\.\/(?:compiler|classify|registry)/,
    '策略不得依赖编译/分类实现',
  )
  console.log('✓ gn2 零 ctx/UI/Host 依赖')
}

// 3. buildSystem('zh'):8 板块全出现 + 双模式纪律 + 通用铁律 + invariant A·B
{
  const sys = buildGeneralSystem('zh')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `zh system 缺少板块锚点 ${section}`)
  }
  assert.ok(sys.includes(GENERAL_FIDELITY_RULE), 'zh system 必须包含「保真改写」')
  assert.ok(sys.includes(GENERAL_NO_INVENTED_CONSTRAINTS), 'zh system 必须包含「无证据不新增硬约束」')
  assert.match(sys, /结构模板模式/, 'zh system 必须含 template 模式')
  assert.match(sys, /提炼目的模式/, 'zh system 必须含 intent 模式')
  assert.match(sys, /待补充/)
  assert.match(sys, /建议\(可忽略\)/)
  assert.ok(sys.includes(INVARIANT_UNKNOWN_NOT_BLOCKING_ZH), 'zh system 必须含 invariant A')
  assert.ok(sys.includes(INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH), 'zh system 必须含 invariant B')
  console.log('✓ gn3 buildSystem(zh):8 板块 + 双模式 + 铁律 + invariant A·B')
}

// 4. buildSystem('en'):同构英文版,8 板块锚点仍全部出现
{
  const sys = buildGeneralSystem('en')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `en system 缺少板块锚点 ${section}`)
  }
  assert.match(sys, /structured template mode/)
  assert.match(sys, /distill intent mode/)
  assert.match(sys, /TODO/)
  assert.match(sys, /UNKNOWN ≠ BLOCKING/)
  console.log('✓ gn4 buildSystem(en):双语同构 + 8 板块')
}

// 5. buildSystem 模式选择:template / intent / auto(默认同时给出两套纪律)
{
  const template = buildGeneralSystem('zh', 'template')
  assert.match(template, /结构模板模式/)
  assert.doesNotMatch(template, /提炼目的模式/)

  const intent = buildGeneralSystem('zh', 'intent')
  assert.match(intent, /提炼目的模式/)
  assert.doesNotMatch(intent, /结构模板模式/)

  const auto = buildGeneralSystem('zh', 'auto')
  assert.match(auto, /结构模板模式/)
  assert.match(auto, /提炼目的模式/)
  console.log('✓ gn5 buildSystem 模式选择:template/intent/auto')
}

// 6. resolveGeneralMode:无上下文 → template;有非空 turn → intent
{
  assert.equal(resolveGeneralMode([]), 'template')
  assert.equal(resolveGeneralMode(undefined), 'template')
  assert.equal(
    resolveGeneralMode([{ role: 'assistant', text: '   ' }]),
    'template',
    '空白 turn 不算上下文',
  )
  assert.equal(
    resolveGeneralMode([{ role: 'user', text: '上次说的是 Mac 方案' }]),
    'intent',
  )
  console.log('✓ gn6 resolveGeneralMode:template / intent 机械判定')
}

// 7. buildUser:真实案例注入 + 8 板块 + 上下文/workspace/缺口/llm_derived + intent 模式
{
  const vars = {
    raw_input: REAL_CASE,
    context_turns: [
      { role: 'user', text: '下游 agent 需要能直接照着做' },
      { role: 'assistant', text: '可以先补一个输出格式' },
    ],
    workspace_metadata: { cwd: '/Users/me/Projects/apo', workspace_name: 'apo' },
    missing_constraints: [
      { id: 'mc-1', label: '目标受众与篇幅', reason: '决定输出详略' },
    ],
    llm_derived: {
      user_goals: [
        {
          id: 'g1',
          text: '整理成下游可执行的提示词',
          source: 'USER_EXPLICIT',
          evidence: ['整理成给下游 agent 的提示词'],
          confidence: 'high',
        },
      ],
      rejected_directions: [],
      known_constraints: [],
    },
  }
  const user = buildGeneralUser(vars)
  assert.ok(user.includes(REAL_CASE), 'user 载荷必须原样包含 raw_input')
  assert.match(user, /<prompt-draft>/)
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(user.includes(section), `user 载荷缺少板块锚点 ${section}`)
  }
  assert.match(user, /用户: 下游 agent 需要能直接照着做/)
  assert.match(user, /助手: 可以先补一个输出格式/)
  assert.match(user, /apo/)
  assert.match(user, /目标受众与篇幅/)
  assert.match(user, /\[待补充:/)
  assert.match(user, /\[quote: 整理成给下游 agent 的提示词\]/)
  assert.match(user, /intent 模式/, '有上下文 → user 载荷必须点明 intent 模式')
  console.log('✓ gn7 buildUser:真实案例 + 上下文/workspace/缺口/llm_derived + intent')
}

// 8. buildUser 语言匹配与 template 模式:英文输入 → 英文载荷;无上下文 → template
{
  const en = buildGeneralUser({
    raw_input: 'Rewrite this draft into a prompt a downstream agent can follow, do not add new dependencies',
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(en, /Here is my prompt draft/)
  assert.match(en, /<prompt-draft>/)
  assert.match(en, /template mode/)
  assert.ok(!en.includes('以下是我的提示词草稿'))

  const zh = buildGeneralUser({
    raw_input: REAL_CASE,
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(zh, /以下是我的提示词草稿/)
  assert.match(zh, /template 模式/)
  assert.ok(!zh.includes('Here is my prompt draft'))
  console.log('✓ gn8 buildUser 语言匹配 + template 模式')
}

// 9. 守卫 1:8 板块必出(sectionPresence 工厂)
{
  const guard = guardById('general-required-sections')
  assert.ok(guard, '必出板块守卫必须存在')
  assert.equal(guard.check(GOOD_GENERAL_OUTPUT, emptyResult, ''), null, '8 板块必须齐全')
  assert.ok(
    guard.check(GOOD_GENERAL_OUTPUT.split('Style').join('风格'), emptyResult, ''),
    '缺 Style → 必须触发',
  )
  console.log('✓ gn9 守卫 1:8 板块必出')
}

// 10. 守卫 2(error 级):Task Goal / Success Criteria 强制板块
{
  const guard = guardById('general-mandatory-goal-and-success')
  assert.ok(guard, '强制板块守卫必须存在')
  assert.match(guard.description, /error/, '强制板块守卫必须是 error 级')
  assert.equal(guard.check(GOOD_GENERAL_OUTPUT, emptyResult, ''), null, '齐备 → 放行')
  assert.ok(
    guard.check(GOOD_GENERAL_OUTPUT.split('Task Goal').join('目标'), emptyResult, ''),
    '缺 Task Goal → 必须触发',
  )
  assert.ok(
    guard.check(GOOD_GENERAL_OUTPUT.split('Success Criteria').join('SC'), emptyResult, ''),
    '缺 Success Criteria → 必须触发',
  )
  console.log('✓ gn10 守卫 2:强制板块 Task Goal / Success Criteria')
}

// 11. 守卫 3:无证据硬约束(铁律 2:无证据不新增硬约束)
{
  const guard = guardById('general-no-invented-hard-constraint')
  assert.ok(guard, '无证据硬约束守卫必须存在')
  assert.ok(
    guard.check('### Constraints\n- 预算 5 万元,两周内完成', emptyResult, ''),
    '无证据「预算/工期」→ 必须触发',
  )
  assert.ok(
    guard.check('### Constraints\n- 必须使用 Docker 部署', emptyResult, ''),
    '无证据「必须使用」→ 必须触发',
  )
  assert.equal(
    guard.check('### Constraints\n- [待补充: 预算上限]', emptyResult, ''),
    null,
    '缺口占位符 → 放行',
  )
  assert.equal(
    guard.check(
      '### Constraints\n- 必须使用 Docker 部署 [quote: 必须使用 Docker 部署]',
      emptyResult,
      '必须使用 Docker 部署',
    ),
    null,
    '有逐字证据 → 放行',
  )
  assert.equal(
    guard.check(GOOD_GENERAL_OUTPUT, emptyResult, REAL_CASE),
    null,
    '合法产物 → 放行',
  )
  console.log('✓ gn11 守卫 3:无证据硬约束触发 / 缺口·证据放行')
}

// 12. 守卫 4:无证据强断言(已确认 / 最终 / 已采用 必须有逐字证据)
{
  const guard = guardById('general-no-unproven-strong-claim')
  assert.ok(guard, '无证据强断言守卫必须存在')
  assert.ok(
    guard.check('### Task Goal\n- 该方案已确认采用为最终方案', emptyResult, ''),
    '无证据「已确认采用」→ 必须触发',
  )
  assert.equal(
    guard.check('### Task Goal\n- 该方案 [待补充: 是否确认]', emptyResult, ''),
    null,
    '带缺口标记 → 放行',
  )
  assert.equal(
    guard.check('### Task Goal\n- 该方案已确认采用 [quote: 就按这个方案]', emptyResult, '就按这个方案'),
    null,
    '有逐字证据 → 放行',
  )
  console.log('✓ gn12 守卫 4:无证据强断言')
}

// 13. 跨策略不变式 A·B 已挂到 general.guards(P02-T01 工厂)
{
  const invariantA = guardById('shared-unknown-not-blocking')
  assert.ok(invariantA, 'invariant A 守卫必须存在')
  assert.equal(invariantA.check('- [待补充: 目标受众]', emptyResult, ''), null)
  assert.ok(invariantA.check('- 请先回答目标受众,否则无法继续', emptyResult, ''))

  assert.ok(guardById('shared-suggested-not-in-explicit'), 'invariant B 守卫必须存在')
  const invariantB = guardById('shared-suggested-not-upgraded')
  assert.ok(invariantB, 'invariant B(升级)守卫必须存在')
  const suggested = [{ text: '建议(可忽略) 先补输出格式', source: 'OPTIMIZER_SUGGESTED' }]
  assert.ok(
    invariantB.check('- 必须先补输出格式', { suggested_requirements: suggested }, ''),
    '建议升级为强约束 → 必须触发',
  )
  assert.equal(
    invariantB.check('- 计划先补输出格式', { suggested_requirements: suggested }, ''),
    null,
  )
  console.log('✓ gn13 invariant A·B 已挂载并生效')
}

// 14. 合法 mock 编译产物:守卫全过 + 无重复 id + 规则齐备
{
  assert.deepEqual(guardIssues(GOOD_GENERAL_OUTPUT, REAL_CASE), [], '合法产物不应触发任何守卫')

  const ids = general.guards.map((guard) => guard.id)
  assert.equal(new Set(ids).size, ids.length, '守卫 id 必须唯一')
  const suggestionIds = general.suggestionRules.map((rule) => rule.id)
  assert.equal(new Set(suggestionIds).size, suggestionIds.length)
  const provenanceIds = general.provenanceRules.map((rule) => rule.id)
  assert.equal(new Set(provenanceIds).size, provenanceIds.length)
  const preservationIds = general.preservationRules.map((rule) => rule.id)
  assert.equal(new Set(preservationIds).size, preservationIds.length)
  assert.ok(general.suggestionRules.length >= 3)
  assert.ok(general.provenanceRules.length >= 3)
  assert.ok(general.preservationRules.length >= 3)
  console.log('✓ gn14 合法产物零守卫问题 + 规则 id 唯一')
}

// 15. 保真检查:专有名词保留 / 语言匹配
{
  const subject = ruleById(general.preservationRules, 'general-preserve-subject-terms')
  assert.ok(subject?.check)
  assert.equal(subject.check(GOOD_GENERAL_OUTPUT, REAL_CASE, []), true)
  assert.equal(
    subject.check('整理成一份提示词,统计错误数量', REAL_CASE, []),
    false,
    '丢失 Node / CLI / Markdown 必须判定不保真',
  )

  const language = ruleById(general.preservationRules, 'general-preserve-language')
  assert.ok(language?.check)
  assert.equal(language.check(GOOD_GENERAL_OUTPUT, REAL_CASE, []), true)
  assert.equal(language.check('English-only output', REAL_CASE, []), false)
  assert.equal(language.check('', REAL_CASE, []), false)

  assert.ok(ruleById(general.preservationRules, 'general-preserve-original-intent'))
  assert.ok(ruleById(general.preservationRules, 'general-preserve-constraint-set'))
  console.log('✓ gn15 保真检查:专有名词 + 语言匹配')
}

// 16. mock 产物抽查:八板块顺序 + 无凭空硬约束 + 建议独立段
{
  const mockCompiled = GOOD_GENERAL_OUTPUT

  let prev = -1
  for (const section of EXPECTED_SECTIONS) {
    const index = mockCompiled.indexOf(`### ${section}`)
    assert.ok(index > 0, `mock 产物缺板块 ### ${section}`)
    assert.ok(index > prev, `板块顺序错误:${section} 必须晚于上一板块`)
    prev = index
  }

  // 建议独立成段,不得混入「明确要求」段
  const explicitBlock = mockCompiled.slice(
    mockCompiled.indexOf('## 明确要求'),
    mockCompiled.indexOf('## 上下文已确认'),
  )
  assert.doesNotMatch(explicitBlock, /建议\(可忽略\)/, '建议不得混入明确要求段')

  // 合法产物不得含无证据硬约束(预算 / 万元 / 必须使用 等)
  const constraintsBlock = mockCompiled.slice(
    mockCompiled.indexOf('### Constraints'),
    mockCompiled.indexOf('### Success Criteria'),
  )
  assert.doesNotMatch(constraintsBlock, /预算|万元|必须使用|仅支持/)

  // 守卫对合法产物零误报
  assert.deepEqual(guardIssues(mockCompiled, REAL_CASE), [])

  // 编译用 system/user 文案齐备
  assert.ok(buildGeneralSystem('zh').length > 0)
  assert.ok(
    general
      .buildUser({
        raw_input: REAL_CASE,
        context_turns: [],
        workspace_metadata: {},
        missing_constraints: [],
      })
      .includes(REAL_CASE),
  )
  console.log('✓ gn16 mock 产物:八板块顺序 + 建议独立段 + 守卫零误报')
}

console.log('\nstrategies-general: all passed')
