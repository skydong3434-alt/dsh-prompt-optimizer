/**
 * RC2 —— Decision Stability & Confirmation Semantics 机械回归(CI 用,不联网)。
 *
 * 覆盖用户给定的 10 条验收里的机械部分:
 *   §3 高影响决策不得被降级为 AGENT_DISCOVERABLE(采样无关)
 *   §4 环境事实不得被升级为 USER_REQUIRED(双向)
 *   §5 阻塞决策不得被 PROVISIONAL 绕过
 *   §7 Confirmation 的「目标」= 用户任务目标,不得引用诊断 / triage 说明
 *   §8 四类数据源不得交叉污染
 * 运行:先 `npm run build`,再 `node test/rc2/rc2-decisions.test.mjs`。
 */
import assert from 'node:assert/strict'
import { parseAnalysisResult } from '../../lib/core/analyze.js'
import { mechanicalTriage } from '../../lib/core/triage.js'
import {
  decisionCategoryOfRequirement,
  isReadableEnvironmentFact,
  isStatedSpecification,
  scanDecisionStatements,
  vagueGoalDecision,
} from '../../lib/core/requirements.js'
import { buildConfirmation, isObjectiveLike } from '../../lib/core/discovery.js'
import { explicitIntentFromInput } from '../../lib/core/router.js'

const analysisJson = (unknowns = [], suggestions = [], requirements = []) =>
  JSON.stringify({
    primary_intent: 'execution',
    work_mode: 'exploratory',
    target: 'agent_task',
    edit_triage: 'REBUILD',
    unknowns,
    requirements,
    suggestions,
    confidence_internal: 0.9,
    rationale: '用户只给了一句目标陈述,适合以最小补齐的方式推进而非重写',
    evidence_quotes: [],
    questions: [],
  })

const parse = (raw, unknowns = [], suggestions = [], requirements = []) =>
  parseAnalysisResult(analysisJson(unknowns, suggestions, requirements), { rawInput: raw, language: 'zh' }).result

// ── §6 的 8 条高歧义 Prompt:机械层必须**每次**都产出阻塞决策 ────────────────
const STABILITY_PROMPTS = [
  '我想用 dsh 控制 comfyui 生成视频。',
  '帮我做一个 AI 知识库。',
  '把这个工具做成能长期自动运行的。',
  '先看看能不能实现这个功能。',
  '继续做这个项目。',
  '帮我优化现在这套架构。',
  '我想让 Agent 自动处理这些任务。',
  '帮我把这个原型做完整。',
]

// 1. 决策类别识别(通用语义,不是固定问题模板)
{
  const expected = {
    '我想用 dsh 控制 comfyui 生成视频。': null, // 模糊目标 → 由 vagueGoalDecision 兜底
    '把这个工具做成能长期自动运行的。': 'lifecycle',
    '先看看能不能实现这个功能。': 'analysis_vs_execution',
    '继续做这个项目。': 'scope',
    '帮我优化现在这套架构。': 'architecture_change',
    '我想让 Agent 自动处理这些任务。': 'lifecycle',
    '帮我把这个原型做完整。': 'mvp_vs_full',
    '帮我做一个 AI 知识库。': null,
  }
  for (const [text, category] of Object.entries(expected)) {
    assert.equal(decisionCategoryOfRequirement(text), category, `类别识别:${text}`)
  }
  assert.equal(decisionCategoryOfRequirement('是否允许自动删除旧文件'), 'mutation_permission')
  assert.equal(decisionCategoryOfRequirement('可以自动推送吗'), 'irreversible_permission')
  assert.equal(decisionCategoryOfRequirement('复用现有 workflow 还是新建'), 'reuse_vs_create')
  assert.equal(decisionCategoryOfRequirement('先做最小可用版本还是一步到位'), 'mvp_vs_full')
  console.log('✓ rc2-1 决策类别语义识别(scope/lifecycle/mvp/授权/架构/复用…)')
}

// 2. §3:模型把高影响决策写成普通 missing(或不写)时,机械层必须拉回阻塞
{
  for (const prompt of STABILITY_PROMPTS) {
    // ① 模型**完全不提**任何未知项
    const bare = parse(prompt)
    assert.equal(bare.gate.blocked, true, `§3 模型漏报 → 机械层必须阻塞:${prompt}`)
    assert.ok(
      bare.gate.blocking_items.every((item) => item.classification === 'USER_REQUIRED' && item.impact === 'high'),
      `§3 机械补的项必须是 USER_REQUIRED + high:${prompt}`,
    )
    // ② 模型把它降级成 AGENT_DISCOVERABLE(采样漂移的另一种表现)
    const downgraded = parse(prompt, [
      { text: prompt, classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '模型这轮判为可自查' },
    ])
    assert.equal(downgraded.gate.blocked, true, `§3 模型降级也不得消除阻塞:${prompt}`)
    // ③ 机械层稳定:同输入多次解析结果完全一致(采样无关)
    const again = parse(prompt)
    assert.deepEqual(
      again.gate.blocking_items.map((item) => item.text),
      bare.gate.blocking_items.map((item) => item.text),
      `§3 机械层必须确定性:${prompt}`,
    )
  }
  console.log('✓ rc2-2 §3 高影响决策不被降级,且机械层确定性(8/8 条稳定阻塞)')
}

