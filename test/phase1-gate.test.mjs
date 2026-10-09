/**
 * v2 Phase 1 —— 端到端「分析 → 门 → 生成」宿主门禁测试。
 *
 * 这是 Phase 1 的核心验收:机械证明三件事——
 *   1. 存在「只有用户本人能决定」的阻塞项时,**不生成**:只下发 discovery_required,
 *      没有 delta、没有 done,且**编译调用次数 = 0**(不消耗编译 token);
 *   2. 没有阻塞项时,分析结论随 meta 下发(intent / target / triage / ledger /
 *      missing_resolution),编译照常;
 *   3. KEEP 分诊时不做模型改写:optimized_prompt **逐字等于**用户输入,
 *      且只有 1 次(元任务)调用。
 *
 * 运行:先 `npm run build`,再 `node test/phase1-gate.test.mjs`。
 */
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { isMetaAnalysisCall } from '../lib/core/analyze.js'

function makeReq(body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = 'POST'
  req.headers = {}
  return req
}

async function call(handler, body) {
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
  await handler(makeReq(body), res)
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

const chunkText = (text) => [
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** respond(options, index) → 该次 llm.stream 的分片;calls 记录全部 GenerateOptions。 */
async function setup({ respond }) {
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
    listModels: async () => [{ id: 'deepseek-chat', provider: 'deepseek-official', name: 'DeepSeek Chat' }],
    resolveModelInfo: async () => ({ id: 'deepseek-chat', provider: 'deepseek-official', name: 'DeepSeek Chat' }),
  })
  await ctx.plugin(plugin, { v3: false })  // 旧多阶段路径测试:显式选择 legacy
  return {
    handler: routes['/dsh-prompt-optimizer/optimize'].handler,
    calls,
    compileCalls: () => calls.filter((o) => !isMetaAnalysisCall(o.system)),
  }
}

const COMPILE_OUTPUT = [
  '<<<DIAGNOSIS>>>',
  '目标清晰,约束边界已标注',
  '<<<EXPLICIT>>>',
  '- 研究目标:Mac 上做 AI 视频 [quote: Mac M1 Pro 32GB]',
  '<<<CONTEXT>>>',
  '(无)',
  '<<<SUGGESTED>>>',
  '- 建议(可忽略) 优先核对官方文档',
  '<<<UNKNOWN>>>',
  '- 期望的视频产出形式与时长:只有你能定,本轮不需要回答;执行方按通用做法先推进',
  '<<<OPTIMIZED>>>',
  '## 研究任务',
  '在 Mac M1 Pro 32GB 上调研 AI 视频方案。',
  '<<<END>>>',
].join('\n')

