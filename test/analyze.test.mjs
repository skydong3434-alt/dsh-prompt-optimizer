/**
 * v2 Phase 1 —— Analysis(意图 / 目标 / 分诊 / 缺失)解析与调用单测。
 *
 * 覆盖:
 *  - 新契约完整解析(主/辅意图 + 工作模式 + 目标 + 引擎 + 分诊 + 未决项 + 台账);
 *  - **旧分类器 JSON 兼容**(prompt_type / missing_constraints / evidence_quotes 派生);
 *  - 证据与要求的逐字校验(伪造一律丢弃,不升级为用户要求);
 *  - 目标与引擎冲突时采纳引擎(机械证据优先);
 *  - 调用侧:硬参数快照 / 取消 / 超时 / 解析失败兜底(兜底绝不制造阻塞)。
 *
 * 运行:先 `npm run build`,再 `node test/analyze.test.mjs`。
 */
import assert from 'node:assert/strict'
import {
  ANALYSIS_MAX_TOKENS,
  ANALYSIS_TEMPERATURE,
  ANALYSIS_ISSUE,
  ANALYSIS_SYSTEM_MARKER,
  ANALYSIS_OUTPUT_FIELDS,
  buildAnalysisSystem,
  buildAnalysisUser,
  analysisPromptFingerprint,
  parseAnalysisResult,
  fallbackAnalysisResult,
  manualAnalysisResult,
  analyzeViaLlm,
  analysisToClassifier,
  isMetaAnalysisCall,
} from '../lib/core/analyze.js'

const raw = '帮我研究 Mac M1 Pro 32GB 怎么用 ComfyUI 做 AI 视频,我看到黑鹤001低显流,还有 H3……'
const turns = [{ role: 'user', text: '我的机器是 Mac M1 Pro 32GB' }]

const FULL = JSON.stringify({
  primary_intent: 'research',
  supporting_intents: ['planning', 'execution'],
  work_mode: 'exploratory',
  target: 'research',
  target_engine: null,
  edit_triage: 'PATCH',
  triage_reasons: ['任务成立,但缺少产出形式'],
  unknowns: [
    { text: '期望的视频产出形式与时长', classification: 'USER_REQUIRED', blocking: false, rationale: '用户偏好', question: '你想要多长的视频?' },
    { text: 'ComfyUI 在本机的实际可用插件列表', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '执行方可自查' },
  ],
  requirements: [
    { text: '在 Mac M1 Pro 32GB 上做 AI 视频', quote: 'Mac M1 Pro 32GB' },
    { text: '凭空捏造的要求', quote: '用户从没说过这句话' },
  ],
  suggestions: ['补充产出形式与时长'],
  confidence_internal: 0.86,
  rationale: '用户在寻求 Mac 上 ComfyUI 做 AI 视频的研究路径',
  evidence_quotes: ['Mac M1 Pro 32GB', 'ComfyUI', '助手也没说过的假引用'],
})

// 1. 系统 / 用户提示词:契约字段齐全、锚点存在、指纹可复现
{
  const system = buildAnalysisSystem('zh')
  assert.ok(system.includes(ANALYSIS_SYSTEM_MARKER))
  for (const field of ANALYSIS_OUTPUT_FIELDS) {
    assert.ok(system.includes(field.name), `system 必须写明字段 ${field.name}`)
  }
  const en = buildAnalysisSystem('en')
  assert.notEqual(system, en)
  assert.equal(buildAnalysisSystem('zh'), system, '同一语言两次构建必须一致')

  const user = buildAnalysisUser({ raw_input: raw, context_turns: turns }, 'zh')
  assert.ok(user.includes(raw), 'user 必须包含本轮输入')
  assert.ok(user.includes('我的机器是 Mac M1 Pro 32GB'), 'user 必须包含上下文')
  assert.ok(user.includes('<prompt-draft>'))
  assert.equal(
    analysisPromptFingerprint(system, user),
    analysisPromptFingerprint(buildAnalysisSystem('zh'), buildAnalysisUser({ raw_input: raw, context_turns: turns }, 'zh')),
    '指纹必须可复现',
  )
  console.log('✓ an1 system/user 契约 + 指纹可复现')
}

