/**
 * v2 Phase 2 —— 验收用例 C / D / E(+ A)端到端契约测试。
 *
 * 用例(v2 §C14 / PLAN §2 Phase 2):
 *   A. 「ComfyUI 控制 DSH」        → Agent 目标 → Agent 任务指令契约
 *   C. 图像提示词                  → 描述式图像契约,正文无 Goal/Phase/Task/Tests
 *   D. 视频提示词                  → 描述式视频契约,同上
 *   E. 乱但完整                    → RESTRUCTURE(只重组)+ 责任清单照常交代
 * 另加:可自查项按处置分派(动作式 / 条件式),**永不** [待补充:]。
 *
 * 运行:先 `npm run build`,再 `node test/phase2-fixtures.test.mjs`。
 */
import assert from 'node:assert/strict'
import { compilePrompt, finalizeCompile, COMPILE_MARKERS as M } from '../lib/core/compiler.js'
import { defaultStrategyRegistry } from '../lib/core/registry.js'
import { parseAnalysisResult } from '../lib/core/analyze.js'
import { routeStrategy } from '../lib/core/router.js'
import { decideTriage } from '../lib/core/triage.js'
import { FORBIDDEN_TEMPLATE_HEADINGS } from '../lib/core/strategies/_visual-shared.js'
import { RETIRED_PLACEHOLDER_RE } from '../lib/core/responsibilities.js'
import { validateCompileResult } from '../lib/core/validate.js'

const turn = (role, text) => ({ role, text })

/** 用分析 JSON 走一遍真实解析(而不是手搓 AnalysisResult),确保契约端点一致。 */
function analyze(json, rawInput, contextTurns = []) {
  const { result } = parseAnalysisResult(JSON.stringify(json), { rawInput, contextTurns })
  assert.ok(result, '分析必须解析成功')
  return result
}

// ── 用例 C:图像提示词 ──────────────────────────────────────────────────────
const IMAGE_RAW = '帮我画一张赛博朋克风格的城市夜景海报,雨夜,霓虹灯,竖版'
const IMAGE_ANALYSIS = {
  primary_intent: 'execution',
  supporting_intents: [],
  work_mode: 'one_shot',
  target: 'image_generation',
  target_engine: 'Midjourney',
  edit_triage: 'PATCH',
  unknowns: [
    { text: '当前可用的出图链路与依赖版本', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '执行方自查' },
    { text: '现有实现的路径', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '自然获得' },
  ],
  requirements: [{ text: '画赛博朋克城市夜景海报', quote: '赛博朋克风格的城市夜景海报' }],
  suggestions: ['可补充画幅比例与排除项'],
  confidence_internal: 0.9,
  rationale: '用户要出图',
  evidence_quotes: ['赛博朋克风格的城市夜景海报', '雨夜'],
}

// ── 用例 D:视频提示词 ──────────────────────────────────────────────────────
const VIDEO_RAW = '生成一段 8 秒的视频:镜头从雨夜街道推近到一个撑着伞的人,电影感'
const VIDEO_ANALYSIS = {
  primary_intent: 'execution',
  supporting_intents: ['creative'],
  work_mode: 'one_shot',
  target: 'video_generation',
  target_engine: '可灵',
  edit_triage: 'PATCH',
  unknowns: [
    // RC2:reuse_vs_create 属于高影响用户决策(必须问用户)→ 这里换成
    // 「纯可读事实 + 分支语义」来验证条件式分支渲染。
    { text: '现有分镜模板是否存在', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '决定是否新建' },
    { text: '画幅与帧率', classification: 'USER_REQUIRED', blocking: false, rationale: '有默认值' },
  ],
  requirements: [{ text: '雨夜推镜到撑伞的人', quote: '镜头从雨夜街道推近到一个撑着伞的人' }],
  suggestions: ['可补充运镜速度'],
  confidence_internal: 0.88,
  rationale: '用户要生成视频',
  evidence_quotes: ['雨夜街道推近到一个撑着伞的人'],
}

