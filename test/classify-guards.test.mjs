/**
 * P03-T03 — 防误判规则与 Manual Override 测试契约。
 *
 * 把 PLAN-v1 §6 的三条产品级纪律固化成机器门禁（S-06「分类不稳」检查点）：
 *   1. 主类型选择依据「当前输入」；历史讨论只作背景，不得覆盖当前请求；
 *   2. assistant / agent 发言 ≠ 用户决定：永不能产生 explicit 来源证据；
 *   3. 手动 override（promptType）直达 compiler，函数级不调用分类器。
 *
 * 另含 S-06 抽查：固定 mock 输出下，同一输入多次分类必须得到完全一致的结果
 * （纯函数 + 无时间戳/随机），并把抽查结论记录到 docs/classifier.md。
 *
 * 语料见 test/fixtures/classify-guards.mjs；本文件只做断言，不改产品代码。
 * 运行：先 `npm run build`，再 `node test/classify-guards.test.mjs`。
 */
import assert from 'node:assert/strict'
import {
  CLASSIFY_ISSUE,
  MULTI_INTENT_NOTE,
  buildClassifierSystem,
  buildClassifierUser,
  classifyViaLlm,
  fallbackClassifierResult,
  looksMultiIntent,
  manualClassifierResult,
  parseClassifierOutput,
  parsePromptTypeInput,
} from '../lib/core/classify.js'
import {
  PROVENANCE_RULE,
  makeProvenanceRecord,
  resolveQuoteSource,
  validateProvenance,
} from '../lib/core/provenance.js'
import {
  CLASSIFY_GUARD_FIXTURES,
  REQUIRED_GUARD_CATEGORIES,
  STABILITY_RAW_INPUT,
} from './fixtures/classify-guards.mjs'

const ROUTE = { provider: 'mock-provider', model: 'mock-model' }
const STABILITY_RUNS = 3

/** 解析结论的稳定签名：不含耗时/时间戳，用于「同输入同结果」断言。 */
function parseSignature(outcome) {
  return JSON.stringify({
    result: outcome.result,
    degraded: outcome.meta.degraded,
    issues: outcome.meta.issues,
    unknownTypeFallback: outcome.meta.unknownTypeFallback,
    droppedEvidence: outcome.meta.droppedEvidence,
    lowConfidence: outcome.meta.lowConfidence,
    multiIntent: outcome.meta.multiIntent,
  })
}

/** classifyViaLlm 结论的稳定签名：刻意排除 durationMs（墙钟不是确定性的一部分）。 */
function classifySignature(outcome) {
  return JSON.stringify({
    result: outcome.result,
    meta: outcome.meta,
    degraded: outcome.degraded,
    aborted: outcome.aborted,
    timedOut: outcome.timedOut,
    usedFallback: outcome.usedFallback,
    failure: outcome.failure,
    request: outcome.request,
  })
}

/** 确定性 mock llm：固定返回 payload，记录调用次数与参数。 */
function makeMockLlm(payload, efforts = [{ id: 'low', name: 'Low' }]) {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      yield { type: 'text-delta', index: 0, text: payload }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    async resolveModelInfo() {
      return { reasoning: { efforts } }
    },
  }
}

/**
 * 函数级 override 旁路：与 PLAN-v1 §6 记载的 handler 语义同构——
 * promptType 合法即直达 manualClassifierResult，分类器一次都不调用。
 */
async function resolveType({ promptType, llm, rawInput, contextTurns }) {
  const override = parsePromptTypeInput(promptType)
  if (override !== undefined) {
    return { source: 'override', result: manualClassifierResult(override) }
  }
  const outcome = await classifyViaLlm(llm, ROUTE, {
    raw_input: rawInput,
    context_turns: contextTurns,
  })
  return { source: 'auto', result: outcome.result }
}

const stability = { runs: STABILITY_RUNS, fixtures: CLASSIFY_GUARD_FIXTURES.length, stable: true }

