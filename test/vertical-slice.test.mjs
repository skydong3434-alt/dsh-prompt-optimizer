/**
 * Vertical Slice 端到端冒烟(smoke 扩展):真实案例
 *   AUTO classifier → Research strategy → compiler → provenance 校验 →
 *   host SSE(meta→delta→done) → 四组来源
 * 用真实 cordis Context + mock llm(按 system 文案锚点区分分析调用 / 编译调用;
 * 分析阶段的预算从 512 改为 1024 后,maxTokens 不再是可靠判据)。
 *
 * 运行:先 `npm run build`,再 `node test/vertical-slice.test.mjs`。
 */
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { isMetaAnalysisCall, ANALYSIS_MAX_TOKENS, ANALYSIS_SYSTEM_MARKER } from '../lib/core/analyze.js'

const REAL_CASE =
  '帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频,我看到黑鹤001低显流,还有 H3……'

const CLASSIFIER_JSON = JSON.stringify({
  prompt_type: 'research',
  confidence_internal: 0.86,
  missing_constraints: ['期望的视频产出形式与时长', 'Mac 本机可接受的生成耗时'],
  rationale: '用户在寻求 Mac 上 ComfyUI 做 AI 视频的研究路径',
  evidence_quotes: ['Mac M1 Pro 32GB', '黑鹤001低显流', 'H3'],
})

/** 真实案例的 mock 编译产物:四段标记协议 + 15 段研究 Prompt 的关键段落。 */
const COMPILE_OUTPUT = [
  '<<<DIAGNOSIS>>>',
  '目标清晰度:目标明确(在 Mac 上用 ComfyUI 做 AI 视频) | 约束边界:时长/产出来源未说明 | 风险:平台兼容性证据不足',
  '<<<EXPLICIT>>>',
  '- 研究目标:在 Mac M1 Pro 32GB 上使用 ComfyUI 做 AI 视频 [quote: Mac M1 Pro 32GB] [quote: ComfyUI]',
  '- 已知候选线索:黑鹤001低显流、H3 [quote: 黑鹤001低显流] [quote: H3]',
  '<<<CONTEXT>>>',
  '- 机器为 Mac M1 Pro 32GB [quote: 我的机器是 Mac M1 Pro 32GB]',
  '<<<SUGGESTED>>>',
  '- 建议(可忽略) 补充目标视频产出形式与时长',
  '- 建议(可忽略) 优先核对官方文档与 Mac/Metal 可复现实践',
  '<<<UNKNOWN>>>',
  '- [待补充: 期望的视频产出形式与时长,决定显存与模型选择]',
  '- [待补充: Mac 本机可接受的生成耗时]',
  '<<<OPTIMIZED>>>',
  '## Background（背景）',
  '- 用户机器为 Mac M1 Pro 32GB,希望用 ComfyUI 做 AI 视频。',
  '## Research Goal（研究目标）',
  '- 研究 Mac M1 Pro 32GB 上用 ComfyUI 做 AI 视频的可执行路径。',
  '## Existing Knowledge（已知信息）',
  '- 用户提到黑鹤001低显流与 H3,二者均为待验证候选线索。',
  '## Constraints（约束）',
  '- [待补充: 期望的视频产出形式与时长]',
  '- [待补充: Mac 本机可接受的生成耗时]',
  '## Candidate Approaches（候选方案）',
  '- 黑鹤001(低显流):候选,待验证 Mac/Metal 兼容性。',
  '- H3:候选,待验证依赖与显存占用。',
  '## Research Questions（研究问题）',
  '- ComfyUI 在 Mac M1 Pro 上可用的 AI 视频工作流有哪些?',
  '## Assumptions To Verify（待验证假设）',
  '- 假设低显存方案在 Mac 上可运行,需实测验证。',
  '## Evidence Requirements（证据要求）',
  '- 每类结论需官方文档或可复现实测支撑。',
  '## Source Priority（来源优先级）',
  '- 官方文档优先于社区转述。',
  '## Conflicting Evidence（冲突证据）',
  '- 冲突说法需并列呈现,不得擅自裁决。',
  '## Evidence Gaps（证据缺口）',
  '- [待补充: 是否存在 Mac 实测案例与可复现步骤]',
  '## Continue-search Conditions（继续检索条件）',
  '- 只有单一来源时继续检索。',
  '## Comparison Dimensions（对比维度）',
  '- 兼容性 / 性能 / 成本 / 维护性。',
  '## Human Decision Points（人工决策点）',
  '- 是否优先验证某条候选路线由用户决定。',
  '## Research Completion Criteria（研究完成标准）',
  '- 关键问题均有证据支撑时结束本轮研究。',
  '<<<END>>>',
].join('\n')