// 2. 新契约完整解析
{
  const { result, meta } = parseAnalysisResult(FULL, { rawInput: raw, contextTurns: turns })
  assert.ok(result, '应解析成功')
  assert.equal(result.intent.primary, 'research')
  assert.deepEqual(result.intent.supporting, ['planning', 'execution'])
  assert.equal(result.intent.work_mode, 'exploratory')
  assert.equal(result.prompt_type, 'research', 'prompt_type 是 primary 的向后兼容投影')
  assert.equal(result.target.target, 'research')
  assert.equal(result.target.engine, null)
  // Phase 4:只有模糊目标的输入 → 机械判据 REBUILD;模型给 PATCH 不得把它降级
  assert.equal(result.triage.triage, 'REBUILD')
  assert.equal(meta.unknownTypeFallback, false)
  assert.equal(meta.multiIntent, true, '有辅意图 → multiIntent')

  // 未决项:两条,全部三分类
  assert.equal(result.missing_resolution.length, 2)
  assert.equal(result.missing_resolution[0].classification, 'USER_REQUIRED')
  assert.equal(result.missing_resolution[0].blocking, false)
  assert.equal(result.missing_resolution[1].classification, 'AGENT_DISCOVERABLE')
  assert.equal(result.gate.blocked, false, '无阻塞项 → 不阻断')
  assert.ok(result.missing_resolution[0].question, '应保留建议问法(Phase 3 用)')

  // 证据:`助手也没说过的假引用` 被丢弃
  assert.deepEqual(result.evidence_quotes, ['Mac M1 Pro 32GB', 'ComfyUI'])
  assert.equal(meta.droppedEvidence, 1)
  assert.ok(meta.issues.includes(ANALYSIS_ISSUE.droppedEvidence))

  // 台账:伪造 quote 的要求被丢弃(不得成为 USER_EXPLICIT)
  const userExplicit = result.ledger.filter((e) => e.source === 'USER_EXPLICIT')
  assert.equal(userExplicit.length, 1, '只有逐字可验证的要求可入 USER_EXPLICIT')
  assert.equal(userExplicit[0].status, 'CONFIRMED')
  assert.ok(meta.issues.includes(ANALYSIS_ISSUE.droppedRequirement))
  assert.equal(
    result.ledger.filter((e) => e.text.includes('凭空捏造')).length,
    0,
    '伪造要求必须彻底丢弃',
  )

  // 建议 → OPTIMIZER_SUGGESTED + PROVISIONAL
  const suggested = result.ledger.filter((e) => e.source === 'OPTIMIZER_SUGGESTED')
  assert.equal(suggested.length, 1)
  assert.equal(suggested[0].status, 'PROVISIONAL')
  console.log('✓ an2 新契约解析 + 证据/要求逐字校验 + 台账分离')
}

// 3. 旧分类器 JSON 兼容(零回归的关键)
{
  const legacyJson = JSON.stringify({
    prompt_type: 'planning',
    confidence_internal: 0.9,
    missing_constraints: ['预算范围', '现有实现的路径'],
    rationale: '用户要一个计划',
    evidence_quotes: ['帮我规划'],
  })
  const { result, meta } = parseAnalysisResult(legacyJson, { rawInput: '帮我规划一下', contextTurns: [] })
  assert.ok(result)
  assert.equal(result.prompt_type, 'planning', '旧 prompt_type 必须被识别为 primary')
  assert.equal(result.intent.primary, 'planning')
  assert.deepEqual(result.intent.supporting, [])
  assert.equal(result.intent.work_mode, 'iterative', '旧契约缺 work_mode → 由主意图推导')
  assert.equal(result.gate.blocked, true, '旧缺失项含「预算范围」→ 阻塞(只有用户能定)')
  assert.equal(result.gate.blocking_items.length, 1)
  assert.equal(result.missing_constraints.length, 2, '非 OPTIONAL 的缺口仍交给编译器(Phase 1 保持占位行为)')
  assert.equal(meta.unknownTypeFallback, false)
  console.log('✓ an3 旧分类器 JSON 兼容派生(含阻塞识别)')
}