// 3. §4 反向保护:环境事实不得升级为 USER_REQUIRED(双向)
{
  const envFacts = [
    'ComfyUI 的版本',
    'workflow 文件位置',
    'API 地址与端口',
    '项目结构',
    '依赖版本',
    '当前实现',
    '配置字段',
    '安装位置',
    '当前可用接口',
    '从环境可读取的能力',
  ]
  for (const fact of envFacts) {
    assert.equal(isReadableEnvironmentFact(fact), true, `§4 必须识别为可读事实:${fact}`)
    assert.equal(decisionCategoryOfRequirement(fact), null, `§4 可读事实不得被判为决策:${fact}`)
    // 模型若把它写成 USER_REQUIRED,机械层必须降级回可自查
    const result = parse('帮我用 comfyui 生成视频', [
      { text: fact, classification: 'USER_REQUIRED', blocking: true, impact: 'high', rationale: '模型误判' },
    ])
    const item = result.missing_resolution.find((entry) => entry.text === fact)
    assert.equal(item?.classification, 'AGENT_DISCOVERABLE', `§4 环境事实不得被升级:${fact}`)
    assert.equal(item?.blocking, false, `§4 环境事实不得阻塞:${fact}`)
  }
  // 已写明的规格也不是决策(实测误报:约束:只看本地可跑的方案)
  assert.equal(isStatedSpecification('约束:只看本地可跑的方案'), true)
  assert.equal(decisionCategoryOfRequirement('约束:只看本地可跑的方案'), null)
  assert.equal(decisionCategoryOfRequirement('验收标准:只允许本地运行'), null)
  console.log('✓ rc2-3 §4 环境事实/已写明规格双向保护(不得升级为要问用户)')
}

// 4. 视觉目标:模糊出图/出片有安全默认 → 不构成高影响决策
{
  assert.equal(mechanicalTriage('帮我画一张赛博朋克城市海报').triage, 'REBUILD')
  assert.equal(vagueGoalDecision('帮我画一张赛博朋克城市海报', 'REBUILD', { visualTarget: true }), null)
  assert.ok(vagueGoalDecision('帮我画一张赛博朋克城市海报', 'REBUILD'), '非视觉目标仍必须问范围')
  console.log('✓ rc2-4 视觉目标豁免(有安全默认),任务型目标不豁免')
}

// 5. §5:阻塞决策不得被 PROVISIONAL 绕过
{
  const blocking = {
    id: 'unknown-x',
    text: '我想用 dsh 控制 comfyui 生成视频。',
    classification: 'USER_REQUIRED',
    blocking: true,
    impact: 'high',
    user_exclusive: true,
    rationale: '机械安全层',
  }
  const model = (items) => ({
    intent: { primary: 'execution', supporting: [], work_mode: 'exploratory', rationale: '诊断:适合最小补齐' },
    target: { target: 'agent_task', modality: 'text', engine: null, confidence: 'high', evidence: [], rationale: '' },
    triage: { triage: 'REBUILD', reasons: [], signals: [], keep_safe: false },
    missing_resolution: items,
    gate: {
      blocked: items.length > 0,
      blocking_items: items,
      discoverable_items: [],
      optional_items: [],
      reason: '',
    },
    ledger: [],
    confidence_internal: 0.9,
    rationale: '诊断:适合最小补齐',
    evidence_quotes: [],
    prompt_type: 'execution',
    missing_constraints: [],
  })
  const ledger = [
    { id: 'p1', text: '优先跑通一条最小闭环', source: 'OPTIMIZER_SUGGESTED', status: 'PROVISIONAL', evidence: [], confidence: 'medium' },
  ]
  const blocked = buildConfirmation({ analysis: model([blocking]), ledger, raw_input: '我想用 dsh 控制 comfyui 生成视频。' })
  assert.deepEqual(blocked.provisional, [], '★ 阻塞决策在场时,确认页不得出现任何暂定项')
  const open = buildConfirmation({ analysis: model([]), ledger, raw_input: '我想用 dsh 控制 comfyui 生成视频。' })
  assert.equal(open.provisional.length, 1, '无阻塞时暂定项照常(合法机制)')

  // 只有用户**主动**选择盲授权后,才允许转 PROVISIONAL
  const withBlind = parse('我想用 dsh 控制 comfyui 生成视频。按你的判断继续')
  assert.equal(withBlind.gate.blocked, true, '盲授权不改变「未回答」的阻塞事实(需显式答案)')
  console.log('✓ rc2-5 §5 阻塞决策不得被 PROVISIONAL 绕过;无阻塞时暂定合法')
}

