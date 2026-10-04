/**
 * P07-T02 — `test/regression/run.mjs` runner 自身单测（fake fixtures + scripted adapter）。
 *
 * 目的（任务契约 Tests）：
 *   - 证明 runner 的 deterministic 层能对 fake fixture 给出正确的 PASS / FAIL；
 *   - 证明 **evaluator 不得覆盖 deterministic FAIL**（硬性断言）；
 *   - 证明 evaluator 重跑不一致不计 PASS（S-08 防误伤）；
 *   - 证明 classify / compile 开销测量与按 strategy 聚合的 min/avg/max 正确；
 *   - 证明 manual override 不发分类调用、AUTO 允许 type_alternatives；
 *   - 证明报告遵守 R-2（threshold=null，DEFERRED_TO_P07_CALIBRATION）。
 *
 * 本文件不读写 fixture 目录、不发网络请求、不依赖真实模型。
 */
import assert from 'node:assert/strict'
import { COMPILE_MARKERS, buildCompilerProtocol, finalizeCompile } from '../../lib/core/compiler.js'
import { defaultStrategyRegistry, isLegacyGeneral } from '../../lib/core/registry.js'
import { normalizeQuoteText } from '../../lib/core/provenance.js'
import {
  stripSuggestionQuotedRefs,
  stripSuggestionReason,
} from '../../lib/core/strategies/_shared.js'
import {
  DEFAULT_REPORT_DIR,
  EVALUATOR_PROMPT_ID,
  REPORT_SCHEMA,
  THRESHOLD_STATUS,
  buildReport,
  compileMaxTokens,
  defaultReportPath,
  evaluateInvariant,
  loadFixtures,
  parseArgs,
  parseEvaluatorAnswer,
  runFixture,
  runInvariantCheck,
  runRegression,
  summarizeCosts,
} from './run.mjs'

const M = COMPILE_MARKERS

/** 最小 protocol 输出：optimized_prompt 恰为 text。 */
const asOutput = (text) => [M.optimized, text, M.end].join('\n')

const classifierJson = (type) =>
  JSON.stringify({
    prompt_type: type,
    confidence_internal: 0.9,
    missing_constraints: [],
    rationale: 'scripted',
    evidence_quotes: [],
  })

/**
 * scripted adapter：按 phase 处理；handlers[phase] 可返回字符串或 { text, usage }。
 * `calls` 记录每次调用的 phase / ctx，便于断言「override 时不发分类调用」等。
 */
function scriptedAdapter(handlers) {
  const calls = []
  return {
    name: 'scripted',
    calls,
    async call(ctx) {
      calls.push(ctx)
      const handler = handlers[ctx.phase]
      if (typeof handler !== 'function') {
        throw new Error(`scripted adapter 未提供 phase=${ctx.phase} 的 handler`)
      }
      const out = await handler(ctx)
      return typeof out === 'string' ? { text: out } : out
    },
  }
}

const fakeFixture = (overrides = {}) => ({
  id: 'fake-basic',
  tags: ['coverage'],
  raw_input: '帮我研究 Mac 上的方案 NEEDLE-X',
  context: [],
  expected_type: 'research',
  invariants: [],
  prohibited_drift: ['示例漂移'],
  ...overrides,
})

// ─────────────────────────────────────────────────────────────────────────────
// r1. invariant 逐条判定（require / prohibit / 非法正则）
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.equal(evaluateInvariant({ desc: 'r', require: 'HIT' }, 'xxHITxx').ok, true)
  assert.equal(evaluateInvariant({ desc: 'r', require: 'MISS' }, 'xxHITxx').ok, false)
  assert.equal(evaluateInvariant({ desc: 'p', prohibit: 'BAD' }, 'xxBADxx').ok, false)
  assert.equal(evaluateInvariant({ desc: 'p', prohibit: 'BAD' }, 'xxGOODxx').ok, true)
  assert.equal(evaluateInvariant({ desc: 'bad', require: '(' }, 'xxx').ok, false)
  console.log('✓ rr1 evaluateInvariant: require / prohibit / 非法正则 fail-closed')
}

