/**
 * P03-T02 — classifyViaLlm 调用侧封装单测(mock llm,独立于 handler 主路径)。
 *
 * 覆盖:
 *  - 正常路径:硬参数(temperature=0 / maxTokens=512 / lowest effort)、JSON 解析;
 *  - thinkFilter:跨 chunk 剥 <think>,干净增量才下发;
 *  - 解析降级:未知类型→general(parser 容错)、无法解析→general 兜底标记;
 *  - 失败分类:AUTH 失败 / 流中断 / 硬超时 / 外部 abort 各自回退 + 标记语义;
 *  - abort 立即生效:调用前已取消不得发起请求;中途取消立即返回;
 *  - 注入面:explicit reasoningEffort、resolveLowestEffort、buildMessage、逐字证据校验。
 *
 * 运行:先 `npm run build`,再 `node test/classify-llm.test.mjs`。
 */
import assert from 'node:assert/strict'
import {
  CLASSIFIER_MAX_TOKENS,
  CLASSIFIER_TEMPERATURE,
  CLASSIFY_LLM_ISSUE,
  classifyViaLlm,
} from '../lib/core/classify.js'

const ROUTE = { provider: 'p', model: 'm' }
const RAW = '帮我写一个 Python 快排函数'

const OK_RESULT = {
  prompt_type: 'execution',
  confidence_internal: 0.82,
  missing_constraints: ['输出格式'],
  rationale: '用户要求直接产出一段代码',
  evidence_quotes: [RAW],
}
const OK_JSON = JSON.stringify(OK_RESULT)

/** 最低档目录:断言 wrapper 钳 lowest。 */
const EFFORTS = [
  { id: 'high', name: 'High' },
  { id: 'low', name: 'Low' },
]

/**
 * mock llm:默认产出 OK_JSON + finish stop;可用 onStream 整体替换流;
 * `calls` 记录全部 stream options;resolveModelInfo 暴露推理档位表。
 */
function makeLlm({ onStream, efforts = EFFORTS } = {}) {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      if (onStream) {
        yield* onStream(options)
        return
      }
      yield { type: 'text-delta', index: 0, text: OK_JSON }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    async resolveModelInfo() {
      return { reasoning: { efforts } }
    },
  }
}

// ll1. 正常路径:解析正确 + 硬参数 + lowest effort
{
  const llm = makeLlm()
  const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: RAW })
  assert.equal(outcome.result.prompt_type, 'execution')
  assert.equal(outcome.result.confidence_internal, 0.82)
  assert.equal(outcome.usedFallback, false)
  assert.equal(outcome.failure, 'none')
  assert.equal(outcome.degraded, false)
  assert.equal(outcome.aborted, false)
  assert.equal(outcome.timedOut, false)
  assert.ok(outcome.durationMs >= 0)

  assert.equal(llm.calls.length, 1, '正常路径只发一次分类调用')
  const sent = llm.calls[0]
  assert.equal(sent.provider, 'p')
  assert.equal(sent.model, 'm')
  assert.equal(sent.maxTokens, CLASSIFIER_MAX_TOKENS)
  assert.equal(sent.maxTokens, 512)
  assert.equal(sent.temperature, CLASSIFIER_TEMPERATURE)
  assert.equal(sent.temperature, 0)
  assert.equal(sent.reasoningEffort, 'low', '应钳到模型支持的最低档')
  assert.ok(sent.signal instanceof AbortSignal, '必须带中止信号')
  assert.equal(sent.messages.length, 1)
  assert.match(sent.system, /JSON/)
  assert.match(String(sent.messages[0].content[0].text), new RegExp(RAW.slice(0, 6)))

  assert.equal(outcome.request.maxTokens, 512)
  assert.equal(outcome.request.temperature, 0)
  assert.equal(outcome.request.reasoningEffort, 'low')
  console.log('✓ ll1 正常路径:硬参数/最低档/解析')
}

