/**
 * review 策略单元测试(P02-T05)。
 *
 * 运行:先 `npm run build`,再 `node test/strategies-review.test.mjs`。
 * 覆盖:契约形状 / 9 段锚点 / 双语 buildSystem / buildUser 注入 / 守卫矩阵
 * (发散必须先对照原目标 · Original Goal / Requirements 强制段 · 必出段落 ·
 * 无证据验收结论 · invariant A·B)/ 保真检查 / mock 编译产物抽查
 * (原目标锚定 + 偏离对应需求 + 修正不越权)。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import review, {
  REVIEW_BASED_ON_ORIGINAL_GOAL,
  REVIEW_CORRECTIONS_SCOPED,
  REVIEW_DEVIATION_NEEDS_REQUIREMENT,
  REVIEW_EVIDENCE_BEFORE_VERDICT,
  REVIEW_MANDATORY_SECTIONS,
  REVIEW_NO_DIVERGENCE,
  REVIEW_REQUIRED_SECTIONS,
  REVIEW_STRATEGY_VERSION,
  buildReviewSystem,
  buildReviewUser,
} from '../lib/core/strategies/review.js'
import {
  INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH,
  INVARIANT_UNKNOWN_NOT_BLOCKING_ZH,
} from '../lib/core/strategies/_shared.js'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (rel) => readFileSync(join(here, rel), 'utf8')

const REAL_CASE =
  '看看这个项目现在还有什么问题?对照最初的目标和需求审查,不要发散成新项目'

const EXPECTED_SECTIONS = [
  'Review Target',
  'Original Goal',
  'Requirements',
  'Evaluation Criteria',
  'Evidence',
  'Deviations',
  'Missing Items',
  'Risks',
  'Suggested Corrections',
]

const emptyResult = { explicit_requirements: [], context_requirements: [] }
const guardIssues = (output, rawInput = '', result = emptyResult) =>
  review.guards
    .map((guard) => guard.check(output, result, rawInput))
    .filter((issue) => issue !== null)
const guardById = (id) => review.guards.find((guard) => guard.id === id)
const ruleById = (rules, id) => rules.find((rule) => rule.id === id)

/** 一份完整的合法编译产物:9 段齐全、原目标锚定、偏离对应需求、修正不越权。 */
const GOOD_REVIEW_OUTPUT = [
  '## 明确要求',
  '- 对照最初的目标和需求审查项目现状 [quote: 对照最初的目标和需求审查]',
  '- 不要发散成新项目 [quote: 不要发散成新项目]',
  '## 上下文已确认',
  '- 最初目标是交付一个可用的优化器插件 [quote: 最初目标是交付一个可用的优化器插件]',
  '## 优化器建议(可忽略)',
  '- 建议(可忽略) 先列出评估标准再逐条核对证据',
  '## 待补充',
  '- [待补充: 原目标的量化验收口径]',
  '## 优化后的 Review Prompt',
  '### Review Target（审查对象）',
  '- 当前仓库 dsh-adaptive-prompt-optimizer 的 P02 进度。',
  '### Original Goal（原目标）',
  '- 原目标:交付一个可独立运行的 DSH 提示词优化插件。',
  '### Requirements（需求）',
  '- R1:七策略各自独立实现且单测通过。',
  '- R2:registry 能按类型返回策略并暴露版本。',
  '### Evaluation Criteria（评估标准）',
  '- 逐条对照 R1..R2,给出 达标 / 部分达标 / 未达标 的判定方法与依据。',
  '### Evidence（证据）',
  '- 证据:各任务提交记录与 `npm test` 的真实输出。',
  '### Deviations（偏离）',
  '- 偏离 R2:registry 尚未接入 review,证据见源码现状。',
  '### Missing Items（缺失项）',
  '- 缺失:creative / general 策略尚未开工(仅跟踪,不阻塞本轮审查)。',
  '### Risks（风险）',
  '- 风险:策略文案与用户示例可能不一致,影响验收。',
  '### Suggested Corrections（修正建议）',
  '- 对照原目标,建议按 P02-T06 → T08 顺序补齐,不扩大范围;完成后用 `npm test` 复测。',
].join('\n')

