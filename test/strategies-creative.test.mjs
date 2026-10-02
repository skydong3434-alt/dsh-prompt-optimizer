/**
 * creative 策略单元测试(P02-T06)。
 *
 * 运行:先 `npm run build`,再 `node test/strategies-creative.test.mjs`。
 * 覆盖:契约形状 / 12 段锚点 / 双语 buildSystem / buildUser 注入 /
 * 实体保真守卫(人物·镜头·动作·资产占位符) / 无证据改设定 warn 守卫 /
 * Success Criteria 强制段 / 无证据强断言 / invariant A·B / 保真检查 /
 * mock 编译产物抽查(实体保真 + 成功标准 + 顺序)。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import creative, {
  CREATIVE_MANDATORY_SECTIONS,
  CREATIVE_NO_INVENTED_CONSTRAINTS,
  CREATIVE_NO_UNPROVEN_SETTING_CHANGE,
  CREATIVE_PRESERVE_GIVEN_ENTITIES,
  CREATIVE_REQUIRED_SECTIONS,
  CREATIVE_STRATEGY_VERSION,
  CREATIVE_SUCCESS_CRITERIA_REQUIRED,
  buildCreativeSystem,
  buildCreativeUser,
  extractCreativeEntities,
} from '../lib/core/strategies/creative.js'
import {
  INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH,
  INVARIANT_UNKNOWN_NOT_BLOCKING_ZH,
} from '../lib/core/strategies/_shared.js'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (rel) => readFileSync(join(here, rel), 'utf8')

const REAL_CASE =
  '给下面这段分镜写一版视频生成提示词:人物A 在雨夜街头追人物B,镜头2 特写资产X(红色雨伞),动作:回眸,不要改变角色关系,保留人物A 的短发设定'

const EXPECTED_SECTIONS = [
  'Creative Goal',
  'Audience',
  'Platform',
  'Style',
  'Reference',
  'Assets',
  'Constraints',
  'Structure',
  'Tone',
  'Output Format',
  'Avoidances',
  'Success Criteria',
]

const emptyResult = { explicit_requirements: [], context_requirements: [] }
const guardIssues = (output, rawInput = '', result = emptyResult) =>
  creative.guards
    .map((guard) => guard.check(output, result, rawInput))
    .filter((issue) => issue !== null)
const guardById = (id) => creative.guards.find((guard) => guard.id === id)
const ruleById = (rules, id) => rules.find((rule) => rule.id === id)

/** 一份完整的合法编译产物:12 段齐全、实体原样保留、设定未变、成功标准可核查。 */
const GOOD_CREATIVE_OUTPUT = [
  '## 明确要求',
  '- 为分镜写视频生成提示词并保留 人物A 的短发设定 [quote: 保留 人物A 的短发设定]',
  '- 不要改变角色关系 [quote: 不要改变角色关系]',
  '## 上下文已确认',
  '- 人物A 在雨夜街头追 人物B [quote: 人物A 在雨夜街头追 人物B]',
  '## 优化器建议(可忽略)',
  '- 建议(可忽略) 先补齐平台与画幅再决定镜头时长',
  '## 待补充',
  '- [待补充: 目标平台与画幅比例]',
  '## 优化后的 Creative Prompt',
  '### Creative Goal（创作目标）',
  '- 生成一版可用于视频模型的分镜提示词,主角为 人物A 与 人物B。',
  '### Audience（受众）',
  '- [待补充: 目标受众]',
  '### Platform（平台）',
  '- [待补充: 发布平台与画幅]',
  '### Style（风格）',
  '- 写实电影感,雨夜霓虹。',
  '### Reference（参考）',
  '- 资产X(红色雨伞)、人物A 的短发设定作为参考素材。',
  '### Assets（资产）',
  '- 人物A(短发) / 人物B / 镜头2(特写) / 资产X(红色雨伞);以上标识原样保留,不得改名或合并。',
  '### Constraints（约束）',
  '- 不改变角色关系,保留 人物A 与 人物B 的关系设定。',
  '### Structure（结构）',
  '- 镜头2 特写 动作:回眸;不改变角色关系。',
  '### Tone（语气）',
  '- 紧张、克制。',
  '### Output Format（输出格式）',
  '- 分镜表:镜号 / 画面 / 台词 / 备注。',
  '### Avoidances（避免项）',
  '- 不得改变角色关系,不得替换 人物A / 人物B / 资产X。',
  '### Success Criteria（成功标准）',
  '- 人物A / 人物B / 镜头2 / 资产X 原样出现;角色关系未被改变;输出为分镜表格式。',
].join('\n')

