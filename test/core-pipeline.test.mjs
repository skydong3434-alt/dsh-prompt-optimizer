/**
 * Core 最小管线单元测试(Vertical Slice):
 * context(确定性归一化)/ classify(JSON 解析 + 回退)/ registry(fallback)/
 * compiler(四段协议解析 + provenance 校验 + 守卫汇总)。
 *
 * 运行:先 `npm run build`,再 `node test/core-pipeline.test.mjs`。
 */
import assert from 'node:assert/strict'
import { normalizeInput } from '../lib/core/context.js'
import {
  CLASSIFIER_MAX_TOKENS,
  CLASSIFIER_TEMPERATURE,
  PROMPT_TYPES,
  buildClassifierSystem,
  buildClassifierUser,
  fallbackClassifierResult,
  isPromptType,
  manualClassifierResult,
  parseClassifierResult,
  parsePromptTypeInput,
} from '../lib/core/classify.js'
import {
  createStrategyRegistry,
  defaultStrategyRegistry,
  generalFallbackStrategy,
  isLegacyGeneral,
} from '../lib/core/registry.js'
import research from '../lib/core/strategies/research.js'
import {
  COMPILE_MARKERS,
  buildCompilePayload,
  buildCompilerProtocol,
  finalizeCompile,
  parseCompileOutput,
} from '../lib/core/compiler.js'

const REAL_CASE =
  '帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频,我看到黑鹤001低显流,还有 H3……'

// cp1. context:raw_input 原样、turns 预算收敛、workspace metadata 只留非空字符串
{
  const ctx = normalizeInput({
    raw_input: REAL_CASE,
    turns: [
      { role: 'user', text: '我的机器是 Mac M1 Pro 32GB' },
      { role: 'assistant', text: '可以试试低显存方案' },
      { role: 'hacker', text: '非法 role 应被过滤' },
      { role: 'user', text: '   ' },
    ],
    workspace_metadata: { cwd: '  /Users/me/video-lab  ', workspace_name: 'video-lab', extra: 'ignored' },
  })
  assert.equal(ctx.raw_input, REAL_CASE, 'raw_input 必须原样保留')
  assert.deepEqual(ctx.bounded_turns, [
    { role: 'user', text: '我的机器是 Mac M1 Pro 32GB' },
    { role: 'assistant', text: '可以试试低显存方案' },
  ])
  assert.deepEqual(ctx.workspace_metadata, { cwd: '/Users/me/video-lab', workspace_name: 'video-lab' })
  assert.equal(normalizeInput({ raw_input: 'x' }).bounded_turns.length, 0)
  console.log('✓ cp1 context 确定性归一化')
}

