/**
 * v2 Phase 4 —— 再优化 Ledger 对账 + legacy 可达性单测。
 *
 * A. 只改措辞 → Ledger 大部分保留(STILL_VALID)
 * B. 改变一个目标(「现在改成…」)→ 相关 requirement supersede(CONFLICTING)
 * C. Agent Prompt → Image Prompt → 旧 Agent requirement 大量失效(INVALIDATED)
 * D. 删除用户原来明确写出的约束 → 不再假装仍是当前 USER_EXPLICIT
 * 另:legacy 生产路径可达性(required_sections / 占位符 / legacy general / 旧 override)
 *
 * 运行:先 `npm run build`,再 `node test/phase4-reconcile.test.mjs`。
 */
import assert from 'node:assert/strict'
import { reconcileLedger, targetFamily, liveOpenRequirements } from '../lib/core/ledger-reconcile.js'
import {
  DEFAULT_STRATEGIES,
  allStrategies,
  defaultStrategyRegistry,
  isLegacyGeneral,
  targetContractRegistry,
} from '../lib/core/registry.js'
import { compilePrompt, finalizeCompile, COMPILE_MARKERS as M } from '../lib/core/compiler.js'
import { routeStrategy, explicitIntentFromInput } from '../lib/core/router.js'

const entry = (id, text, status = 'CONFIRMED', source = 'USER_EXPLICIT', evidence = ['原话']) => ({
  id: `ledger-${id}`,
  text,
  source,
  status,
  evidence,
  confidence: 'high',
})

function analysis({ target = 'agent_task', texts = [], blocking = [] } = {}) {
  const resolution = [
    ...texts.map((text, index) => ({
      id: `unknown-${index}`,
      text,
      classification: 'AGENT_DISCOVERABLE',
      blocking: false,
      rationale: '',
      impact: 'low',
      user_exclusive: false,
    })),
    ...blocking,
  ]
  return {
    intent: { primary: 'execution', supporting: [], work_mode: 'one_shot', rationale: '' },
    target: { target, modality: 'text', engine: null, confidence: 'high', evidence: [], rationale: '' },
    triage: { triage: 'PATCH', reasons: [], signals: [], keep_safe: false },
    missing_resolution: resolution,
    gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: '' },
    ledger: [],
    confidence_internal: 0.9,
    rationale: '',
    evidence_quotes: [],
    prompt_type: 'execution',
    missing_constraints: [],
  }
}

const PREVIOUS = [
  entry('a', '已有可工作的 workflow'),
  entry('b', '本轮只验证控制链路'),
  entry('c', 'ComfyUI 版本', 'DISCOVERABLE', 'UNKNOWN', []),
]

// A. 只改措辞 → 大部分保留
{
  const result = reconcileLedger({
    previous: PREVIOUS,
    analysis: analysis({ target: 'agent_task', texts: ['DSH 当前可用的控制方式'] }),
    rawInput: '我想用 dsh 控制 comfyui 生成视频,已经有 workflow,先验证控制链路',
    previousTarget: 'agent_task',
  })
  assert.ok(result.stillValid.length >= 2, `A:措辞微调应保留大部分,实际 ${result.summary}`)
  assert.ok(result.stillValid.includes('ledger-a'))
  assert.ok(result.stillValid.includes('ledger-b'))
  assert.equal(result.conflicting.length, 0, 'A:措辞微调不得被当成冲突')
  assert.equal(result.invalidated.length, 0)
  assert.equal(result.ledger.find((e) => e.id === 'ledger-a').status, 'CONFIRMED')
  assert.equal(result.ledger.find((e) => e.id === 'ledger-a').source, 'USER_EXPLICIT', '保留时来源不变')
  console.log('✓ p4r1 A 只改措辞 → Ledger 大部分保留')
}

// B. 改变一个目标(「现在改成…」)→ supersede
{
  const result = reconcileLedger({
    previous: PREVIOUS,
    analysis: analysis({ target: 'agent_task', texts: ['长期自动化方案设计'] }),
    rawInput: '现在改成建立长期自动化流程',
    previousTarget: 'agent_task',
  })
  assert.ok(result.conflicting.length >= 2, `B:换向应取代旧决定,实际 ${result.summary}`)
  const superseded = result.ledger.find((e) => e.id === 'ledger-b')
  assert.equal(superseded.status, 'REJECTED')
  assert.match(String(superseded.note), /再优化对账/)
  assert.equal(result.stillValid.length, 0)
  console.log('✓ p4r2 B 目标改变 → 旧 requirement supersede(REJECTED)')
}

// C. Agent Prompt → Image Prompt → 大量失效
{
  const result = reconcileLedger({
    previous: PREVIOUS,
    analysis: analysis({ target: 'image_generation', texts: ['画面主体描述'] }),
    rawInput: '帮我生成 Midjourney 图片提示词',
    previousTarget: 'agent_task',
  })
  assert.equal(result.invalidated.length, 3, `C:换族应全部失效,实际 ${result.summary}`)
  assert.equal(result.conflicting.length, 0, '换族不是「换向冲突」而是「不再相关」')
  for (const item of result.ledger) assert.equal(item.status, 'NOT_APPLICABLE')
  assert.notEqual(targetFamily('agent_task'), targetFamily('image_generation'))
  console.log('✓ p4r3 C 换任务族 → 旧 requirement 全部 NOT_APPLICABLE')
}