// ─────────────────────────────────────────────────────────────────────────────
// g1. fixtures 完备性：五类场景齐全、id 唯一、期望自洽
// ─────────────────────────────────────────────────────────────────────────────
{
  const ids = CLASSIFY_GUARD_FIXTURES.map((fixture) => fixture.id)
  assert.equal(new Set(ids).size, ids.length, 'fixture id 必须唯一')

  const categories = new Set(CLASSIFY_GUARD_FIXTURES.map((fixture) => fixture.category))
  for (const required of REQUIRED_GUARD_CATEGORIES) {
    assert.ok(categories.has(required), `必须覆盖场景类别 ${required}`)
  }

  for (const fixture of CLASSIFY_GUARD_FIXTURES) {
    assert.ok(fixture.raw_input.trim(), `${fixture.id}: raw_input 不得为空`)
    assert.ok(fixture.mock_output.trim().startsWith('{'), `${fixture.id}: mock_output 必须是 JSON`)
    assert.ok(fixture.expect.type, `${fixture.id}: 缺少 expect.type`)
    // kept / dropped 不得重复，且两者无交集
    const kept = new Set(fixture.expect.kept ?? [])
    for (const quote of fixture.expect.dropped ?? []) {
      assert.ok(!kept.has(quote), `${fixture.id}: quote 不能同时 kept 与 dropped`)
    }
    for (const item of fixture.expect.resolution ?? []) {
      assert.equal(item.valid, item.source !== 'UNKNOWN', `${fixture.id}: valid 与 source 必须自洽`)
    }
  }
  console.log(`✓ g1 fixtures 完备：${ids.length} 例，场景 ${[...categories].join('/')}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// g2. 防误判三规则写进 system prompt（产品纪律的提示词侧锚点）
// ─────────────────────────────────────────────────────────────────────────────
{
  const zh = buildClassifierSystem('zh')
  assert.match(zh, /以「当前输入」为判断对象/, '规则 1：以当前输入为判断对象')
  assert.match(zh, /历史讨论仅供参考,不得用历史话题覆盖当前请求/, '规则 1 必须禁止历史覆盖当前')
  assert.match(zh, /区分「当前请求」与「之前讨论过的内容」/, '规则 2：区分当前请求与历史讨论')
  assert.match(zh, /助手 \/ Agent 的建议不等于用户决定/, '规则 3：assistant 建议≠用户决定')
  assert.match(zh, /evidence_quotes 只能引用用户自己的发言/, '规则 3 必须限定证据只能是用户发言')
  assert.match(zh, /不得把助手的提议、结论或猜测当作依据/, '规则 3 必须禁止助手结论作依据')
  console.log('✓ g2 system prompt 含防误判三规则（禁止历史覆盖当前）')
}

// ─────────────────────────────────────────────────────────────────────────────
// g3. user 载荷：当前输入原样且在最后；历史只标注为参考
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const fixture of CLASSIFY_GUARD_FIXTURES) {
    const payload = buildClassifierUser(
      { raw_input: fixture.raw_input, context_turns: fixture.context_turns },
      'zh',
    )
    assert.ok(payload.includes(fixture.raw_input), `${fixture.id}: 当前输入必须原样出现`)
    const draftIndex = payload.indexOf('<prompt-draft>')
    assert.ok(draftIndex >= 0, `${fixture.id}: 必须有 <prompt-draft>`)
    if (fixture.context_turns.length) {
      const contextIndex = payload.indexOf('<conversation-context>')
      assert.ok(contextIndex >= 0, `${fixture.id}: 有历史必须有上下文块`)
      assert.ok(contextIndex < draftIndex, `${fixture.id}: 当前输入必须在历史之后（最后读到）`)
      assert.match(payload, /只有「用户」的发言能作为用户意图证据/, `${fixture.id}: 历史须标注为参考`)
    } else {
      assert.doesNotMatch(payload, /<conversation-context>/, `${fixture.id}: 无历史不得有上下文块`)
    }
  }
  console.log('✓ g3 user 载荷：当前输入置后、历史标注参考')
}

// ─────────────────────────────────────────────────────────────────────────────
// g4. 逐字证据纪律：只有用户发言能进 evidence_quotes；助手/杜撰一律丢弃
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const fixture of CLASSIFY_GUARD_FIXTURES) {
    const outcome = parseClassifierOutput(fixture.mock_output, {
      rawInput: fixture.raw_input,
      contextTurns: fixture.context_turns,
    })
    assert.ok(outcome.result, `${fixture.id}: mock_output 必须可解析`)
    assert.equal(
      outcome.result.prompt_type,
      fixture.expect.type,
      `${fixture.id}: 主类型必须以当前输入为准`,
    )
    assert.deepEqual(
      outcome.result.evidence_quotes,
      fixture.expect.kept,
      `${fixture.id}: 只保留用户发言的逐字证据`,
    )
    assert.equal(
      outcome.meta.droppedEvidence,
      (fixture.expect.dropped ?? []).length,
      `${fixture.id}: 助手/杜撰证据必须被计入丢弃`,
    )
    if ((fixture.expect.dropped ?? []).length) {
      assert.ok(
        outcome.meta.issues.includes(CLASSIFY_ISSUE.evidenceNotVerbatim),
        `${fixture.id}: 丢弃证据必须留稳定 issue`,
      )
    }
    if (fixture.expect.lowConfidence !== undefined) {
      assert.equal(
        outcome.meta.lowConfidence,
        fixture.expect.lowConfidence,
        `${fixture.id}: 低置信标记与阈值一致`,
      )
    }
  }
  console.log('✓ g4 逐字证据：用户发言保留、助手发言丢弃')
}

// ─────────────────────────────────────────────────────────────────────────────
// g5. 来源判定：raw=USER_EXPLICIT，context-user=CONTEXT_EXPLICIT，
//     assistant-only=UNKNOWN（永不升格为用户 explicit）
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const fixture of CLASSIFY_GUARD_FIXTURES) {
    for (const item of fixture.expect.resolution ?? []) {
      const resolution = resolveQuoteSource(
        item.quote,
        fixture.raw_input,
        fixture.context_turns,
      )
      assert.equal(resolution.matchedIn, item.matchedIn, `${fixture.id}: matchedIn 期望`)
      assert.equal(resolution.source, item.source, `${fixture.id}: source 期望`)
      assert.equal(resolution.valid, item.valid, `${fixture.id}: valid 期望`)
      if (item.matchedIn !== 'raw') {
        assert.notEqual(
          resolution.source,
          'USER_EXPLICIT',
          `${fixture.id}: 非本轮 raw 的证据不得判为 USER_EXPLICIT`,
        )
      }
    }
  }
  console.log('✓ g5 来源判定：raw/context-user/assistant-only 三态清晰')
}

// ─────────────────────────────────────────────────────────────────────────────
// g6. assistant 发言不产生 explicit（provenance 机械校验语义）
// ─────────────────────────────────────────────────────────────────────────────
{
  const assistantFixture = CLASSIFY_GUARD_FIXTURES.find((f) => f.category === 'assistant-bg')
  const assistantQuote = assistantFixture.expect.resolution.find(
    (item) => item.matchedIn === 'assistant-only',
  ).quote

  // 6.1 来源解析：assistant-only 一律 invalid / UNKNOWN，绝不 explicit。
  const resolution = resolveQuoteSource(
    assistantQuote,
    assistantFixture.raw_input,
    assistantFixture.context_turns,
  )
  assert.equal(resolution.valid, false)
  assert.equal(resolution.source, 'UNKNOWN')

  // 6.2 就算有人把助手发言塞进 USER_EXPLICIT 记录，校验器也必须发出
  //     assistantOnlyEvidence 告警，而不是把它当成合法 explicit 证据。
  const bogusExplicit = makeProvenanceRecord({
    text: '采用 MiniMax API + 512x512 的组合',
    source: 'USER_EXPLICIT',
    evidence: [assistantQuote],
  })
  const assistantOnlyValidation = validateProvenance(
    [bogusExplicit],
    assistantFixture.raw_input,
    assistantFixture.context_turns,
  )
  const rules = assistantOnlyValidation.problems.map((problem) => problem.rule)
  assert.ok(
    rules.includes(PROVENANCE_RULE.assistantOnlyEvidence),
    '助手发言证据必须触发 assistantOnlyEvidence 告警',
  )
  assert.ok(
    !rules.includes(PROVENANCE_RULE.evidenceNotInRaw),
    '助手发言命中时只发告警，不得再叠加 evidenceNotInRaw',
  )

  // 6.3 对照：真正对不上任何用户发言（杜撰）的证据 → error 级 evidenceNotInRaw。
  const fabricated = makeProvenanceRecord({
    text: '每周自动发布 6 条视频',
    source: 'USER_EXPLICIT',
    evidence: ['用户从未说过这句话'],
  })
  const fabricatedValidation = validateProvenance(
    [fabricated],
    assistantFixture.raw_input,
    assistantFixture.context_turns,
  )
  assert.equal(fabricatedValidation.ok, false, '杜撰证据必须 error')
  assert.ok(
    fabricatedValidation.problems.some(
      (problem) => problem.rule === PROVENANCE_RULE.evidenceNotInRaw,
    ),
    '杜撰证据必须触发 evidenceNotInRaw',
  )
  assert.ok(
    !fabricatedValidation.problems.some(
      (problem) => problem.rule === PROVENANCE_RULE.assistantOnlyEvidence,
    ),
    '杜撰（无处命中）与 assistant-only 必须区分',
  )

  // 6.4 用户自己的否定发言仍然能作 explicit 证据（守卫不是一刀切禁言用户）。
  const negationFixture = CLASSIFY_GUARD_FIXTURES.find((f) => f.category === 'negation')
  const userNegation = negationFixture.expect.resolution.find((item) => item.matchedIn === 'raw')
  const userResolution = resolveQuoteSource(
    userNegation.quote,
    negationFixture.raw_input,
    negationFixture.context_turns,
  )
  assert.equal(userResolution.valid, true)
  assert.equal(userResolution.source, 'USER_EXPLICIT')
  assert.equal(userResolution.confidence, 'high')
  console.log('✓ g6 assistant 发言不产生 explicit（用户否定仍有效）')
}

// ─────────────────────────────────────────────────────────────────────────────
// g7. 多意图：只取主类型、缺口注明，不拆分子请求
// ─────────────────────────────────────────────────────────────────────────────
{
  const fixture = CLASSIFY_GUARD_FIXTURES.find((f) => f.category === 'multi-intent')
  assert.equal(looksMultiIntent(fixture.raw_input), true, '分析+执行必须被识别为多意图')

  const outcome = parseClassifierOutput(fixture.mock_output, {
    rawInput: fixture.raw_input,
    contextTurns: fixture.context_turns,
  })
  assert.equal(outcome.result.prompt_type, 'execution', '主类型由模型给出，不被拆分')
  assert.ok(
    outcome.result.missing_constraints.includes(MULTI_INTENT_NOTE),
    '多意图必须在缺口清单注明',
  )
  for (const label of fixture.expect.missingIncludes ?? []) {
    assert.ok(outcome.result.missing_constraints.includes(label), `既有缺口不得丢失：${label}`)
  }
  assert.equal(outcome.meta.multiIntent, true)
  assert.ok(outcome.meta.issues.includes(CLASSIFY_ISSUE.multiIntent))

  // 对照：单意图的稳定语料不得被误判成多意图。
  assert.equal(looksMultiIntent(STABILITY_RAW_INPUT), false, '「研究并对比」不是规划+执行双意图')
  console.log('✓ g7 多意图：主类型 + 缺口注明（不拆分）')
}

// ─────────────────────────────────────────────────────────────────────────────
// g8. Manual Override 旁路：函数级不调用分类器
// ─────────────────────────────────────────────────────────────────────────────
{
  // 8.1 promptType 解析：闭集内合法才 override，其余走 AUTO。
  for (const type of ['research', 'planning', 'execution', 'diagnostic', 'review', 'creative', 'general']) {
    assert.equal(parsePromptTypeInput(type), type)
  }
  assert.equal(parsePromptTypeInput('Research'), undefined, '大小写不符 = 非法')
  assert.equal(parsePromptTypeInput('bogus'), undefined)
  assert.equal(parsePromptTypeInput(undefined), undefined)
  assert.equal(parsePromptTypeInput(''), undefined)

  // 8.2 manualClassifierResult 是纯函数直接产物：置信度 1、无证据、理由可辨识。
  const manual = manualClassifierResult('creative')
  assert.equal(manual.prompt_type, 'creative')
  assert.equal(manual.confidence_internal, 1)
  assert.deepEqual(manual.evidence_quotes, [])
  assert.deepEqual(manual.missing_constraints, [])
  assert.match(manual.rationale, /手动指定/)

  // 8.3 函数级旁路：override 时 mock llm 的 stream 一次都不能被调用。
  const overrideLlm = makeMockLlm('{"prompt_type":"general","confidence_internal":0.1}')
  const overrideOutcome = await resolveType({
    promptType: 'creative',
    llm: overrideLlm,
    rawInput: '随便写点东西',
    contextTurns: [],
  })
  assert.equal(overrideOutcome.source, 'override')
  assert.equal(overrideOutcome.result.prompt_type, 'creative')
  assert.equal(overrideOutcome.result.confidence_internal, 1)
  assert.equal(overrideLlm.calls.length, 0, 'override 时绝不允许发起分类调用')

  // 8.4 对照：非法/缺省 promptType 才走 AUTO，分类器恰好被调用一次。
  const autoLlm = makeMockLlm(
    '{"prompt_type":"execution","confidence_internal":0.8,"missing_constraints":[],"rationale":"","evidence_quotes":[]}',
  )
  const autoOutcome = await resolveType({
    promptType: 'bogus',
    llm: autoLlm,
    rawInput: '帮我写一段脚本',
    contextTurns: [],
  })
  assert.equal(autoOutcome.source, 'auto')
  assert.equal(autoLlm.calls.length, 1, '非法 override 必须回落到 AUTO')
  assert.equal(autoLlm.calls[0].temperature, 0)
  assert.equal(autoLlm.calls[0].maxTokens, 512)

  // 8.5 无 override 字段同样走 AUTO（旧请求体零回归）。
  const legacyLlm = makeMockLlm(
    '{"prompt_type":"review","confidence_internal":0.7,"missing_constraints":[],"rationale":"","evidence_quotes":[]}',
  )
  const legacyOutcome = await resolveType({
    promptType: undefined,
    llm: legacyLlm,
    rawInput: '帮我看看这段代码',
    contextTurns: [],
  })
  assert.equal(legacyOutcome.source, 'auto')
  assert.equal(legacyLlm.calls.length, 1)
  console.log('✓ g8 override 旁路：函数级零分类调用（非法/缺省回落 AUTO）')
}

// ─────────────────────────────────────────────────────────────────────────────
// g9. S-06 稳定性抽查：固定 mock 下同输入多次同结果（纯函数确定性）
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const fixture of CLASSIFY_GUARD_FIXTURES) {
    const signatures = []
    for (let run = 0; run < STABILITY_RUNS; run += 1) {
      signatures.push(
        parseSignature(
          parseClassifierOutput(fixture.mock_output, {
            rawInput: fixture.raw_input,
            contextTurns: fixture.context_turns,
          }),
        ),
      )
    }
    assert.equal(
      new Set(signatures).size,
      1,
      `${fixture.id}: ${STABILITY_RUNS} 次解析必须完全一致`,
    )
  }

  // 调用侧稳定性：同一 mock 输出、同一输入跑多次，除耗时外完全一致。
  const payload =
    '{"prompt_type":"research","confidence_internal":0.74,"missing_constraints":["时间范围"],' +
    '"rationale":"需要调研","evidence_quotes":["本地部署方案"]}'
  const callSignatures = []
  for (let run = 0; run < STABILITY_RUNS; run += 1) {
    const llm = makeMockLlm(payload)
    const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: STABILITY_RAW_INPUT })
    assert.equal(llm.calls.length, 1)
    callSignatures.push(classifySignature(outcome))
  }
  assert.equal(
    new Set(callSignatures).size,
    1,
    `classifyViaLlm ${STABILITY_RUNS} 次结果必须一致`,
  )

  // 兜底也必须是确定性的（回退 general + 低置信，无随机）。
  const fallbacks = [0, 1, 2].map(() => JSON.stringify(fallbackClassifierResult('分类失败')))
  assert.equal(new Set(fallbacks).size, 1)

  stability.stable = true
  console.log(
    `✓ g9 S-06 稳定性抽查：${CLASSIFY_GUARD_FIXTURES.length} 例 × ${STABILITY_RUNS} 次 + 调用侧 ${STABILITY_RUNS} 次全部一致`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// g10. S-06 检查点摘要（供 docs/classifier.md 记录）
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.equal(stability.stable, true)
  console.log(
    `S-06 CHECKPOINT: stable=${stability.stable} fixtures=${stability.fixtures} runs=${stability.runs} ` +
      `overrideBypass=ok assistantNotExplicit=ok`,
  )
}

console.log('test/classify-guards.test.mjs: all classifier guard tests passed')