// 1. 契约形状:type / 独立版本 / 12 段锚点 / 强制段 Success Criteria
{
  assert.equal(creative.type, 'creative')
  assert.equal(creative.version, CREATIVE_STRATEGY_VERSION)
  assert.equal(creative.version, '0.1.0', '策略必须带独立版本号 0.1.0')
  assert.deepEqual(creative.required_sections, EXPECTED_SECTIONS)
  assert.equal(creative.required_sections.length, 12)
  assert.deepEqual(creative.outputContract.sections, EXPECTED_SECTIONS)
  assert.deepEqual(CREATIVE_REQUIRED_SECTIONS, EXPECTED_SECTIONS)
  assert.deepEqual(CREATIVE_MANDATORY_SECTIONS, ['Success Criteria'])
  assert.ok(CREATIVE_MANDATORY_SECTIONS.includes('Success Criteria'), 'Success Criteria 必须是强制段')
  assert.ok(creative.purpose.length > 0)
  assert.equal(typeof creative.buildSystem, 'function')
  assert.equal(typeof creative.buildUser, 'function')
  console.log('✓ cr1 契约形状:type/version 0.1.0/12 段锚点/强制段 Success Criteria')
}

// 2. 零 ctx / UI / Host import(纯数据 + 纯函数,可独立升级)
{
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const source = stripComments(readSource('../src/core/strategies/creative.ts'))
  assert.doesNotMatch(source, /ctx\.llm/, '策略不得依赖 ctx.llm')
  assert.doesNotMatch(source, /from ['"]@deepseek-ai/, '策略不得 import Harness 包')
  assert.doesNotMatch(source, /from ['"]react/, '策略不得 import react')
  assert.doesNotMatch(source, /client\//, '策略不得 import UI 代码')
  assert.doesNotMatch(
    source,
    /from ['"]\.\.\/(?:compiler|classify|registry)/,
    '策略不得依赖编译/分类实现',
  )
  console.log('✓ cr2 零 ctx/UI/Host 依赖')
}

// 3. buildSystem('zh'):12 段全出现 + 创作铁律 + 共享不变式
{
  const sys = buildCreativeSystem('zh')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `zh system 缺少段落锚点 ${section}`)
  }
  assert.ok(sys.includes(CREATIVE_PRESERVE_GIVEN_ENTITIES), 'zh system 必须包含「保留给定实体」')
  assert.ok(
    sys.includes(CREATIVE_NO_UNPROVEN_SETTING_CHANGE),
    'zh system 必须包含「无证据不改设定」',
  )
  assert.ok(
    sys.includes(CREATIVE_SUCCESS_CRITERIA_REQUIRED),
    'zh system 必须包含「成功标准必备」',
  )
  assert.ok(
    sys.includes(CREATIVE_NO_INVENTED_CONSTRAINTS),
    'zh system 必须包含「不发明硬约束」',
  )
  assert.match(sys, /不得编造|不得猜测/)
  assert.match(sys, /待补充/)
  assert.match(sys, /建议\(可忽略\)/)
  assert.ok(sys.includes(INVARIANT_UNKNOWN_NOT_BLOCKING_ZH), 'zh system 必须含 invariant A')
  assert.ok(
    sys.includes(INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH),
    'zh system 必须含 invariant B',
  )
  console.log('✓ cr3 buildSystem(zh):12 段 + 创作铁律 + invariant A·B')
}

// 4. buildSystem('en'):同构英文版,12 段锚点仍全部出现
{
  const sys = buildCreativeSystem('en')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `en system 缺少段落锚点 ${section}`)
  }
  assert.match(sys, /Success Criteria must not be omitted/)
  assert.match(sys, /UNKNOWN ≠ BLOCKING/)
  assert.match(sys, /TODO/)
  console.log('✓ cr4 buildSystem(en):双语同构 + 12 段')
}

// 5. buildUser:真实案例注入 + 12 段 + 实体清单 + 缺口纪律 + 上下文/workspace/llm_derived
{
  const vars = {
    raw_input: REAL_CASE,
    context_turns: [
      { role: 'user', text: '人物A 就是我之前定的短发女主,不要改' },
      { role: 'assistant', text: '可以先补一个分镜结构' },
    ],
    workspace_metadata: { cwd: '/Users/me/Projects/apo', workspace_name: 'apo' },
    missing_constraints: [
      { id: 'mc-1', label: '目标平台与画幅比例', reason: '决定分镜构图与时长' },
    ],
    llm_derived: {
      user_goals: [
        {
          id: 'g1',
          text: '为分镜写视频生成提示词',
          source: 'USER_EXPLICIT',
          evidence: ['保留人物A 的短发设定'],
          confidence: 'high',
        },
      ],
      rejected_directions: [],
      known_constraints: [],
    },
  }
  const user = buildCreativeUser(vars)
  assert.ok(user.includes(REAL_CASE), 'user 载荷必须原样包含 raw_input')
  assert.match(user, /<prompt-draft>/)
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(user.includes(section), `user 载荷缺少段落锚点 ${section}`)
  }
  assert.match(user, /用户: 人物A 就是我之前定的短发女主,不要改/)
  assert.match(user, /助手: 可以先补一个分镜结构/)
  assert.match(user, /apo/)
  assert.match(user, /目标平台与画幅比例/)
  assert.match(user, /\[待补充:/)
  assert.match(user, /\[quote: 保留人物A 的短发设定\]/)
  // 实体清单显式注入(保真断言的可读来源)
  assert.match(user, /检测到以下可识别实体/)
  assert.match(user, /- 人物A/)
  assert.match(user, /- 人物B/)
  assert.match(user, /- 镜头2/)
  assert.match(user, /- 资产X/)
  console.log('✓ cr5 buildUser:真实案例 + 实体清单 + 上下文/workspace/缺口/llm_derived')
}

// 6. buildUser 语言匹配:英文输入 → 英文载荷;中文输入 → 中文载荷
{
  const en = buildCreativeUser({
    raw_input:
      'Write a video generation prompt for this storyboard, keep the original characters and do not change their relationship',
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(en, /Here is my creative request/)
  assert.match(en, /<prompt-draft>/)
  assert.ok(!en.includes('以下是我的创作诉求'))

  const zh = buildCreativeUser({
    raw_input: REAL_CASE,
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(zh, /以下是我的创作诉求/)
  assert.ok(!zh.includes('Here is my creative request'))
  console.log('✓ cr6 buildUser 语言匹配(zh 优先)')
}

// 7. 实体提取:标签+标识 / 括号占位符 / @handle 三种写法
{
  assert.deepEqual(
    extractCreativeEntities(REAL_CASE),
    ['人物A', '人物B', '镜头2', '资产X'],
    'REAL_CASE 必须提取到 人物A/人物B/镜头2/资产X',
  )
  const placeholders = extractCreativeEntities('保留 <人物A> 与 【资产X】,参考 @prop_x')
  assert.ok(placeholders.includes('<人物A>'), '尖括号占位符必须提取')
  assert.ok(placeholders.includes('【资产X】'), '方括号占位符必须提取')
  assert.ok(placeholders.includes('@prop_x'), '@handle 必须提取')
  assert.ok(placeholders.includes('人物A'), '标签+标识也要提取')
  assert.deepEqual(extractCreativeEntities('把这段话写得更口语一点'), [], '无实体时返回空数组')
  console.log('✓ cr7 实体提取:标签+标识 / 括号占位符 / @handle')
}

// 8. 守卫 1(error 级):可识别实体不得被替换 / 丢失(占位符保真断言)
{
  const guard = guardById('creative-preserve-entities')
  assert.ok(guard, '实体保真守卫必须存在')
  assert.match(guard.description, /error/, '实体保真守卫必须是 error 级')
  assert.equal(guard.check(GOOD_CREATIVE_OUTPUT, emptyResult, REAL_CASE), null, '实体齐全 → 放行')

  const replaced = GOOD_CREATIVE_OUTPUT.replace(/资产X/g, '资产Y')
  const issue = guard.check(replaced, emptyResult, REAL_CASE)
  assert.ok(issue, '实体被替换(资产X → 资产Y)→ 必须触发')
  assert.match(issue, /error/, '触发信息必须标明 error 级')

  const dropped = GOOD_CREATIVE_OUTPUT.replace(/镜头2/g, '某个镜头')
  assert.ok(guard.check(dropped, emptyResult, REAL_CASE), '实体丢失(镜头2)→ 必须触发')

  assert.equal(
    guard.check('任意输出', emptyResult, '把这段话写得更口语一点'),
    null,
    '输入无可识别实体 → 不触发',
  )
  console.log('✓ cr8 守卫 1:实体被替换/丢失 → error;无实体输入放行')
}

// 9. 守卫 2(warn 级):无证据的「改变角色关系 / 技能 / Blocking」类语言
{
  const guard = guardById('creative-no-unproven-setting-change')
  assert.ok(guard, '无证据改设定守卫必须存在')
  assert.match(guard.description, /warn/, '改设定守卫必须是 warn 级')

  const change = guard.check(
    '### Suggested Corrections\n- 建议改变角色关系,让人物A 与人物B 互换身份。',
    emptyResult,
    REAL_CASE,
  )
  assert.ok(change, '无证据「改变角色关系」→ 必须触发')
  assert.match(change, /warn/, '触发信息必须标明 warn 级')

  assert.ok(
    guard.check('- 建议调整技能设定,让 人物A 使用新能力。', emptyResult, REAL_CASE),
    '无证据「调整技能」→ 必须触发',
  )

  // 带逐字证据 → 放行
  assert.equal(
    guard.check('- 改变角色关系 [quote: 把人物A和人物B的关系改成敌对]', emptyResult, REAL_CASE),
    null,
    '带逐字证据 → 放行',
  )
  // 禁令 / 保留措辞 → 放行
  assert.equal(
    guard.check('- 不要改变角色关系,保留原设定。', emptyResult, REAL_CASE),
    null,
    '禁令措辞 → 放行',
  )
  assert.equal(
    guard.check('- 不改变角色关系,保留 人物A 与 人物B 的关系设定。', emptyResult, REAL_CASE),
    null,
    '保留措辞 → 放行',
  )
  // 缺口标记 → 放行
  assert.equal(
    guard.check('- [待补充: 角色关系是否变更]', emptyResult, REAL_CASE),
    null,
    '缺口标记 → 放行',
  )
  assert.equal(guard.check(GOOD_CREATIVE_OUTPUT, emptyResult, REAL_CASE), null, '合法产物 → 放行')
  console.log('✓ cr9 守卫 2:无证据改设定触发 warn / 证据·禁令·缺口放行')
}

// 10. 守卫 3:12 段必出段落齐全(sectionPresence 工厂)
{
  const guard = guardById('creative-required-sections')
  assert.ok(guard, '必出段落守卫必须存在')
  assert.equal(guard.check(GOOD_CREATIVE_OUTPUT, emptyResult, ''), null, '12 段必须齐全')
  assert.ok(
    guard.check(GOOD_CREATIVE_OUTPUT.split('Assets').join(''), emptyResult, ''),
    '缺段 → 必须触发',
  )
  console.log('✓ cr10 守卫 3:12 段必出段落齐全')
}

// 11. 守卫 4(error 级):Success Criteria 强制段(任务契约点名)
{
  const guard = guardById('creative-mandatory-success-criteria')
  assert.ok(guard, 'Success Criteria 强制段守卫必须存在')
  assert.match(guard.description, /error/, '缺成功标准守卫必须是 error 级')
  assert.equal(guard.check(GOOD_CREATIVE_OUTPUT, emptyResult, REAL_CASE), null, '齐备 → 放行')
  const missing = GOOD_CREATIVE_OUTPUT.replace(/Success Criteria/g, 'SC')
  assert.ok(guard.check(missing, emptyResult, REAL_CASE), '缺 Success Criteria → 必须触发')
  console.log('✓ cr11 守卫 4:缺 Success Criteria 段触发 error')
}

// 12. 守卫 5:无证据强断言(已定稿 / 最终设定 / 已确定 必须有逐字证据)
{
  const guard = guardById('creative-no-unproven-strong-claim')
  assert.ok(guard, '无证据强断言守卫必须存在')
  assert.ok(
    guard.check('### 成功标准\n- 人物A 的设定已定稿', emptyResult, ''),
    '无证据「已定稿」→ 必须触发',
  )
  assert.ok(
    guard.check('### 成功标准\n- 最终设定为 人物A 短发', emptyResult, ''),
    '无证据「最终设定」→ 必须触发',
  )
  assert.equal(
    guard.check('### 成功标准\n- 人物A 的设定 [待补充: 是否定稿]', emptyResult, ''),
    null,
    '带缺口标记 → 放行',
  )
  assert.equal(
    guard.check('### 成功标准\n- 人物A 的设定已定稿', emptyResult, '人物A 的设定已定稿'),
    null,
    '有逐字证据 → 放行',
  )
  console.log('✓ cr12 守卫 5:无证据强断言')
}

// 13. 跨策略不变式 A·B 已挂到 creative.guards(P02-T01 工厂)
{
  assert.ok(guardById('shared-unknown-not-blocking'), 'invariant A 守卫必须存在')
  assert.ok(guardById('shared-suggested-not-in-explicit'), 'invariant B 守卫必须存在')
  assert.ok(guardById('shared-suggested-not-upgraded'), 'invariant B(升级)守卫必须存在')

  const unknown = guardById('shared-unknown-not-blocking')
  assert.equal(unknown.check('- [待补充: 目标平台]', emptyResult, ''), null)
  assert.ok(unknown.check('- 请先回答目标平台,否则无法继续创作', emptyResult, ''))

  const upgraded = guardById('shared-suggested-not-upgraded')
  const suggested = [{ text: '建议(可忽略) 先补平台', source: 'OPTIMIZER_SUGGESTED' }]
  assert.ok(
    upgraded.check('- 必须先补平台', { suggested_requirements: suggested }, ''),
    '建议升级为强约束 → 必须触发',
  )
  assert.equal(
    upgraded.check('- 计划先补平台', { suggested_requirements: suggested }, ''),
    null,
  )
  console.log('✓ cr13 invariant A·B 已挂载并生效')
}

// 14. 合法 mock 编译产物:守卫全过 + 无重复 id + 规则齐备
{
  assert.deepEqual(guardIssues(GOOD_CREATIVE_OUTPUT, REAL_CASE), [], '合法产物不应触发任何守卫')

  const ids = creative.guards.map((guard) => guard.id)
  assert.equal(new Set(ids).size, ids.length, '守卫 id 必须唯一')
  const suggestionIds = creative.suggestionRules.map((rule) => rule.id)
  assert.equal(new Set(suggestionIds).size, suggestionIds.length)
  const provenanceIds = creative.provenanceRules.map((rule) => rule.id)
  assert.equal(new Set(provenanceIds).size, provenanceIds.length)
  const preservationIds = creative.preservationRules.map((rule) => rule.id)
  assert.equal(new Set(preservationIds).size, preservationIds.length)
  assert.ok(creative.suggestionRules.length >= 3)
  assert.ok(creative.provenanceRules.length >= 3)
  assert.ok(creative.preservationRules.length >= 3)
  console.log('✓ cr14 合法产物零守卫问题 + 规则 id 唯一')
}

// 15. 保真检查:实体标识 / 设定未变 / 专有名词 / 语言匹配
{
  const entities = ruleById(creative.preservationRules, 'creative-preserve-entity-identifiers')
  assert.ok(entities?.check)
  assert.equal(entities.check(GOOD_CREATIVE_OUTPUT, REAL_CASE, []), true)
  assert.equal(entities.check('只写了人物甲和某个镜头', REAL_CASE, []), false, '丢实体 → 不保真')
  assert.equal(entities.check('任意输出', '把这段话写得更口语一点', []), true, '无实体 → 保真')

  assert.ok(ruleById(creative.preservationRules, 'creative-preserve-relations-and-skills'))
  assert.ok(ruleById(creative.preservationRules, 'creative-preserve-given-style-and-format'))

  const subject = ruleById(creative.preservationRules, 'creative-preserve-subject-signals')
  assert.ok(subject?.check)
  const caseWithSignal = '参考 H3 的质感给 人物A 写分镜'
  assert.equal(subject.check('参考 H3 的质感给 人物A 写分镜', caseWithSignal, []), true)
  assert.equal(
    subject.check('参考某模型的质感给 人物A 写分镜', caseWithSignal, []),
    false,
    '丢失 H3 → 不保真',
  )

  const language = ruleById(creative.preservationRules, 'creative-preserve-language')
  assert.ok(language?.check)
  assert.equal(language.check(GOOD_CREATIVE_OUTPUT, REAL_CASE, []), true)
  assert.equal(language.check('English-only output', REAL_CASE, []), false)
  assert.equal(language.check('', REAL_CASE, []), false)
  console.log('✓ cr15 保真检查:实体标识 + 设定/风格规则 + H3 保留 + 语言匹配')
}

// 16. mock 编译产物抽查:实体保真 + 成功标准可核查 + 段落顺序
{
  const mockCompiled = GOOD_CREATIVE_OUTPUT

  // Assets 必须早于 Constraints / Success Criteria(先固定实体再谈约束与验收)
  const assetsIndex = mockCompiled.indexOf('### Assets')
  assert.ok(assetsIndex > 0)
  assert.ok(assetsIndex < mockCompiled.indexOf('### Constraints'))
  assert.ok(assetsIndex < mockCompiled.indexOf('### Success Criteria'))

  // 创作目标必须早于结构 / 避免项 / 成功标准
  const goalIndex = mockCompiled.indexOf('### Creative Goal')
  assert.ok(goalIndex > 0)
  for (const anchor of ['### Structure', '### Avoidances', '### Success Criteria']) {
    assert.ok(goalIndex < mockCompiled.indexOf(anchor), `Creative Goal 必须早于 ${anchor}`)
  }

  // 每个可识别实体在优化稿中原样出现
  for (const entity of extractCreativeEntities(REAL_CASE)) {
    assert.ok(mockCompiled.includes(entity), `实体 ${entity} 必须原样出现`)
  }

  // 成功标准必须可核查,不得空泛
  const criteria = mockCompiled.slice(mockCompiled.indexOf('### Success Criteria'))
  assert.match(criteria, /原样出现/)
  assert.match(criteria, /未被改变/)
  assert.doesNotMatch(criteria, /好看|满意/)

  // 守卫对合法产物零误报
  assert.deepEqual(guardIssues(mockCompiled, REAL_CASE), [])

  // 编译用 system/user 文案齐备
  assert.ok(buildCreativeSystem('zh').length > 0)
  assert.ok(
    creative
      .buildUser({
        raw_input: REAL_CASE,
        context_turns: [],
        workspace_metadata: {},
        missing_constraints: [],
      })
      .includes(REAL_CASE),
  )
  console.log('✓ cr16 mock 产物:实体保真 + 成功标准可核查 + 段落顺序 + 守卫零误报')
}

console.log('\nstrategies-creative: all passed')