// D. 删除用户明确写出的约束 → 不再假装仍是当前 USER_EXPLICIT
{
  const result = reconcileLedger({
    previous: PREVIOUS,
    analysis: analysis({ target: 'agent_task', texts: ['其他事情'] }),
    rawInput: '帮我做点别的',
    previousTarget: 'agent_task',
  })
  const dropped = result.ledger.find((e) => e.id === 'ledger-a')
  assert.equal(dropped.status, 'NOT_APPLICABLE', 'D:新输入未再提及 → 不得继续作为当前要求')
  assert.equal(
    result.ledger.some((e) => e.source === 'USER_EXPLICIT' && e.status === 'CONFIRMED' && e.id === 'ledger-a'),
    false,
    '★ 不能永远假装它仍是当前 USER_EXPLICIT',
  )
  assert.equal(liveOpenRequirements(result.ledger).length, 0, '对账后没有需要重新判定的 OPEN 项')
  console.log('✓ p4r4 D 删除约束 → 不再作为当前 USER_EXPLICIT')
}

// E. 对账不新增用户来源 / 幂等
{
  const result = reconcileLedger({
    previous: PREVIOUS,
    analysis: analysis({ target: 'agent_task', texts: [] }),
    rawInput: '完全不同的另一件事',
    previousTarget: 'agent_task',
  })
  assert.equal(result.ledger.length, PREVIOUS.length, '对账不新增条目')
  for (const item of result.ledger) {
    assert.ok(['USER_EXPLICIT', 'CONTEXT_EXPLICIT', 'OPTIMIZER_SUGGESTED', 'WORKSPACE_FACT', 'UNKNOWN'].includes(item.source))
  }
  const twice = reconcileLedger({
    previous: result.ledger,
    analysis: analysis({ target: 'agent_task', texts: [] }),
    rawInput: '完全不同的另一件事',
    previousTarget: 'agent_task',
  })
  assert.deepEqual(
    twice.ledger.map((e) => e.status),
    result.ledger.map((e) => e.status),
    '对账必须幂等',
  )
  console.log('✓ p4r5 对账不新增来源且幂等')
}

// ═════════════════════════════════════════════════════════════════════════════
// legacy 可达性(§12):生产路径不得再进入旧语义
// ═════════════════════════════════════════════════════════════════════════════
{
  // 1. 任何注册策略都不再标记 legacy
  for (const strategy of allStrategies) {
    assert.equal(isLegacyGeneral(strategy), false, `${strategy.type} 不得走 legacy 主路径`)
  }
  // 2. 正常路由(含 general / 三种目标契约)都不会命中 legacy
  const routeFor = (primary, target) =>
    routeStrategy(
      {
        ...analysis({ target }),
        intent: { primary, supporting: [], work_mode: 'one_shot', rationale: '' },
        prompt_type: primary,
      },
      { rawInput: 'x' },
    )
  for (const primary of ['research', 'planning', 'execution', 'diagnostic', 'review', 'creative', 'general']) {
    for (const target of ['general', 'agent_task', 'coding', 'writing', 'data_analysis', 'image_generation', 'video_generation']) {
      const decision = routeFor(primary, target)
      assert.equal(
        isLegacyGeneral(decision.strategy),
        false,
        `${primary}/${target} 路由到了 legacy 策略`,
      )
    }
  }
  // 3. compilePrompt 正常路径产出的 plan.legacy 恒为 false,且不注入占位符
  for (const promptType of ['research', 'planning', 'general']) {
    const plan = compilePrompt({ raw_input: '帮我做一件事,要 300 字以内,输出 markdown', promptType })
    assert.equal(plan.legacy, false, `${promptType}:正常路径不得 legacy`)
    const outcome = finalizeCompile(plan.strategy, `${M.diagnosis}\nd\n${M.explicit}\n(无)\n${M.context}\n(无)\n${M.suggested}\n(无)\n${M.unknown}\n(无)\n${M.optimized}\n${plan.strategy.informationResponsibilities.map((r) => `## ${r}\n- x`).join('\n')}\n${M.end}`, {
      rawInput: '帮我做一件事,要 300 字以内,输出 markdown',
      contextTurns: [],
      classifier: plan.classifier,
      missing: plan.vars.missing_constraints,
      mode: 'full',
      language: 'zh',
    })
    assert.doesNotMatch(
      outcome.result.optimized_prompt,
      /\[(?:待补充|TODO)\s*[:：]/,
      `${promptType}:生产路径不得产出占位符`,
    )
  }
  // 4. 目标契约注册表与意图注册表仍然分离
  assert.equal(defaultStrategyRegistry.types().length, 7)
  assert.equal(targetContractRegistry.types().length, 4)
  assert.equal(DEFAULT_STRATEGIES.length, 7)
  console.log('✓ p4r6 legacy 不可达:全部策略/全部路由/正常编译路径均不进入旧语义')
}

// 手动 override 仍可达(高级入口保留),且正文明确约束优先
{
  const a = { ...analysis({ target: 'general' }) }
  const manual = routeStrategy(a, { manualType: 'planning', rawInput: '帮我规划一下' })
  assert.equal(manual.basis, 'manual-override')
  assert.equal(manual.strategy.type, 'planning')

  const constrained = routeStrategy(a, {
    manualType: 'execution',
    rawInput: '帮我看看这段代码,只检查,不修改文件',
  })
  assert.equal(constrained.basis, 'explicit-constraint', '★ 正文明确约束优先于手动 override')
  assert.equal(constrained.strategy.type, 'review')
  assert.equal(explicitIntentFromInput('帮我看看这段代码,只检查,不修改文件').label, '只检查 / 不修改')
  console.log('✓ p4r7 手动 override 仍可达;正文明确约束优先')
}

console.log('phase4-reconcile.test.mjs: ALL PASS')
