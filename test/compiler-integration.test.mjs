/**
 * P04-T03 Compiler + Validator 集成测试(i1..i13)。
 *
 * 覆盖 PLAN-v1 §8/§9 的「compile → finalize → validate」全链路语义闭环:
 *   i1  七类型契约矩阵前置审计(七类型齐全 / required_sections 稳定 / 注册表可寻);
 *   i2  七类型 × override 契约字段矩阵:骨架字段齐全、required_sections 满足、
 *       explicit 逐字证据可寻、suggested 独立、provenance_ok 由 validate 决定;
 *   i3  七类型 × AUTO 分类路径(策略与 prompt_type 一致、override 标志正确);
 *   i4  置信度映射(High/Medium/Low)与 classifier 骨架一致;
 *   i5  缺口注入:classifier 与 [待补充:] 未知段合并去重、缺口在交付稿可见;
 *   i6  失败注入:compiler 输出缺失协议锚点 → 降级 + provenance_ok=false(不伪造来源);
 *   i7  失败注入:伪造 quote / 建议升级 / 无证据量化 → error 数据可定位;
 *   i8  markdown 四段回退 + `- (无)` / 重复标记 / think 块容错(协议解析回归);
 *   i9  provenance_ok 全类型联动:finalizeCompile 与 validateCompileResult 逐类型一致;
 *   i10 legacy general 零回归(不注入四段协议、provenance 段为空、ok=true);
 *   i11 纯函数纪律:可复现、无 ctx.llm / Harness / React / DOM 依赖;
 *   i12 S-07 复审:provenance 机制在七类型上有效防止误标(伪造 quote / 建议升级 /
 *       无证据强断言 三类注入均被机械拦截);
 *   i13 交付稿 provenance 四组互斥 + 无来源交叉污染(不得凭空升级)。
 *
 * 运行:先 `npm run build`,再 `node test/compiler-integration.test.mjs`。
 *
 * 说明:本文件的场景文案全部为本项目独立撰写(与被测策略解耦的「模拟模型输出」),
 * 未复制任何 AGPL 项目(linshenkx / zhangjiazhi)的源码 / 模板 / 测试。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { defaultStrategyRegistry } from '../lib/core/registry.js'
import { compilePrompt, finalizeCompile, parseCompileOutput, COMPILE_MARKERS } from '../lib/core/compiler.js'
import { validateCompileResult } from '../lib/core/validate.js'

const M = COMPILE_MARKERS
const TYPES = ['research', 'planning', 'execution', 'diagnostic', 'review', 'creative', 'general']

// ─────────────────────────────────────────────────────────────────────────────
// 七类型契约矩阵(手工 override;每类型一段「模拟模型输出」)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 每种类型一个场景:
 *   raw        —— 用户本轮输入(同时是 explicit 逐字证据的来源);
 *   quote      —— 从 raw 中文末逐字截取的证据片段(不得是 raw 之外的文字);
 *   missing    —— classifier 给出的缺口(编译期必须落成 [待补充: …]);
 *   suggested  —— 优化器建议(必须独立成段,不得混入 explicit);
 *   body       —— 优化稿(必须含策略全部 required_sections)。
 */
