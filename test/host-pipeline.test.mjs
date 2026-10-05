/**
 * P05-T01 Host Pipeline 集成测试(h1..h6)。
 *
 * 用真实 cordis Context + mock llm/httpServer 直接驱动插件注册的 HTTP handler,
 * 验证 PLAN-v1 §13 P05 的两阶段编排契约:
 *   h1 AUTO:classifyViaLlm → compilePrompt → meta → delta → done 事件序;
 *   h2 override(合法 promptType):完全跳过分类调用(零 classify 请求);
 *   h3 分类失败 → general 低置信兜底,编译继续(绝不阻塞);
 *   h4 非 legacy:done.provenance_ok 由三层输出守卫(P04-T02)决定,
 *      证明 Host 确实执行 compile → finalize → validate;
 *   h5 legacy general 零回归(不套用新协议必出段落要求);
 *   h6 回退模型链在 override 编译阶段行为不变(fallbackUsed / provider/model)。
 *
 * 运行:先 `npm run build`,再 `node test/host-pipeline.test.mjs`。
 *
 * 说明:本文件的场景文案全部为本项目独立撰写(与被测策略解耦的「模拟模型输出」),
 * 未复制任何 AGPL 项目(linshenkx / zhangjiazhi)的源码 / 模板 / 测试。
 */
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { COMPILE_MARKERS as M } from '../lib/core/compiler.js'
import { ANALYSIS_MAX_TOKENS, ANALYSIS_SYSTEM_MARKER } from '../lib/core/analyze.js'

// ─────────────────────────────────────────────────────────────────────────────
// Host harness(与 smoke.mjs 同构:真实 Context + mock llm)
// ─────────────────────────────────────────────────────────────────────────────

function makeReq(body, method = 'POST', headers) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = method
  req.headers = headers ?? {}
  return req
}

async function call(handler, body, method, headers) {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    on() {},
    writeHead(status, h) {
      res.status = status
      res.headers = h ?? {}
      return res
    },
    write(chunk) {
      res.body += chunk
      return true
    },
    end(payload) {
      if (payload) res.body += payload
      res.writableEnded = true
    },
  }
  const req =
    typeof body === 'string'
      ? Object.assign(Readable.from([body]), { method: method ?? 'POST', headers: headers ?? {} })
      : makeReq(body, method, headers)
  await handler(req, res)
  return res
}

function sseEvents(res) {
  return res.body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      return line ? JSON.parse(line.slice(5).trim()) : null
    })
    .filter(Boolean)
}

function doneOf(res) {
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /text\/event-stream/)
  const done = sseEvents(res).find((e) => e.type === 'done')
  assert.ok(done, '应收到 done 事件')
  return done
}

