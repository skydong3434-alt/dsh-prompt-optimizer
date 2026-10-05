/**
 * research 策略单元测试(v0.2 正式版;P01.5 验收线全保留)。
 *
 * 运行:先 `npm run build`,再 `node test/strategies-research.test.mjs`。
 * 覆盖:契约形状 / 15 段锚点 / 双语 buildSystem / buildUser 注入 / 守卫矩阵 /
 * 保真检查 / 真实案例 mock-llm 编译产物抽查(PLAN-v1 §11.2 invariants) /
 * v0.2 来源规则完整化 + 跨策略不变式 A·B 挂载。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import research, {
  NO_CASE_IS_NOT_INFEASIBLE,
  RESEARCH_REQUIRED_SECTIONS,
  RESEARCH_STRATEGY_VERSION,
  buildResearchSystem,
  buildResearchUser,
} from '../lib/core/strategies/research.js'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (rel) => readFileSync(join(here, rel), 'utf8')

const REAL_CASE =
  '帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频,我看到黑鹤001低显流,还有 H3……'

const EXPECTED_SECTIONS = [
  'Background',
  'Research Goal',
  'Existing Knowledge',
  'Constraints',
  'Candidate Approaches',
  'Research Questions',
  'Assumptions To Verify',
  'Evidence Requirements',
  'Source Priority',
  'Conflicting Evidence',
  'Evidence Gaps',
  'Continue-search Conditions',
  'Comparison Dimensions',
  'Human Decision Points',
  'Research Completion Criteria',
]

const emptyResult = { explicit_requirements: [], context_requirements: [] }
const guardIssues = (output, rawInput = '', result = emptyResult) =>
  research.guards
    .map((guard) => guard.check(output, result, rawInput))
    .filter((issue) => issue !== null)
const guardById = (id) => research.guards.find((guard) => guard.id === id)
const ruleById = (rules, id) => rules.find((rule) => rule.id === id)

// 1. 契约形状:type / 独立版本 / 15 段锚点 / sections 顺序一致
{
  assert.equal(research.type, 'research')
  assert.equal(research.version, RESEARCH_STRATEGY_VERSION)
  assert.equal(research.version, '0.2.0', '策略必须带独立版本号 0.2.0')
  assert.deepEqual(research.required_sections, EXPECTED_SECTIONS)
  assert.equal(research.required_sections.length, 15)
  assert.deepEqual(research.outputContract.sections, EXPECTED_SECTIONS)
  assert.ok(research.purpose.length > 0)
  assert.equal(typeof research.buildSystem, 'function')
  assert.equal(typeof research.buildUser, 'function')
  console.log('✓ rs1 契约形状:type/version 0.2.0/15 段锚点')
}

// 2. 零 ctx / UI / Host import(纯数据 + 纯函数,可独立升级)
{
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const source = stripComments(readSource('../src/core/strategies/research.ts'))
  const sharedSource = stripComments(readSource('../src/core/strategies/_shared.ts'))
  assert.doesNotMatch(source, /ctx\.llm/, '策略不得依赖 ctx.llm')
  assert.doesNotMatch(source, /from ['"]@deepseek-ai/, '策略不得 import Harness 包')
  assert.doesNotMatch(source, /from ['"]react/, '策略不得 import react')
  assert.doesNotMatch(source, /client\//, '策略不得 import UI 代码')
  assert.doesNotMatch(sharedSource, /^\s*import\b/m, '_shared.ts 必须零 import')
  console.log('✓ rs2 零 ctx/UI/Host 依赖')
}

// 3. buildSystem('zh'):15 段全出现 + 研究铁律文案
{
  const sys = research.buildSystem('zh')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `zh system 缺少段落锚点 ${section}`)
  }
  assert.match(sys, /Evidence before conclusion/)
  assert.ok(sys.includes(NO_CASE_IS_NOT_INFEASIBLE), 'zh system 必须包含「没有案例 ≠ 不可行」')
  assert.match(sys, /没有案例\s*≠\s*不可行/)
  assert.match(sys, /CUDA/, 'zh system 必须包含 CUDA-only 类限制的替代路径纪律')
  assert.match(sys, /待补充/)
  assert.match(sys, /建议\(可忽略\)/)
  console.log('✓ rs3 buildSystem(zh):15 段 + 铁律 + 替代路径纪律')
}

// 4. buildSystem('en'):同构英文版,15 段锚点仍全部出现
{
  const sys = research.buildSystem('en')
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(sys.includes(section), `en system 缺少段落锚点 ${section}`)
  }
  assert.match(sys, /Absence of examples is not evidence of infeasibility/)
  assert.match(sys, /CUDA-only/)
  assert.match(sys, /TODO/)
  console.log('✓ rs4 buildSystem(en):双语同构 + 15 段')
}

// 5. buildUser:真实案例注入 + 15 段 + 缺口纪律 + 上下文/workspace/llm_derived
{
  const vars = {
    raw_input: REAL_CASE,
    context_turns: [
      { role: 'user', text: '我的机器是 Mac M1 Pro 32GB' },
      { role: 'assistant', text: '可以试试低显存方案' },
    ],
    workspace_metadata: { cwd: '/Users/me/projects/video-lab', workspace_name: 'video-lab' },
    missing_constraints: [
      { id: 'mc-1', label: '目标视频时长', reason: '决定显存与模型选择' },
    ],
    llm_derived: {
      user_goals: [{ id: 'g1', text: '用 ComfyUI 在 Mac 上做 AI 视频', source: 'USER_EXPLICIT', evidence: ['使用 ComfyUI 做 AI 视频'], confidence: 'high' }],
      rejected_directions: [],
      known_constraints: [],
    },
  }
  const user = research.buildUser(vars)
  assert.ok(user.includes(REAL_CASE), 'user 载荷必须原样包含 raw_input')
  assert.match(user, /<prompt-draft>/)
  for (const section of EXPECTED_SECTIONS) {
    assert.ok(user.includes(section), `user 载荷缺少段落锚点 ${section}`)
  }
  assert.match(user, /用户: 我的机器是 Mac M1 Pro 32GB/)
  assert.match(user, /助手: 可以试试低显存方案/)
  assert.match(user, /video-lab/)
  assert.match(user, /目标视频时长/)
  assert.doesNotMatch(user, /-\s*\[待补充:|;\[待补充: [^\]]+\]/, 'v2:user 载荷不得再以占位符形式列出缺口')
  assert.match(user, /未决项及处置|执行前须知|分支条件/, 'v2:未决项按处置分类交付')
  assert.match(user, /ComfyUI 在 Mac 上做 AI 视频/)
  assert.match(user, /\[quote: 使用 ComfyUI 做 AI 视频\]/)
  console.log('✓ rs5 buildUser:真实案例 + 上下文/workspace/缺口/llm_derived')
}

// 6. buildUser 语言匹配:英文输入 → 英文载荷;中文输入 → 中文载荷
{
  const en = buildResearchUser({
    raw_input: 'Research how to run ComfyUI on a Mac M1 Pro 32GB for AI video',
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(en, /Here is my research request/)
  assert.match(en, /<prompt-draft>/)
  assert.ok(!en.includes('以下是我的研究诉求'))

  const zh = buildResearchUser({
    raw_input: REAL_CASE,
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  })
  assert.match(zh, /以下是我的研究诉求/)
  assert.ok(!zh.includes('Here is my research request'))
  console.log('✓ rs6 buildUser 语言匹配(zh 优先)')
}

// 7. 守卫 1:无证据强断言触发(MiniMax 已确认 / 黑鹤001 不可行 / H3 采用)
{
  const guard = guardById('research-no-unfounded-strong-assertion')
  assert.ok(guard, '守卫 1 必须存在')

  for (const line of [
    '- MiniMax 已确认采用为最终路线',
    '- MiniMax 采用为首选方案',
    '- 黑鹤001 不可行,直接淘汰',
    '- H3 确定为最终方案',
  ]) {
    assert.ok(guard.check(line, emptyResult, REAL_CASE), `应触发强断言守卫:${line}`)
  }

  // 有逐字证据 → 不触发;标注为候选/待确认 → 不触发
  assert.equal(
    guard.check('- 用户已确认不考虑 H3 [quote: 不考虑 H3]', emptyResult, '不考虑 H3'),
    null,
  )
  assert.equal(guard.check('- H3 仅为候选方案,待确认是否可行', emptyResult, REAL_CASE), null)
  console.log('✓ rs7 守卫 1:无证据强断言触发 / 有证据或候选标注放行')
}

// 8. 守卫 2:凭空量化约束触发(预算 / 万元 / ¥ / 时限)
{
  const guard = guardById('research-no-invented-quantities')
  assert.ok(guard)
  assert.ok(guard.check('- 项目预算 5 万元,两周内完成调研', emptyResult, REAL_CASE))
  assert.ok(guard.check('- 云算力 ¥5000 封顶', emptyResult, REAL_CASE))
  assert.equal(guard.check('- 预算 [待补充: 预算上限]', emptyResult, REAL_CASE), null)
  assert.equal(guard.check('- 用户明确预算 1 万元 [quote: 预算 1 万元]', emptyResult, '预算 1 万元'), null)
  console.log('✓ rs8 守卫 2:凭空量化触发 / 待补充或带证据放行')
}

// 9. 守卫 3:「没有案例」推「不可行」触发(没有案例 ≠ 不可行)
{
  const guard = guardById('research-no-infeasible-from-absence')
  assert.ok(guard)
  assert.ok(guard.check('- 没有找到 Mac 案例,因此 ComfyUI 方案不可行,予以淘汰', emptyResult, REAL_CASE))
  assert.ok(guard.check('- 未找到现成案例,故该路线行不通', emptyResult, REAL_CASE))
  assert.equal(
    guard.check('- 未找到现成案例,应继续研究替代路径与验证方式', emptyResult, REAL_CASE),
    null,
    '不含不可行结论时不得触发',
  )
  console.log('✓ rs9 守卫 3:由「没案例」推「不可行」触发')
}

// 10. 守卫 4:优化稿必须暴露证据缺口
{
  const guard = guardById('research-require-evidence-gap-disclosure')
  assert.ok(guard)
  assert.ok(guard.check('## 优化后的 Research Prompt\n- 研究 Mac 方案', emptyResult, REAL_CASE))
  assert.equal(guard.check('## 优化稿\n- 证据要求:需要官方文档', emptyResult, REAL_CASE), null)
  assert.equal(
    guard.check('## 执行前须知(由执行方自行确认)\n- 动手前先确认:本机可用的生成链路与依赖版本', emptyResult, REAL_CASE),
    null,
    'v2:动作式执行责任算合格形式',
  )
  assert.equal(
    guard.check('## 分支条件\n- 是否已有 workflow:存在则优先复用,不存在则新建', emptyResult, REAL_CASE),
    null,
    'v2:条件式分支也算合格形式',
  )
  console.log('✓ rs10 守卫 4:缺口未暴露触发 / v2 两种新形式放行')
}

// 11. 合法 mock 编译产物:守卫全过 + 无重复 id
{
  const good = [
    '## 明确要求',
    `- 研究对象:Mac M1 Pro 32GB 上用 ComfyUI 做 AI 视频 [quote: Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频]`,
    '- 已看到两条候选线索:黑鹤001低显流、H3 [quote: 黑鹤001低显流] [quote: H3]',
    '## 上下文已确认',
    '- (无)',
    '## 优化器建议(可忽略)',
    '- 建议(可忽略) 补充输出格式与目标受众',
    '## 执行前须知（由执行方自行确认，不需要询问用户）',
    '- 动手前先确认:本机可用的生成链路与依赖版本',
    '## 优化后的 Research Prompt',
    '### Candidate Approaches（候选方案）',
    '- 候选 1:黑鹤001 低显存流程(需验证 Mac 兼容性)',
    '- 候选 2:H3(需验证依赖与显存占用)',
    '### Human Decision Points（人工决策点）',
    '- 是否优先采用某条候选路线,由用户决定',
  ].join('\n')
  assert.deepEqual(guardIssues(good, REAL_CASE), [], '合法产物不应触发任何守卫')

  const ids = research.guards.map((guard) => guard.id)
  assert.equal(new Set(ids).size, ids.length, '守卫 id 必须唯一')
  const suggestionIds = research.suggestionRules.map((rule) => rule.id)
  assert.equal(new Set(suggestionIds).size, suggestionIds.length)
  const provenanceIds = research.provenanceRules.map((rule) => rule.id)
  assert.equal(new Set(provenanceIds).size, provenanceIds.length)
  assert.ok(research.suggestionRules.length >= 3)
  assert.ok(research.provenanceRules.length >= 3)
  console.log('✓ rs11 合法产物零守卫问题 + 规则 id 唯一')
}

// 12. 保真检查:专有名词保留 / 语言匹配
{
  const subject = ruleById(research.preservationRules, 'research-preserve-subject-terms')
  assert.ok(subject?.check)
  const kept = '研究目标:在 Mac M1 Pro 32GB 上用 ComfyUI 做 AI 视频;候选方案包含黑鹤001低显流与 H3,需要逐条验证兼容性与性能'
  assert.equal(subject.check(kept, REAL_CASE, []), true)
  assert.equal(subject.check('研究目标:一个视频方案', REAL_CASE, []), false, '丢失专有名词必须判定不保真')

  const language = ruleById(research.preservationRules, 'research-preserve-language')
  assert.ok(language?.check)
  assert.equal(language.check(kept, REAL_CASE, []), true)
  assert.equal(language.check('English-only output', REAL_CASE, []), false)
  assert.equal(language.check('', REAL_CASE, []), false)
  console.log('✓ rs12 保真检查:专有名词 + 语言匹配')
}

// 13. 真实案例 mock-llm 编译产物抽查(PLAN-v1 §11.2 deterministic invariants)
{
  const mockCompiled = [
    '## 明确要求',
    '- 研究目标:Mac M1 Pro 32GB 上如何用 ComfyUI 做 AI 视频 [quote: 帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频]',
    '- 候选线索:黑鹤001低显流、H3 [quote: 我看到黑鹤001低显流,还有 H3]',
    '## 优化器建议(可忽略)',
    '- 建议(可忽略) 补充目标视频时长与产出来源',
    '## 执行前须知（由执行方自行确认，不需要询问用户）',
    '- 动手前先确认:Mac 上 ComfyUI 的实际性能数据与依赖版本',
    '## 优化后的 Research Prompt',
    '### Background（背景）',
    '- 用户机器为 Mac M1 Pro 32GB,希望用 ComfyUI 做 AI 视频。',
    '### Candidate Approaches（候选方案）',
    '- 黑鹤001(低显流):待验证 Mac/Metal 兼容性。',
    '- H3:待验证依赖与显存占用。',
    '### Evidence Gaps（证据缺口）',
    '- 是否已有 Mac 实测案例与可复现步骤:存在则优先复用其实验配置,不存在则按自建路径处理',
    '### Human Decision Points（人工决策点）',
    '- 是否优先验证某条候选路线由用户决定。',
    '### Research Completion Criteria（研究完成标准）',
    '- 证据充分、冲突已解释、缺口已显式列出。',
  ].join('\n')

  // 硬禁令(与 PLAN-v1 §11.2 一致)
  assert.doesNotMatch(mockCompiled, /MiniMax(已确认|确定|采用)/)
  assert.doesNotMatch(mockCompiled, /黑鹤001(不可行|淘汰|放弃)/)
  assert.doesNotMatch(mockCompiled, /预算|万元|人民币|¥/)
  // 必须暴露证据缺口 + 含人工决策点
  assert.match(mockCompiled, /证据|动手前先确认|分支|待验证/)
  assert.ok(mockCompiled.includes('Human Decision Points'))
  // 守卫对合法产物零误报
  assert.deepEqual(guardIssues(mockCompiled, REAL_CASE), [])
  // 编译用 system/user 文案齐备
  assert.ok(buildResearchSystem('zh').length > 0)
  assert.ok(research.buildUser({ raw_input: REAL_CASE, context_turns: [], workspace_metadata: {}, missing_constraints: [] }).includes(REAL_CASE))
  console.log('✓ rs13 真实案例 mock 编译产物:invariants 全过 + 守卫零误报')
}

// 14. v0.2 正式化:来源规则完整化 + 跨策略不变式 A·B 挂载(P02-T07)
{
  const provenanceIds = research.provenanceRules.map((rule) => rule.id)
  assert.ok(
    research.provenanceRules.length >= 6,
    '来源规则应完整化(含上下文仅用户 / 冲突证据并列 / 缺口显式)',
  )
  for (const id of [
    'research-context-user-only',
    'research-conflicting-evidence-side-by-side',
    'research-gaps-explicit',
  ]) {
    assert.ok(provenanceIds.includes(id), `来源规则缺 ${id}`)
  }

  const invariantA = guardById('shared-unknown-not-blocking')
  assert.ok(invariantA, 'invariant A 守卫必须挂到 research')
  assert.equal(
    invariantA.check('- 动手前先确认:Mac 实测数据来源', emptyResult, ''),
    null,
    'v2:动作式执行责任不是阻塞问题',
  )
  assert.ok(
    invariantA.check('- 请先回答目标显存,否则无法继续研究', emptyResult, ''),
    '阻塞式未知项 → 必须触发',
  )

  assert.ok(guardById('shared-suggested-not-in-explicit'), 'invariant B 守卫必须挂到 research')
  const invariantB = guardById('shared-suggested-not-upgraded')
  assert.ok(invariantB, 'invariant B(升级)守卫必须挂到 research')
  const suggested = [{ text: '建议(可忽略) 先补目标时长', source: 'OPTIMIZER_SUGGESTED' }]
  assert.ok(
    invariantB.check('- 必须先补目标时长', { suggested_requirements: suggested }, ''),
    '建议升级为强约束 → 必须触发',
  )
  assert.equal(
    invariantB.check('- 计划先补目标时长', { suggested_requirements: suggested }, ''),
    null,
  )
  console.log('✓ rs14 v0.2:来源规则完整化 + invariant A·B 挂载')
}

console.log('\nstrategies-research: all passed')