// ll2. thinkFilter:思考块(内含复述 JSON)被剥掉,只解析正文
{
  let sawThink = false
  const llm = makeLlm({
    onStream: function* () {
      yield { type: 'text-delta', index: 0, text: '<thi' }
      yield { type: 'text-delta', index: 0, text: 'nk>复述 {prompt_type:"research"}</think>' }
      yield { type: 'text-delta', index: 0, text: OK_JSON }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: RAW }, {
    onDelta: (text) => {
      if (text.includes('<think>')) sawThink = true
    },
  })
  assert.equal(outcome.result.prompt_type, 'execution', '思考块里的 research 不得被当作结果')
  assert.equal(sawThink, false, 'onDelta 只能收到剥离思考块后的干净增量')
  console.log('✓ ll2 thinkFilter 跨 chunk 剥离')
}

// ll3. 未知类型 → parser 容错回退 general(非调用失败,usedFallback=false)
{
  const unknown = JSON.stringify({
    prompt_type: 'not_a_type',
    confidence_internal: 0.9,
    missing_constraints: [],
    rationale: '',
    evidence_quotes: [],
  })
  const llm = makeLlm({ onStream: function* () { yield { type: 'text-delta', index: 0, text: unknown }; yield { type: 'finish', reason: { kind: 'stop' } } } })
  const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: RAW })
  assert.equal(outcome.result.prompt_type, 'general')
  assert.equal(outcome.meta.unknownTypeFallback, true)
  assert.equal(outcome.degraded, true)
  assert.equal(outcome.usedFallback, false, '这是解析降级,不是调用兜底')
  assert.equal(outcome.failure, 'none')
  console.log('✓ ll3 未知类型 parser 降级 general')
}

// ll4. 无法解析 → general 兜底 + 低置信 + 稳定标记
{
  const llm = makeLlm({ onStream: function* () { yield { type: 'text-delta', index: 0, text: '完全不是 JSON' }; yield { type: 'finish', reason: { kind: 'stop' } } } })
  const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: RAW })
  assert.equal(outcome.result.prompt_type, 'general')
  assert.equal(outcome.result.confidence_internal, 0.2)
  assert.equal(outcome.usedFallback, true)
  assert.equal(outcome.failure, 'invalid-output')
  assert.equal(outcome.meta.lowConfidence, true)
  assert.ok(outcome.meta.issues.includes(CLASSIFY_LLM_ISSUE.invalidOutput))
  console.log('✓ ll4 不可解析 → general 兜底标记')
}

// ll5. AUTH 失败 → general 兜底 + failure=auth
{
  const llm = makeLlm({
    onStream: function* () {
      yield { type: 'text-delta', index: 0, text: '' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH_401', message: 'invalid api key' } } }
    },
  })
  const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: RAW })
  assert.equal(outcome.result.prompt_type, 'general')
  assert.equal(outcome.usedFallback, true)
  assert.equal(outcome.failure, 'auth')
  assert.equal(outcome.aborted, false)
  assert.equal(outcome.timedOut, false)
  assert.ok(outcome.meta.issues.includes(CLASSIFY_LLM_ISSUE.authFailed))
  assert.match(String(outcome.reason), /AUTH_401/)
  console.log('✓ ll5 AUTH 失败回退(标记 auth)')
}

// ll6. 流中断(迭代器抛出)→ general 兜底 + failure=stream-error
{
  const llm = makeLlm({
    onStream: async function* () {
      yield { type: 'text-delta', index: 0, text: '{"prompt_type":"exec' }
      throw new Error('socket hang up')
    },
  })
  const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: RAW })
  assert.equal(outcome.result.prompt_type, 'general')
  assert.equal(outcome.usedFallback, true)
  assert.equal(outcome.failure, 'stream-error')
  assert.equal(outcome.aborted, false)
  assert.ok(outcome.meta.issues.includes(CLASSIFY_LLM_ISSUE.streamError))
  assert.match(String(outcome.reason), /socket hang up/)
  console.log('✓ ll6 流中断回退(标记 stream-error)')
}

// ll7. 硬超时 → timedOut=true(不信任半截输出),调用方应走错误通道
{
  const calls = []
  const llm = {
    calls,
    async *stream(options) {
      calls.push(options)
      // 模拟遵守 abort 的适配器:超时中止后以异常结束。
      await new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true })
      })
    },
    async resolveModelInfo() {
      return { reasoning: { efforts: EFFORTS } }
    },
  }
  const started = Date.now()
  const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: RAW }, { timeoutMs: 30 })
  assert.equal(outcome.timedOut, true, '超时必须标记 timedOut')
  assert.equal(outcome.aborted, true)
  assert.equal(outcome.failure, 'timeout')
  assert.equal(outcome.usedFallback, true)
  assert.equal(outcome.result.prompt_type, 'general')
  assert.ok(outcome.meta.issues.includes(CLASSIFY_LLM_ISSUE.timedOut))
  assert.ok(Date.now() - started < 2000, '超时必须按时生效,不能挂死')
  console.log('✓ ll7 硬超时 → timeout 标记')
}

