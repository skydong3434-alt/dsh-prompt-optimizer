/**
 * v2 Phase 2 —— Target-aware Router + 目标编译契约单测。
 *
 * 覆盖:
 *   · 路由优先级:手动覆盖 > 视觉目标 > Agent 目标 > 意图 > 兜底;
 *   · 视觉契约:图像 / 视频责任清单**不含** Goal/Phase/Task/Tests,守卫机械拒绝模板标题;
 *   · 目标契约注册表与意图注册表分离(不污染分类器闭集);
 *   · 与 TARGET_CATALOG 的一致性(目标目录是单一真源)。
 *
 * 运行:先 `npm run build`,再 `node test/router.test.mjs`。
 */
import assert from 'node:assert/strict'
import { routeStrategy, isVisualContract } from '../lib/core/router.js'
import {
  defaultStrategyRegistry,
  targetContractRegistry,
  TARGET_CONTRACT_STRATEGIES,
  allStrategies,
  agentStrategy,
  imageStrategy,
  videoStrategy,
} from '../lib/core/registry.js'
import {
  FORBIDDEN_TEMPLATE_HEADINGS,
  VISUAL_CONTRACT_VERSION,
} from '../lib/core/strategies/_visual-shared.js'
import { TARGET_CATALOG, getTargetSpec } from '../lib/core/targets.js'
import { PROMPT_TYPES } from '../lib/core/classify.js'

/** 最小分析结果工厂(只填路由关心的字段)。 */
function analysis({
  primary = 'execution',
  supporting = [],
  target = 'general',
  modality = 'text',
  engine = null,
  triage = 'PATCH',
} = {}) {
  return {
    intent: { primary, supporting, work_mode: 'one_shot', rationale: 'r' },
    target: { target, modality, engine, confidence: 'medium', evidence: [], rationale: 'r' },
    triage: { triage, reasons: [], signals: [], keep_safe: false },
    missing_resolution: [],
    gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: '' },
    ledger: [],
    confidence_internal: 0.8,
    rationale: 'r',
    evidence_quotes: [],
    prompt_type: primary,
    missing_constraints: [],
  }
}

// 1. 注册表分离:三个目标契约不进意图注册表,分类器闭集仍是七值
{
  assert.equal(PROMPT_TYPES.length, 7, '分类器闭集必须仍是七个意图')
  assert.deepEqual([...PROMPT_TYPES].sort(), [
    'creative',
    'diagnostic',
    'execution',
    'general',
    'planning',
    'research',
    'review',
  ])
  for (const type of ['agent', 'image', 'video']) {
    assert.equal(defaultStrategyRegistry.has(type), false, `意图注册表不得含 ${type}`)
    assert.equal(targetContractRegistry.has(type), true, `目标契约注册表必须含 ${type}`)
  }
  assert.equal(defaultStrategyRegistry.types().length, 7)
  assert.equal(targetContractRegistry.types().length, 4, '契约表 = agent/image/video + general 兜底')
  assert.equal(TARGET_CONTRACT_STRATEGIES.length, 3)
  assert.equal(allStrategies.length, 10, '审计视图 = 七意图 + 三目标契约')
  assert.equal(new Set(allStrategies.map((s) => s.type)).size, 10, '策略 type 不得重复')
  console.log('✓ rt1 目标契约与意图注册表分离(分类器闭集不受污染)')
}

// 2. 视觉目标胜过意图
{
  const img = routeStrategy(analysis({ primary: 'planning', target: 'image_generation', modality: 'image' }))
  assert.equal(img.strategy.type, 'image')
  assert.equal(img.basis, 'visual-target')
  assert.equal(img.contract, 'descriptive')
  assert.equal(isVisualContract(img), true)

  const vid = routeStrategy(analysis({ primary: 'research', target: 'video_generation', modality: 'video' }))
  assert.equal(vid.strategy.type, 'video')
  assert.equal(vid.contract, 'descriptive')
  assert.match(vid.reason, /描述式/)
  console.log('✓ rt2 视觉目标 > 意图(图像 / 视频都走描述式契约)')
}

// 3. Agent 目标:执行 / 通用意图 → Agent 契约;其他意图仍走意图策略
{
  const exec = routeStrategy(analysis({ primary: 'execution', target: 'agent_task' }))
  assert.equal(exec.strategy.type, 'agent')
  assert.equal(exec.basis, 'agent-target')

  const general = routeStrategy(analysis({ primary: 'general', target: 'agent_task' }))
  assert.equal(general.strategy.type, 'agent')

  const research = routeStrategy(analysis({ primary: 'research', target: 'agent_task' }))
  assert.equal(research.strategy.type, 'research', '研究意图即使目标是 Agent 也走研究策略')
  assert.equal(research.basis, 'intent')
  console.log('✓ rt3 Agent 目标按意图细分(执行/通用 → Agent 契约)')
}