// ─────────────────────────────────────────────────────────────────────────────
// r2. deterministic PASS / FAIL 判定 + overall 语义
// ─────────────────────────────────────────────────────────────────────────────
{
  const passFixture = fakeFixture({
    id: 'fake-pass',
    invariants: [{ desc: '必须包含 NEEDLE-X', require: 'NEEDLE-X' }],
  })
  const passAdapter = scriptedAdapter({
    classify: () => classifierJson('research'),
    compile: () => asOutput('NEEDLE-X 已覆盖'),
  })
  const passRun = await runRegression({ fixtures: [passFixture], adapter: passAdapter })
  assert.equal(passRun.results[0].overall, 'PASS')
  assert.equal(passRun.results[0].deterministic.ok, true)
  assert.equal(passRun.totals.deterministic_pass, 1)
  assert.equal(passRun.totals.deterministic_fail, 0)

  const failFixture = fakeFixture({
    id: 'fake-fail',
    invariants: [{ desc: '不得出现 FORBIDDEN-Y', prohibit: 'FORBIDDEN-Y' }],
  })
  const failAdapter = scriptedAdapter({
    classify: () => classifierJson('research'),
    compile: () => asOutput('这里出现了 FORBIDDEN-Y'),
  })
  const failRun = await runRegression({ fixtures: [failFixture], adapter: failAdapter })
  assert.equal(failRun.results[0].overall, 'FAIL')
  assert.equal(failRun.results[0].deterministic.violations, 1)
  console.log('✓ rr2 deterministic require/prohibit → PASS / FAIL')
}

// ─────────────────────────────────────────────────────────────────────────────
// r3. evaluator 不得覆盖 deterministic FAIL（硬性断言）
// ─────────────────────────────────────────────────────────────────────────────
{
  const fixture = fakeFixture({
    id: 'fake-eval-cannot-override',
    invariants: [{ desc: '必须包含 NEEDLE-MISSING', require: 'NEEDLE-MISSING' }],
    effect: { evaluator_prompt_id: EVALUATOR_PROMPT_ID, questions: ['优化稿是否更准确？'] },
  })
  const adapter = scriptedAdapter({
    classify: () => classifierJson('research'),
    compile: () => asOutput('完全没有那个关键词'),
    evaluator: () => JSON.stringify({ answer: 'yes', reason: 'evaluator 认为很好' }),
  })
  const run = await runRegression({ fixtures: [fixture], adapter, mode: 'all' })
  const result = run.results[0]
  assert.equal(result.deterministic.ok, false, 'deterministic 必须 FAIL')
  assert.equal(result.evaluator.verdict, 'pass', 'evaluator 参考线给 pass')
  assert.equal(result.overall, 'FAIL', 'evaluator 绝不能把 deterministic FAIL 翻成 PASS')
  assert.equal(result.evaluator_used, true)
  assert.equal(result.reference_mismatch, false, 'deterministic FAIL 时不构成「参考线不一致」')
  console.log('✓ rr3 evaluator 不得覆盖 deterministic FAIL（硬 Gate 只在 deterministic）')
}

// ─────────────────────────────────────────────────────────────────────────────
// r4. evaluator 重跑不一致不计 PASS（S-08）
// ─────────────────────────────────────────────────────────────────────────────
{
  const fixture = fakeFixture({
    id: 'fake-eval-inconsistent',
    invariants: [{ desc: '硬断言缺失', require: 'NEEDLE-MISSING' }],
    effect: { evaluator_prompt_id: EVALUATOR_PROMPT_ID, questions: ['q1'] },
  })
  const queue = ['no', 'yes']
  const adapter = scriptedAdapter({
    classify: () => classifierJson('research'),
    compile: () => asOutput('无关键词'),
    evaluator: () => JSON.stringify({ answer: queue.shift(), reason: '重跑不同' }),
  })
  const run = await runRegression({ fixtures: [fixture], adapter, mode: 'all' })
  const result = run.results[0]
  assert.equal(result.evaluator.verdict, 'inconsistent')
  assert.equal(result.evaluator.questions[0].stable, false)
  assert.equal(result.evaluator.questions[0].attempts.length, 2)
  assert.notEqual(result.overall, 'PASS')
  console.log('✓ rr4 evaluator 重跑不一致不计 PASS（inconsistent）')
}