// 6. §7 + §8:Confirmation 的「目标」= 用户任务目标;四类不得交叉污染
{
  const confirmedEntry = {
    id: 'ledger-g',
    text: '把 dsh 作为控制入口',
    source: 'USER_EXPLICIT',
    status: 'CONFIRMED',
    evidence: ['我想用 dsh 控制 comfyui 生成视频。'],
    confidence: 'high',
  }
  const model = {
    intent: { primary: 'execution', supporting: [], work_mode: 'exploratory', rationale: '用户只给了一句目标陈述,适合以最小补齐的方式推进而非重写' },
    target: { target: 'agent_task', modality: 'text', engine: null, confidence: 'high', evidence: [], rationale: '' },
    triage: { triage: 'REBUILD', reasons: ['只有模糊目标'], signals: [], keep_safe: false },
    missing_resolution: [],
    gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: '' },
    ledger: [],
    confidence_internal: 0.9,
    rationale: '用户只给了一句目标陈述,适合以最小补齐的方式推进而非重写',
    evidence_quotes: [],
    prompt_type: 'execution',
    missing_constraints: [],
  }
  const ledger = [
    confirmedEntry,
    { id: 'ledger-d', text: 'ComfyUI 版本', source: 'UNKNOWN', status: 'DISCOVERABLE', evidence: [], confidence: 'low' },
    { id: 'ledger-p', text: '暂定使用 9:16 画幅', source: 'OPTIMIZER_SUGGESTED', status: 'PROVISIONAL', evidence: [], confidence: 'medium' },
  ]
  const confirmation = buildConfirmation({ analysis: model, ledger, raw_input: '我想用 dsh 控制 comfyui 生成视频。' })
  assert.doesNotMatch(confirmation.goal, /目标陈述|最小补齐|triage|REBUILD|诊断/, '★ 目标不得引用诊断 / triage 说明')
  assert.ok(confirmation.goal.includes('我想用 dsh 控制 comfyui 生成视频'), '目标必须是用户自己的任务目标')
  // 四类数据源各归其位
  assert.equal(confirmation.confirmed.length, 1)
  assert.equal(confirmation.agent_researches.length, 1)
  assert.equal(confirmation.provisional.length, 1)
  assert.ok(confirmation.confirmed.every((item) => item.text !== 'ComfyUI 版本'), '可自查项不得进「你已确认」')
  assert.ok(confirmation.provisional.every((item) => item.text !== 'ComfyUI 版本'), '可自查项不得进暂定')
  assert.ok(!confirmation.agent_researches.includes('暂定使用 9:16 画幅'), '暂定项不得进可自查')
  // 目标类判定:取舍句 / 问题句不算目标
  assert.equal(isObjectiveLike('我想用 dsh 控制 comfyui 生成视频。'), true)
  assert.equal(isObjectiveLike('复用现有 workflow 还是新建'), false)
  assert.equal(isObjectiveLike('是否允许自动删除'), false)
  console.log('✓ rc2-6 §7/§8 目标 = 用户任务目标;四类数据源不交叉污染')
}

// 7. 规格行不得被误读成意图指令(实测:约束:只看本地可跑的方案 → 误判 review)
{
  assert.equal(explicitIntentFromInput('约束:只看本地可跑的方案;输出格式:方案对比表'), null)
  assert.equal(explicitIntentFromInput('帮我看看这段代码,只检查,不修改文件。')?.intent, 'review')
  console.log('✓ rc2-7 规格行不触发意图覆盖(约束 ≠ 评审指令)')
}

// 8. 扫描器:句子级扫描去重 + 不重复补同一类别
{
  const found = scanDecisionStatements('把这个工具做成能长期自动运行的,顺便帮我优化现在这套架构。')
  assert.equal(new Set(found.map((item) => item.category)).size, found.length, '同一类别不得重复')
  assert.ok(found.length >= 1)
  console.log('✓ rc2-8 句子级决策扫描(按类别去重)')
}

console.log('rc2-decisions.test.mjs: ALL PASS')