// cp2. classify:合法 JSON(含 think 块/代码块)/ 缺字段默认 / 非法类型与坏 JSON 回退
{
  assert.equal(CLASSIFIER_MAX_TOKENS, 512)
  assert.equal(CLASSIFIER_TEMPERATURE, 0)
  assert.deepEqual([...PROMPT_TYPES], ['research', 'planning', 'execution', 'diagnostic', 'review', 'creative', 'general'])
  assert.equal(isPromptType('research'), true)
  assert.equal(isPromptType('bogus'), false)
  assert.equal(parsePromptTypeInput('review'), 'review')
  assert.equal(parsePromptTypeInput('bogus'), undefined)
  assert.equal(parsePromptTypeInput(undefined), undefined)

  const withThink = `<think>先判断意图</think>\n{"prompt_type":"research","confidence_internal":0.86,"missing_constraints":["产出形式"],"rationale":"研究诉求","evidence_quotes":["黑鹤001低显流"]}`
  const parsed = parseClassifierResult(withThink)
  assert.equal(parsed.prompt_type, 'research')
  assert.equal(parsed.confidence_internal, 0.86)
  assert.deepEqual(parsed.missing_constraints, ['产出形式'])
  assert.deepEqual(parsed.evidence_quotes, ['黑鹤001低显流'])

  // 字段缺失补默认值;confidence 越界被 clamp
  const defaults = parseClassifierResult('{"prompt_type":"general","confidence_internal":9}')
  assert.equal(defaults.confidence_internal, 1)
  assert.deepEqual(defaults.missing_constraints, [])
  assert.equal(defaults.rationale, '')

  assert.equal(parseClassifierResult('not json at all'), null, '非 JSON 必须回退')
  assert.equal(parseClassifierResult('{"prompt_type":"unknown_type"}'), null, '非法类型必须回退')

  const fb = fallbackClassifierResult('分类调用失败')
  assert.equal(fb.prompt_type, 'general')
  assert.ok(fb.confidence_internal < 0.6, '回退必须低置信')
  assert.match(fb.rationale, /分类调用失败/)
  const manual = manualClassifierResult('research')
  assert.equal(manual.prompt_type, 'research')
  assert.equal(manual.confidence_internal, 1)

  const system = buildClassifierSystem('zh')
  assert.match(system, /protect|以当前输入|判断对象/)
  assert.match(system, /助手/)
  const user = buildClassifierUser({ raw_input: REAL_CASE, context_turns: [{ role: 'user', text: '我的机器是 Mac' }] }, 'zh')
  assert.match(user, /<prompt-draft>/)
  assert.match(user, /<conversation-context>/)
  console.log('✓ cp2 classify JSON 解析 / 回退 / 手动覆盖')
}

// cp3. registry:research + general fallback;未知类型兜底 general;版本可审计
{
  // 各核心模块是独立 bundle,策略模块副本之间不保证对象同一性,故比对契约字段。
  const registeredResearch = defaultStrategyRegistry.get('research')
  assert.equal(registeredResearch.type, 'research')
  assert.equal(registeredResearch.version, '0.2.0')
  assert.equal(defaultStrategyRegistry.get('general'), generalFallbackStrategy)
  assert.equal(defaultStrategyRegistry.get('planning'), generalFallbackStrategy, '未注册类型必须回退 general')
  assert.equal(defaultStrategyRegistry.get('bogus'), generalFallbackStrategy)
  assert.equal(defaultStrategyRegistry.has('planning'), false)
  const versions = defaultStrategyRegistry.getVersion()
  assert.equal(versions.research, '0.2.0')
  assert.equal(versions.general, '0.1.0')
  assert.equal(defaultStrategyRegistry.list().length, 2)

  assert.equal(isLegacyGeneral(generalFallbackStrategy), true, 'general 兜底应标记为 legacy')
  assert.equal(isLegacyGeneral(research), false)

  // 自定义注册表裁掉 general 时仍保证 fallback 可用
  const custom = createStrategyRegistry([research])
  assert.equal(custom.get('planning'), generalFallbackStrategy)
  console.log('✓ cp3 registry fallback / 版本可审计')
}