// 4. 目标与引擎冲突 → 采纳引擎(机械证据)
{
  const conflict = JSON.stringify({
    primary_intent: 'execution',
    target: 'writing',
    target_engine: '可灵',
    edit_triage: 'PATCH',
  })
  const { result, meta } = parseAnalysisResult(conflict, { rawInput: '帮我写一段可灵用的提示词', contextTurns: [] })
  assert.equal(result.target.target, 'video_generation', '引擎有机械证据,优先于模型的 target')
  assert.equal(result.target.modality, 'video')
  assert.equal(result.target.engine.id, 'kling')
  assert.equal(result.target.confidence, 'high')
  assert.ok(meta.issues.includes(ANALYSIS_ISSUE.targetEngineConflict))
  console.log('✓ an4 目标/引擎冲突 → 采纳引擎并留痕')
}

// 5. 解析容错:无 JSON / 非对象 / think 包裹 / 非法枚举
{
  assert.equal(parseAnalysisResult('抱歉,我无法分析。', { rawInput: raw, contextTurns: [] }).result, null)
  assert.equal(parseAnalysisResult('[1,2,3]', { rawInput: raw, contextTurns: [] }).result, null)
  assert.equal(parseAnalysisResult('', { rawInput: raw, contextTurns: [] }).result, null)

  const thinkWrapped = `<think>让我想想…</think>${FULL}`
  assert.ok(parseAnalysisResult(thinkWrapped, { rawInput: raw, contextTurns: turns }).result, 'think 块必须被剥离')

  const bogus = JSON.stringify({
    primary_intent: 'nope',
    work_mode: 'nope',
    target: 'nope',
    edit_triage: 'nope',
    confidence_internal: 9,
  })
  const { result, meta } = parseAnalysisResult(bogus, { rawInput: '帮我处理一下这件事', contextTurns: [] })
  assert.ok(result)
  assert.equal(result.prompt_type, 'general', '非法主意图 → general')
  assert.equal(result.intent.work_mode, 'one_shot', '非法工作模式 → 按 general 推导')
  assert.equal(result.target.target, 'general', '非法目标且无线索 → 确定性兜底 general')
  assert.equal(result.confidence_internal, 1, '置信度越界必须钳制')
  assert.ok(meta.issues.includes(ANALYSIS_ISSUE.invalidPrimary))
  assert.ok(meta.issues.includes(ANALYSIS_ISSUE.invalidWorkMode))
  assert.ok(meta.issues.includes(ANALYSIS_ISSUE.invalidTarget))
  console.log('✓ an5 解析容错(无 JSON / think / 非法枚举 / 钳制)')
}

// 6. 兜底与手动路径都不得制造阻塞
{
  const fallback = fallbackAnalysisResult('测试兜底', { rawInput: '帮我研究一下这个方案', contextTurns: [] })
  assert.equal(fallback.prompt_type, 'general')
  assert.equal(fallback.gate.blocked, false, '兜底绝不能阻断生成')
  assert.deepEqual(fallback.missing_resolution, [])
  assert.equal(fallback.triage.keep_safe, false)

  const manual = manualAnalysisResult('planning', { rawInput: '帮我规划一下', contextTurns: [] })
  assert.equal(manual.prompt_type, 'planning')
  assert.equal(manual.confidence_internal, 1)
  assert.equal(manual.gate.blocked, false)
  assert.match(manual.intent.rationale, /手动/)
  assert.equal(manual.target.target, 'general')

  // 手动 override + 图像线索 → 目标仍按确定性线索识别
  const manualImage = manualAnalysisResult('execution', { rawInput: '画一张赛博朋克海报', contextTurns: [] })
  assert.equal(manualImage.target.target, 'image_generation')
  assert.equal(manualImage.target.modality, 'image')
  console.log('✓ an6 兜底/手动路径不制造阻塞 + 目标线索仍识别')
}