// ─────────────────────────────────────────────────────────────────────────────
// r5. 开销测量：classify / compile 分别测量 + 按 strategy 聚合 min/avg/max
// ─────────────────────────────────────────────────────────────────────────────
{
  const fixtures = [
    fakeFixture({ id: 'fake-cost-a', invariants: [{ desc: 'r', require: 'OK' }] }),
    fakeFixture({ id: 'fake-cost-b', invariants: [{ desc: 'r', require: 'OK' }] }),
  ]
  const adapter = scriptedAdapter({
    classify: () => classifierJson('research'),
    compile: () => ({ text: asOutput('OK'), usage: { prompt_tokens: 123, completion_tokens: 45 } }),
  })
  const run = await runRegression({ fixtures, adapter })
  const research = run.costs.research
  assert.equal(research.classify.calls, 2, 'classify 每次调用分别测量')
  assert.equal(research.compile.calls, 2, 'compile 每次调用分别测量')
  for (const phase of ['classify', 'compile']) {
    const bucket = research[phase]
    assert.ok(bucket.system_tokens.max > 0, `${phase} 必须记录 system prompt token`)
    assert.ok(bucket.context_tokens.max > 0, `${phase} 必须记录 context token`)
    assert.ok(bucket.total_input_tokens.max > 0, `${phase} 必须记录 total input token`)
    assert.ok(bucket.latency_ms.min >= 0 && bucket.latency_ms.max >= bucket.latency_ms.min)
  }
  // classify 无 usage → total = system + context 估算；compile 有 usage → 采用真实 prompt_tokens。
  assert.equal(
    research.classify.total_input_tokens.max,
    research.classify.system_tokens.max + research.classify.context_tokens.max,
  )
  assert.equal(research.compile.actual_prompt_tokens.avg, 123, '真实 usage 可用时优先采用')
  assert.ok(research._total.calls === 4, 'strategy 级合计 = classify + compile')
  console.log('✓ rr5 开销测量:classify/compile 分测 + min/avg/max + usage 优先')
}

// ─────────────────────────────────────────────────────────────────────────────
// r6. manual override 不发分类调用；AUTO 允许 type_alternatives
// ─────────────────────────────────────────────────────────────────────────────
{
  const overrideFixture = fakeFixture({
    id: 'fake-override',
    expected_type: 'research',
    manual_override: 'planning',
    invariants: [{ desc: 'r', require: 'OK' }],
  })
  const overrideAdapter = scriptedAdapter({
    classify: () => {
      throw new Error('manual override 时不得发起分类调用')
    },
    compile: () => asOutput('OK'),
  })
  const overrideRun = await runRegression({ fixtures: [overrideFixture], adapter: overrideAdapter })
  assert.equal(overrideRun.results[0].overridden, true)
  assert.equal(overrideRun.results[0].resolved_type, 'planning')
  assert.equal(overrideRun.results[0].classification.ok, true)
  assert.equal(
    overrideAdapter.calls.some((call) => call.phase === 'classify'),
    false,
    'override 路径必须完全跳过分类',
  )

  const altFixture = fakeFixture({
    id: 'fake-alt',
    type_alternatives: ['planning'],
    invariants: [{ desc: 'r', require: 'OK' }],
  })
  const altAdapter = scriptedAdapter({
    classify: () => classifierJson('planning'),
    compile: () => asOutput('OK'),
  })
  const altRun = await runRegression({ fixtures: [altFixture], adapter: altAdapter })
  assert.equal(altRun.results[0].classification.ok, true, '次优分类应被接受')

  const mismatchAdapter = scriptedAdapter({
    classify: () => classifierJson('general'),
    compile: () => asOutput('OK'),
  })
  const mismatchRun = await runRegression({ fixtures: [altFixture], adapter: mismatchAdapter })
  assert.equal(mismatchRun.results[0].classification.ok, false, '集合外分类必须判 FAIL 证据')
  console.log('✓ rr6 manual override 旁路分类 / AUTO type_alternatives 容错')
}