const LEGACY_OUTPUT = ['<<<ANALYSIS>>>', '简要分析', '<<<OPTIMIZED>>>', '通用改写结果', '<<<END>>>'].join('\n')

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
    writeHead(status, hs) {
      res.status = status
      res.headers = hs ?? {}
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

/**
 * mock llm:元任务分析调用(system 含分析器锚点)返回 CLASSIFIER_JSON,编译调用返回
 * COMPILE_OUTPUT;`overrides.stream` 可整体替换。calls 记录全部 GenerateOptions。
 */
function makeLlm(overrides = {}) {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      if (isMetaAnalysisCall(options.system)) {
        yield { type: 'text-delta', index: 0, text: CLASSIFIER_JSON }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: COMPILE_OUTPUT }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek 官方' }],
    listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    ...overrides,
  }
}

async function setup({ config = {}, llmOverrides = {} } = {}) {
  const routes = {}
  const ctx = new Context()
  ctx.provide('httpServer', {
    register(r) {
      routes[r.path] = r
      return () => {}
    },
  })
  const llm = makeLlm(llmOverrides)
  ctx.provide('llm', llm)
  await ctx.plugin(plugin, config)
  assert.ok(routes['/dsh-prompt-optimizer/optimize'], '插件应注册优化路由')
  return { ctx, llm, handler: routes['/dsh-prompt-optimizer/optimize'].handler }
}

// 1. 真实案例全链路:AUTO → Research → 编译 → provenance;四组来源可审计
{
  const { handler, llm } = await setup()
  const contextTurn = { role: 'user', text: '我的机器是 Mac M1 Pro 32GB' }
  const res = await call(handler, { text: REAL_CASE, provider: 'p', model: 'm', context: [contextTurn] })
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /text\/event-stream/)
  const events = sseEvents(res)
  const metaIndex = events.findIndex((e) => e.type === 'meta')
  const firstDelta = events.findIndex((e) => e.type === 'delta')
  const doneIndex = events.findIndex((e) => e.type === 'done')
  assert.equal(metaIndex, 0, 'meta 必须是第一个事件')
  assert.ok(firstDelta > metaIndex && doneIndex > firstDelta, '事件序必须 meta→delta…→done')

  const meta = events[metaIndex]
  assert.equal(meta.prompt_type, 'research', '真实案例必须识别为 research')
  assert.equal(meta.confidence_level, 'High', '0.86 应映射 High')
  assert.equal(meta.missing_constraints.length, 2)
  assert.match(String(meta.rationale), /研究/)
  assert.equal(meta.provenance_ok, true)

  const done = events[doneIndex]
  assert.equal(done.prompt_type, 'research')
  assert.equal(done.strategy_version, '0.2.0', '策略独立版本必须可审计')
  assert.equal(done.provenance_ok, true, '机械比对 + 守卫必须通过')
  assert.equal(done.wellFormed, true)

  // 四组来源区分
  assert.equal(done.explicit_requirements.length, 2)
  assert.ok(done.explicit_requirements.every((r) => r.source === 'USER_EXPLICIT'))
  assert.equal(done.context_requirements.length, 1)
  assert.equal(done.context_requirements[0].source, 'CONTEXT_EXPLICIT')
  assert.equal(done.suggested_requirements.length, 2)
  assert.ok(done.suggested_requirements.every((r) => r.source === 'OPTIMIZER_SUGGESTED'))
  assert.equal(done.unknowns.length, 2)
  assert.ok(done.unknowns.every((r) => r.source === 'UNKNOWN'))
  const sources = new Set([
    ...done.explicit_requirements,
    ...done.context_requirements,
    ...done.suggested_requirements,
    ...done.unknowns,
  ].map((r) => r.source))
  assert.deepEqual([...sources].sort(), ['CONTEXT_EXPLICIT', 'OPTIMIZER_SUGGESTED', 'UNKNOWN', 'USER_EXPLICIT'])

  // 验收线:H3 不确认 / 黑鹤001 不淘汰 / 不发明预算 / 缺口显式
  const optimized = String(done.optimized ?? '')
  assert.doesNotMatch(optimized, /H3\s*(已确认|确定|采用|选用|定为)/, 'H3 不得写成已确认路线')
  assert.doesNotMatch(optimized, /黑鹤001\s*(不可行|淘汰|放弃|排除)/, '黑鹤001 不得被淘汰')
  assert.doesNotMatch(optimized, /预算|万元|人民币|¥/, '不得凭空发明预算')
  assert.match(optimized, /\[待补充:/, '必须显式暴露证据缺口')
  assert.ok(optimized.includes('Mac M1 Pro 32GB'), '专有名词必须保留')
  assert.ok(!optimized.includes('<<<'), '优化稿不得混入协议标记')

  // 分析调用参数:maxTokens 1024 / temperature 0;编译调用另一次
  assert.equal(llm.calls.length, 2, 'AUTO = 分析调用 + 编译调用')
  assert.equal(llm.calls[0].maxTokens, ANALYSIS_MAX_TOKENS)
  assert.equal(llm.calls[0].temperature, 0)
  assert.equal(llm.calls[0].provider, 'p')
  assert.ok(llm.calls[0].system.includes(ANALYSIS_SYSTEM_MARKER), '分析 system prompt 应存在')
  // 编译调用注入 research system + 机器可解析协议;user 携带原始输入与上下文
  const compileCall = llm.calls[1]
  assert.ok(compileCall.system.includes('Research 研究型 Prompt 编译器'))
  assert.ok(compileCall.system.includes('<<<OPTIMIZED>>>'), '编译协议必须包含 OPTIMIZED 锚点')
  assert.ok(compileCall.system.includes('没有案例 ≠ 不可行'), '研究铁律必须进入 system')
  const userText = compileCall.messages[0].content[0].text
  assert.ok(userText.includes(REAL_CASE), 'user 载荷必须包含原始输入')
  assert.ok(userText.includes('我的机器是 Mac M1 Pro 32GB'), 'user 载荷必须包含上下文')
  console.log('✓ vs1 真实案例全链路(AUTO→Research→provenance→SSE)')
}