const SCENARIOS = [
  {
    type: 'research',
    raw: '帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频,我看到黑鹤001低显流,还有 H3……',
    quote: ['Mac M1 Pro 32GB', 'ComfyUI', 'H3'],
    missing: ['期望的视频产出形式与时长'],
    suggested: ['补充目标产出形式'],
    body: [
      '## Background（背景）',
      '- 用户机器为 Mac M1 Pro 32GB,目标是 AI 视频,当前线索为黑鹤001低显流与 H3',
      '## Research Goal（研究目标）',
      '- 研究 Mac M1 Pro 32GB 上用 ComfyUI 做 AI 视频的可执行路径',
      '## Existing Knowledge（已知信息）',
      '- 用户提到黑鹤001低显流与 H3,二者均为候选线索',
      '## Constraints（约束）',
      '- [待补充: 期望的视频产出形式与时长]',
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
      '- [待补充: Mac 实测案例]',
      '## Continue-search Conditions（继续检索条件）',
      '- 只有单一来源时继续检索',
      '## Comparison Dimensions（对比维度）',
      '- 兼容性 / 性能 / 成本 / 维护性',
      '## Human Decision Points（人工决策点）',
      '- 是否采用某候选由用户决定',
      '## Research Completion Criteria（研究完成标准）',
      '- 关键问题均有证据支撑时结束本轮研究',
    ].join('\n'),
  },
  {
    type: 'planning',
    raw: '帮我规划 P04-T01 Compiler 的实现步骤,失败要能回退,不确定的先停下来问我',
    quote: ['P04-T01 Compiler 的实现步骤', '失败要能回退'],
    missing: ['交付时间'],
    suggested: ['补充回滚演练'],
    body: [
      '## Goal（目标）',
      '- 规划 P04-T01 Compiler 的实现步骤,保证失败可回退',
      '## Why（为什么）',
      '- 降低实现风险,让不确定项显式暴露',
      '## Preconditions（前置条件）',
      '- 上游 P03 已交付,测试可运行',
      '## Inputs（输入）',
      '- 任务契约、现有测试基线',
      '## Executor（执行者）',
      '- 由实现方执行,验收方复核',
      '## Tools（工具）',
      '- Node 与 git',
      '## Phases（阶段）',
      '### Phase 1:准备',
      '- Acceptance(验收标准):任务契约与基线核对完成',
      '### Phase 2:实现',
      '- Acceptance(验收标准):核心函数可单测通过',
      '### Phase 3:验证',
      '- Acceptance(验收标准):集成测试与门禁全绿',
      '## Tasks（任务）',
      '- 拆分子任务并标注依赖',
      '## Dependencies（依赖）',
      '- 依赖 P03 产出',
      '## Exact Steps（精确步骤）',
      '- 先写测试,再实现,最后回归',
      '## Outputs（产出物）',
      '- 代码改动与测试报告',
      '## Tests（测试）',
      '- 单元测试与集成测试',
      '## Acceptance Criteria（验收标准）',
      '- 全绿且无回归',
      '## Failure Handling（失败处理）',
      '- 失败先回修,不绕过断言',
      '## Stop Conditions（停止条件）',
      '- 触发契约停止条件时上报',
      '## Next Step Condition（下一步条件）',
      '- 验收通过后进入下一个 Task',
    ].join('\n'),
  },
  {
    type: 'execution',
    raw: '帮我执行 P05-T01 的 Registry 兼容层,只改 index.ts,不要动路由,完成后给我交接',
    quote: ['P05-T01 的 Registry 兼容层', '只改 index.ts'],
    missing: ['提交拆分粒度'],
    suggested: ['补充提交拆分建议'],
    body: [
      '## Current Task（当前任务）',
      '- P05-T01 的 Registry 兼容层',
      '## Goal（目标）',
      '- 让 Registry 兼容既有调用路径',
      '## Preconditions（前置条件）',
      '- P04 已验收',
      '## Allowed Scope（允许范围）',
      '- index.ts',
      '## Forbidden Scope（禁止范围）',
      '- 路由层',
      '## Inputs（输入）',
      '- 现有接口与测试',
      '## Executor（执行者）',
      '- 本仓库 Agent',
      '## Tools（工具）',
      '- Node 与 git',
      '## Exact Actions（具体动作）',
      '- 增加兼容分支并补测试',
      '## Tests（测试）',
      '- Registry 单测',
      '## Acceptance（验收）',
      '- 全绿',
      '## Failure Handling（失败处理）',
      '- 失败先回修',
      '## Git·State Rules（Git 规则）',
      '- 一个内容提交加一个状态同步提交',
      '## Stop Conditions（停止条件）',
      '- 触发即上报',
      '## Handoff（交接）',
      '- 交接 P05-T02',
    ].join('\n'),
  },
  {
    type: 'diagnostic',
    raw: '诊断 T-42 报错:超时后没有重试,请先收集证据不要急着改',
    quote: ['T-42 报错', '先收集证据不要急着改'],
    missing: ['超时阈值'],
    suggested: ['补充日志采样'],
    body: [
      '## Symptom（症状）',
      '- T-42 报错:超时后没有重试',
      '## Expected Behavior（期望行为）',
      '- 超时后按策略重试',
      '## Actual Behavior（实际行为）',
      '- 超时直接失败,没有重试记录',
      '## Evidence Collection（证据收集）',
      '- 收集超时日志与调用链',
      '- [待补充: 超时阈值]',
      '## Reproduction（复现）',
      '- 构造超时场景重复执行',
      '## Hypotheses（假设）',
      '- 假设一:重试分支未被触发',
      '## Root Cause Analysis（根因分析）',
      '- 根因未确认,需先证伪假设一',
      '## Disprove-Verify（证伪验证）',
      '- 用日志验证假设一,证伪后再定位',
      '## Fix Proposal（修复建议）',
      '- 修复后补复测,并用回归用例验证',
      '## Regression Test（回归测试）',
      '- 新增超时重试回归用例,判定可复现',
    ].join('\n'),
  },
  {
    type: 'review',
    raw: '帮我审查 P02-T05 的交付是否满足原目标,只按原需求评估不要发散',
    quote: ['P02-T05 的交付是否满足原目标', '只按原需求评估不要发散'],
    missing: ['评测样例'],
    suggested: ['补充评测样例'],
    body: [
      '## Review Target（审查对象）',
      '- P02-T05 的交付',
      '## Original Goal（原目标）',
      '- 按原需求评估交付',
      '## Requirements（需求）',
      '- 只按原需求评估,不发散',
      '## Evaluation Criteria（评估标准）',
      '- 逐条对照原目标',
      '## Evidence（证据）',
      '- 交付记录与测试输出',
      '## Deviations（偏离）',
      '- 与原目标对照后未发现偏离',
      '## Missing Items（缺失项）',
      '- [待补充: 评测样例]',
      '## Risks（风险）',
      '- 样例不足可能低估风险',
      '## Suggested Corrections（修正建议）',
      '- 建议(可忽略) 补充评测样例',
    ].join('\n'),
  },
  {
    type: 'creative',
    raw: '帮我写一个关于咖啡馆的短视频脚本,适合放在社交平台,风格温柔',
    quote: ['咖啡馆的短视频脚本', '风格温柔'],
    missing: ['镜头数量'],
    suggested: ['补充背景音乐方向'],
    body: [
      '## Creative Goal（创作目标）',
      '- 写一个咖啡馆的短视频脚本',
      '## Audience（受众）',
      '- 社交平台上的咖啡爱好者',
      '## Platform（平台）',
      '- 社交平台竖屏',
      '## Style（风格）',
      '- 温柔',
      '## Reference（参考）',
      '- 无外部参考,需保持原设定',
      '## Assets（素材）',
      '- [待补充: 镜头数量]',
      '## Constraints（约束）',
      '- 不得改变人物关系与技能设定',
      '## Structure（结构）',
      '- 开场引入咖啡馆氛围,随后展开人物互动',
      '## Tone（语气）',
      '- 温柔',
      '## Output Format（输出格式）',
      '- 分镜脚本',
      '## Avoidances（规避）',
      '- 不得改变角色关系,不得更换主角',
      '## Success Criteria（成功标准）',
      '- 脚本可直接拍摄且风格与温柔一致',
    ].join('\n'),
  },
  {
    type: 'general',
    raw: '帮我改一下这段提示词,让它更容易被理解,不要新增我没说的要求',
    quote: ['改一下这段提示词', '不要新增我没说的要求'],
    missing: ['目标输出长度'],
    suggested: ['补充语气约束'],
    body: [
      '## Role（角色）',
      '- 你是提示词编辑',
      '## Task Goal（任务目标）',
      '- 改一下这段提示词,让它更容易被理解',
      '## Input Materials（输入材料）',
      '- 用户提供的原提示词草稿',
      '## Output Format（输出格式）',
      '- 输出优化后的完整提示词',
      '## Content Requirements（内容要求）',
      '- 不新增用户未说明的硬约束',
      '## Style（风格）',
      '- 简洁清晰',
      '## Constraints（约束）',
      '- 不得新增我没说的要求',
      '- [待补充: 目标输出长度]',
      '## Success Criteria（成功标准）',
      '- 优化后更易理解,且未新增要求',
    ].join('\n'),
  },
]