// cp4. compiler 协议:标记段解析 → 四组记录 / 缺口 / 优化稿;Markdown 回退;垃圾输出降级
{
  const protocol = buildCompilerProtocol('zh')
  for (const marker of Object.values(COMPILE_MARKERS)) {
    assert.ok(protocol.includes(marker), `协议必须包含标记 ${marker}`)
  }
  assert.ok(buildCompilerProtocol('en').includes(COMPILE_MARKERS.optimized))

  const marked = [
    COMPILE_MARKERS.diagnosis,
    '目标清晰度:目标明确 | 约束边界:时长未说明',
    COMPILE_MARKERS.explicit,
    '- 研究 Mac 上用 ComfyUI 做 AI 视频 [quote: Mac M1 Pro 32GB] [quote: ComfyUI]',
    COMPILE_MARKERS.context,
    '- (无)',
    COMPILE_MARKERS.suggested,
    '- 建议(可忽略) 补充目标产出形式',
    COMPILE_MARKERS.unknown,
    '- [待补充: 期望的视频时长,决定显存选择]',
    COMPILE_MARKERS.optimized,
    '## Background（背景）\n- 用户机器为 Mac M1 Pro 32GB',
    COMPILE_MARKERS.end,
  ].join('\n')
  const sections = parseCompileOutput(marked)
  assert.equal(sections.wellFormed, true)
  assert.match(sections.diagnosis, /目标清晰度/)
  assert.equal(sections.explicit_requirements.length, 1)
  assert.equal(sections.explicit_requirements[0].source, 'USER_EXPLICIT')
  assert.deepEqual(sections.explicit_requirements[0].evidence, ['Mac M1 Pro 32GB', 'ComfyUI'])
  assert.equal(sections.explicit_requirements[0].text, '研究 Mac 上用 ComfyUI 做 AI 视频')
  assert.equal(sections.context_requirements.length, 0, '(无) 不应产生记录')
  assert.equal(sections.suggested_requirements.length, 1)
  assert.equal(sections.suggested_requirements[0].text, '补充目标产出形式', '建议标签应被剥离')
  assert.equal(sections.unknowns.length, 1)
  assert.deepEqual(sections.missing_constraints, [{ id: 'mc-unknown-1', label: '期望的视频时长,决定显存选择' }])
  assert.match(sections.optimized_prompt, /Mac M1 Pro 32GB/)
  assert.ok(!sections.optimized_prompt.includes(COMPILE_MARKERS.end))

  // Markdown 四段标题回退
  const markdown = [
    '## 明确要求',
    '- 研究 Mac 方案 [quote: Mac M1 Pro 32GB]',
    '## 优化后的 Research Prompt',
    '### Background（背景）',
    '- 背景内容',
  ].join('\n')
  const mdSections = parseCompileOutput(markdown)
  assert.equal(mdSections.wellFormed, true)
  assert.equal(mdSections.explicit_requirements.length, 1)
  assert.match(mdSections.optimized_prompt, /背景内容/)

  // 完全不符合协议:整段降级为优化稿,wellFormed=false
  const garbage = parseCompileOutput('就是一段没有任何标记的普通文字')
  assert.equal(garbage.wellFormed, false)
  assert.equal(garbage.optimized_prompt, '就是一段没有任何标记的普通文字')
  assert.deepEqual(garbage.explicit_requirements, [])
  console.log('✓ cp4 compiler 协议解析 / Markdown 回退 / 降级')
}