// 2. 手动 override:完全不调用分类(只有编译一次调用);meta 直接 High
{
  const { handler, llm } = await setup()
  const res = await call(handler, {
    text: REAL_CASE,
    provider: 'p',
    model: 'm',
    promptType: 'research',
    context: [{ role: 'user', text: '我的机器是 Mac M1 Pro 32GB' }],
  })
  const events = sseEvents(res)
  const meta = events.find((e) => e.type === 'meta')
  const done = events.find((e) => e.type === 'done')
  assert.equal(meta.prompt_type, 'research')
  assert.equal(meta.confidence_level, 'High')
  assert.match(String(meta.rationale), /手动/)
  assert.equal(done.provenance_ok, true)
  assert.equal(llm.calls.length, 1, 'override 不得触发分析调用(函数级断言)')
  assert.ok(!isMetaAnalysisCall(llm.calls[0].system), '唯一一次调用应是编译调用')
  console.log('✓ vs2 手动 override 跳过分析')
}

// 3. 非法 promptType 按 AUTO 处理(不能因未知值绕过分类)
{
  const { handler, llm } = await setup()
  const res = await call(handler, { text: REAL_CASE, provider: 'p', model: 'm', promptType: 'not-a-type' })
  const done = sseEvents(res).find((e) => e.type === 'done')
  assert.equal(done.prompt_type, 'research')
  assert.equal(llm.calls.length, 2, '非法 promptType 应回落 AUTO(分析 + 编译)')
  console.log('✓ vs3 非法 promptType 回落 AUTO')
}

// 4. 分析失败 → general 兜底(legacy 路径零回归,provenance 为空但 ok=true)
{
  const { handler } = await setup({
    llmOverrides: {
      async *stream(options) {
        if (isMetaAnalysisCall(options.system)) {
          yield { type: 'text-delta', index: 0, text: 'not a json classifier answer' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', index: 0, text: LEGACY_OUTPUT }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const res = await call(handler, { text: REAL_CASE, provider: 'p', model: 'm' })
  const events = sseEvents(res)
  const meta = events.find((e) => e.type === 'meta')
  const done = events.find((e) => e.type === 'done')
  assert.equal(meta.prompt_type, 'general')
  assert.equal(meta.confidence_level, 'Low')
  assert.equal(done.prompt_type, 'general')
  assert.equal(done.provenance_ok, true, 'legacy 兜底无可校验 provenance 段,应为 true')
  assert.equal(done.optimized, '通用改写结果')
  console.log('✓ vs4 分类失败 general 兜底(零回归)')
}

console.log('\nvertical-slice: all passed')