// ─────────────────────────────────────────────────────────────────────────────
// r7. invariant_checks 运行期判定（阻塞句式 / 建议升级）
// ─────────────────────────────────────────────────────────────────────────────
{
  const fixture = fakeFixture({
    id: 'fake-checks',
    invariants: [],
    invariant_checks: [{ id: 'unknown-not-blocking', desc: '不得阻塞' }],
  })
  const adapter = scriptedAdapter({
    classify: () => classifierJson('research'),
    compile: () => asOutput('请先回答以下问题后才能继续'),
  })
  const run = await runRegression({ fixtures: [fixture], adapter })
  const check = run.results[0].deterministic.invariant_checks[0]
  assert.equal(check.ok, false)
  assert.match(check.detail, /阻塞句式/)
  assert.equal(run.results[0].overall, 'FAIL')

  const cleanCtx = (result) => ({
    fixture: {},
    result,
    plan: {},
    rawOutput: '',
    surface: '',
    problems: [],
  })
  const leaked = runInvariantCheck(
    { id: 'suggested-not-upgraded', desc: '', params: {} },
    cleanCtx({
      suggested_requirements: [{ text: '加背景音乐' }],
      explicit_requirements: [{ text: '加背景音乐' }],
      context_requirements: [],
    }),
  )
  assert.equal(leaked.ok, false)
  const clean = runInvariantCheck(
    { id: 'suggested-not-upgraded', desc: '', params: {} },
    cleanCtx({
      suggested_requirements: [{ text: '加背景音乐' }],
      explicit_requirements: [{ text: '使用温柔风格' }],
      context_requirements: [],
    }),
  )
  assert.equal(clean.ok, true)
  const unknown = runInvariantCheck(
    { id: 'does-not-exist', desc: 'unknown id', params: {} },
    cleanCtx({ explicit_requirements: [], context_requirements: [] }),
  )
  assert.equal(unknown.ok, false, '未知 canonical id 必须 fail-closed')
  console.log('✓ rr7 invariant_checks:阻塞句式/建议升级/未知 id fail-closed')
}

// ─────────────────────────────────────────────────────────────────────────────
// r8. summarizeCosts min/avg/max 纯函数
// ─────────────────────────────────────────────────────────────────────────────
{
  const costs = summarizeCosts([
    { strategy: 'x', phase: 'compile', system_tokens: 10, context_tokens: 20, total_input_tokens: 30, latency_ms: 100, actual_prompt_tokens: null },
    { strategy: 'x', phase: 'compile', system_tokens: 20, context_tokens: 40, total_input_tokens: 60, latency_ms: 300, actual_prompt_tokens: null },
  ])
  assert.deepEqual(costs.x.compile.system_tokens, { min: 10, avg: 15, max: 20 })
  assert.deepEqual(costs.x.compile.context_tokens, { min: 20, avg: 30, max: 40 })
  assert.deepEqual(costs.x.compile.latency_ms, { min: 100, avg: 200, max: 300 })
  assert.equal(costs.x.compile.actual_prompt_tokens, null)
  console.log('✓ rr8 summarizeCosts min/avg/max 正确')
}