// 1. 契约形状:type / 独立版本 / 9 段锚点 / sections 顺序一致
{
  assert.equal(review.type, 'review')
  assert.equal(review.version, REVIEW_STRATEGY_VERSION)
  assert.equal(review.version, '0.1.0', '策略必须带独立版本号 0.1.0')
  assert.deepEqual(review.required_sections, EXPECTED_SECTIONS)
  assert.equal(review.required_sections.length, 9)
  assert.deepEqual(review.outputContract.sections, EXPECTED_SECTIONS)
  assert.deepEqual(REVIEW_REQUIRED_SECTIONS, EXPECTED_SECTIONS)
  assert.deepEqual(REVIEW_MANDATORY_SECTIONS, ['Original Goal', 'Requirements'])
  assert.ok(REVIEW_MANDATORY_SECTIONS.includes('Original Goal'), 'Original Goal 必须是强制段')
  assert.ok(REVIEW_MANDATORY_SECTIONS.includes('Requirements'), 'Requirements 必须是强制段')
  assert.ok(review.purpose.length > 0)
  assert.equal(typeof review.buildSystem, 'function')
  assert.equal(typeof review.buildUser, 'function')
  console.log('✓ rv1 契约形状:type/version 0.1.0/9 段锚点/强制段')
}

// 2. 零 ctx / UI / Host import(纯数据 + 纯函数,可独立升级)
{
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const source = stripComments(readSource('../src/core/strategies/review.ts'))
  assert.doesNotMatch(source, /ctx\.llm/, '策略不得依赖 ctx.llm')
  assert.doesNotMatch(source, /from ['"]@deepseek-ai/, '策略不得 import Harness 包')
  assert.doesNotMatch(source, /from ['"]react/, '策略不得 import react')
  assert.doesNotMatch(source, /client\//, '策略不得 import UI 代码')
  assert.doesNotMatch(
    source,
    /from ['"]\.\.\/(?:compiler|classify|registry)/,
    '策略不得依赖编译/分类实现',
  )
  console.log('✓ rv2 零 ctx/UI/Host 依赖')
}

// 3. buildSystem('zh'):9 段全出现 + 审查铁律 + 共享不变式
{
  const sys = buildReviewSystem('zh')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `zh system 缺少段落锚点 ${section}`)
  }
  assert.ok(sys.includes(REVIEW_BASED_ON_ORIGINAL_GOAL), 'zh system 必须包含「基于原目标审查」')
  assert.ok(sys.includes(REVIEW_NO_DIVERGENCE), 'zh system 必须包含「只审查、不另起项目」')
  assert.ok(sys.includes(REVIEW_EVIDENCE_BEFORE_VERDICT), 'zh system 必须包含「先证据后评价」')
  assert.ok(
    sys.includes(REVIEW_DEVIATION_NEEDS_REQUIREMENT),
    'zh system 必须包含「偏离必须对应需求」',
  )
  assert.ok(sys.includes(REVIEW_CORRECTIONS_SCOPED), 'zh system 必须包含「修正建议不越权」')
  assert.match(sys, /不得编造/)
  assert.match(sys, /待补充/)
  assert.match(sys, /建议\(可忽略\)/)
  assert.ok(sys.includes(INVARIANT_UNKNOWN_NOT_BLOCKING_ZH), 'zh system 必须含 invariant A')
  assert.ok(
    sys.includes(INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH),
    'zh system 必须含 invariant B',
  )
  console.log('✓ rv3 buildSystem(zh):9 段 + 审查铁律 + invariant A·B')
}

// 4. buildSystem('en'):同构英文版,9 段锚点仍全部出现
{
  const sys = buildReviewSystem('en')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `en system 缺少段落锚点 ${section}`)
  }
  assert.match(sys, /Review only, never start a new project/)
  assert.match(sys, /Evidence before verdict/)
  assert.match(sys, /Original Goal and Requirements must not be omitted/)
  assert.match(sys, /TODO/)
  console.log('✓ rv4 buildSystem(en):双语同构 + 9 段')
}

// 5. buildUser:真实案例注入 + 9 段 + 缺口纪律 + 上下文/workspace/llm_derived
{
  const vars = {
    raw_input: REAL_CASE,
    context_turns: [
      { role: 'user', text: '最初目标是交付一个可用的优化器插件,不要扩成新平台' },
      { role: 'assistant', text: '可以先看 P02 的策略完成度' },
    ],
    workspace_metadata: { cwd: '/Users/me/Projects/apo', workspace_name: 'apo' },
    missing_constraints: [
      { id: 'mc-1', label: '原目标的量化验收口径', reason: '决定评估标准如何判定' },
    ],
    llm_derived: {
      user_goals: [
        {
          id: 'g1',
          text: '对照最初目标审查项目现状',
          source: 'USER_EXPLICIT',
          evidence: ['对照最初的目标和需求审查'],
          confidence: 'high',
        },
      ],
      rejected_directions: [],
      known_constraints: [],
    },
  }
  const user = buildReviewUser(vars)
  assert.ok(user.includes(REAL_CASE), 'user 载荷必须原样包含 raw_input')
  assert.match(user, /<prompt-draft>/)
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(user.includes(section), `user 载荷缺少段落锚点 ${section}`)
  }
  assert.match(user, /用户: 最初目标是交付一个可用的优化器插件/)
  assert.match(user, /助手: 可以先看 P02 的策略完成度/)
  assert.match(user, /apo/)
  assert.match(user, /原目标的量化验收口径/)
  assert.match(user, /\[待补充:/)
  assert.match(user, /\[quote: 对照最初的目标和需求审查\]/)
  console.log('✓ rv5 buildUser:真实案例 + 上下文/workspace/缺口/llm_derived')
}

// 6. buildUser 语言匹配:英文输入 → 英文载荷;中文输入 → 中文载荷
{
  const en = buildReviewUser({
    raw_input:
      'Review this project against the original goal and requirements, do not start a new project',
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(en, /Here is my review request/)
  assert.match(en, /<prompt-draft>/)
  assert.ok(!en.includes('以下是我的审查诉求'))

  const zh = buildReviewUser({
    raw_input: REAL_CASE,
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(zh, /以下是我的审查诉求/)
  assert.ok(!zh.includes('Here is my review request'))
  console.log('✓ rv6 buildUser 语言匹配(zh 优先)')
}

// 7. 守卫 1:发散语言且无原目标对照 → warn 触发
{
  const guard = guardById('review-no-divergence-without-goal')
  assert.ok(guard, '守卫 1 必须存在')
  assert.match(guard.description, /warn/, '发散守卫必须是 warn 级')

  const unframed = [
    '### Deviations（偏离）',
    '- 偏离 R2:registry 未接入。',
    '### Suggested Corrections（修正建议）',
    '- 建议重构整个项目并新建功能。',
  ].join('\n')
  const issue = guard.check(unframed, emptyResult, REAL_CASE)
  assert.ok(issue, '发散语言且无原目标对照 → 必须触发')
  assert.match(issue, /warn/, '触发信息必须标明 warn 级')

  // 原目标对照后放行
  const framed = [
    '### Suggested Corrections（修正建议）',
    '- 原目标对照:相比原目标,此处建议整体重构并已标明偏离。',
  ].join('\n')
  assert.equal(guard.check(framed, emptyResult, REAL_CASE), null, '对照原目标 → 放行')

  // 禁令措辞不算发散
  assert.equal(
    guard.check('- 不要新建功能,保持原目标范围。', emptyResult, REAL_CASE),
    null,
    '禁令措辞 → 放行',
  )
  // 无发散语言 → 放行
  assert.equal(
    guard.check('### Deviations（偏离）\n- 偏离 R2:未覆盖。', emptyResult, REAL_CASE),
    null,
  )
  assert.equal(guard.check(GOOD_REVIEW_OUTPUT, emptyResult, REAL_CASE), null, '合法产物 → 放行')
  console.log('✓ rv7 守卫 1:发散无对照触发 / 对照原目标放行')
}

// 8. 守卫 2:缺 Original Goal / Requirements 段 → error(任务契约点名)
{
  const guard = guardById('review-mandatory-original-goal-requirements')
  assert.ok(guard, '守卫 2 必须存在')
  assert.match(guard.description, /error/, '缺原目标/需求守卫必须是 error 级')
  assert.equal(guard.check(GOOD_REVIEW_OUTPUT, emptyResult, REAL_CASE), null, '齐备 → 放行')

  const missingGoal = GOOD_REVIEW_OUTPUT.replace(/Original Goal/g, 'OG')
  assert.ok(guard.check(missingGoal, emptyResult, REAL_CASE), '缺 Original Goal → 必须触发')

  const missingRequirements = GOOD_REVIEW_OUTPUT.replace(/Requirements/g, 'Reqs')
  assert.ok(
    guard.check(missingRequirements, emptyResult, REAL_CASE),
    '缺 Requirements → 必须触发',
  )
  console.log('✓ rv8 守卫 2:缺原目标/需求段触发 error')
}

// 9. 守卫 3:必出段落齐全(sectionPresence 工厂)
{
  const guard = guardById('review-required-sections')
  assert.ok(guard, '守卫 3 必须存在')
  assert.equal(guard.check(GOOD_REVIEW_OUTPUT, emptyResult, ''), null, '9 段必须齐全')
  assert.ok(
    guard.check(
      GOOD_REVIEW_OUTPUT.split('Suggested Corrections').join(''),
      emptyResult,
      '',
    ),
    '缺段 → 必须触发',
  )
  console.log('✓ rv9 守卫 3:必出段落齐全')
}

// 10. 守卫 4:无证据验收结论(已达标 / 已满足 / 全部通过 必须有逐字证据)
{
  const guard = guardById('review-no-unproven-verdict')
  assert.ok(guard, '守卫 4 必须存在')

  assert.ok(
    guard.check('### Evidence\n- R1 需求已达标', emptyResult, ''),
    '无证据「已达标」→ 必须触发',
  )
  assert.ok(
    guard.check('### Evidence\n- R1 全部通过', emptyResult, ''),
    '无证据「全部通过」→ 必须触发',
  )
  assert.equal(
    guard.check('### Evidence\n- R1 待验证:尚无 `npm test` 证据', emptyResult, ''),
    null,
    '待验证结论 → 放行',
  )
  assert.equal(
    guard.check('### Evidence\n- R1 已达标', emptyResult, 'R1 已达标'),
    null,
    '有逐字证据 → 放行',
  )
  console.log('✓ rv10 守卫 4:无证据验收结论')
}

// 11. 跨策略不变式 A·B 已挂到 review.guards(P02-T01 工厂)
{
  assert.ok(guardById('shared-unknown-not-blocking'), 'invariant A 守卫必须存在')
  assert.ok(guardById('shared-suggested-not-in-explicit'), 'invariant B 守卫必须存在')
  assert.ok(guardById('shared-suggested-not-upgraded'), 'invariant B(升级)守卫必须存在')

  const unknown = guardById('shared-unknown-not-blocking')
  assert.equal(unknown.check('- [待补充: 原目标量化口径]', emptyResult, ''), null)
  assert.ok(unknown.check('- 请先回答原目标,否则无法继续审查', emptyResult, ''))

  const upgraded = guardById('shared-suggested-not-upgraded')
  const suggested = [{ text: '建议(可忽略) 先列出评估标准', source: 'OPTIMIZER_SUGGESTED' }]
  assert.ok(
    upgraded.check('- 必须先列出评估标准', { suggested_requirements: suggested }, ''),
    '建议升级为强约束 → 必须触发',
  )
  assert.equal(
    upgraded.check('- 计划先列出评估标准', { suggested_requirements: suggested }, ''),
    null,
  )
  console.log('✓ rv11 invariant A·B 已挂载并生效')
}

// 12. 合法 mock 编译产物:守卫全过 + 无重复 id + 规则齐备
{
  assert.deepEqual(guardIssues(GOOD_REVIEW_OUTPUT, REAL_CASE), [], '合法产物不应触发任何守卫')

  const ids = review.guards.map((guard) => guard.id)
  assert.equal(new Set(ids).size, ids.length, '守卫 id 必须唯一')
  const suggestionIds = review.suggestionRules.map((rule) => rule.id)
  assert.equal(new Set(suggestionIds).size, suggestionIds.length)
  const provenanceIds = review.provenanceRules.map((rule) => rule.id)
  assert.equal(new Set(provenanceIds).size, provenanceIds.length)
  const preservationIds = review.preservationRules.map((rule) => rule.id)
  assert.equal(new Set(preservationIds).size, preservationIds.length)
  assert.ok(review.suggestionRules.length >= 3)
  assert.ok(review.provenanceRules.length >= 3)
  assert.ok(review.preservationRules.length >= 3)
  console.log('✓ rv12 合法产物零守卫问题 + 规则 id 唯一')
}

// 13. 保真检查:审查对象信号(P02-T05)与专有名词保留 / 语言匹配
{
  const subject = ruleById(review.preservationRules, 'review-preserve-subject-signals')
  assert.ok(subject?.check)
  const caseWithSignal = '看看这个项目现在还有什么问题?对照最初目标审查 P02-T05,不要发散成新项目'
  const kept = '审查对象:P02-T05;对照原目标后给出偏离与修正。'
  assert.equal(subject.check(kept, caseWithSignal, []), true)
  assert.equal(
    subject.check('审查对象:一个插件任务;对照原目标后给出偏离与修正。', caseWithSignal, []),
    false,
    '丢失 P02-T05 必须判定不保真',
  )

  const language = ruleById(review.preservationRules, 'review-preserve-language')
  assert.ok(language?.check)
  assert.equal(language.check(kept, caseWithSignal, []), true)
  assert.equal(language.check('English-only output', caseWithSignal, []), false)
  assert.equal(language.check('', caseWithSignal, []), false)

  assert.ok(ruleById(review.preservationRules, 'review-preserve-original-goal-verbatim'))
  assert.ok(ruleById(review.preservationRules, 'review-preserve-evidence-verbatim'))
  assert.ok(ruleById(review.preservationRules, 'review-preserve-scope-boundary'))
  console.log('✓ rv13 保真检查:P02-T05 保留 + 语言匹配 + 原目标/证据/范围边界')
}

// 14. mock 编译产物抽查:原目标锚定 + 偏离对应需求 + 修正不越权
{
  const mockCompiled = GOOD_REVIEW_OUTPUT

  // 原目标段必须早于偏离 / 修正段(审查基于原目标)
  const goalIndex = mockCompiled.indexOf('### Original Goal')
  assert.ok(goalIndex > 0)
  for (const anchor of ['### Deviations', '### Missing Items', '### Suggested Corrections']) {
    assert.ok(goalIndex < mockCompiled.indexOf(anchor), `Original Goal 必须早于 ${anchor}`)
  }
  // 偏离必须点名需求编号
  assert.match(mockCompiled, /### Deviations（偏离）\n- 偏离 R2/)
  // 修正必须对照原目标并给复测方式
  const correctionIndex = mockCompiled.indexOf('### Suggested Corrections')
  assert.match(mockCompiled.slice(correctionIndex), /对照原目标/)
  assert.match(mockCompiled.slice(correctionIndex), /复测/)
  // 守卫对合法产物零误报
  assert.deepEqual(guardIssues(mockCompiled, REAL_CASE), [])
  // 编译用 system/user 文案齐备
  assert.ok(buildReviewSystem('zh').length > 0)
  assert.ok(
    review
      .buildUser({
        raw_input: REAL_CASE,
        context_turns: [],
        workspace_metadata: {},
        missing_constraints: [],
      })
      .includes(REAL_CASE),
  )
  console.log('✓ rv14 mock 产物:原目标锚定 + 偏离对应需求 + 修正不越权 + 守卫零误报')
}

console.log('\nstrategies-review: all passed')