/** respond(options, callIndex) → 该次 llm.stream 应吐出的分片数组。 */
async function setup({ config = {}, respond }) {
  const calls = []
  const routes = {}
  const ctx = new Context()
  ctx.provide('httpServer', {
    register(r) {
      routes[r.path] = r
      return () => {}
    },
  })
  ctx.provide('llm', {
    async *stream(options) {
      const index = calls.length
      calls.push(options)
      for (const chunk of respond(options, index)) yield chunk
    },
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek 官方' }],
    listModels: async () => [
      { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
    ],
    // 不暴露推理档位:最低档解析返回 undefined(覆盖「目录失败不乱发」路径)。
    resolveModelInfo: async () => ({
      provider: 'deepseek-official',
      id: 'deepseek-chat',
      name: 'DeepSeek Chat',
    }),
  })
  await ctx.plugin(plugin, config)
  assert.ok(routes['/dsh-prompt-optimizer/optimize'], '插件应注册优化路由')
  return { handler: routes['/dsh-prompt-optimizer/optimize'].handler, calls }
}

const textOf = (options) => options.messages[0].content[0].text
const chunkText = (text) => [
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

// ─────────────────────────────────────────────────────────────────────────────
// research 场景(与 P04-T03 集成测试同源的本项目自定义 fixture)
// ─────────────────────────────────────────────────────────────────────────────

const RESEARCH = {
  type: 'research',
  raw: '帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频,我看到黑鹤001低显流,还有 H3……',
  quote: ['Mac M1 Pro 32GB', 'ComfyUI', 'H3'],
  missing: ['期望的视频产出形式与时长'],
  suggested: ['补充目标产出形式'],
  body: [
    '## Background（背景）',
    '- 用户机器为 Mac M1 Pro 32GB,目标是 AI 视频,当前线索为黑鹤001低显流与 H3',
    '## Research Goal（研究目标）',
    '- 研究 Mac M1 Pro 32GB 上用 ComfyUI 做 AI 视频的可执行路径',
    '## Existing Knowledge（已知信息）',
    '- 用户提到黑鹤001低显流与 H3,二者均为候选线索',
    '## Constraints（约束）',
    '- 期望的视频产出形式与时长:只有你能定,本轮不需要回答;执行方按通用做法先推进',
    '## Candidate Approaches（候选方案）',
    '- 黑鹤001:候选,待验证',
    '- H3:候选,待验证',
    '## Research Questions（研究问题）',
    '- ComfyUI 在 Mac M1 Pro 上有哪些可用工作流?',
    '## Assumptions To Verify（待验证假设）',
    '- 假设低显存方案可运行,需实测验证',
    '## Evidence Requirements（证据要求）',
    '- 每类结论需官方文档或可复现实测',
    '## Source Priority（来源优先级）',
    '- 官方文档优先于社区转述',
    '## Conflicting Evidence（冲突证据）',
    '- 冲突说法需并列呈现,不得擅自裁决',
    '## Evidence Gaps（证据缺口）',
    '- 动手前先确认:Mac 实测案例',
    '## Continue-search Conditions（继续检索条件）',
    '- 只有单一来源时继续检索',
    '## Comparison Dimensions（对比维度）',
    '- 兼容性 / 性能 / 成本 / 维护性',
    '## Human Decision Points（人工决策点）',
    '- 是否采用某候选由用户决定',
    '## Research Completion Criteria（研究完成标准）',
    '- 关键问题均有证据支撑时结束本轮研究',
  ].join('\n'),
}

/** 组装一段机器可解析的 research 协议输出(body 可替换以注入缺陷)。 */
function researchOutput(body = RESEARCH.body, explicitLines) {
  return [
    M.diagnosis,
    '目标清晰度:目标明确 | 类型:research',
    M.explicit,
    ...(explicitLines ?? [`- 编译用户要求 [quote: ${RESEARCH.quote[0]}]`]),
    M.context,
    '- (无)',
    M.suggested,
    ...RESEARCH.suggested.map((item) => `- 建议(可忽略) ${item}`),
    M.unknown,
    ...RESEARCH.missing.map((item) => `- ${item}`),
    M.optimized,
    body,
    M.end,
  ].join('\n')
}

/** 合法分类 JSON(evidence_quotes 必须逐字来自用户输入)。 */
const RESEARCH_CLASSIFY_JSON = JSON.stringify({
  prompt_type: 'research',
  confidence_internal: 0.86,
  missing_constraints: [...RESEARCH.missing],
  rationale: '用户要研究可行性',
  evidence_quotes: [RESEARCH.quote[0]],
})

/** Phase 4:general 走 v2 四段协议时的产物(4 项信息责任齐全)。 */
const GENERAL_PROTOCOL_OUTPUT = [
  '<<<DIAGNOSIS>>>',
  '目标明确,约束清晰',
  '<<<EXPLICIT>>>',
  '(无)',
  '<<<CONTEXT>>>',
  '(无)',
  '<<<SUGGESTED>>>',
  '(无)',
  '<<<UNKNOWN>>>',
  '(无)',
  '<<<OPTIMIZED>>>',
  '## Request（请求要点）',
  '- 按用户输入整理提示词',
  '## Context & Inputs（上下文与输入）',
  '- 用户给出的草稿',
  '## Constraints & Exclusions（约束与排除）',
  '- 用户未给出额外约束',
  '## Deliverable Shape（产出形态）',
  '- 可直接使用的提示词',
  '<<<END>>>',
].join('\n')

const LEGACY_OUTPUT = [
  '<<<ANALYSIS>>>',
  '目标明确,约束清晰',
  '<<<OPTIMIZED>>>',
  '优化后的提示词',
  '<<<END>>>',
].join('\n')

// ─────────────────────────────────────────────────────────────────────────────
// h1. AUTO:classifyViaLlm → compilePrompt → meta → delta → done
// ─────────────────────────────────────────────────────────────────────────────
{
  const { handler, calls } = await setup({
    respond: (_options, index) =>
      index === 0 ? chunkText(RESEARCH_CLASSIFY_JSON) : chunkText(researchOutput()),
  })
  const res = await call(handler, { text: RESEARCH.raw, provider: 'session-p', model: 'session-m' })
  const events = sseEvents(res)
  const metaIndex = events.findIndex((e) => e.type === 'meta')
  const firstDelta = events.findIndex((e) => e.type === 'delta')
  const doneIndex = events.findIndex((e) => e.type === 'done')
  assert.equal(metaIndex, 0, 'meta 必须是第一个事件')
  assert.ok(firstDelta > metaIndex, 'delta 必须在 meta 之后')
  assert.ok(doneIndex > firstDelta, 'done 必须在 delta 之后')

  // 两次调用:第 1 次是分析硬参数(temp0/1024),第 2 次是编译。
  assert.equal(calls.length, 2, 'AUTO = 分析 1 次 + 编译 1 次')
  assert.equal(calls[0].maxTokens, ANALYSIS_MAX_TOKENS, '分析调用必须 1024 token 封顶')
  assert.equal(calls[0].temperature, 0)
  assert.ok(calls[0].system.includes(ANALYSIS_SYSTEM_MARKER), '第 1 次调用必须是分析器 system')
  assert.notEqual(calls[1].maxTokens, ANALYSIS_MAX_TOKENS)
  assert.match(calls[1].system, /<<<DIAGNOSIS>>>/, '编译调用必须下发四段协议 system')

  const meta = events[metaIndex]
  assert.equal(meta.prompt_type, 'research')
  assert.equal(meta.confidence_level, 'High')
  assert.equal(meta.rationale, '用户要研究可行性')
  assert.deepEqual(
    meta.missing_constraints.map((item) => item.label),
    RESEARCH.missing,
  )
  // meta 阶段编译结果尚未产出:provenance_ok 是乐观值,done 才是真值。
  assert.equal(meta.provenance_ok, true)

  const done = events[doneIndex]
  assert.equal(done.prompt_type, 'research')
  assert.equal(done.confidence_level, 'High')
  assert.equal(done.explicit_requirements.length, 1)
  assert.equal(done.explicit_requirements[0].source, 'USER_EXPLICIT')
  assert.deepEqual(done.explicit_requirements[0].evidence, [RESEARCH.quote[0]])
  assert.deepEqual(done.context_requirements, [])
  assert.equal(done.suggested_requirements.length, RESEARCH.suggested.length)
  assert.equal(done.provenance_ok, true, '完整协议输出必须通过三层守卫')
  assert.match(done.optimized, /Research Goal/)
  console.log('✓ h1 AUTO 两阶段:meta→delta→done + 分类/编译调用分离')
}

// ─────────────────────────────────────────────────────────────────────────────
// h2. override:合法 promptType 完全跳过分类调用
// ─────────────────────────────────────────────────────────────────────────────
{
  const { handler, calls } = await setup({
    respond: () => chunkText(researchOutput()),
  })
  const res = await call(handler, {
    text: RESEARCH.raw,
    promptType: 'research',
    provider: 'p',
    model: 'm',
  })
  const done = doneOf(res)
  assert.equal(calls.length, 1, 'override 只能有 1 次编译调用(零分析)')
  assert.notEqual(calls[0].maxTokens, ANALYSIS_MAX_TOKENS, '唯一调用不能是分析调用')
  assert.ok(!calls[0].system.includes(ANALYSIS_SYSTEM_MARKER), 'override 不得下发分析 system')
  assert.match(calls[0].system, /<<<DIAGNOSIS>>>/, 'override 直入编译协议')

  const meta = sseEvents(res).find((e) => e.type === 'meta')
  assert.equal(meta.prompt_type, 'research')
  assert.equal(meta.confidence_level, 'High', '手动指定应为最高置信')
  assert.equal(done.prompt_type, 'research')
  assert.equal(done.provenance_ok, true)
  assert.ok(done.optimized.includes(RESEARCH.body.split('\n')[0].replace('## ', '')), '优化稿必须来自协议解析')
  console.log('✓ h2 override 无 classify 调用,直入编译')
}

// ─────────────────────────────────────────────────────────────────────────────
// h3. 分析失败 → general 低置信兜底;编译继续(不阻塞)
// ─────────────────────────────────────────────────────────────────────────────
{
  const { handler, calls } = await setup({
    respond: (_options, index) =>
      index === 0 ? chunkText('抱歉,我无法完成分类。') : chunkText(GENERAL_PROTOCOL_OUTPUT),
  })
  const res = await call(handler, { text: '帮我看看这段代码', provider: 'p', model: 'm' })
  const done = doneOf(res)
  const meta = sseEvents(res).find((e) => e.type === 'meta')
  assert.equal(calls.length, 2, '分析失败也必须继续到编译')
  assert.equal(calls[0].maxTokens, ANALYSIS_MAX_TOKENS)
  assert.equal(meta.prompt_type, 'general', '分析解析失败必须回退 general')
  assert.equal(meta.confidence_level, 'Low', '回退 general 必须低置信')
  assert.match(String(meta.rationale), /分类|通用|手动/)
  assert.equal(done.prompt_type, 'general')
  assert.equal(done.analysis, '目标明确,约束清晰', 'v2:诊断段正常解析')
  assert.ok(done.optimized.includes('请求要点'), 'v2:general 走信息责任契约')
  assert.equal(done.provenance_ok, true)
  console.log('✓ h3 分析失败 → general + Low,编译继续(v2 契约)')
}

// ─────────────────────────────────────────────────────────────────────────────
// h4. 非 legacy:done.provenance_ok 由三层输出守卫决定(证明 Host 跑了 validate)
// ─────────────────────────────────────────────────────────────────────────────
{
  // 去掉一个策略必出段落「Comparison Dimensions」:finalize 的 provenance + 策略
  // guards 仍会通过,只有 validate 的 required_sections 检查能拦住 → 结果必须 false。
  const defectiveBody = RESEARCH.body.replace(
    '## Comparison Dimensions（对比维度）\n- 兼容性 / 性能 / 成本 / 维护性\n',
    '',
  )
  assert.ok(!defectiveBody.includes('Comparison Dimensions'), 'fixture 必须真的缺段')

  const { handler, calls } = await setup({
    respond: () => chunkText(researchOutput(defectiveBody)),
  })
  const res = await call(handler, { text: RESEARCH.raw, promptType: 'research', provider: 'p', model: 'm' })
  const done = doneOf(res)
  assert.equal(calls.length, 1)
  assert.match(done.optimized, /Research Goal/, '缺陷只应影响必出段落完整性')
  assert.equal(done.provenance_ok, false, '缺必出段落必须由 validate 拦截并落到 done')
  // 结论失败不代表内容丢失:优化稿仍完整下发,交 UI 顶部警示(不静默丢弃)。
  assert.ok(done.optimized.length > 0)

  // h4b. 伪造 quote(不在用户输入中)→ Phase 4:Validator **可控回流**而非交付。
  //      交付一个「声称是用户要求」的稿子是不可接受的;回流带 reason code。
  const forged = await setup({
    respond: () => chunkText(researchOutput(RESEARCH.body, ['- 伪造要求 [quote: 用户从未说过这句]'])),
  })
  const forgedRes = await call(forged.handler, {
    text: RESEARCH.raw,
    promptType: 'research',
    provider: 'p',
    model: 'm',
  })
  const forgedEvents = sseEvents(forgedRes)
  assert.equal(forgedEvents.some((e) => e.type === 'done'), false, '伪造来源不得交付结果')
  const returned = forgedEvents.find((e) => e.type === 'returned')
  assert.ok(returned, '必须下发 returned 事件')
  assert.equal(returned.action, 'RETURN_TO_MISSING_RESOLUTION')
  assert.equal(returned.reason_code, 'VF_FABRICATED_USER_EXPLICIT')
  assert.equal(returned.requires, 'provenance_downgrade')
  assert.equal(returned.returns.length, 1, '必须记录回流次数(有界)')
  console.log('✓ h4 非 legacy:三层守卫决定交付 / 可控回流')
}

// ─────────────────────────────────────────────────────────────────────────────
// h5. override general(Phase 4:走 v2 information-responsibility 契约,不再是 legacy)
// ─────────────────────────────────────────────────────────────────────────────
{
  const { handler, calls } = await setup({ respond: () => chunkText(GENERAL_PROTOCOL_OUTPUT) })
  const res = await call(handler, { text: '帮我改一下这段提示词', promptType: 'general', provider: 'p', model: 'm' })
  const done = doneOf(res)
  assert.equal(calls.length, 1, 'override general 也应跳过分类')
  assert.match(calls[0].system, /<<<DIAGNOSIS>>>/, 'Phase 4:general 下发 v2 四段协议')
  assert.equal(done.prompt_type, 'general')
  assert.equal(done.confidence_level, 'High')
  assert.equal(done.analysis, '目标明确,约束清晰')
  assert.ok(done.optimized.includes('请求要点'), 'v2:general 输出信息责任')
  assert.equal(done.provenance_ok, true)
  assert.deepEqual(done.explicit_requirements, [])
  assert.deepEqual(done.suggested_requirements, [])
  console.log('✓ h5 override general 走 v2 契约(信息责任)')
}

// ─────────────────────────────────────────────────────────────────────────────
// h6. 回退模型链:override 编译阶段主路由零产出失败 → 换备用路由,行为不变
// ─────────────────────────────────────────────────────────────────────────────
{
  const { handler, calls } = await setup({
    config: { fallbackModel: 'good-p/good-m' },
    respond: (options) =>
      options.provider === 'bad-p'
        ? [
            { type: 'finish', reason: { kind: 'error', failure: { code: 'DOWN', message: 'provider down' } } },
          ]
        : chunkText(researchOutput()),
  })
  const res = await call(handler, {
    text: RESEARCH.raw,
    promptType: 'research',
    provider: 'bad-p',
    model: 'bad-m',
  })
  const done = doneOf(res)
  assert.equal(calls.length, 2, '主路由失败 + 备用路由成功 = 2 次编译调用')
  assert.equal(done.provider, 'good-p')
  assert.equal(done.model, 'good-m')
  assert.equal(done.fallbackUsed, true)
  assert.match(String(done.fallbackReason), /provider down/)
  assert.equal(done.provenance_ok, true, '备用路由产出仍走同一套守卫')
  console.log('✓ h6 回退链在编译阶段行为不变')
}

console.log('\nhost-pipeline: all passed')