// ─────────────────────────────────────────────────────────────────────────────
// r9. CLI 解析 / evaluator 解析 / 报告纪律（R-2）
// ─────────────────────────────────────────────────────────────────────────────
{
  const options = parseArgs(['--mode', 'all', '--fixture', 'a,b', '--adapter', 'mock', '--no-report'])
  assert.equal(options.mode, 'all')
  assert.deepEqual(options.fixtures, ['a', 'b'])
  assert.equal(options.writeReport, false)

  assert.throws(() => parseArgs(['--mode', 'bogus']), /--mode/)
  assert.throws(() => parseArgs(['--adapter', 'external']), /--external/)
  assert.throws(() => parseArgs(['--unknown-flag']), /未知参数/)

  assert.equal(parseEvaluatorAnswer('```json\n{"answer":"yes","reason":"r"}\n```').answer, 'yes')
  assert.equal(parseEvaluatorAnswer('{"answer":"no","reason":"r"}').answer, 'no')
  assert.equal(parseEvaluatorAnswer('完全不是 JSON').answer, 'unknown')

  assert.match(defaultReportPath(new Date('2026-10-04T00:00:00Z')), /report-2026-10-04\.json$/)
  assert.ok(defaultReportPath().startsWith(DEFAULT_REPORT_DIR))

  const report = buildReport({
    mode: 'deterministic',
    adapterName: 'mock',
    run: { totals: { fixtures: 0 }, costs: {}, results: [] },
    generatedAt: '2026-10-04T00:00:00.000Z',
  })
  assert.equal(report.schema, REPORT_SCHEMA)
  assert.equal(report.evaluator_prompt_id, EVALUATOR_PROMPT_ID)
  assert.equal(report.threshold, null, 'R-2:未校准前不得设阈值')
  assert.equal(report.threshold_status, THRESHOLD_STATUS)
  assert.equal(report.gate, 'deterministic')

  await assert.rejects(() => runRegression({ fixtures: [] }), /adapter/)
  console.log('✓ rr9 CLI / evaluator 解析 / 报告 R-2 纪律')
}

// ─────────────────────────────────────────────────────────────────────────────
// r10. 真实语料可被 runner 加载（14 例，与 schema.test 同一目录）
// ─────────────────────────────────────────────────────────────────────────────
{
  const fixtures = loadFixtures()
  assert.equal(fixtures.length, 14, 'P07-T01 定稿语料应为 14 例')
  assert.ok(fixtures.every((fixture) => Array.isArray(fixture.context)))
  assert.ok(fixtures.some((fixture) => fixture.id === 'assistant-only-context-not-user-decision'))
  console.log('✓ rr10 loadFixtures:14 例语料可加载（context 已归一化）')
}

// ─────────────────────────────────────────────────────────────────────────────
// r11. compile maxTokens 必须镜像 host（默认 8192 + 跟随输入长度，32768 封顶）
// ─────────────────────────────────────────────────────────────────────────────
{
  // 默认下限 = host Config.maxTokens(8192)；短输入不得低于它。
  assert.equal(compileMaxTokens({ raw_input: '短输入' }), 8192)
  // 跟随输入长度：ASCII 长草稿按 4 字符/token 估算 ×2，抬高上限。
  const long = 'x'.repeat(20000)
  assert.equal(compileMaxTokens({ raw_input: long }), Math.max(8192, Math.ceil(20000 / 4) * 2))
  assert.ok(compileMaxTokens({ raw_input: long }) > 8192)
  // autoMaxTokens 关闭 → 固定值（host cfg.autoMaxTokens === false 分支）。
  assert.equal(compileMaxTokens({ raw_input: long }, { maxTokens: 4096, autoMaxTokens: false }), 4096)
  // 32768 封顶。
  assert.equal(compileMaxTokens({ raw_input: 'x'.repeat(1000000) }), 32768)
  // CLI 解析：默认镜像 host；显式覆盖；非法值 fail-fast。
  assert.equal(parseArgs([]).maxTokens, 8192)
  assert.equal(parseArgs([]).autoMaxTokens, true)
  assert.equal(parseArgs(['--max-tokens', '4096']).maxTokens, 4096)
  assert.equal(parseArgs(['--no-auto-max-tokens']).autoMaxTokens, false)
  assert.throws(() => parseArgs(['--max-tokens', '1']), /max-tokens/)

  // 端到端：compile 调用必须真的带上该上限（旧实现漏传 → live adapter 落 2048 截断）。
  let compileCtx = null
  const adapter = scriptedAdapter({
    classify: () => classifierJson('research'),
    compile: (ctx) => {
      compileCtx = ctx
      return asOutput('OK')
    },
  })
  const run = await runRegression({
    fixtures: [fakeFixture({ id: 'fake-maxtokens', invariants: [{ desc: 'r', require: 'OK' }] })],
    adapter,
  })
  assert.equal(compileCtx.maxTokens, 8192, 'compile 调用必须显式携带 host 保真的 maxTokens')
  assert.equal(run.results[0].compile_max_tokens, 8192)
  console.log('✓ rr11 compile maxTokens 镜像 host（8192 + auto，未再落 2048 截断）')
}