// 7. 投影回旧契约(编译管线零改动接入)
{
  const { result } = parseAnalysisResult(FULL, { rawInput: raw, contextTurns: turns })
  const classifier = analysisToClassifier(result)
  assert.equal(classifier.prompt_type, 'research')
  assert.equal(classifier.confidence_internal, result.confidence_internal)
  assert.deepEqual(classifier.evidence_quotes, result.evidence_quotes)
  assert.deepEqual(classifier.missing_constraints, result.missing_constraints)
  console.log('✓ an7 analysisToClassifier 投影(向后兼容)')
}

// 8. analyzeViaLlm:硬参数快照 / 成功 / 解析失败兜底 / 取消 / 超时
{
  const makeLlm = (script) => {
    const calls = []
    return {
      calls,
      async *stream(options) {
        calls.push(options)
        yield* script(options)
      },
    }
  }
  const route = { provider: 'p', model: 'm' }
  const chunk = (text) => [
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  const ok = await analyzeViaLlm(makeLlm(() => chunk(FULL)), route, { raw_input: raw, context_turns: turns })
  assert.equal(ok.usedFallback, false)
  assert.equal(ok.aborted, false)
  assert.equal(ok.result.prompt_type, 'research')
  assert.equal(ok.request.maxTokens, ANALYSIS_MAX_TOKENS)
  assert.equal(ok.request.temperature, ANALYSIS_TEMPERATURE)
  assert.ok(typeof ok.durationMs === 'number')

  const bad = await analyzeViaLlm(makeLlm(() => chunk('不是 JSON')), route, { raw_input: raw })
  assert.equal(bad.usedFallback, true)
  assert.equal(bad.failure, 'invalid-output')
  assert.equal(bad.result.gate.blocked, false, '解析失败兜底不得阻断')

  const preAborted = new AbortController()
  preAborted.abort()
  const aborted = await analyzeViaLlm(makeLlm(() => chunk(FULL)), route, { raw_input: raw }, { signal: preAborted.signal })
  assert.equal(aborted.aborted, true)
  assert.equal(aborted.usedFallback, true)
  assert.equal(aborted.result.gate.blocked, false)

  const hung = await analyzeViaLlm(
    makeLlm(() => [{ type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'boom' } } }]),
    route,
    { raw_input: raw },
  )
  assert.equal(hung.usedFallback, true)
  assert.equal(hung.failure, 'stream-error')
  assert.equal(hung.result.gate.blocked, false)

  // 硬参数必须真实下发(temp0/1024),不能只在快照里好看
  const llm = makeLlm(() => chunk(FULL))
  await analyzeViaLlm(llm, route, { raw_input: raw })
  assert.equal(llm.calls[0].maxTokens, ANALYSIS_MAX_TOKENS)
  assert.equal(llm.calls[0].temperature, ANALYSIS_TEMPERATURE)
  assert.ok(llm.calls[0].system.includes(ANALYSIS_SYSTEM_MARKER))
  console.log('✓ an8 analyzeViaLlm:硬参数 / 兜底 / 取消 / 失败一律不阻断')
}

// 9. 元任务判据:识别分析/分类调用,不误伤编译调用
{
  assert.equal(isMetaAnalysisCall(buildAnalysisSystem('zh')), true)
  assert.equal(isMetaAnalysisCall(buildAnalysisSystem('en')), true)
  assert.equal(isMetaAnalysisCall(undefined), false)
  assert.equal(isMetaAnalysisCall('<<<DIAGNOSIS>>> 你是一名研究型 Prompt 编译器'), false)
  console.log('✓ an9 isMetaAnalysisCall 判据(分析/分类 vs 编译)')
}

console.log('analyze.test.mjs: ALL PASS')