// ── 用例 A:ComfyUI 控制 DSH(Agent 目标)──────────────────────────────────
const AGENT_RAW = '帮我做一件事:让 ComfyUI 通过 DSH 自动把工作流跑起来并汇报结果'
const AGENT_ANALYSIS = {
  primary_intent: 'execution',
  supporting_intents: ['planning'],
  work_mode: 'governed',
  target: 'agent_task',
  target_engine: 'DSH',
  edit_triage: 'PATCH',
  unknowns: [
    { text: '当前 DSH 的可用接口签名', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '执行方自查' },
  ],
  requirements: [{ text: '让 ComfyUI 通过 DSH 跑工作流', quote: 'ComfyUI 通过 DSH 自动把工作流跑起来' }],
  suggestions: ['建议明确不可逆动作的确认点'],
  confidence_internal: 0.85,
  rationale: '交给 Agent 执行的任务',
  evidence_quotes: ['ComfyUI 通过 DSH 自动把工作流跑起来'],
}

// ── 用例 E:乱但完整 ────────────────────────────────────────────────────────
const MESSY_RAW =
  '帮我把这个模块重构一下,要求是接口签名不变,接口签名不变,输出格式要给出问题清单和改动后的代码,输出格式要给出问题清单和改动后的代码,别动数据库迁移,别动数据库迁移,记得加测试,记得加测试,验收就是现有测试全绿,验收就是现有测试全绿,别的你看着办,别的你看着办。'

/** 视觉合约:描述式正文(无任务模板标题)。 */
const IMAGE_BODY = [
  '## Subject（主体）',
  '- 一个人在雨夜的霓虹街道上,撑着伞,半身入画',
  '## Scene（场景与环境）',
  '- 赛博朋克城市夜景,湿漉漉的柏油路,反射霓虹招牌',
  '## Style（风格）',
  '- 赛博朋克插画风,高饱和霓虹,轻微颗粒感',
  '## Composition（构图与镜头）',
  '- 竖版构图,低机位仰拍,街道纵深向画面深处收束',
  '## Lighting & Color（光线与色调）',
  '- 冷青主调 + 品红霓虹点缀,强对比,体积光',
  '## Aspect Ratio（画幅与画质）',
  '- 9:16 竖版,高清细节',
  '## Negative（排除项）',
  '- 不要文字水印,不要白天光线',
].join('\n')

const VIDEO_BODY = [
  '## Shot（镜头）',
  '- 中景起,稳定器缓慢推近到近景',
  '## Action & Timing（动作与时间演进）',
  '- 0-3s 雨夜街道全景;3-6s 推近到撑伞的人;6-8s 停留并轻微上摇',
  '## Scene & Mood（场景与氛围）',
  '- 雨夜街道,霓虹反光,孤独而安静',
  '## Style & Quality（风格与画质）',
  '- 电影感,浅景深,胶片颗粒',
  '## Duration & Format（时长与格式）',
  '- 8 秒,16:9,24fps',
  '## Negative（排除项）',
  '- 不要快速跳切,不要字幕',
].join('\n')

const AGENT_BODY = [
  '## Objective & Definition of Done（目标与完成定义）',
  '- 让 ComfyUI 经 DSH 自动跑通工作流并回报结果;完成定义 = 工作流产出可访问的结果文件并附日志',
  '## Scope & Boundaries（边界）',
  '- 只允许修改工作流配置;不得修改 DSH 源码',
  '## Tools & Permissions（工具与权限）',
  '- 可用 ComfyUI API 与 DSH CLI',
  '## Context & Inputs（上下文与输入）',
  '- 目标工作流与本机环境',
  '## Verification（验收方式）',
  '- 复现命令 + 输出核对清单',
  '## Stop Conditions（停止条件）',
  '- 需要不可逆操作时停下并确认',
].join('\n')

function buildOutput(body, unknownLines = [], quote = '') {
  return [
    M.diagnosis,
    '目标清晰度:目标明确 | 约束边界:已标注',
    M.explicit,
    quote ? `- 用户目标:已按原话保留 [quote: ${quote}]` : '- (无)',
    M.context,
    '- (无)',
    M.suggested,
    '- 建议(可忽略) 补充输出格式',
    M.unknown,
    ...(unknownLines.length ? unknownLines : ['- (无)']),
    M.optimized,
    body,
    M.end,
  ].join('\n')
}