// ─────────────────────────────────────────────────────────────────────────────
// r12. finalizeCompile 未知项同话题去重（G-4 #2 落地证据）
// ─────────────────────────────────────────────────────────────────────────────
{
  const strategy = defaultStrategyRegistry.get('planning')
  const rawText = [
    '<<<EXPLICIT>>>',
    '- 帮我规划 [quote: 帮我规划]',
    '<<<CONTEXT>>>',
    '- (无)',
    '<<<SUGGESTED>>>',
    '- (无)',
    '<<<UNKNOWN>>>',
    '预算方面我还没定，预算边界先空着，需注入[待补充:预算边界]',
    '工期约束也没想好',
    '时间上你给个提示就行',
    '<<<OPTIMIZED>>>',
    '# Goal（目标）\n仅框架',
    '<<<END>>>',
  ].join('\n')
  const outcome = finalizeCompile(strategy, rawText, {
    rawInput: '帮我规划。预算方面我还没定，预算边界先空着，工期约束也没想好，时间上你给个提示就行。',
    contextTurns: [],
    classifier: { confidence_internal: 0.9 },
    missing: [],
    mode: 'full',
    legacy: isLegacyGeneral(strategy),
  })
  const labels = outcome.result.missing_constraints.map((m) => m.label)
  assert.equal(
    labels.filter((l) => l.includes('预算')).length,
    1,
    `预算话题只保留一条，实际 ${labels.join(' | ')}`,
  )
  assert.equal(
    labels.filter((l) => /工期|时间/.test(l)).length,
    1,
    `工期/时间同一话题只保留一条，实际 ${labels.join(' | ')}`,
  )
  assert.ok(
    !outcome.result.optimized_prompt.includes('需注入[待补充'),
    '注入占位符必须剥离内嵌 [待补充: …] 标记',
  )
  console.log('✓ rr12 未知项同话题去重（预算/工期·时间各一条 + 剥内嵌占位符）')
}

// ─────────────────────────────────────────────────────────────────────────────
// r13. 建议条目剥离触发理由 / 用户原话引用（P07-T03 实测：理由引用导致误判升级）
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.equal(stripSuggestionReason('回退用 git 恢复（触发理由：「失败就回退」未指明粒度）'), '回退用 git 恢复')
  assert.equal(stripSuggestionReason('按周拆分。理由：用户要求按月'), '按周拆分')
  assert.equal(stripSuggestionQuotedRefs('作为「每步可回退」的落地机制'), '作为的落地机制')
  console.log('✓ rr13 建议条目剥离触发理由与引号引用片段')
}

// ─────────────────────────────────────────────────────────────────────────────
// r14. 编译纪律文案落盘（P07-T03 修复轮：对象前置 / 争议转述 / 平台原词 / 执行时态 / 可追溯）
// ─────────────────────────────────────────────────────────────────────────────
{
  const zh = buildCompilerProtocol('zh')
  const en = buildCompilerProtocol('en')
  for (const kw of ['对象前置', '只能 CUDA', 'Mac M1 Pro', '已执行', '可回追']) {
    assert.ok(zh.includes(kw), `zh 编译纪律应包含「${kw}」`)
  }
  for (const kw of ['object-first', 'only CUDA', 'Mac M1 Pro', 'execution wording', 'traceable']) {
    assert.ok(en.includes(kw), `en 编译纪律应包含「${kw}」`)
  }
  console.log('✓ rr14 编译纪律文案落盘（对象前置/争议转述/平台原词/执行时态/可追溯）')
}