// ll8. abort 立即生效:调用前已取消 → 绝不发起请求
{
  const controller = new AbortController()
  controller.abort()
  const llm = makeLlm()
  const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: RAW }, { signal: controller.signal })
  assert.equal(llm.calls.length, 0, '已取消不得发起分类请求')
  assert.equal(outcome.aborted, true)
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.failure, 'aborted')
  assert.equal(outcome.usedFallback, true)
  assert.ok(outcome.meta.issues.includes(CLASSIFY_LLM_ISSUE.aborted))
  console.log('✓ ll8 调用前取消立即生效(零请求)')
}

// ll9. 中途取消 → 立即返回 aborted,而非把半截输出当结果
{
  const controller = new AbortController()
  let firstDelta = false
  const llm = makeLlm({
    onStream: async function* (options) {
      yield { type: 'text-delta', index: 0, text: OK_JSON }
      await new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('client disconnected')), { once: true })
      })
    },
  })
  const pending = classifyViaLlm(llm, ROUTE, { raw_input: RAW }, {
    signal: controller.signal,
    onDelta: () => {
      firstDelta = true
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  const outcome = await pending
  assert.equal(firstDelta, true, '取消前的干净增量应已下发')
  assert.equal(outcome.aborted, true)
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.failure, 'aborted')
  console.log('✓ ll9 中途取消立即生效')
}

// ll10. 推理强度注入:显式 > resolveLowestEffort 注入
{
  const llm = makeLlm()
  await classifyViaLlm(llm, ROUTE, { raw_input: RAW }, { reasoningEffort: 'medium' })
  assert.equal(llm.calls[0].reasoningEffort, 'medium', '显式值优先级最高')

  let injected = 0
  const llm2 = makeLlm()
  await classifyViaLlm(llm2, ROUTE, { raw_input: RAW }, {
    resolveLowestEffort: async () => {
      injected += 1
      return 'minimal'
    },
  })
  assert.equal(injected, 1)
  assert.equal(llm2.calls[0].reasoningEffort, 'minimal', '宿主注入的最低档解析必须被复用')
  console.log('✓ ll10 reasoningEffort 注入优先级')
}

// ll11. 逐字证据校验:只保留 raw_input / 上下文 user 的逐字片段
{
  const contextTurn = { role: 'user', text: '目标语言是 TypeScript' }
  const payload = JSON.stringify({
    prompt_type: 'execution',
    confidence_internal: 0.7,
    missing_constraints: [],
    rationale: '',
    evidence_quotes: [RAW, '目标语言是 TypeScript', '助手编的话'],
  })
  const llm = makeLlm({ onStream: function* () { yield { type: 'text-delta', index: 0, text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } })
  const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: RAW, context_turns: [contextTurn] })
  assert.deepEqual(outcome.result.evidence_quotes, [RAW, '目标语言是 TypeScript'])
  assert.equal(outcome.meta.droppedEvidence, 1)
  assert.equal(outcome.degraded, true, '丢弃非逐字证据必须标记降级')
  console.log('✓ ll11 逐字证据校验(上下文 user 可作证据)')
}

// ll12. buildMessage 注入:宿主可带 id/source 的真实 Message 工厂
{
  const llm = makeLlm()
  await classifyViaLlm(llm, ROUTE, { raw_input: RAW }, {
    buildMessage: (payload) => ({ role: 'user', content: payload, marker: 'injected' }),
  })
  assert.equal(llm.calls[0].messages[0].marker, 'injected')
  console.log('✓ ll12 buildMessage 注入')
}

// ll13. max-tokens finish 标记截断但不误判为失败(JSON 仍可用)
{
  const llm = makeLlm({ onStream: function* () { yield { type: 'text-delta', index: 0, text: OK_JSON }; yield { type: 'finish', reason: { kind: 'max-tokens' } } } })
  const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: RAW })
  assert.equal(outcome.usedFallback, false)
  assert.equal(outcome.failure, 'none')
  assert.match(String(outcome.reason), /truncated/)
  console.log('✓ ll13 max-tokens 截断标记')
}

// ll14. 混合失败分支互斥:错误优先级(超时 > abort > auth > stream)
{
  const llm = makeLlm({
    onStream: function* () {
      yield { type: 'text-delta', index: 0, text: '' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM_500', message: 'bad gateway' } } }
    },
  })
  const outcome = await classifyViaLlm(llm, ROUTE, { raw_input: RAW })
  assert.equal(outcome.failure, 'stream-error')
  assert.ok(outcome.meta.issues.includes(CLASSIFY_LLM_ISSUE.streamError))
  assert.ok(!outcome.meta.issues.includes(CLASSIFY_LLM_ISSUE.authFailed))
  console.log('✓ ll14 非 AUTH 错误归类 stream-error')
}

console.log('\nclassify-llm: all passed')