const byType = new Map(SCENARIOS.map((scenario) => [scenario.type, scenario]))

/** 组装一段机器可解析的「模拟模型输出」(标记协议)。 */
function buildOutput(scenario, overrides = {}) {
  const {
    explicitLines = [`- 编译用户要求 [quote: ${scenario.quote[0]}]`],
    contextLines = ['- (无)'],
    suggestedLines = scenario.suggested.map((item) => `- 建议(可忽略) ${item}`),
    unknownLines = scenario.missing.map((item) => `- [待补充: ${item}]`),
    body = scenario.body,
  } = overrides
  return [
    M.diagnosis,
    `目标清晰度:目标明确 | 类型:${scenario.type}`,
    M.explicit,
    ...explicitLines,
    M.context,
    ...contextLines,
    M.suggested,
    ...suggestedLines,
    M.unknown,
    ...unknownLines,
    M.optimized,
    body,
    M.end,
  ].join('\n')
}

function classifierFor(scenario, confidence = 0.86) {
  return {
    prompt_type: scenario.type,
    confidence_internal: confidence,
    missing_constraints: [...scenario.missing],
    rationale: `${scenario.type} 诉求`,
    evidence_quotes: [...scenario.quote],
  }
}

function missingFor(scenario) {
  return scenario.missing.map((label, index) => ({
    id: `mc-classifier-${index + 1}`,
    label,
  }))
}

function finalizeFor(scenario, rawOutput, opts = {}) {
  return finalizeCompile(defaultStrategyRegistry.get(scenario.type), rawOutput, {
    rawInput: scenario.raw,
    contextTurns: [],
    classifier: classifierFor(scenario),
    missing: missingFor(scenario),
    mode: 'full',
    ...opts,
  })
}

/** 七类型统一跑 compile(override) → finalize → validate 的完整链路。 */
function runPipeline(scenario, overrides = {}) {
  const plan = compilePrompt({
    raw_input: scenario.raw,
    promptType: scenario.type,
    registry: defaultStrategyRegistry,
  })
  const output = buildOutput(scenario, overrides)
  const outcome = finalizeFor(scenario, output)
  const report = validateCompileResult(outcome.result, {
    rawInput: scenario.raw,
    contextTurns: [],
    strategy: plan.strategy,
    rawOutput: output,
  })
  return { plan, output, outcome, report }
}

const CONTRACT_FIELDS = [
  'prompt_type',
  'confidence_level',
  'diagnosis',
  'explicit_requirements',
  'context_requirements',
  'suggested_requirements',
  'unknowns',
  'missing_constraints',
  'optimized_prompt',
  'strategy_version',
  'provenance_ok',
]

const errorsOf = (report) => report.problems.filter((problem) => problem.severity === 'error')
const rulesOf = (report) => report.problems.map((problem) => problem.rule)