/** 跑完整契约:分析 → 路由 → 编译 → 收尾 → 校验。 */
function runContract(name, analysisJson, rawInput, body, unknownLines = [], quote = '') {
  const analysis = analyze(analysisJson, rawInput)
  const decision = routeStrategy(analysis)
  const plan = compilePrompt({
    raw_input: rawInput,
    analysis,
    classifier: {
      prompt_type: analysis.prompt_type,
      confidence_internal: analysis.confidence_internal,
      missing_constraints: analysis.missing_constraints,
      rationale: analysis.rationale,
      evidence_quotes: analysis.evidence_quotes,
    },
  })
  assert.equal(plan.strategy.type, decision.strategy.type, `${name}:compilePrompt 必须采用同一条路由`)
  assert.ok(plan.route, `${name}:compilePlan 必须带路由裁决`)

  const raw = buildOutput(body, unknownLines, quote)
  const outcome = finalizeCompile(plan.strategy, raw, {
    rawInput,
    contextTurns: [],
    classifier: plan.classifier,
    missing: plan.vars.missing_constraints,
    mode: 'full',
    language: 'zh',
    analysis,
  })
  const report = validateCompileResult(outcome.result, {
    rawInput,
    contextTurns: [],
    strategy: plan.strategy,
    rawOutput: raw,
  })
  return { analysis, decision, plan, outcome, report }
}

// C. 图像提示词:描述式契约 + 正文无任务模板标题 + 零占位符
{
  const { decision, plan, outcome, report } = runContract(
    'C',
    IMAGE_ANALYSIS,
    IMAGE_RAW,
    IMAGE_BODY,
    ['- 当前可用的出图链路与依赖版本'],
    '赛博朋克风格的城市夜景海报',
  )
  assert.equal(decision.basis, 'visual-target')
  assert.equal(plan.strategy.type, 'image')
  assert.equal(outcome.result.contract, 'image', 'CompileResult.contract 必须记录图像契约')
  assert.equal(outcome.result.prompt_type, 'execution', 'prompt_type 仍表达工作意图')

  // 正文不得出现任务模板标题(机械扫描)
  for (const heading of FORBIDDEN_TEMPLATE_HEADINGS) {
    assert.doesNotMatch(
      outcome.result.optimized_prompt,
      new RegExp(`(?:^|\\n)\\s*#{0,6}\\s*\\**${heading}\\b`, 'i'),
      `C:图像成品不得出现「${heading}」`,
    )
  }
  assert.ok(outcome.result.optimized_prompt.includes('Subject'), 'C:必须交代主体责任')
  assert.ok(outcome.result.optimized_prompt.includes('Negative'), 'C:必须交代排除项责任')
  assert.equal(RETIRED_PLACEHOLDER_RE.test(outcome.result.optimized_prompt), false, 'C:零占位符')
  assert.ok(
    outcome.result.optimized_prompt.includes('动手前先确认:当前可用的出图链路与依赖版本'),
    'C:可自查项必须落成动作式执行责任',
  )
  assert.equal(
    outcome.result.optimized_prompt.includes('现有实现的路径'),
    false,
    'C:自然获得的纯定位项必须省略',
  )
  assert.deepEqual(report.problems.filter((p) => p.severity === 'error'), [], 'C:不得有 error 级问题')
  console.log('✓ C 图像提示词:描述式契约,无 Goal/Phase/Task/Tests,零占位符')
}

// D. 视频提示词:描述式契约 + 条件式分支
{
  const { decision, outcome, report } = runContract(
    'D',
    VIDEO_ANALYSIS,
    VIDEO_RAW,
    VIDEO_BODY,
    // RC2:「是否已有可复用的分镜模板」属于 reuse_vs_create 高影响决策(必须问用户),
    // 因此这里改用**纯可读事实 + 分支语义**的文本来验证「条件式分支」渲染。
    ['- 现有分镜模板是否存在'],
    '镜头从雨夜街道推近到一个撑着伞的人',
  )
  assert.equal(decision.strategy.type, 'video')
  assert.equal(outcome.result.contract, 'video')
  assert.equal(outcome.result.prompt_type, 'execution')
  for (const heading of FORBIDDEN_TEMPLATE_HEADINGS) {
    assert.doesNotMatch(
      outcome.result.optimized_prompt,
      new RegExp(`(?:^|\\n)\\s*#{0,6}\\s*\\**${heading}\\b`, 'i'),
      `D:视频成品不得出现「${heading}」`,
    )
  }
  assert.ok(outcome.result.optimized_prompt.includes('Shot'), 'D:必须交代镜头责任')
  assert.ok(outcome.result.optimized_prompt.includes('Action & Timing'), 'D:必须交代动作时序责任')
  assert.equal(RETIRED_PLACEHOLDER_RE.test(outcome.result.optimized_prompt), false, 'D:零占位符')
  assert.ok(
    outcome.result.optimized_prompt.includes('存在则优先复用'),
    'D:决定分支的可自查项必须落成条件式指令',

  )
  // 非阻塞的用户决定项不得进正文
  assert.equal(outcome.result.optimized_prompt.includes('画幅与帧率'), false, 'D:用户决定项不注入正文')
  assert.equal(report.problems.filter((p) => p.severity === 'error').length, 0)
  console.log('✓ D 视频提示词:描述式契约 + 条件式分支,零占位符')
}