/** Phase 4:general 走 v2 契约时的产物(4 项信息责任齐全)。 */
const GENERAL_OUTPUT = [
  '<<<DIAGNOSIS>>>',
  '目标清晰,约束边界已标注',
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

// RC2 起:模糊目标会先进入 Discovery;测「直接编译」的用例用已明确输入
const RESEARCH_TEXT = '帮我研究 Mac M1 Pro 32GB 怎么做 AI 视频。约束:只看本地可跑的方案;输出格式:方案对比表 + 每项优缺点;验收:给出可执行步骤与显存占用实测数据。'

/** 分析输出:含一个「只有用户能决定 + 高影响」的阻塞项(预算)。 */
const ANALYSIS_BLOCKED = JSON.stringify({
  primary_intent: 'planning',
  supporting_intents: ['research'],
  work_mode: 'iterative',
  target: 'agent_task',
  edit_triage: 'PATCH',
  triage_reasons: ['任务成立,但缺关键约束'],
  unknowns: [
    { text: '预算范围', classification: 'USER_REQUIRED', blocking: true, rationale: '只有用户能定,且决定方案规模', question: '这个项目大概的预算范围是多少?' },
    { text: '现有实现的文件路径', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '执行方可自查' },
  ],
  requirements: [{ text: '研究 Mac 上做 AI 视频', quote: 'Mac M1 Pro 32GB' }],
  suggestions: ['建议先确认预算'],
  confidence_internal: 0.9,
  rationale: '用户要一个方案,但预算未定',
  evidence_quotes: ['Mac M1 Pro 32GB'],
})

/** 分析输出:无阻塞项。 */
const ANALYSIS_OK = JSON.stringify({
  primary_intent: 'research',
  supporting_intents: [],
  work_mode: 'exploratory',
  target: 'research',
  edit_triage: 'PATCH',
  unknowns: [
    { text: 'ComfyUI 在本机的可用插件清单', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '执行方可自查' },
  ],
  requirements: [{ text: '在 Mac M1 Pro 32GB 上做 AI 视频', quote: 'Mac M1 Pro 32GB' }],
  suggestions: ['补充产出形式'],
  confidence_internal: 0.86,
  rationale: '用户在寻求 Mac 上做 AI 视频的研究路径',
  evidence_quotes: ['Mac M1 Pro 32GB'],
})

/** 一份已完备成稿:机械判据会判 KEEP。 */
const COMPLETE_PROMPT = [
  '你是一名资深后端工程师,请审查并重构订单服务模块。',
  '',
  '要求:',
  '1. 保持对外 HTTP 接口签名完全不变,不得改动任何路由路径。',
  '2. 数据库迁移必须可回滚,禁止在迁移里删除字段。',
  '3. 所有新增逻辑必须带单元测试,覆盖率不低于 80%。',
  '',
  '约束:',
  '- 仅限修改 src/order 目录下的文件。',
  '',
  '输出格式:先给出问题清单(含文件路径与行号),再给出改动后的代码。',
  '',
  '验收标准:',
  '- npm test 全绿;',
  '- 现有 API 契约测试全部通过。',
].join('\n')

// 1. 非歧义的「阻塞」项 → 新定义下被降级为允许未决,正常编译交付
//    (旧规则:高影响 + 用户专属 = blocking → Discovery;已废除)
{
  const { handler, calls, compileCalls } = await setup({
    respond: (_options, index) => chunkText(index === 0 ? ANALYSIS_BLOCKED : COMPILE_OUTPUT),
  })
  const res = await call(handler, { text: RESEARCH_TEXT, provider: 'p', model: 'm' })
  assert.equal(res.status, 200)
  const events = sseEvents(res)
  const kinds = events.map((e) => e.type)
  assert.equal(kinds.includes('discovery_required'), false, '★ 执行期取舍(预算)不得进入 Discovery')
  assert.equal(kinds.includes('done'), true, '★ 应正常编译交付')
  assert.equal(calls.length, 2, '分析 1 次 + 编译 1 次')
  assert.equal(compileCalls().length, 1, '★ 无阻塞 → 恰好编译一次')
}

// 1b. 真语义歧义(指代无先行词)→ 只发 discovery_required,绝不生成
{
  const { handler, calls, compileCalls } = await setup({
    respond: (_options, index) => chunkText(index === 0 ? ANALYSIS_OK : COMPILE_OUTPUT),
  })
  const res = await call(handler, { text: '帮我把这个优化一下。', provider: 'p', model: 'm' })
  const events = sseEvents(res)
  const kinds = events.map((e) => e.type)
  assert.deepEqual(kinds, ['discovery_required'], '唯一事件必须是 discovery_required')
  assert.ok(!kinds.includes('delta'), '阻塞时不得推送任何模型产出')
  assert.ok(!kinds.includes('done'), '阻塞时不得下发 done')
  assert.equal(compileCalls().length, 0, '★ 语义歧义:编译调用必须为 0')
  const gate = events[0]
  assert.equal(gate.gate.blocked, true)
  assert.ok(gate.gate.blocking_items.length >= 1, '★ 阻塞项来自语义歧义')
  assert.match(gate.gate.blocking_items[0].text, /指代不明/)
  assert.ok(Array.isArray(gate.ledger), '阻塞时必须带出台账字段')
  assert.ok(String(gate.rationale ?? '').length > 0, '必须给出用户可读的门禁理由')
  console.log('✓ p1g1b 语义歧义 → 仅 discovery_required,零编译调用')
}

// 2. 无阻塞项 → 正常 meta→delta→done,且 meta 携带完整分析结论
{
  const { handler, calls, compileCalls } = await setup({
    respond: (_options, index) => chunkText(index === 0 ? ANALYSIS_OK : COMPILE_OUTPUT),
  })
  const res = await call(handler, { text: RESEARCH_TEXT, provider: 'p', model: 'm' })
  const events = sseEvents(res)
  const meta = events.find((e) => e.type === 'meta')
  const done = events.find((e) => e.type === 'done')

  assert.equal(events[0].type, 'meta', 'meta 必须第一个事件')
  assert.ok(events.some((e) => e.type === 'delta'))
  assert.ok(done, '应收到 done')
  assert.equal(calls.length, 2, '分析 1 次 + 编译 1 次')
  assert.equal(compileCalls().length, 1)

  assert.equal(meta.intent.primary, 'research')
  assert.equal(meta.intent.work_mode, 'exploratory')
  assert.equal(meta.target.target, 'research')
  assert.equal(meta.target.modality, 'text')
  assert.equal(meta.triage.triage, 'RESTRUCTURE')
  assert.ok(Array.isArray(meta.ledger))
  assert.equal(meta.missing_resolution.length, 1)
  assert.equal(meta.missing_resolution[0].classification, 'AGENT_DISCOVERABLE')

  // 台账:用户要求 CONFIRMED、可自查项 DISCOVERABLE,且来源/状态分离
  const explicit = done.ledger.find((e) => e.source === 'USER_EXPLICIT')
  assert.ok(explicit, 'done 台账必须带上用户要求')
  assert.equal(explicit.status, 'CONFIRMED')
  const discoverable = done.ledger.find((e) => e.status === 'DISCOVERABLE')
  assert.ok(discoverable, '可自查项应标 DISCOVERABLE 而非 [待补充:] 语义')
  assert.ok(done.optimized.includes('研究任务'), '编译产出正常返回')
  assert.equal(done.target.target, 'research')
  assert.equal(done.triage.triage, 'RESTRUCTURE')
  console.log('✓ p1g2 无阻塞 → 正常生成 + meta/done 带完整分析结论')
}

// 3. KEEP 分诊 → 零模型改写,输出逐字等于输入
{
  const keepAnalysis = JSON.stringify({
    primary_intent: 'review',
    supporting_intents: ['execution'],
    work_mode: 'one_shot',
    target: 'coding',
    edit_triage: 'KEEP',
    triage_reasons: ['已是高质量成稿'],
    unknowns: [{ text: '预算范围', classification: 'USER_REQUIRED', blocking: true, rationale: '本该阻塞' }],
    requirements: [],
    suggestions: [],
    confidence_internal: 0.9,
    rationale: '输入已是成稿',
    evidence_quotes: [],
  })
  const { handler, calls, compileCalls } = await setup({
    respond: (_options, index) => chunkText(index === 0 ? keepAnalysis : COMPILE_OUTPUT),
  })
  const res = await call(handler, { text: COMPLETE_PROMPT, provider: 'p', model: 'm' })
  const events = sseEvents(res)
  const done = events.find((e) => e.type === 'done')

  assert.equal(calls.length, 1, 'KEEP 只允许 1 次分析调用,不得调用模型改写')
  assert.equal(compileCalls().length, 0, 'KEEP 不得进入编译')
  assert.ok(!events.some((e) => e.type === 'delta'), 'KEEP 不得流式改写输出')
  assert.ok(done, 'KEEP 仍应下发 done(交付原稿)')
  assert.equal(done.keep, true)
  assert.equal(done.triage.triage, 'KEEP')
  assert.equal(done.triage.keep_safe, true)
  assert.equal(done.optimized, COMPLETE_PROMPT, 'KEEP 输出必须与用户输入逐字一致')
  assert.equal(done.provenance_ok, true)
  // KEEP 的硬承诺压过阻塞项:成稿不追问
  assert.equal(done.missing_resolution.length, 1)
  assert.equal(
    events.some((e) => e.type === 'discovery_required'),
    false,
    'KEEP 不追问(追问与「原样保留」自相矛盾)',
  )
  console.log('✓ p1g3 KEEP → 零模型改写,输出逐字等于输入')
}

// 4. 图像目标:分析如实标注 modality,Phase 1 不改编译契约
{
  const imageAnalysis = JSON.stringify({
    primary_intent: 'execution',
    work_mode: 'one_shot',
    target: 'image_generation',
    target_engine: 'Midjourney',
    edit_triage: 'PATCH',
    unknowns: [{ text: '画幅比例', classification: 'USER_REQUIRED', blocking: false, rationale: '有默认值' }],
    requirements: [],
    suggestions: [],
    confidence_internal: 0.8,
    rationale: '用户要出图',
    evidence_quotes: [],
  })
  const { handler } = await setup({
    respond: (_options, index) => chunkText(index === 0 ? imageAnalysis : COMPILE_OUTPUT),
  })
  const res = await call(handler, { text: '帮我画一张赛博朋克风格的城市海报', provider: 'p', model: 'm' })
  const meta = sseEvents(res).find((e) => e.type === 'meta')
  assert.equal(meta.target.target, 'image_generation')
  assert.equal(meta.target.modality, 'image')
  assert.equal(meta.target.engine.id, 'midjourney')
  assert.equal(meta.gate.blocked, false, '低影响项不得阻塞')
  console.log('✓ p1g4 图像目标如实标注(引擎 high 置信 + 不误阻塞)')
}

// 5. 手动覆盖:零分析调用(尊重用户选择),仍带目标解析
{
  const { handler, calls } = await setup({ respond: () => chunkText(COMPILE_OUTPUT) })
  const res = await call(handler, { text: '帮我画一张海报', promptType: 'execution', provider: 'p', model: 'm' })
  const meta = sseEvents(res).find((e) => e.type === 'meta')
  assert.equal(calls.length, 1, '手动覆盖零分析调用')
  assert.equal(isMetaAnalysisCall(calls[0].system), false, '唯一调用是编译调用')
  assert.equal(meta.prompt_type, 'execution')
  assert.equal(meta.confidence_level, 'High')
  assert.equal(meta.target.target, 'image_generation', '手动路径仍识别目标')
  assert.equal(
    sseEvents(res).some((e) => e.type === 'discovery_required'),
    false,
    '手动路径不得被门阻断',
  )
  console.log('✓ p1g5 手动覆盖零分析调用 + 目标线索仍识别')
}

// 6. 分析失败 → 兜底继续编译(门不误伤:拿不准就不阻断)
{
  const { handler, calls } = await setup({
    respond: (_options, index) => chunkText(index === 0 ? '我不是 JSON' : GENERAL_OUTPUT),
  })
  const res = await call(handler, { text: RESEARCH_TEXT, provider: 'p', model: 'm' })
  const events = sseEvents(res)
  const meta = events.find((e) => e.type === 'meta')
  const done = events.find((e) => e.type === 'done')
  // RC:解析失败 → 一次性加预算重试(2 次分析 + 1 次编译)
  assert.equal(calls.length, 3, 'RC:分析解析失败 → 重试一次,再继续编译')
  assert.ok(done, '分析失败不得阻断用户')
  assert.equal(
    events.some((e) => e.type === 'discovery_required'),
    false,
    '兜底绝不制造阻塞',
  )
  assert.equal(meta.prompt_type, 'general')
  assert.equal(done.provenance_ok, true)
  console.log('✓ p1g6 分析失败 → 兜底继续,绝不误阻断')
}

// 7. v2 Phase 2 端到端:图像目标经宿主 → 描述式契约 + 零 [待补充:] + contract 下发
{
  const IMAGE_ANALYSIS = JSON.stringify({
    primary_intent: 'execution',
    supporting_intents: [],
    work_mode: 'one_shot',
    target: 'image_generation',
    target_engine: 'Midjourney',
    edit_triage: 'PATCH',
    unknowns: [
      { text: '当前可用的出图链路与依赖版本', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '执行方自查' },
      { text: '现有实现的路径', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '自然获得' },
    ],
    requirements: [],
    suggestions: [],
    confidence_internal: 0.9,
    rationale: '用户要出图',
    evidence_quotes: [],
  })
  const IMAGE_BODY = [
    '<<<DIAGNOSIS>>>',
    '目标明确:出图',
    '<<<EXPLICIT>>>',
    '(无)',
    '<<<CONTEXT>>>',
    '(无)',
    '<<<SUGGESTED>>>',
    '(无)',
    '<<<UNKNOWN>>>',
    '(无)',
    '<<<OPTIMIZED>>>',
    '## Subject（主体）',
    '- 雨夜霓虹街道上的撑伞人',
    '## Scene（场景与环境）',
    '- 赛博朋克城市夜景',
    '## Style（风格）',
    '- 赛博朋克插画',
    '## Composition（构图与镜头）',
    '- 竖版低机位',
    '## Lighting & Color（光线与色调）',
    '- 冷青主调 + 品红霓虹',
    '## Aspect Ratio（画幅与画质）',
    '- 9:16',
    '## Negative（排除项）',
    '- 不要文字水印',
    '<<<END>>>',
  ].join('\n')
  const { handler, calls, compileCalls } = await setup({
    respond: (_options, index) => chunkText(index === 0 ? IMAGE_ANALYSIS : IMAGE_BODY),
  })
  const res = await call(handler, { text: '帮我画一张赛博朋克城市夜景海报', provider: 'p', model: 'm' })
  const events = sseEvents(res)
  const meta = events.find((e) => e.type === 'meta')
  const done = events.find((e) => e.type === 'done')
  assert.equal(calls.length, 2, '分析 1 次 + 编译 1 次')
  assert.equal(compileCalls().length, 1)
  assert.equal(meta.prompt_type, 'execution', 'prompt_type 仍表达工作意图')
  assert.equal(meta.contract, 'image', 'meta 必须下发编译契约')
  assert.equal(done.contract, 'image')
  assert.ok(done.optimized.includes('Subject'), '图像契约正文照常返回')
  assert.doesNotMatch(done.optimized, /\[(?:待补充|TODO)\s*[:：]/, 'v2:宿主产出不得含退役占位符')
  assert.ok(
    done.optimized.includes('动手前先确认:当前可用的出图链路与依赖版本'),
    'v2:可自查项落成动作式执行责任',
  )
  assert.equal(done.optimized.includes('现有实现的路径'), false, 'v2:自然获得项省略')
  for (const heading of ['Goal', 'Phases', 'Tasks', 'Acceptance Criteria']) {
    assert.doesNotMatch(
      done.optimized,
      new RegExp(`(?:^|\\n)\\s*#{0,6}\\s*\\**${heading}\\b`, 'i'),
      `v2:图像成品不得出现任务模板标题「${heading}」`,
    )
  }
  console.log('✓ p1g7 图像目标端到端:描述式契约 + contract 下发 + 零占位符')
}

console.log('phase1-gate.test.mjs: ALL PASS')