// ─────────────────────────────────────────────────────────────────────────────
// i1. 契约矩阵前置审计:七类型 × required_sections 稳定
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.deepEqual(defaultStrategyRegistry.types().sort(), [...TYPES].sort(), '七类型必须全部注册')
  assert.equal(SCENARIOS.length, 7)
  assert.equal(new Set(SCENARIOS.map((scenario) => scenario.type)).size, 7, '矩阵不得重复类型')

  for (const scenario of SCENARIOS) {
    const strategy = defaultStrategyRegistry.get(scenario.type)
    assert.equal(strategy.type, scenario.type)
    assert.ok(strategy.required_sections.length >= 8, `${scenario.type} 必出段落数异常`)
    for (const section of strategy.required_sections) {
      assert.ok(
        scenario.body.includes(section),
        `${scenario.type} 场景优化稿缺少必出段落「${section}」`,
      )
    }
    assert.deepEqual(defaultStrategyRegistry.getSections(scenario.type), [
      ...strategy.required_sections,
    ])
    assert.match(strategy.version, /^\d+\.\d+\.\d+$/, `${scenario.type} 必须暴露独立版本`)
  }
  console.log('✓ i1 七类型契约矩阵前置审计(类型 / 段落 / 版本)')
}

// ─────────────────────────────────────────────────────────────────────────────
// i2. 七类型 × override 契约字段矩阵 + required_sections 满足 + provenance_ok=true
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const scenario of SCENARIOS) {
    const { plan, outcome, report } = runPipeline(scenario)

    // override 直达 registry:函数级旁路分类,不存在 classifier 调用。
    assert.equal(plan.overridden, true, `${scenario.type} override 必须被识别`)
    assert.equal(plan.classifier.prompt_type, scenario.type)
    assert.equal(plan.strategy.type, scenario.type)
    assert.equal(plan.result.prompt_type, scenario.type)
    assert.equal(plan.result.confidence_level, 'High')

    // 骨架:validate 之前绝不乐观置真。
    assert.equal(plan.result.provenance_ok, false, '骨架必须 provenance_ok=false')
    assert.equal(plan.result.optimized_prompt, '')
    assert.equal(plan.result.diagnosis, '')

    // 契约字段齐全且类型正确。
    for (const field of CONTRACT_FIELDS) {
      assert.ok(field in outcome.result, `${scenario.type} CompileResult 缺字段 ${field}`)
    }
    assert.ok(Array.isArray(outcome.result.explicit_requirements))
    assert.ok(Array.isArray(outcome.result.context_requirements))
    assert.ok(Array.isArray(outcome.result.suggested_requirements))
    assert.ok(Array.isArray(outcome.result.unknowns))
    assert.ok(Array.isArray(outcome.result.missing_constraints))
    assert.equal(typeof outcome.result.diagnosis, 'string')
    assert.ok(outcome.result.diagnosis.length > 0, '诊断段必须落地')
    assert.equal(outcome.result.strategy_version, plan.strategy.version)

    // 要求段:来源身份正确 + 逐字证据 + 可寻回。
    assert.equal(outcome.result.explicit_requirements.length, 1)
    assert.equal(outcome.result.explicit_requirements[0].source, 'USER_EXPLICIT')
    assert.deepEqual(outcome.result.explicit_requirements[0].evidence, [scenario.quote[0]])
    assert.equal(outcome.result.context_requirements.length, 0, '无上下文证据不得凭空生成记录')

    // suggested 独立成段、独立来源。
    assert.equal(outcome.result.suggested_requirements.length, scenario.suggested.length)
    assert.ok(
      outcome.result.suggested_requirements.every((record) => record.source === 'OPTIMIZER_SUGGESTED'),
    )
    for (const item of scenario.suggested) {
      assert.ok(
        !outcome.result.explicit_requirements.some((record) => record.text.includes(item)),
        '建议不得混入 explicit 来源组',
      )
    }

    // 缺口 → [待补充: …] 在交付稿中可定位。
    for (const label of scenario.missing) {
      assert.ok(
        outcome.result.missing_constraints.some((item) => item.label === label),
        `${scenario.type} 缺口 ${label} 必须进入 missing_constraints`,
      )
      assert.ok(
        outcome.result.optimized_prompt.includes(label),
        `${scenario.type} 缺口 ${label} 必须在交付稿中可见`,
      )
    }

    // 必出段落齐全 + 三层守卫全绿 + provenance_ok=true。
    for (const section of plan.strategy.required_sections) {
      assert.ok(
        outcome.result.optimized_prompt.includes(section),
        `${scenario.type} 交付稿缺段落「${section}」`,
      )
    }
    assert.equal(outcome.wellFormed, true, `${scenario.type} 协议解析必须 wellFormed`)
    assert.equal(outcome.result.provenance_ok, true, `${scenario.type} 应通过:${JSON.stringify(report.problems)}`)
    assert.deepEqual(errorsOf(report), [], `${scenario.type} 不得有 error 级问题`)
    assert.equal(report.provenance_ok, true)
    assert.equal(report.ok, true)
  }
  console.log('✓ i2 七类型 × override 契约字段矩阵 + required_sections + provenance_ok')
}

// ─────────────────────────────────────────────────────────────────────────────
// i3. 七类型 × AUTO 分类路径(策略一致、override 标志正确)
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const scenario of SCENARIOS) {
    const classifier = classifierFor(scenario)
    const plan = compilePrompt({
      raw_input: scenario.raw,
      classifier,
      registry: defaultStrategyRegistry,
    })
    assert.equal(plan.overridden, false, 'AUTO 路径不得标记 override')
    assert.equal(plan.classifier.prompt_type, scenario.type, 'AUTO 必须采用 classifier 的类型')
    assert.equal(plan.strategy.type, scenario.type)
    assert.equal(plan.result.prompt_type, scenario.type)

    const output = buildOutput(scenario)
    const outcome = finalizeFor(scenario, output)
    const report = validateCompileResult(outcome.result, {
      rawInput: scenario.raw,
      strategy: plan.strategy,
      rawOutput: output,
    })
    assert.equal(outcome.result.provenance_ok, true, `${scenario.type} AUTO 路径应通过`)
    assert.equal(report.provenance_ok, outcome.result.provenance_ok)
  }
  console.log('✓ i3 七类型 × AUTO 分类路径一致性')
}

