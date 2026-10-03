/**
 * P04-T01 Compiler 核心单元测试(k1..k16)。
 *
 * 覆盖:
 *   - 四段标记协议(EXPLICIT/CONTEXT/SUGGESTED/UNKNOWN + OPTIMIZED/END)与中英同构;
 *   - parseCompileOutput 容错:缺段降级、重复标记取最后、think 剥离、Markdown 回退、
 *     整段降级、`(无)` / 空行 / `*` 项目符号 / 中英占位符;
 *   - suggested 永不混入 explicit(来源标注逐条断言);
 *   - compilePrompt:override 七类型直达 registry、AUTO 分类、缺省兜底、legacy general、
 *     10 步编排审计、缺失信息 → [待补充:] 注入;
 *   - injectMissingPlaceholders + finalizeCompile 联动(非 legacy 注入 / legacy 零回归);
 *   - 纯函数纪律:可复现、无 LLM / UI / Host 依赖。
 *
 * 运行:先 `npm run build`,再 `node test/compiler.test.mjs`。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import research from '../lib/core/strategies/research.js'
import {
  defaultStrategyRegistry,
  generalFallbackStrategy,
  isLegacyGeneral,
} from '../lib/core/registry.js'
import {
  COMPILE_MARKERS,
  COMPILE_PROMPT_STEPS,
  buildCompilerProtocol,
  compilePrompt,
  finalizeCompile,
  injectMissingPlaceholders,
  parseCompileOutput,
} from '../lib/core/compiler.js'

const REAL_CASE =
  '帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频,我看到黑鹤001低显流,还有 H3……'

const M = COMPILE_MARKERS

// ─────────────────────────────────────────────────────────────────────────────
// k1. 协议锚点:七个标记齐全 + 段落顺序 + 中英同构
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.deepEqual(Object.keys(M), [
    'diagnosis',
    'explicit',
    'context',
    'suggested',
    'unknown',
    'optimized',
    'end',
  ])
  for (const marker of Object.values(M)) assert.match(marker, /^<<<[A-Z]+>>>$/)

  const { buildCompilerProtocol } = await import('../lib/core/compiler.js')
  const zh = buildCompilerProtocol('zh')
  const en = buildCompilerProtocol('en')
  for (const marker of Object.values(M)) {
    assert.ok(zh.includes(marker), `zh 协议缺标记 ${marker}`)
    assert.ok(en.includes(marker), `en 协议缺标记 ${marker}`)
  }
  const order = [M.explicit, M.context, M.suggested, M.unknown, M.optimized, M.end].map((marker) =>
    zh.indexOf(marker),
  )
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], '四段协议顺序必须保持 EXPLICIT→CONTEXT→SUGGESTED→UNKNOWN→OPTIMIZED→END')
  }
  assert.match(zh, /建议\(可忽略\)/)
  assert.match(zh, /\[待补充:/)
  assert.match(en, /Suggestion \(optional\)/)
  assert.match(en, /\[TODO:/)
  console.log('✓ k1 四段协议锚点 / 顺序 / 中英同构')
}

// ─────────────────────────────────────────────────────────────────────────────
// k2. 完整拆解:四组来源 + 缺口 + 优化稿;quote 逐字提取
// ─────────────────────────────────────────────────────────────────────────────
const MARKED = [
  M.diagnosis,
  '目标清晰度:目标明确 | 约束边界:时长未说明',
  M.explicit,
  '- 研究 Mac 上用 ComfyUI 做 AI 视频 [quote: Mac M1 Pro 32GB] [quote: ComfyUI]',
  M.context,
  '- 机器为 Mac M1 Pro 32GB [quote: 我的机器是 Mac M1 Pro 32GB]',
  M.suggested,
  '- 建议(可忽略) 补充目标产出形式',
  '- Suggestion (optional) prefer local reproducible steps',
  M.unknown,
  '- [待补充: 期望的视频时长,决定显存选择]',
  '- [TODO: pick a target platform]',
  M.optimized,
  '## Background（背景）',
  '- 用户机器为 Mac M1 Pro 32GB',
  M.end,
].join('\n')

{
  const parsed = parseCompileOutput(MARKED)
  assert.equal(parsed.wellFormed, true)
  assert.match(parsed.diagnosis, /目标清晰度/)
  assert.equal(parsed.explicit_requirements.length, 1)
  assert.equal(parsed.explicit_requirements[0].source, 'USER_EXPLICIT')
  assert.equal(parsed.explicit_requirements[0].text, '研究 Mac 上用 ComfyUI 做 AI 视频')
  assert.deepEqual(parsed.explicit_requirements[0].evidence, ['Mac M1 Pro 32GB', 'ComfyUI'])
  assert.equal(parsed.context_requirements.length, 1)
  assert.equal(parsed.context_requirements[0].source, 'CONTEXT_EXPLICIT')
  assert.equal(parsed.suggested_requirements.length, 2)
  assert.ok(parsed.suggested_requirements.every((r) => r.source === 'OPTIMIZER_SUGGESTED'))
  assert.equal(parsed.suggested_requirements[0].text, '补充目标产出形式', '中文建议标签应剥离')
  assert.equal(parsed.suggested_requirements[1].text, 'prefer local reproducible steps', '英文建议标签应剥离')
  assert.equal(parsed.unknowns.length, 2)
  assert.ok(parsed.unknowns.every((r) => r.source === 'UNKNOWN'))
  assert.deepEqual(
    parsed.missing_constraints,
    [
      { id: 'mc-unknown-1', label: '期望的视频时长,决定显存选择' },
      { id: 'mc-unknown-2', label: 'pick a target platform' },
    ],
    '中英 [待补充:] / [TODO:] 都必须落成缺口',
  )
  assert.match(parsed.optimized_prompt, /Mac M1 Pro 32GB/)
  assert.ok(!parsed.optimized_prompt.includes('<<<'), '优化稿不得混入协议标记')
  assert.ok(!parsed.optimized_prompt.includes('建议(可忽略)'), '建议段不得并入优化稿')
  console.log('✓ k2 四段完整拆解 / quote / 中英缺口')
}

// ─────────────────────────────────────────────────────────────────────────────
// k3. suggested 永不混入 explicit(逐条来源断言 + 负向构造)
// ─────────────────────────────────────────────────────────────────────────────
{
  const parsed = parseCompileOutput(MARKED)
  for (const record of parsed.explicit_requirements) assert.equal(record.source, 'USER_EXPLICIT')
  for (const record of parsed.context_requirements) assert.equal(record.source, 'CONTEXT_EXPLICIT')
  for (const record of parsed.suggested_requirements) assert.equal(record.source, 'OPTIMIZER_SUGGESTED')
  for (const record of parsed.unknowns) assert.equal(record.source, 'UNKNOWN')

  const explicitTexts = new Set(parsed.explicit_requirements.map((r) => r.text))
  for (const suggestion of parsed.suggested_requirements) {
    assert.ok(!explicitTexts.has(suggestion.text), '建议文本不得出现在明确要求组')
  }
  assert.equal(parsed.explicit_requirements[0].evidence.length, 2)
  assert.equal(parsed.suggested_requirements[0].evidence.length, 0, '建议无需证据,但必须标来源')
  console.log('✓ k3 suggested 独立成段,来源不越界')
}

// ─────────────────────────────────────────────────────────────────────────────
// k4. 缺段降级:只有 OPTIMIZED / 没有 OPTIMIZED / Markdown 回退 / 整段降级
// ─────────────────────────────────────────────────────────────────────────────
{
  const onlyOptimized = [M.optimized, '## Background', '- 仅优化稿', M.end].join('\n')
  const a = parseCompileOutput(onlyOptimized)
  assert.equal(a.wellFormed, true)
  assert.deepEqual(a.explicit_requirements, [])
  assert.deepEqual(a.context_requirements, [])
  assert.deepEqual(a.suggested_requirements, [])
  assert.deepEqual(a.unknowns, [])
  assert.deepEqual(a.missing_constraints, [])
  assert.equal(a.optimized_prompt, '## Background\n- 仅优化稿')

  // 有 EXPLICIT 但没有 OPTIMIZED 锚点 → 不可信分段,整段降级(绝不伪造 provenance)
  const noAnchor = [M.explicit, '- 研究目标 [quote: Mac M1 Pro 32GB]', M.end].join('\n')
  const b = parseCompileOutput(noAnchor)
  assert.equal(b.wellFormed, false)
  assert.deepEqual(b.explicit_requirements, [], '无 OPTIMIZED 锚点不得产出 explicit 记录')
  assert.equal(b.optimized_prompt, noAnchor.trim(), '整段降级为优化稿')

  // Markdown 四段标题回退
  const markdown = [
    '## 明确要求',
    '- 研究 Mac 方案 [quote: Mac M1 Pro 32GB]',
    '## 优化后的 Research Prompt',
    '### Background（背景）',
    '- 背景内容',
  ].join('\n')
  const c = parseCompileOutput(markdown)
  assert.equal(c.wellFormed, true)
  assert.equal(c.explicit_requirements.length, 1)
  assert.match(c.optimized_prompt, /背景内容/)
  assert.ok(!c.optimized_prompt.includes('## 明确要求'), 'Markdown 来源段不得并入优化稿')

  // 完全不符合协议 → wellFormed=false,优化稿=原文
  const d = parseCompileOutput('就是一段没有任何标记的普通文字')
  assert.equal(d.wellFormed, false)
  assert.equal(d.optimized_prompt, '就是一段没有任何标记的普通文字')
  assert.deepEqual(d.explicit_requirements, [])
  console.log('✓ k4 缺段降级 / Markdown 回退 / 整段降级')
}

// ─────────────────────────────────────────────────────────────────────────────
// k5. 重复标记取最后(模型复述标记) + `(无)` / 空行 / `*` 项目符号 / 标记空格
// ─────────────────────────────────────────────────────────────────────────────
{
  const duplicated = [
    M.explicit,
    '- 第一版要求 [quote: 不存在]',
    M.optimized,
    'first optimized',
    M.end,
    M.explicit,
    '- (无)',
    M.context,
    '',
    '* 上下文项 [quote: 我的机器是 Mac M1 Pro 32GB]',
    M.suggested,
    '- 建议: 补充受众',
    M.unknown,
    '- 缺少核心参数',
    '<<< OPTIMIZED >>>',
    'second optimized',
    M.end,
  ].join('\n')
  const parsed = parseCompileOutput(duplicated)
  assert.equal(parsed.wellFormed, true)
  assert.equal(parsed.explicit_requirements.length, 0, '重复 EXPLICIT 取最后:该段为 (无)')
  assert.equal(parsed.context_requirements.length, 1, '* 项目符号与空行应被容忍')
  assert.equal(parsed.suggested_requirements[0].text, '补充受众', '「建议:」前缀应被剥离')
  assert.equal(parsed.unknowns.length, 1)
  assert.equal(parsed.optimized_prompt, 'second optimized', '重复 OPTIMIZED 取最后')
  assert.deepEqual(parsed.missing_constraints, [{ id: 'mc-unknown-1', label: '缺少核心参数' }])
  console.log('✓ k5 重复标记取最后 / 行解析容错')
}

// ─────────────────────────────────────────────────────────────────────────────
// k6. think 剥离:思考块里的伪标记不得污染解析
// ─────────────────────────────────────────────────────────────────────────────
{
  const withThink = [
    '<think>我先口算一下 <<<OPTIMIZED>>>思考中的假稿<<<END>>></think>',
    M.explicit,
    '- 真实要求 [quote: Mac M1 Pro 32GB]',
    M.optimized,
    '真实优化稿',
    M.end,
  ].join('\n')
  const parsed = parseCompileOutput(withThink)
  assert.equal(parsed.optimized_prompt, '真实优化稿', 'think 内的伪标记必须被剥离')
  assert.equal(parsed.explicit_requirements.length, 1)

  const thinkOnly = '<think>只有思考 <<<OPTIMIZED>>>假稿<<<END>>></think>'
  const degraded = parseCompileOutput(thinkOnly)
  assert.equal(degraded.wellFormed, false, '只剩 think 内容时不得当作协议输出')
  assert.ok(!degraded.optimized_prompt.includes('假稿'))
  console.log('✓ k6 think 剥离(伪标记 / 仅思考)')
}

// ─────────────────────────────────────────────────────────────────────────────
// k7. compilePrompt override:七类型直达 registry(函数级零分类)
// ─────────────────────────────────────────────────────────────────────────────
const PROMPT_TYPES = ['research', 'planning', 'execution', 'diagnostic', 'review', 'creative', 'general']
{
  for (const type of PROMPT_TYPES) {
    const plan = compilePrompt({
      raw_input: '帮我处理一下这件事',
      promptType: type,
      registry: defaultStrategyRegistry,
    })
    const strategy = defaultStrategyRegistry.get(type)
    assert.equal(plan.overridden, true, `${type}: override 必须被识别`)
    assert.equal(plan.strategy, strategy, `${type}: 必须直达 registry 中的策略`)
    assert.equal(plan.result.prompt_type, type)
    assert.equal(plan.result.strategy_version, strategy.version, `${type}: 策略版本可审计`)
    assert.equal(plan.result.confidence_level, 'High', `${type}: override 为确定性高把握`)
    assert.match(plan.classifier.rationale, /手动/)
    assert.equal(plan.result.provenance_ok, false, 'validate 之前必须保持 false')
    assert.equal(plan.result.optimized_prompt, '', '骨架不得预填优化稿')
    assert.deepEqual(plan.result.explicit_requirements, [])
    assert.deepEqual(plan.result.suggested_requirements, [])
    assert.ok(plan.system.length > 0 && plan.user.length > 0)
  }
  console.log('✓ k7 override 七类型直达 registry(零分类)')
}

// ─────────────────────────────────────────────────────────────────────────────
// k8. compilePrompt AUTO:分类结果 → 策略 / 缺口注入 / 载荷
// ─────────────────────────────────────────────────────────────────────────────
const CLASSIFIER = {
  prompt_type: 'research',
  confidence_internal: 0.86,
  missing_constraints: ['期望的视频产出形式与时长', 'Mac 本机可接受的生成耗时'],
  rationale: '用户在寻求 Mac 上 ComfyUI 做 AI 视频的研究路径',
  evidence_quotes: ['Mac M1 Pro 32GB'],
}
{
  const plan = compilePrompt({
    raw_input: REAL_CASE,
    turns: [
      { role: 'user', text: '我的机器是 Mac M1 Pro 32GB' },
      { role: 'assistant', text: '可以试试低显存方案' },
      { role: 'hacker', text: '非法 role 应被过滤' },
    ],
    classifier: CLASSIFIER,
    registry: defaultStrategyRegistry,
  })
  assert.equal(plan.overridden, false)
  assert.equal(plan.strategy, defaultStrategyRegistry.get('research'))
  assert.equal(plan.legacy, false)
  assert.equal(plan.result.confidence_level, 'High')
  assert.deepEqual(plan.result.missing_constraints, [
    { id: 'mc-classifier-1', label: '期望的视频产出形式与时长' },
    { id: 'mc-classifier-2', label: 'Mac 本机可接受的生成耗时' },
  ])
  assert.equal(plan.result.provenance_ok, false)
  // 步骤 1/2:raw_input 原样,非法 role 被确定性过滤
  assert.equal(plan.normalized.raw_input, REAL_CASE)
  assert.deepEqual(plan.normalized.bounded_turns, [
    { role: 'user', text: '我的机器是 Mac M1 Pro 32GB' },
    { role: 'assistant', text: '可以试试低显存方案' },
  ])
  assert.equal(plan.vars.raw_input, REAL_CASE)
  // 步骤 7/8/9:策略 system + 机器可解析协议;user 携带缺口 → [待补充:]
  assert.ok(plan.system.includes('<<<OPTIMIZED>>>'), 'system 必须包含四段协议锚点')
  assert.ok(plan.system.includes('建议'), 'system 必须含建议标注纪律')
  assert.ok(plan.user.includes(REAL_CASE))
  assert.ok(plan.user.includes('[待补充: 期望的视频产出形式与时长]'), '缺口必须注入 user 载荷')
  console.log('✓ k8 compilePrompt AUTO:策略 / 归一化 / 缺口注入')
}

// ─────────────────────────────────────────────────────────────────────────────
// k9. compilePrompt 兜底:无分类、非法 override、未知类型
// ─────────────────────────────────────────────────────────────────────────────
{
  const noClassifier = compilePrompt({ raw_input: 'hello' })
  assert.equal(noClassifier.overridden, false)
  assert.equal(noClassifier.classifier.prompt_type, 'general')
  assert.equal(noClassifier.strategy.type, 'general')
  assert.equal(noClassifier.result.confidence_level, 'Low')
  assert.match(noClassifier.classifier.rationale, /回退通用/)

  const invalidOverride = compilePrompt({
    raw_input: REAL_CASE,
    promptType: 'not-a-type',
    classifier: CLASSIFIER,
    registry: defaultStrategyRegistry,
  })
  assert.equal(invalidOverride.overridden, false, '非法 override 必须回落 AUTO,不能绕过分类语义')
  assert.equal(invalidOverride.strategy, defaultStrategyRegistry.get('research'))

  const unknownType = compilePrompt({
    raw_input: 'x',
    classifier: { ...CLASSIFIER, prompt_type: 'bogus' },
    registry: defaultStrategyRegistry,
  })
  assert.equal(unknownType.strategy.type, 'general', '未知类型必须回退 general')
  console.log('✓ k9 缺省 / 非法 override / 未知类型兜底')
}

// ─────────────────────────────────────────────────────────────────────────────
// k10. compilePrompt legacy general:零回归路径
// ─────────────────────────────────────────────────────────────────────────────
{
  const plan = compilePrompt({
    raw_input: '帮我看看这段代码',
    promptType: 'general',
    legacy: true,
    mode: 'fast',
    registry: defaultStrategyRegistry,
  })
  assert.equal(plan.legacy, true)
  assert.equal(plan.strategy, generalFallbackStrategy)
  assert.equal(plan.system.includes('<<<DIAGNOSIS>>>'), false, 'legacy 不接新协议')
  assert.ok(plan.system.includes('OPTIMIZED'))
  assert.equal(plan.user, '以下是我的提示词草稿:\n\n帮我看看这段代码')
  console.log('✓ k10 legacy general 零回归路径')
}

// ─────────────────────────────────────────────────────────────────────────────
// k11. 10 步编排审计
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.equal(COMPILE_PROMPT_STEPS.length, 10, 'PLAN-v1 §8 明确 10 步')
  const ids = COMPILE_PROMPT_STEPS.map((step) => step.id)
  assert.equal(new Set(ids).size, 10, '步骤 id 必须唯一')
  assert.ok(COMPILE_PROMPT_STEPS.every((step) => step.zh && step.enforcedBy))
  assert.ok(COMPILE_PROMPT_STEPS.some((step) => step.enforcedBy === 'protocol'))
  assert.ok(COMPILE_PROMPT_STEPS.some((step) => step.enforcedBy === 'finalize'))

  const plan = compilePrompt({ raw_input: REAL_CASE, classifier: CLASSIFIER, registry: defaultStrategyRegistry })
  assert.ok(plan.steps.length >= 4)
  for (const id of plan.steps) assert.ok(ids.includes(id), `未知步骤 id ${id}`)
  for (const required of [
    'context-reconstruction',
    'missing-information',
    'strategy-structuring',
    'output-contract',
    'provenance-preservation',
  ]) {
    assert.ok(plan.steps.includes(required), `编排必须落实 ${required}`)
  }
  console.log('✓ k11 10 步编排审计锚点')
}

// ─────────────────────────────────────────────────────────────────────────────
// k12. injectMissingPlaceholders:不重复 / 语言 / 空 label
// ─────────────────────────────────────────────────────────────────────────────
{
  const missing = [
    { id: 'm1', label: '目标受众' },
    { id: 'm2', label: '预算上限' },
  ]
  const fresh = injectMissingPlaceholders('## Goal\n做视频', missing, 'zh')
  assert.match(fresh.prompt, /## 待补充（编译期自动补录）/)
  assert.ok(fresh.prompt.includes('[待补充: 目标受众]'))
  assert.ok(fresh.prompt.includes('[待补充: 预算上限]'))
  assert.equal(fresh.injected.length, 2)

  const partly = injectMissingPlaceholders('## Goal\n做视频\n[待补充: 目标受众]', missing, 'zh')
  assert.equal(partly.injected.length, 1, '已出现的缺口不得重复注入')
  assert.equal(partly.prompt.split('[待补充: 目标受众]').length - 1, 1)
  assert.ok(partly.prompt.includes('[待补充: 预算上限]'))

  const english = injectMissingPlaceholders('## Goal\nmake a video', missing, 'en')
  assert.match(english.prompt, /## TODOs \(auto-appended by compiler\)/)
  assert.ok(english.prompt.includes('[TODO: 目标受众]'))

  const empty = injectMissingPlaceholders('原文', [{ id: 'e', label: '   ' }], 'zh')
  assert.equal(empty.prompt, '原文')
  assert.equal(empty.injected.length, 0)

  const blank = injectMissingPlaceholders('', [{ id: 'm1', label: '目标受众' }], 'zh')
  assert.match(blank.prompt, /^## 待补充/)
  console.log('✓ k12 缺口占位符注入:幂等 / 中英 / 空值')
}

// ─────────────────────────────────────────────────────────────────────────────
// k13. finalizeCompile 联动:非 legacy 注入缺口;legacy 不注入;provenance_ok 仍由校验决定
// ─────────────────────────────────────────────────────────────────────────────
{
  const missing = [{ id: 'mc-classifier-1', label: '期望的视频产出形式与时长' }]
  const raw = [
    M.diagnosis,
    '目标清晰度:目标明确',
    M.explicit,
    '- 研究目标:Mac 上用 ComfyUI 做 AI 视频 [quote: Mac M1 Pro 32GB] [quote: ComfyUI]',
    M.context,
    '- (无)',
    M.suggested,
    '- 建议(可忽略) 补充产出形式',
    M.unknown,
    '- [待补充: Mac 实测案例]',
    M.optimized,
    '## Background（背景）\n- 用户机器为 Mac M1 Pro 32GB\n## Evidence Gaps（证据缺口）\n- [待补充: Mac 实测案例]',
    M.end,
  ].join('\n')

  const outcome = finalizeCompile(research, raw, {
    rawInput: REAL_CASE,
    contextTurns: [],
    classifier: { ...CLASSIFIER, missing_constraints: [] },
    missing,
    mode: 'full',
  })
  assert.equal(outcome.wellFormed, true)
  assert.equal(outcome.result.provenance_ok, true, '真实 quote + 缺口暴露应通过校验')
  assert.deepEqual(
    outcome.result.missing_constraints.map((m) => m.label),
    ['期望的视频产出形式与时长', 'Mac 实测案例'],
    'classifier 缺口与 UNKNOWN 段缺口必须合并去重',
  )
  assert.ok(
    outcome.result.optimized_prompt.includes('[待补充: 期望的视频产出形式与时长]'),
    '未在优化稿出现的缺口必须被机械注入',
  )
  assert.equal(
    outcome.result.optimized_prompt.split('[待补充: Mac 实测案例]').length - 1,
    1,
    '已在优化稿出现的缺口不得重复注入',
  )

  // 伪造 quote 仍必须让 provenance_ok=false(注入不掩盖校验失败)
  const fake = raw.replace(
    '[quote: Mac M1 Pro 32GB] [quote: ComfyUI]',
    '[quote: 这句不在输入里]',
  )
  const bad = finalizeCompile(research, fake, {
    rawInput: REAL_CASE,
    contextTurns: [],
    classifier: { ...CLASSIFIER, missing_constraints: [] },
    missing,
    mode: 'full',
  })
  assert.equal(bad.result.provenance_ok, false)
  assert.ok(bad.problems.some((p) => p.rule === 'PROVENANCE_EVIDENCE_NOT_IN_RAW'))

  // legacy general:原样输出,不注入缺口(零回归)
  const legacy = finalizeCompile(generalFallbackStrategy, '<<<OPTIMIZED>>>\n通用改写结果\n<<<END>>>', {
    rawInput: '帮我看看这段代码',
    contextTurns: [],
    classifier: { prompt_type: 'general', confidence_internal: 0.2, missing_constraints: [], rationale: '', evidence_quotes: [] },
    missing: [{ id: 'mc-1', label: '输出格式' }],
    mode: 'fast',
    legacy: true,
  })
  assert.equal(legacy.result.optimized_prompt, '通用改写结果')
  assert.ok(!legacy.result.optimized_prompt.includes('待补充'))
  assert.equal(isLegacyGeneral(generalFallbackStrategy), true)
  console.log('✓ k13 finalizeCompile 缺口注入 / legacy 零回归 / 校验联动')
}

// ─────────────────────────────────────────────────────────────────────────────
// k14. 纯函数:可复现、不修改输入、无 LLM / UI / Host 依赖
// ─────────────────────────────────────────────────────────────────────────────
{
  const stripIds = (parsed) => ({
    ...parsed,
    explicit_requirements: parsed.explicit_requirements.map(({ id, ...rest }) => rest),
    context_requirements: parsed.context_requirements.map(({ id, ...rest }) => rest),
    suggested_requirements: parsed.suggested_requirements.map(({ id, ...rest }) => rest),
    unknowns: parsed.unknowns.map(({ id, ...rest }) => rest),
  })
  const a = parseCompileOutput(MARKED)
  const b = parseCompileOutput(MARKED)
  assert.deepEqual(stripIds(a), stripIds(b), '解析内容必须可复现(id 由全局序列保证单次运行内唯一)')
  const allIds = [
    ...a.explicit_requirements,
    ...a.context_requirements,
    ...a.suggested_requirements,
    ...a.unknowns,
  ].map((record) => record.id)
  assert.equal(new Set(allIds).size, allIds.length, '记录 id 必须唯一')

  const plan1 = compilePrompt({ raw_input: REAL_CASE, classifier: CLASSIFIER, registry: defaultStrategyRegistry })
  const plan2 = compilePrompt({ raw_input: REAL_CASE, classifier: CLASSIFIER, registry: defaultStrategyRegistry })
  assert.deepEqual(plan1.result, plan2.result, '同一输入必须得到同一骨架')
  assert.equal(plan1.system, plan2.system, '同一输入必须得到同一 system')
  assert.equal(plan1.user, plan2.user, '同一输入必须得到同一 user')

  const source = readFileSync(new URL('../src/core/compiler.ts', import.meta.url), 'utf8')
  // 去掉注释后再做依赖面扫描(文档里会提到这些词,注释不算依赖)。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/ctx\.llm/.test(code), 'compiler.ts 不得依赖 ctx.llm')
  assert.ok(!/@deepseek-ai\//.test(code), 'compiler.ts 不得依赖 Harness 包')
  assert.ok(!/\bfrom\s+['"]react/.test(code), 'compiler.ts 不得依赖 React')
  assert.ok(!/document\.|window\./.test(code), 'compiler.ts 不得依赖 DOM')
  assert.ok(source.includes('export function compilePrompt'), 'compilePrompt 必须导出')
  console.log('✓ k14 纯函数 / 零 Host·UI·LLM 依赖')
}

// ─────────────────────────────────────────────────────────────────────────────
// k15. compilePrompt 与 finalizeCompile 串联:override 全类型输出契约不变量
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const type of PROMPT_TYPES) {
    const strategy = defaultStrategyRegistry.get(type)
    const plan = compilePrompt({ raw_input: '请帮我处理', promptType: type, registry: defaultStrategyRegistry })
    assert.equal(plan.strategy, strategy)
    for (const section of strategy.required_sections) {
      assert.ok(
        plan.system.includes(section) || plan.user.includes(section),
        `${type}: 契约段落 ${section} 必须进入编译载荷`,
      )
    }
  }
  console.log('✓ k15 override 各类型 required_sections 均进入载荷')
}

// ─────────────────────────────────────────────────────────────────────────────
// k16. 解析器对「建议段被写进要求段」不宽容:来源只由所在段决定
// ─────────────────────────────────────────────────────────────────────────────
{
  const mixed = [
    M.explicit,
    '- 明确要求 A [quote: Mac M1 Pro 32GB]',
    M.suggested,
    '- 建议(可忽略) 明确要求 B',
    M.optimized,
    '## Background\n[待补充: x]',
    M.end,
  ].join('\n')
  const parsed = parseCompileOutput(mixed)
  assert.equal(parsed.explicit_requirements.length, 1)
  assert.equal(parsed.suggested_requirements.length, 1)
  assert.ok(!parsed.explicit_requirements.some((r) => r.text.includes('明确要求 B')))
  assert.equal(parsed.suggested_requirements[0].source, 'OPTIMIZER_SUGGESTED')
  assert.equal(parsed.explicit_requirements[0].source, 'USER_EXPLICIT')
  assert.ok(!parsed.optimized_prompt.includes('明确要求 B'), '建议段不得进入优化稿正文')
  console.log('✓ k16 来源由所在段决定,建议永不升格为要求')
}

console.log('\ncompiler: all passed')