// cp5. finalizeCompile:真实案例四组来源 → provenance_ok=true;伪造 quote → false;守卫触发 → false
{
  const classifier = {
    prompt_type: 'research',
    confidence_internal: 0.86,
    missing_constraints: ['期望的视频时长'],
    rationale: '研究诉求',
    evidence_quotes: ['Mac M1 Pro 32GB'],
  }
  const missing = [{ id: 'mc-classifier-1', label: '期望的视频时长' }]
  const vars = {
    raw_input: REAL_CASE,
    context_turns: [{ role: 'user', text: '我的机器是 Mac M1 Pro 32GB' }],
    workspace_metadata: {},
    missing_constraints: missing,
  }
  const payload = buildCompilePayload(research, vars, { language: 'zh', mode: 'full' })
  assert.match(payload.system, /COMPILE|<<<DIAGNOSIS>>>|机器可解析输出协议/)
  assert.match(payload.user, /<prompt-draft>/)

  const good = [
    COMPILE_MARKERS.diagnosis,
    '目标清晰度:目标明确',
    COMPILE_MARKERS.explicit,
    '- 研究目标:Mac 上用 ComfyUI 做 AI 视频 [quote: Mac M1 Pro 32GB] [quote: ComfyUI]',
    COMPILE_MARKERS.context,
    '- 机器为 Mac M1 Pro 32GB [quote: 我的机器是 Mac M1 Pro 32GB]',
    COMPILE_MARKERS.suggested,
    '- 建议(可忽略) 补充产出形式',
    COMPILE_MARKERS.unknown,
    '- [待补充: 期望时长]',
    COMPILE_MARKERS.optimized,
    '## Candidate Approaches（候选方案）\n- 黑鹤001:候选,待验证\n- H3:候选,待验证\n## Evidence Gaps（证据缺口）\n- [待补充: Mac 实测案例]',
    COMPILE_MARKERS.end,
  ].join('\n')
  const outcome = finalizeCompile(research, good, {
    rawInput: REAL_CASE,
    contextTurns: [...vars.context_turns],
    classifier,
    missing,
    mode: 'full',
  })
  assert.equal(outcome.result.provenance_ok, true)
  assert.equal(outcome.wellFormed, true)
  assert.equal(outcome.result.confidence_level, 'High')
  assert.equal(outcome.result.strategy_version, '0.2.0')
  assert.equal(outcome.result.explicit_requirements.length, 1)
  assert.equal(outcome.result.context_requirements.length, 1)
  assert.equal(outcome.result.suggested_requirements.length, 1)
  assert.equal(outcome.result.unknowns.length, 1)
  // classifier 缺口 + 编译器缺口去重合并
  assert.deepEqual(outcome.result.missing_constraints.map((m) => m.label), ['期望的视频时长', '期望时长'])

  // 伪造 quote:explicit 记录只带 raw 中不存在的 quote → provenance_ok=false
  const fake = good.replace(
    '[quote: Mac M1 Pro 32GB] [quote: ComfyUI]',
    '[quote: 这句话根本不在输入里]',
  )
  const bad = finalizeCompile(research, fake, {
    rawInput: REAL_CASE,
    contextTurns: [...vars.context_turns],
    classifier,
    missing,
    mode: 'full',
  })
  assert.equal(bad.result.provenance_ok, false, '伪造 quote 必须让 provenance_ok=false')
  assert.ok(bad.problems.some((p) => p.rule === 'PROVENANCE_EVIDENCE_NOT_IN_RAW'))

  // 守卫触发:无证据强断言「不可行」→ provenance_ok=false
  const drift = good.replace('## Evidence Gaps（证据缺口）', '## Evidence Gaps（证据缺口）\n- H3 不可行,直接淘汰')
  const guarded = finalizeCompile(research, drift, {
    rawInput: REAL_CASE,
    contextTurns: [...vars.context_turns],
    classifier,
    missing,
    mode: 'full',
  })
  assert.equal(guarded.result.provenance_ok, false, '守卫触发必须让 provenance_ok=false')
  assert.ok(guarded.problems.some((p) => p.rule.startsWith('research-')))
  console.log('✓ cp5 finalizeCompile:四组来源 / 伪造 quote / 守卫')
}

// cp6. legacy general:沿用 parseOptimizerOutput,provenance 为空且 ok=true(零回归)
{
  const legacyPayload = buildCompilePayload(generalFallbackStrategy, {
    raw_input: '帮我看看这段代码',
    context_turns: [],
    workspace_metadata: {},
    missing_constraints: [],
  }, { language: 'zh', mode: 'fast', legacy: true })
  assert.ok(!legacyPayload.system.includes('ANALYSIS'), 'fast legacy 不应要求 ANALYSIS')
  assert.ok(legacyPayload.system.includes('OPTIMIZED'))
  assert.equal(legacyPayload.user, '以下是我的提示词草稿:\n\n帮我看看这段代码')

  const outcome = finalizeCompile(generalFallbackStrategy, '<<<OPTIMIZED>>>\n改写后的草稿\n<<<END>>>', {
    rawInput: '帮我看看这段代码',
    contextTurns: [],
    classifier: fallbackClassifierResult(),
    missing: [],
    mode: 'fast',
    legacy: true,
  })
  assert.equal(outcome.result.prompt_type, 'general')
  assert.equal(outcome.result.optimized_prompt, '改写后的草稿')
  assert.equal(outcome.result.provenance_ok, true)
  assert.equal(outcome.wellFormed, true)
  console.log('✓ cp6 legacy general 零回归')
}

console.log('\ncore-pipeline: all passed')