// ─────────────────────────────────────────────────────────────────────────────
// i4. 置信度映射与 classifier 骨架一致
// ─────────────────────────────────────────────────────────────────────────────
{
  const scenario = byType.get('research')

  for (const [confidence, level] of [
    [0.86, 'High'],
    [0.8, 'High'],
    [0.79, 'Medium'],
    [0.6, 'Medium'],
    [0.59, 'Low'],
    [0.2, 'Low'],
  ]) {
    const plan = compilePrompt({
      raw_input: scenario.raw,
      classifier: classifierFor(scenario, confidence),
      registry: defaultStrategyRegistry,
    })
    assert.equal(plan.result.confidence_level, level)
    const outcome = finalizeFor(scenario, buildOutput(scenario), {
      classifier: classifierFor(scenario, confidence),
    })
    assert.equal(outcome.result.confidence_level, level, 'finalize 必须沿用同一映射')
  }
  console.log('✓ i4 置信度映射(High/Medium/Low)全链路一致')
}

// ─────────────────────────────────────────────────────────────────────────────
// i5. 缺口注入:classifier 缺口 + 协议未知段合并去重,且不重复注入
// ─────────────────────────────────────────────────────────────────────────────
{
  const scenario = byType.get('research')
  const output = buildOutput(scenario, {
    unknownLines: ['- [待补充: 协议内缺口]'],
  })
  const outcome = finalizeFor(scenario, output)
  const labels = outcome.result.missing_constraints.map((item) => item.label)
  assert.deepEqual(labels, [...scenario.missing, '协议内缺口'], '缺口必须按出现顺序合并')
  assert.equal(new Set(labels).size, labels.length, '缺口不得重复')
  assert.ok(outcome.result.optimized_prompt.includes(scenario.missing[0]))
  assert.ok(outcome.result.optimized_prompt.includes('协议内缺口'))
  assert.equal(outcome.result.provenance_ok, true)
  assert.equal(
    rulesOf(validateCompileResult(outcome.result, { rawInput: scenario.raw })).includes(
      'VALIDATION_UNKNOWN_NOT_MARKED',
    ),
    false,
  )

  // 场景 body 不含缺口 → 编译期机械追加,不发明、不改写既有内容。
  const absent = byType.get('planning')
  const noGapBody = absent.body.replace(`[待补充: ${absent.missing[0]}]`, '待确认')
  const outcome2 = finalizeFor(absent, buildOutput(absent, { body: noGapBody, unknownLines: [] }))
  assert.ok(
    outcome2.result.optimized_prompt.includes(`[待补充: ${absent.missing[0]}]`),
    '未在优化稿出现的缺口必须被机械注入',
  )
  assert.match(outcome2.result.optimized_prompt, /## 待补充（编译期自动补录）/)
  assert.ok(outcome2.result.optimized_prompt.includes(noGapBody), '注入不得改写既有正文')
  console.log('✓ i5 缺口注入:合并去重 + 机械补录')
}

// ─────────────────────────────────────────────────────────────────────────────
// i6. 失败注入:compiler 流中断 / 协议缺失 → 降级 + provenance_ok=false
// ─────────────────────────────────────────────────────────────────────────────
{
  const scenario = byType.get('research')
  const classifier = classifierFor(scenario)

  // 6a. 流中断(空输出):协议降级,不得伪造 provenance;缺口仍机械补录(不发明信息)。
  const empty = finalizeFor(scenario, '')
  assert.equal(empty.wellFormed, false)
  assert.deepEqual(empty.result.explicit_requirements, [])
  assert.deepEqual(empty.result.suggested_requirements, [])
  assert.equal(empty.result.provenance_ok, false, '空输出必须 provenance_ok=false')
  assert.ok(
    empty.result.optimized_prompt.includes(`[待补充: ${scenario.missing[0]}]`),
    '空输出时缺口仍须对用户可见',
  )
  assert.ok(
    empty.result.optimized_prompt.includes(scenario.missing[0]),
    '补录只允许包含缺口文本,不得伪造优化稿正文',
  )

  // 6b. 有 OPTIMIZED 锚点但三段来源缺失:保留优化稿,来源组为空。
  const partial = finalizeFor(scenario, [M.optimized, scenario.body, M.end].join('\n'))
  assert.equal(partial.wellFormed, true)
  assert.equal(partial.result.explicit_requirements.length, 0)
  assert.equal(partial.result.suggested_requirements.length, 0)
  assert.ok(partial.result.optimized_prompt.includes('Research Goal'))
  assert.equal(
    partial.result.provenance_ok,
    true,
    '缺少来源段不等于伪造;缺口注入后不产生 error',
  )

  // 6c. 中断前只吐了一半(无 END):仍可解析,但错误必须由 validate 兜住。
  const clipped = finalizeFor(scenario, buildOutput(scenario).replace(new RegExp(`\\n?${M.end}`), ''))
  assert.equal(clipped.result.provenance_ok, true, '缺 END 本身不改变 provenance 语义')
  assert.ok(clipped.result.optimized_prompt.includes('Research Goal'))

  // 6d. 非协议纯文本(模型完全跑偏):整段降级,来源组为空,validate 必须 false。
  const garbage = finalizeFor(scenario, '抱歉,我无法完成这个请求。')
  assert.equal(garbage.wellFormed, false)
  assert.equal(garbage.result.provenance_ok, false)
  assert.equal(
    rulesOf(
      validateCompileResult(garbage.result, {
        rawInput: scenario.raw,
        strategy: defaultStrategyRegistry.get('research'),
      }),
    ).includes('VALIDATION_REQUIRED_SECTION_MISSING'),
    true,
    '降级输出必须由 required_sections 守卫兜住',
  )

  void classifier
  console.log('✓ i6 失败注入:空输出 / 缺来源段 / 截断 / 跑偏均不伪造 provenance')
}

// ─────────────────────────────────────────────────────────────────────────────
// i7. 失败注入:伪证据 / 建议升级 / 无证据量化 → error 数据可定位
// ─────────────────────────────────────────────────────────────────────────────
{
  const scenario = byType.get('research')

  // 7a. 伪造 quote(不在 raw 中)→ provenance error。
  const forged = runPipeline(scenario, {
    explicitLines: ['- 研究不存在的方向 [quote: 这句根本不在输入里]'],
  })
  assert.equal(forged.outcome.result.provenance_ok, false)
  assert.equal(forged.report.provenance_ok, false)
  assert.ok(
    forged.report.problems.some((problem) => /EVIDENCE/.test(problem.rule)),
    '伪造 quote 必须命中证据规则',
  )

  // 7b. 建议被写成明确要求 → invariant B error。
  const upgraded = runPipeline(scenario, {
    explicitLines: [`- ${scenario.suggested[0]} [quote: ${scenario.quote[0]}]`],
  })
  assert.equal(upgraded.outcome.result.provenance_ok, false)
  assert.ok(
    rulesOf(upgraded.report).some((rule) => rule === 'VALIDATION_SUGGESTED_IN_REQUIREMENTS'),
    '建议混入 explicit 必须命中 suggestedInRequirements',
  )

  // 7c. 无证据强断言 + 无证据量化。
  const inventedBody = `${scenario.body}\n## Constraints（约束）\n- 预算 5000 元,预计耗时 2 小时`
  const invented = runPipeline(scenario, { body: inventedBody })
  assert.equal(invented.outcome.result.provenance_ok, false)
  assert.ok(
    rulesOf(invented.report).includes('VALIDATION_UNEVIDENCED_QUANTIFICATION'),
    '无证据量化必须命中 unevidencedQuantification',
  )

  const strong = runPipeline(scenario, {
    body: `${scenario.body}\n## Candidate Approaches（候选方案）\n- H3 最终确定,直接淘汰`,
  })
  assert.equal(strong.outcome.result.provenance_ok, false)
  assert.ok(
    rulesOf(strong.report).includes('VALIDATION_UNPROVEN_STRONG_CLAIM'),
    '无证据强断言必须命中 unprovenStrongClaim',
  )

  // 7d. 每条 error 都带可定位数据(rule + detail + severity)。
  for (const problem of errorsOf(strong.report)) {
    assert.equal(typeof problem.rule, 'string')
    assert.ok(problem.rule.length > 0)
    assert.equal(typeof problem.detail, 'string')
    assert.ok(problem.detail.length > 0)
  }
  console.log('✓ i7 伪证据 / 建议升级 / 无证据量化与强断言 → error 可定位')
}

// ─────────────────────────────────────────────────────────────────────────────
// i8. 协议解析容错回归:markdown 回退 / `(无)` / 重复标记 / think 块
// ─────────────────────────────────────────────────────────────────────────────
{
  const scenario = byType.get('planning')

  // 8a. markdown 四段回退(策略原始 formatNote 写法)。
  const markdown = [
    '## 明确要求',
    `- 规划 P04-T01 的实现步骤 [quote: ${scenario.quote[0]}]`,
    '## 上下文已确认',
    '- (无)',
    '## 优化器建议（可忽略）',
    '- 建议(可忽略) 补充回滚演练',
    '## 待补充',
    '- [待补充: 交付时间]',
    '## 优化后的 Prompt',
    scenario.body,
  ].join('\n')
  const parsedMd = parseCompileOutput(markdown)
  assert.equal(parsedMd.wellFormed, true)
  assert.equal(parsedMd.explicit_requirements.length, 1)
  assert.equal(parsedMd.suggested_requirements.length, 1)
  assert.deepEqual(parsedMd.missing_constraints.map((item) => item.label), ['交付时间'])
  assert.ok(parsedMd.optimized_prompt.includes('Acceptance Criteria'))
  const mdOutcome = finalizeFor(scenario, markdown)
  assert.equal(mdOutcome.result.provenance_ok, true, 'markdown 回退路径同样必须通过')

  // 8b. `(无)` / 空行 / 项目符号容错。
  const noneOutput = [
    M.explicit,
    '- (无)',
    M.context,
    '* (无)',
    M.suggested,
    '- (无)',
    M.unknown,
    '- (无)',
    M.optimized,
    scenario.body,
    M.end,
  ].join('\n')
  const parsedNone = parseCompileOutput(noneOutput)
  assert.deepEqual(parsedNone.explicit_requirements, [])
  assert.deepEqual(parsedNone.context_requirements, [])
  assert.deepEqual(parsedNone.suggested_requirements, [])
  assert.deepEqual(parsedNone.unknowns, [])
  assert.deepEqual(parsedNone.missing_constraints, [])

  // 8c. 推理模型复述标记 → 取最后一次出现。
  const repeated = [
    M.explicit,
    '- 讨论中的旧要求(应被丢弃)',
    M.optimized,
    '（思考中复述的旧稿,应被丢弃）',
    M.explicit,
    `- 规划 P04-T01 的实现步骤 [quote: ${scenario.quote[0]}]`,
    M.optimized,
    scenario.body,
    M.end,
  ].join('\n')
  const parsedRepeat = parseCompileOutput(repeated)
  assert.equal(parsedRepeat.explicit_requirements.length, 1, '重复标记必须取最后一次')
  assert.ok(!parsedRepeat.optimized_prompt.includes('应被丢弃'))
  assert.ok(parsedRepeat.optimized_prompt.includes('Acceptance Criteria'))

  // 8d. think 块必须被剥离,不进入优化稿。
  const withThink = `<think>先规划一下</think>\n${buildOutput(scenario)}`
  const parsedThink = parseCompileOutput(withThink)
  assert.equal(parsedThink.wellFormed, true)
  assert.ok(!parsedThink.optimized_prompt.includes('先规划一下'))
  console.log('✓ i8 协议解析容错回归(markdown / (无) / 重复标记 / think)')
}

// ─────────────────────────────────────────────────────────────────────────────
// i9. provenance_ok 全类型联动:finalizeCompile ↔ validateCompileResult
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const scenario of SCENARIOS) {
    const strategy = defaultStrategyRegistry.get(scenario.type)

    const goodOutput = buildOutput(scenario)
    const good = finalizeFor(scenario, goodOutput)
    const goodReport = validateCompileResult(good.result, {
      rawInput: scenario.raw,
      strategy,
      rawOutput: goodOutput,
    })
    assert.equal(good.result.provenance_ok, goodReport.provenance_ok, `${scenario.type} 通过侧必须一致`)
    assert.equal(good.problems.some((problem) => problem.severity === 'error'), false)
    assert.deepEqual(
      goodReport.problems.map((problem) => problem.rule).sort(),
      good.problems.map((problem) => problem.rule).sort(),
      `${scenario.type} 两侧问题集必须一致`,
    )

    const badOutput = buildOutput(scenario, {
      explicitLines: ['- 伪造要求 [quote: 这段文字不存在于任何用户输入]'],
    })
    const bad = finalizeFor(scenario, badOutput)
    const badReport = validateCompileResult(bad.result, {
      rawInput: scenario.raw,
      strategy,
      rawOutput: badOutput,
    })
    assert.equal(bad.result.provenance_ok, false, `${scenario.type} 伪造证据必须 false`)
    assert.equal(badReport.provenance_ok, false)
    assert.equal(bad.result.provenance_ok, badReport.provenance_ok, `${scenario.type} 失败侧必须一致`)
  }
  console.log('✓ i9 provenance_ok 全类型联动(finalize ↔ validate)')
}