// A. ComfyUI 控制 DSH → Agent 任务指令契约
{
  const { decision, outcome } = runContract(
    'A',
    AGENT_ANALYSIS,
    AGENT_RAW,
    AGENT_BODY,
    ['- 当前 DSH 的可用接口签名'],
    'ComfyUI 通过 DSH 自动把工作流跑起来',
  )
  assert.equal(decision.basis, 'agent-target')
  assert.equal(outcome.result.contract, 'agent')
  assert.ok(outcome.result.optimized_prompt.includes('Objective & Definition of Done'))
  assert.ok(outcome.result.optimized_prompt.includes('Stop Conditions'), 'A:必须给出停止条件')
  assert.ok(
    outcome.result.optimized_prompt.includes('动手前先确认:当前 DSH 的可用接口签名'),
    'A:接口签名属行动前调查项 → 动作式',
  )
  console.log('✓ A ComfyUI→DSH:Agent 任务指令契约(目标/边界/权限/验收/停止条件)')
}

// E. 乱但完整 → RESTRUCTURE(只重组,不新增语义)
{
  const triage = decideTriage({ raw_input: MESSY_RAW })
  assert.equal(triage.triage, 'RESTRUCTURE', `E:必须判 RESTRUCTURE,实为 ${triage.triage}`)
  assert.ok(triage.reasons.length > 0)

  // 即使分诊是 RESTRUCTURE,处置契约照常生效(与分诊正交)
  const analysis = analyze(
    {
      primary_intent: 'execution',
      supporting_intents: ['review'],
      work_mode: 'one_shot',
      target: 'coding',
      edit_triage: 'RESTRUCTURE',
      unknowns: [
        { text: '当前依赖版本与可用接口', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '行动前须查' },
        { text: '现有实现的路径', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '自然获得' },
      ],
      requirements: [{ text: '接口签名不变', quote: '接口签名不变' }],
      suggestions: [],
      confidence_internal: 0.9,
      rationale: '信息齐但组织混乱',
      evidence_quotes: ['接口签名不变'],
    },
    MESSY_RAW,
  )
  const decision = routeStrategy(analysis)
  assert.equal(decision.strategy.type, 'execution', 'E:意图是执行 → 执行策略')
  assert.equal(decision.contract, 'structured')

  const plan = compilePrompt({ raw_input: MESSY_RAW, analysis })
  const outcome = finalizeCompile(
    plan.strategy,
    buildOutput('## Current Task（当前任务）\n- 重构模块,接口签名不变\n## Allowed Scope（允许范围）\n- 仅限该模块\n## Forbidden Scope（禁止范围）\n- 不得改数据库迁移\n## Output Format（输出格式）\n- 问题清单 + 改动后代码\n## Acceptance Criteria（验收标准）\n- 现有测试全绿'),
    {
      rawInput: MESSY_RAW,
      contextTurns: [],
      classifier: plan.classifier,
      missing: plan.vars.missing_constraints,
      mode: 'full',
      language: 'zh',
      analysis,
    },
  )
  assert.ok(
    outcome.result.optimized_prompt.includes('动手前先确认:当前依赖版本与可用接口'),
    'E:可自查项按处置注入(与分诊级别无关)',
  )
  assert.equal(
    outcome.result.optimized_prompt.includes('现有实现的路径'),
    false,
    'E:自然获得项省略',
  )
  assert.equal(RETIRED_PLACEHOLDER_RE.test(outcome.result.optimized_prompt), false, 'E:零占位符')
  console.log('✓ E 乱但完整:判 RESTRUCTURE(只重组),处置契约照常生效')
}

// 交叉:三个目标契约都不得污染意图注册表 / 互不串用
{
  assert.equal(defaultStrategyRegistry.get('image').type, 'general', '意图注册表未知类型回落 general')
  assert.equal(defaultStrategyRegistry.get('video').type, 'general')
  assert.equal(defaultStrategyRegistry.get('agent').type, 'general')
  console.log('✓ cross:目标契约不污染意图注册表(未知类型回落 general)')
}

console.log('phase2-fixtures.test.mjs: ALL PASS')
