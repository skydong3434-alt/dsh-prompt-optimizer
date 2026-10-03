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
import { COMPILE_MARKERS } from '../../lib/core/compiler.js'
import {
  DEFAULT_REPORT_DIR,
  EVALUATOR_PROMPT_ID,
  REPORT_SCHEMA,
  THRESHOLD_STATUS,
  buildReport,
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

console.log('\ntest/regression/run.test.mjs: all regression runner tests passed')