// ─────────────────────────────────────────────────────────────────────────────
// i10. legacy general 零回归(不接四段协议)
// ─────────────────────────────────────────────────────────────────────────────
{
  const scenario = byType.get('general')
  const plan = compilePrompt({
    raw_input: scenario.raw,
    promptType: 'general',
    legacy: true,
    registry: defaultStrategyRegistry,
  })
  assert.equal(plan.legacy, true)
  assert.equal(plan.system.includes(M.diagnosis), false, 'legacy 不接新协议')

  const legacyOutput = [
    'ANALYSIS:',
    '目标明确,约束清晰',
    'OPTIMIZED:',
    '## Role（角色）',
    '- 你是提示词编辑',
  ].join('\n')
  const outcome = finalizeCompile(plan.strategy, legacyOutput, {
    rawInput: scenario.raw,
    contextTurns: [],
    classifier: classifierFor(scenario),
    missing: missingFor(scenario),
    mode: 'full',
    legacy: true,
  })
  assert.equal(outcome.result.provenance_ok, true, 'legacy 保持既有语义')
  assert.deepEqual(outcome.problems, [])
  assert.deepEqual(outcome.result.explicit_requirements, [])
  assert.deepEqual(outcome.result.suggested_requirements, [])
  assert.ok(outcome.result.optimized_prompt.includes('你是提示词编辑'))
  console.log('✓ i10 legacy general 零回归')
}