// 4. 意图路由 + 手动覆盖优先级
{
  for (const primary of ['research', 'planning', 'execution', 'diagnostic', 'review', 'creative', 'general']) {
    const d = routeStrategy(analysis({ primary }))
    assert.equal(d.strategy.type, primary, `意图 ${primary} 应路由到同名策略`)
    assert.equal(d.contract, 'structured')
    assert.equal(d.basis, 'intent')
  }
  // 手动覆盖:即使目标是图像,用户手动选了 execution → 尊重用户
  const manual = routeStrategy(analysis({ target: 'image_generation', modality: 'image' }), {
    manualType: 'execution',
  })
  assert.equal(manual.strategy.type, 'execution')
  assert.equal(manual.basis, 'manual-override')
  assert.match(manual.reason, /手动/)
  console.log('✓ rt4 意图路由 + 手动覆盖最高优先级')
}

// 5. KEEP / REBUILD 不改变契约选择(分诊与路由正交)
{
  for (const triage of ['KEEP', 'PATCH', 'RESTRUCTURE', 'REBUILD']) {
    const d = routeStrategy(analysis({ primary: 'planning', triage }))
    assert.equal(d.strategy.type, 'planning', `分诊 ${triage} 不得改变契约`)
    assert.equal(d.signals.triage, triage)
  }
  console.log('✓ rt5 分诊与路由正交')
}

// 6. 审计信号快照完整
{
  const d = routeStrategy(
    analysis({
      primary: 'planning',
      supporting: ['research', 'execution'],
      target: 'video_generation',
      modality: 'video',
      engine: { id: 'kling', name: 'Kling / 可灵', target: 'video_generation', modality: 'video' },
    }),
  )
  assert.equal(d.signals.primary, 'planning')
  assert.deepEqual(d.signals.supporting, ['research', 'execution'])
  assert.equal(d.signals.target, 'video_generation')
  assert.equal(d.signals.modality, 'video')
  assert.equal(d.signals.engine, 'kling')
  console.log('✓ rt6 路由信号快照(可审计)')
}

// 7. 视觉契约:责任清单不含任务模板标题
{
  for (const strategy of [imageStrategy, videoStrategy]) {
    assert.equal(strategy.version, VISUAL_CONTRACT_VERSION)
    for (const heading of FORBIDDEN_TEMPLATE_HEADINGS) {
      assert.ok(
        !strategy.informationResponsibilities.includes(heading),
        `${strategy.type} 责任清单不得含任务模板标题「${heading}」`,
      )
    }
    // 责任清单必须是描述式的
    assert.ok(strategy.informationResponsibilities.length >= 6, `${strategy.type} 至少 6 项描述责任`)
    assert.deepEqual(strategy.outputContract.responsibilities, strategy.informationResponsibilities)
    assert.deepEqual(strategy.outputContract.sections, strategy.informationResponsibilities)
  }
  assert.ok(imageStrategy.informationResponsibilities.includes('Composition'))
  assert.ok(imageStrategy.informationResponsibilities.includes('Negative'))
  assert.ok(videoStrategy.informationResponsibilities.includes('Shot'))
  assert.ok(videoStrategy.informationResponsibilities.includes('Action & Timing'))
  assert.ok(agentStrategy.informationResponsibilities.includes('Objective & Definition of Done'))
  assert.ok(agentStrategy.informationResponsibilities.includes('Tools & Permissions'))
  console.log('✓ rt7 视觉 / Agent 契约责任清单(无任务模板标题)')
}

// 8. 视觉守卫:出现任务模板标题即触发;描述式合法产物零误报
{
  const guard = imageStrategy.guards.find((g) => g.id === 'visual-no-task-template')
  assert.ok(guard, '图像策略必须挂载 visual-no-task-template 守卫')
  for (const heading of ['Goal', 'Phases', 'Tasks', 'Acceptance Criteria', 'Verification Steps']) {
    assert.ok(
      guard.check(`## Subject\n- a cat\n\n## ${heading}\n- something`, { optimized_prompt: '' }, 'x'),
      `模板标题「${heading}」必须被守卫拒绝`,
    )
  }
  assert.equal(
    guard.check('## Subject\n- 一只猫\n## Scene\n- 雨夜街道\n## Style\n- 赛博朋克插画', { optimized_prompt: '' }, 'x'),
    null,
    '纯描述式产物不得误报',
  )
  const videoGuard = videoStrategy.guards.find((g) => g.id === 'visual-no-task-template')
  assert.ok(videoGuard, '视频策略必须挂载同一守卫')
  console.log('✓ rt8 视觉守卫拒绝任务模板(画像/视频不再套 Goal/Phase/Task/Tests)')
}

// 9. 与 TARGET_CATALOG 一致:视觉责任覆盖目标目录的责任条目数
{
  for (const [type, targetId] of [
    ['image', 'image_generation'],
    ['video', 'video_generation'],
  ]) {
    const spec = getTargetSpec(targetId)
    const strategy = type === 'image' ? imageStrategy : videoStrategy
    assert.equal(
      strategy.informationResponsibilities.length,
      spec.responsibilities.length,
      `${type} 契约责任数与 TARGET_CATALOG(${targetId}) 必须一致(单一真源)`,
    )
  }
  assert.ok(TARGET_CATALOG.every((t) => t.responsibilities.length >= 3))
  console.log('✓ rt9 视觉契约与 TARGET_CATALOG 一致')
}

console.log('router.test.mjs: ALL PASS')
