/**
 * _shared 共享规则段 / 守卫工厂单元测试(P02-T01)。
 *
 * 运行:先 `npm run build`,再 `node test/strategies-shared.test.mjs`。
 * 覆盖:契约形状与零依赖 / 常量组 / 语言检测复用 estimateTokens 口径 /
 * 建议前缀在产物协议中强制 / 五个守卫工厂矩阵 /
 * invariant A(UNKNOWN ≠ BLOCKING)、invariant B(SUGGESTED ≠ USER REQUIREMENT) 端到端。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FIDELITY_SELF_CHECK_EN,
  FIDELITY_SELF_CHECK_ZH,
  INVARIANT_SUGGESTED_NOT_REQUIREMENT_EN,
  INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH,
  INVARIANT_UNKNOWN_NOT_BLOCKING_EN,
  INVARIANT_UNKNOWN_NOT_BLOCKING_ZH,
  QUOTE_MARKER_PREFIX,
  SHARED_RULES_EN,
  SHARED_RULES_VERSION,
  SHARED_RULES_ZH,
  SUGGESTION_LABEL_EN,
  SUGGESTION_LABEL_ZH,
  TODO_PLACEHOLDER_PREFIX,
  TODO_PLACEHOLDER_PREFIX_EN,
  TODO_PLACEHOLDER_RE,
  countCjkChars,
  detectLanguage,
  estimateTokenCount,
  extractRequirementText,
  forbidUnprovenStrongClaim,
  isChineseDominant,
  quoteMarker,
  readProtocolLines,
  sectionPresence,
  sharedRules,
  stripSuggestionLabel,
  suggestedNotInExplicit,
  suggestedNotUpgraded,
  todoPlaceholder,
  unknownNotBlocking,
} from '../lib/core/strategies/_shared.js'
import { estimateTokens } from '../lib/prompt.js'
import { makeProvenanceRecord, validateProvenance } from '../lib/core/provenance.js'
import research from '../lib/core/strategies/research.js'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (rel) => readFileSync(join(here, rel), 'utf8')

const REAL_CASE =
  '帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频,我看到黑鹤001低显流,还有 H3……'

const emptyResult = { explicit_requirements: [], context_requirements: [] }
const guardById = (guard) => guard

// 1. 契约形状:版本号 / 零 import / 零 ctx·UI·Host 依赖 / 既有导出未改名
{
  assert.match(SHARED_RULES_VERSION, /^\d+\.\d+\.\d+$/, '共享规则段必须带独立语义化版本')

  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const source = stripComments(readSource('../src/core/strategies/_shared.ts'))
  assert.doesNotMatch(source, /^\s*import\b/m, '_shared.ts 必须零 import')
  assert.doesNotMatch(source, /ctx\.llm/, '共享规则段不得依赖 ctx.llm')
  assert.doesNotMatch(source, /from ['"]@deepseek-ai/, '不得 import Harness 包')
  assert.doesNotMatch(source, /from ['"]react/, '不得 import react')
  assert.doesNotMatch(source, /client\//, '不得 import UI 代码')

  for (const [name, value] of Object.entries({
    SHARED_RULES_ZH,
    SHARED_RULES_EN,
    SUGGESTION_LABEL_ZH,
    SUGGESTION_LABEL_EN,
    TODO_PLACEHOLDER_PREFIX,
    TODO_PLACEHOLDER_PREFIX_EN,
    QUOTE_MARKER_PREFIX,
  })) {
    assert.ok(value, `导出常量 ${name} 不得为空`)
  }
  for (const fn of [
    todoPlaceholder,
    quoteMarker,
    isChineseDominant,
    detectLanguage,
    countCjkChars,
    estimateTokenCount,
    sharedRules,
    readProtocolLines,
    extractRequirementText,
    stripSuggestionLabel,
    forbidUnprovenStrongClaim,
    suggestedNotInExplicit,
    sectionPresence,
    unknownNotBlocking,
    suggestedNotUpgraded,
  ]) {
    assert.equal(typeof fn, 'function', '既有/新增导出必须是函数')
  }
  console.log('✓ ss1 契约形状:版本号 + 零 import/ctx/UI + 导出完整')
}

// 2. 常量组:待补充格式 / quote 标记 / 建议前缀 / 保真自检清单
{
  assert.equal(todoPlaceholder('预算'), '[待补充: 预算]')
  assert.equal(todoPlaceholder('预算', 'en'), '[TODO: 预算]')
  assert.equal(todoPlaceholder('', 'en'), '[TODO: 待明确信息]')
  assert.equal(quoteMarker('用户原话'), '[quote: 用户原话]')
  assert.equal(quoteMarker('   '), '')
  assert.equal(SUGGESTION_LABEL_ZH, '建议(可忽略)')
  assert.ok(TODO_PLACEHOLDER_RE.test('[待补充: 预算上限]'))
  assert.ok(TODO_PLACEHOLDER_RE.test('[TODO: budget]'))
  assert.equal(FIDELITY_SELF_CHECK_ZH.length, FIDELITY_SELF_CHECK_EN.length)
  assert.ok(FIDELITY_SELF_CHECK_ZH.length >= 5, '保真自检清单必须足够覆盖对象/方向/数量/禁入/术语')
  assert.ok(FIDELITY_SELF_CHECK_ZH.some((item) => item.includes('禁入')))
  assert.ok(FIDELITY_SELF_CHECK_EN.some((item) => item.includes('verbatim')))
  console.log('✓ ss2 常量组:待补充/quote/建议前缀/保真自检清单')
}

// 3. 建议前缀在共享产物协议中强制出现(zh + en + invariant B)
{
  const zh = sharedRules('zh').join('\n')
  const en = sharedRules('en').join('\n')
  assert.ok(zh.includes(SUGGESTION_LABEL_ZH), 'zh 协议必须强制建议前缀')
  assert.ok(en.includes(SUGGESTION_LABEL_EN), 'en 协议必须强制建议前缀')
  assert.match(zh, /独立成段/, '必须要求建议独立成段')
  assert.match(zh, /永不写入「明确要求/, '必须禁止建议混入要求段')
  assert.ok(zh.includes('跨策略不变式'), 'zh 协议必须包含跨策略不变式段')
  assert.match(en, /Cross-strategy invariants/i)
  console.log('✓ ss3 建议前缀在产物协议中强制(zh/en/invariant)')
}

// 4. 语言检测复用 estimateTokens 同一 CJK 判定区间
{
  const samples = ['你好世界', 'abcd', '你好ab', 'Mac M1 Pro 32GB', '\u3400\u3401', '\uF900']
  for (const sample of samples) {
    assert.equal(
      estimateTokenCount(sample),
      estimateTokens(sample),
      `estimateTokenCount 必须与 prompt.ts estimateTokens 同口径:${sample}`,
    )
  }
  assert.equal(isChineseDominant('你好世界'), true)
  assert.equal(isChineseDominant('abcd'), false)
  assert.equal(isChineseDominant('\u3400\u3401'), true, '扩展 A 区必须按 estimateTokens 口径算中文')
  assert.equal(countCjkChars('\uF900'), 1, '兼容表意区必须按 estimateTokens 口径算中文')
  assert.equal(detectLanguage('请帮我研究'), 'zh')
  assert.equal(detectLanguage('Research this'), 'en')
  console.log('✓ ss4 语言检测复用 estimateTokens 口径(CJK 扩展 A/兼容区)')
}

// 5. sharedRules 结构:六段 / 顺序稳定 / 返回新数组
{
  assert.equal(SHARED_RULES_ZH.length, 6)
  assert.equal(SHARED_RULES_EN.length, 6)
  const zh = sharedRules('zh')
  assert.match(zh[0], /保真原则/)
  assert.match(zh[1], /语言匹配/)
  assert.match(zh[2], /未决项处置纪律/, 'v2 Phase 2:共享纪律段改为「未决项处置纪律」')
  assert.match(zh[3], /建议标注纪律/)
  assert.match(zh[4], /禁入集合处理/)
  assert.match(zh[5], /跨策略不变式/)

  const before = SHARED_RULES_ZH.length
  zh.push('污染')
  assert.equal(SHARED_RULES_ZH.length, before, 'sharedRules 必须返回新数组')
  assert.deepEqual(sharedRules('zh'), [...SHARED_RULES_ZH])
  console.log('✓ ss5 sharedRules 六段结构 + 顺序 + 新数组')
}

// 6. invariant A 常量:UNKNOWN ≠ BLOCKING(zh/en)且进入共享协议
{
  assert.match(INVARIANT_UNKNOWN_NOT_BLOCKING_ZH, /UNKNOWN/)
  assert.match(INVARIANT_UNKNOWN_NOT_BLOCKING_ZH, /BLOCKING/)
  assert.match(INVARIANT_UNKNOWN_NOT_BLOCKING_ZH, /待补充/)
  assert.match(INVARIANT_UNKNOWN_NOT_BLOCKING_EN, /UNKNOWN/)
  assert.match(INVARIANT_UNKNOWN_NOT_BLOCKING_EN, /BLOCKING/)
  assert.match(INVARIANT_UNKNOWN_NOT_BLOCKING_EN, /TODO/)
  assert.ok(sharedRules('zh').join('\n').includes(INVARIANT_UNKNOWN_NOT_BLOCKING_ZH))
  assert.ok(sharedRules('en').join('\n').includes(INVARIANT_UNKNOWN_NOT_BLOCKING_EN))
  console.log('✓ ss6 invariant A 常量:UNKNOWN ≠ BLOCKING 纳入协议')
}

// 7. invariant B 常量:OPTIMIZER_SUGGESTED ≠ USER REQUIREMENT(zh/en)
{
  assert.match(INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH, /OPTIMIZER_SUGGESTED/)
  assert.match(INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH, /USER REQUIREMENT/)
  assert.match(INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH, /建议身份/)
  assert.match(INVARIANT_SUGGESTED_NOT_REQUIREMENT_EN, /OPTIMIZER_SUGGESTED/)
  assert.match(INVARIANT_SUGGESTED_NOT_REQUIREMENT_EN, /USER REQUIREMENT/)
  assert.ok(sharedRules('zh').join('\n').includes(INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH))
  console.log('✓ ss7 invariant B 常量:建议身份声明纳入协议')
}

// 8. 守卫工厂 1:forbidUnprovenStrongClaim(强断言无证据触发)
{
  const guard = guardById(forbidUnprovenStrongClaim())
  assert.equal(guard.id, 'shared-no-unproven-strong-claim')

  for (const line of [
    '- MiniMax 已确认采用为最终路线',
    '- MiniMax 采用为首选方案',
    '- 黑鹤001 不可行,直接淘汰',
    '- H3 确定为最终方案',
  ]) {
    assert.ok(guard.check(line, emptyResult, REAL_CASE), `应触发强断言守卫:${line}`)
  }
  // 有逐字证据 / 降级标注 / 占位符 → 放行
  assert.equal(guard.check('- 用户已确认不考虑 H3 [quote: 不考虑 H3]', emptyResult, '不考虑 H3'), null)
  assert.equal(guard.check('- H3 仅为候选方案,待确认是否可行', emptyResult, REAL_CASE), null)
  assert.equal(guard.check('- [待补充: 是否采用 H3]', emptyResult, REAL_CASE), null)
  // 元信息段(建议/未知/诊断)整段不参与断言扫描
  assert.equal(
    guard.check('<<<SUGGESTED>>>\n- MiniMax 已确认采用\n<<<END>>>', emptyResult, REAL_CASE),
    null,
  )
  // 自定义 id / 额外强断言词
  const custom = forbidUnprovenStrongClaim({ id: 'x-strong', extraPattern: /凭空/ })
  assert.equal(custom.id, 'x-strong')
  assert.ok(custom.check('- 凭空决定使用某平台', emptyResult, REAL_CASE))
  console.log('✓ ss8 守卫 1:无证据强断言触发 / 有证据或降级放行')
}

// 9. 守卫工厂 2:suggestedNotInExplicit(建议不得进入 explicit/context/要求段)
{
  const guard = guardById(suggestedNotInExplicit())
  assert.equal(guard.id, 'shared-suggested-not-in-explicit')

  const explicit = [
    { text: '补充输出格式', source: 'USER_EXPLICIT', evidence: ['补充输出格式'] },
  ]
  const suggested = [
    { text: '建议(可忽略) 补充输出格式', source: 'OPTIMIZER_SUGGESTED', evidence: [] },
  ]
  assert.ok(
    guard.check('', { explicit_requirements: explicit, suggested_requirements: suggested }, ''),
    '建议与明确要求同文 → 必须触发',
  )
  assert.equal(
    guard.check('', { explicit_requirements: [{ text: '研究对象 Mac', source: 'USER_EXPLICIT' }], suggested_requirements: suggested }, ''),
    null,
    '建议独立时不得触发',
  )
  // 要求段文本命中建议内容(即使记录组未串味)
  const output = [
    '## 明确要求',
    '- 补充输出格式',
    '## 优化器建议(可忽略)',
    '- (无)',
  ].join('\n')
  assert.ok(guard.check(output, { suggested_requirements: suggested }, ''), '要求段含建议文本 → 必须触发')
  assert.equal(guard.check(output, emptyResult, ''), null, '无建议记录时不得触发')
  assert.equal(stripSuggestionLabel('建议(可忽略) 补充目标受众'), '补充目标受众')
  assert.equal(stripSuggestionLabel('Suggestion (optional): add tone'), 'add tone')
  console.log('✓ ss9 守卫 2:suggested 混入 explicit/要求段触发')
}

// 10. 守卫工厂 3:sectionPresence 可复用(research.required_sections)
{
  const guard = sectionPresence(['Background', 'Constraints'])
  assert.equal(guard.id, 'shared-required-sections')
  assert.ok(guard.check('Background only', emptyResult, ''))
  assert.equal(guard.check('Background\nConstraints', emptyResult, ''), null)

  const researchGuard = sectionPresence(research.required_sections)
  assert.equal(researchGuard.check(research.buildSystem('zh'), emptyResult, ''), null, 'research 15 段必须齐全')
  assert.ok(researchGuard.check(research.buildSystem('zh').split('Conflicting Evidence').join(''), emptyResult, ''))
  assert.ok(researchGuard.check('', emptyResult, ''))
  // 自定义 id / description
  const custom = sectionPresence(['A'], { id: 'x-sections', description: 'desc' })
  assert.equal(custom.id, 'x-sections')
  assert.equal(custom.description, 'desc')
  console.log('✓ ss10 守卫 3:sectionPresence 工厂可复用(含 research 15 段)')
}

// 11. 守卫工厂 4:unknownNotBlocking(UNKNOWN ≠ BLOCKING)
{
  const guard = guardById(unknownNotBlocking())
  assert.equal(guard.id, 'shared-unknown-not-blocking')

  assert.ok(guard.check('- 请先回答你偏好的视频时长,然后我再继续', emptyResult, ''))
  assert.ok(guard.check('- 你必须确认预算,否则无法继续', emptyResult, ''))
  assert.ok(guard.check('- 请先确认目标平台', emptyResult, ''))
  // 非阻塞未知:占位符 / 明确说明不影响继续 → 放行
  assert.equal(guard.check('- [待补充: 期望的视频时长]', emptyResult, ''), null)
  assert.equal(guard.check('- 未知项:期望的视频时长(非阻塞,先按通用流程继续)', emptyResult, ''), null)
  // 真正的方向改变理由(允许 NEEDS_USER_INPUT)
  assert.equal(guard.check('- 请先回答预算,因为它会实质改变任务方向', emptyResult, ''), null)
  // 禁令措辞是在禁止阻塞,不得触发
  assert.equal(guard.check('- 禁止写「请先回答 X」这类阻塞句式', emptyResult, ''), null)
  // UNKNOWN 段里的阻塞句式仍必须触发(UNKNOWN ≠ BLOCKING)
  assert.ok(
    guard.check('<<<UNKNOWN>>>\n- 请先回答目标平台\n<<<END>>>', emptyResult, ''),
    'UNKNOWN 段的阻塞句式必须触发',
  )
  console.log('✓ ss11 守卫 4:阻塞式未知触发 / 占位符与方向改变放行')
}

// 12. 守卫工厂 5:suggestedNotUpgraded(建议不得升级为强约束)
{
  const guard = guardById(suggestedNotUpgraded())
  assert.equal(guard.id, 'shared-suggested-not-upgraded')
  const suggested = [{ text: '建议(可忽略) 补充目标受众', source: 'OPTIMIZER_SUGGESTED' }]

  const upgraded = [
    '<<<EXPLICIT>>>',
    '- 必须补充目标受众',
    '<<<SUGGESTED>>>',
    '- 建议(可忽略) 补充目标受众',
    '<<<END>>>',
  ].join('\n')
  assert.ok(guard.check(upgraded, { suggested_requirements: suggested }, ''), '强约束句式 → 必须触发')
  assert.ok(
    guard.check('- 用户已确认采用 补充目标受众', { suggested_requirements: suggested }, ''),
    'Human Decision / 已确认语境 → 必须触发',
  )
  const proper = [
    '<<<EXPLICIT>>>',
    '- 研究对象 Mac M1 Pro 32GB',
    '<<<SUGGESTED>>>',
    '- 建议(可忽略) 补充目标受众',
    '<<<END>>>',
  ].join('\n')
  assert.equal(guard.check(proper, { suggested_requirements: suggested }, ''), null)
  assert.equal(guard.check(upgraded, emptyResult, ''), null, '无建议记录时不得触发')
  console.log('✓ ss12 守卫 5:建议以强约束句式出现在要求语境触发')
}

// 13. invariant A 端到端:多项 UNKNOWN 的样例 provenance_ok=true 且无阻塞句式
{
  const records = [
    makeProvenanceRecord({ text: '用 ComfyUI 做 AI 视频', source: 'USER_EXPLICIT', evidence: ['使用 ComfyUI 做 AI 视频'], confidence: 'high' }),
    makeProvenanceRecord({ text: '期望的视频时长', source: 'UNKNOWN', note: '用户未说明' }),
    makeProvenanceRecord({ text: '预算上限', source: 'UNKNOWN', note: '用户未说明' }),
    makeProvenanceRecord({ text: '目标发布平台', source: 'UNKNOWN', note: '用户未说明' }),
    makeProvenanceRecord({ text: '是否需要旁白', source: 'UNKNOWN', note: '用户未说明' }),
  ]
  const validation = validateProvenance(records, REAL_CASE, [])
  assert.equal(validation.ok, true, 'UNKNOWN 豁免,不得阻塞 provenance')
  assert.deepEqual(validation.problems, [])

  const compiled = [
    '<<<EXPLICIT>>>',
    '- 用 ComfyUI 做 AI 视频 [quote: 使用 ComfyUI 做 AI 视频]',
    '<<<SUGGESTED>>>',
    '- 建议(可忽略) 补充目标受众与产出来源',
    '<<<UNKNOWN>>>',
    '- [待补充: 期望的视频时长]',
    '- [待补充: 预算上限]',
    '- [待补充: 目标发布平台]',
    '- [待补充: 是否需要旁白]',
    '<<<OPTIMIZED>>>',
    '## Research Goal（研究目标）',
    '- 研究 Mac M1 Pro 32GB 上如何用 ComfyUI 做 AI 视频',
    '## Evidence Gaps（证据缺口）',
    '- [待补充: 期望的视频时长与预算上限]',
    '## Human Decision Points（人工决策点）',
    '- 具体路线由用户决定,当前无需用户先回答',
    '<<<END>>>',
  ].join('\n')

  assert.equal(unknownNotBlocking().check(compiled, {}, REAL_CASE), null, '多项 UNKNOWN 不得产生阻塞句式')
  assert.equal(
    suggestedNotInExplicit().check(compiled, {
      explicit_requirements: records.filter((r) => r.source === 'USER_EXPLICIT'),
      suggested_requirements: [{ text: '补充目标受众与产出来源', source: 'OPTIMIZER_SUGGESTED' }],
    }, REAL_CASE),
    null,
    '建议保持在建议段时不得触发',
  )
  assert.equal(forbidUnprovenStrongClaim().check(compiled, {}, REAL_CASE), null)
  console.log('✓ ss13 invariant A:多 UNKNOWN 仍 provenance_ok=true 且无阻塞句式')
}

// 14. invariant B 端到端:建议身份不得无痕升级
{
  const suggested = [{ text: '建议(可忽略) 补充目标受众', source: 'OPTIMIZER_SUGGESTED' }]
  const leaked = [
    '<<<EXPLICIT>>>',
    '- 补充目标受众',
    '<<<SUGGESTED>>>',
    '- 建议(可忽略) 补充目标受众',
    '<<<END>>>',
  ].join('\n')
  assert.ok(suggestedNotInExplicit().check(leaked, { suggested_requirements: suggested }, ''))
  assert.equal(
    suggestedNotUpgraded().check(leaked, { suggested_requirements: suggested }, ''),
    null,
    '仅串味但无强约束措辞时,由 suggestedNotInExplicit 负责',
  )
  const leakedStrong = leaked.replace('- 补充目标受众', '- 必须补充目标受众')
  assert.ok(suggestedNotUpgraded().check(leakedStrong, { suggested_requirements: suggested }, ''))
  // 合法产物:建议独立段 + 无强约束措辞 → 两守卫全过
  const clean = [
    '<<<EXPLICIT>>>',
    '- 研究 ComfyUI 低显存方案 [quote: 黑鹤001低显流]',
    '<<<SUGGESTED>>>',
    '- 建议(可忽略) 补充目标受众',
    '<<<UNKNOWN>>>',
    '- [待补充: 期望的视频时长]',
    '<<<OPTIMIZED>>>',
    '## Candidate Approaches（候选方案）',
    '- 候选 1:黑鹤001 低显存流程(待验证 Mac 兼容性)',
    '<<<END>>>',
  ].join('\n')
  assert.equal(suggestedNotInExplicit().check(clean, { suggested_requirements: suggested }, ''), null)
  assert.equal(suggestedNotUpgraded().check(clean, { suggested_requirements: suggested }, ''), null)
  console.log('✓ ss14 invariant B:建议升级触发 / 独立建议段放行')
}

// 15. 分段读取工具:标记段 + Markdown 四段标题一致
{
  const output = [
    '## 明确要求',
    '- A',
    '## 上下文已确认',
    '- B',
    '## 优化器建议(可忽略)',
    '- C',
    '## 待补充',
    '- D',
  ].join('\n')
  const sections = readProtocolLines(output).map((item) => item.section)
  assert.deepEqual(sections, ['explicit', 'context', 'suggested', 'unknown'])
  assert.equal(extractRequirementText(output), '- A\n- B')

  const markerOutput = '<<<EXPLICIT>>>\n- A\n<<<OPTIMIZED>>>\n- Z\n<<<END>>>'
  const markerSections = readProtocolLines(markerOutput).map((item) => item.section)
  assert.deepEqual(markerSections, ['explicit', 'optimized'])
  console.log('✓ ss15 readProtocolLines/要求段抽取:标记与 Markdown 一致')
}

console.log('\nstrategies-shared: all passed')