// ─────────────────────────────────────────────────────────────────────────────
// i11. 纯函数纪律:可复现、零 ctx.llm / Harness / React / DOM 依赖
// ─────────────────────────────────────────────────────────────────────────────
{
  const scenario = byType.get('diagnostic')
  // provenance 记录的 id 是模块内递增序号(全局唯一,便于审计),不参与「同输入可复现」判定。
  const stripIds = (value) =>
    JSON.parse(JSON.stringify(value, (key, item) => (key === 'id' ? undefined : item)))
  const first = runPipeline(scenario)
  const second = runPipeline(scenario)
  assert.deepEqual(stripIds(first.outcome.result), stripIds(second.outcome.result), '同输入必须可复现')
  assert.deepEqual(first.report.problems, second.report.problems)

  const source = readFileSync(new URL('../src/core/compiler.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/ctx\.llm/.test(code), 'compiler.ts 不得依赖 ctx.llm')
  assert.ok(!/@deepseek-ai\//.test(code), 'compiler.ts 不得依赖 Harness 包')
  assert.ok(!/\bfrom\s+['"]react/.test(code), 'compiler.ts 不得依赖 React')
  assert.ok(!/document\.|window\./.test(code), 'compiler.ts 不得依赖 DOM')

  // 集成测试自身不得引入网络 / 随机来源。
  const self = readFileSync(new URL('./compiler-integration.test.mjs', import.meta.url), 'utf8')
  assert.ok(!/Math\.random\(/.test(self), '测试不得依赖随机数')
  assert.ok(!/fetch\(|https?:\/\//.test(self.replace(/^\/\*\*[\s\S]*?\*\//, '')), '测试不得发起网络请求')
  console.log('✓ i11 纯函数纪律:可复现 / 零 Host·UI·LLM 依赖')
}

// ─────────────────────────────────────────────────────────────────────────────
// i12. S-07 复审:provenance 机制在七类型上有效防止「误标为已确认」
// ─────────────────────────────────────────────────────────────────────────────
{
  const findings = []

  for (const scenario of SCENARIOS) {
    const strategy = defaultStrategyRegistry.get(scenario.type)

    // 注入 1:伪造 quote(把优化器推断伪装成用户原话)。
    const forged = runPipeline(scenario, {
      explicitLines: [`- 优化器推断的要求 [quote: 用户从未说过这句话]`],
    })
    const forgedBlocked = forged.report.problems.some(
      (problem) => problem.severity === 'error' && /EVIDENCE/.test(problem.rule),
    )
    assert.equal(forgedBlocked, true, `${scenario.type}:伪造 quote 必须被拦截`)

    // 注入 2:建议 → 明确要求(来源身份混淆)。
    const mixed = runPipeline(scenario, {
      explicitLines: [`- ${scenario.suggested[0]} [quote: ${scenario.quote[0]}]`],
    })
    const mixedBlocked = rulesOf(mixed.report).includes('VALIDATION_SUGGESTED_IN_REQUIREMENTS')
    assert.equal(mixedBlocked, true, `${scenario.type}:建议升级必须被拦截`)

    // 注入 3:用户未给出的量化硬约束(凭空发明)。
    const invented = runPipeline(scenario, {
      body: `${scenario.body}\n## Constraints（约束）\n- 预算 1999 元`,
    })
    const inventedBlocked = rulesOf(invented.report).includes('VALIDATION_UNEVIDENCED_QUANTIFICATION')
    assert.equal(inventedBlocked, true, `${scenario.type}:无证据量化必须被拦截`)

    findings.push({
      type: scenario.type,
      forgedQuoteBlocked: forgedBlocked,
      suggestionUpgradeBlocked: mixedBlocked,
      inventedQuantificationBlocked: inventedBlocked,
      strategyGuards: strategy.guards.length,
    })
  }

  assert.equal(findings.length, 7)
  assert.ok(
    findings.every(
      (item) =>
        item.forgedQuoteBlocked && item.suggestionUpgradeBlocked && item.inventedQuantificationBlocked,
    ),
    'S-07:七类型三类误标注入必须全部被机械拦截',
  )
  // 复审记录(证据留痕:供 P04-T03 验收与 P07 回归引用)。
  console.log(`S-07 recheck: ${findings.length}/7 strategy types x 3 injection classes blocked`, JSON.stringify(findings))
  console.log('✓ i12 S-07 复审:provenance 机制有效防止误标(伪证据 / 建议升级 / 凭空量化)')
}

// ─────────────────────────────────────────────────────────────────────────────
// i13. 交付稿四组来源互斥 + 无交叉污染
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const scenario of SCENARIOS) {
    const { outcome } = runPipeline(scenario)
    const groups = {
      explicit: outcome.result.explicit_requirements,
      context: outcome.result.context_requirements,
      suggested: outcome.result.suggested_requirements,
      unknown: outcome.result.unknowns,
    }
    const seen = new Set()
    for (const [name, records] of Object.entries(groups)) {
      for (const record of records) {
        const key = `${name}:${record.text}`
        assert.ok(!seen.has(key), `${scenario.type} 同一记录不得跨组重复`)
        seen.add(key)
      }
    }
    assert.ok(
      groups.explicit.every((record) => record.source === 'USER_EXPLICIT'),
      'explicit 组来源必须纯净',
    )
    assert.ok(
      groups.suggested.every((record) => record.source === 'OPTIMIZER_SUGGESTED'),
      'suggested 组来源必须纯净',
    )
    const suggestedTexts = groups.suggested.map((record) => record.text)
    for (const text of suggestedTexts) {
      assert.ok(
        !groups.explicit.some((record) => record.text.includes(text)),
        '建议文本不得出现在 explicit 组',
      )
    }
  }
  console.log('✓ i13 四组来源互斥 / 无交叉污染')
}

console.log('\ncompiler-integration: all passed')