// ─────────────────────────────────────────────────────────────────────────────
// r15. execution 守卫：编号标题也能识别执行段骨架；纯规划标题仍触发
// ─────────────────────────────────────────────────────────────────────────────
{
  const guards = defaultStrategyRegistry.get('execution').guards
  const guard = guards.find((g) => g.id === 'execution-not-planning-dominated')
  assert.ok(guard, 'execution 守卫应存在')
  const minimal = { explicit_requirements: [], context_requirements: [] }
  const good =
    '### 1. Current Task\n### 2. Goal\n### 3. Allowed Scope\n### 4. Exact Actions\n### 5. Forbidden Scope\n### 6. Handoff'
  assert.equal(guard.check(good, minimal, ''), null, '编号标题应识别为执行段骨架')
  const bad = '### 1. Goals\n### 2. Milestones\n### 3. Roadmap'
  assert.ok(guard.check(bad, minimal, ''), '纯规划标题应触发守卫')
  console.log('✓ rr15 execution 守卫支持编号标题（### 1. Current Task）')
}

// ─────────────────────────────────────────────────────────────────────────────
// r16. planning 守卫：元说明豁免 + 阶段去重计数（P07-T03 实测两处误报）
// ─────────────────────────────────────────────────────────────────────────────
{
  const guards = defaultStrategyRegistry.get('planning').guards
  const execGuard = guards.find((g) => g.id === 'planning-no-execution-evidence')
  const phaseGuard = guards.find((g) => g.id === 'planning-phase-requires-acceptance')
  assert.ok(execGuard && phaseGuard, 'planning 守卫应存在')
  const minimal = { explicit_requirements: [], context_requirements: [] }
  assert.equal(
    execGuard.check('# Goal\n保证 16 段齐全且无「已执行」类措辞。', minimal, ''),
    null,
    '「无『已执行』类措辞」元说明不得触发执行证据守卫',
  )
  assert.ok(execGuard.check('# Goal\n上周已完成实现。', minimal, ''), '真实执行证据仍应触发')
  const repeated =
    [
      'Phase 1 任务一',
      'Phase 2 任务二',
      'Phase 3 任务三',
      'Phase 4 任务四',
      'Phase 1 步骤',
      'Phase 2 步骤',
      'Phase 3 步骤',
      'Phase 4 步骤',
      'Acceptance 1',
      'Acceptance 2',
      'Acceptance 3',
      'Acceptance 4',
    ].join('\n')
  assert.equal(phaseGuard.check(repeated, minimal, ''), null, '去重后 4 阶段均有验收，不得误判')
  console.log('✓ rr16 planning 守卫：元说明豁免 + 阶段去重计数')
}

// ─────────────────────────────────────────────────────────────────────────────
// r17. provenance 全角/半角标点归一（P07-T03 实测：模型引原话时转半角导致误判）
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.equal(
    normalizeQuoteText('我看到一半说法是 MPS 可以,另一半说只能 CUDA,到底哪个对?'),
    normalizeQuoteText('我看到一半说法是 MPS 可以，另一半说只能 CUDA，到底哪个对？'),
    '全角/半角标点应归一为同一文本',
  )
  assert.equal(
    normalizeQuoteText('“预算、边界”'),
    normalizeQuoteText('「预算、边界」'),
    '引号/书名号类角标应作为边缘噪声剥离',
  )
  console.log('✓ rr17 provenance 全角/半角标点归一（quote 字面比对不再误判）')
}

console.log('\ntest/regression/run.test.mjs: all regression runner tests passed')