/**
 * V3 单次调用路径测试（自适应提示词优化器）。
 *
 * 覆盖 §十一 要求:普通交流 / 想法讨论 / 深度研究 / 内容创作 / 图片生成 / 图片编辑 /
 * 视频生成 / 首尾帧视频 / 音频生成 / Agent 开发任务 / 严格结构化输出 / 关键歧义提问 /
 * 用户回答后继续 / 高风险操作边界 / 模型超时 / 原有清晰提示词的最小修改。
 *
 * 关键回归:「我想用 DSH 控制 ComfyUI 生成视频」**不得**识别为 VIDEO。
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import {
  buildV3Messages,
  inferUsageMechanically,
  looksStructured,
  parseV3Output,
  detectIntentExpansion,
  detectSpecialUsageTemplateDrift,
  looksLikeProtocolEnvelope,
  conservativeOutput,
  stripThinking,
  previewableText,
} from '../lib/core/v3.js'

// ── 1. 用途判定严格性(机械兜底 + 提示词约束) ────────────────────────────────
{
  const cases = [
    ['我想用 DSH 控制 ComfyUI 生成视频', 'GENERAL'],
    ['我想用 dsh 控制 comfyui 生成视频。', 'GENERAL'],
    ['帮我做一个 AI 知识库', 'GENERAL'],
    ['帮我把这个优化一下', 'GENERAL'],
    ['先看看能不能实现这个功能', 'GENERAL'],
    ['帮我写一段可灵图生视频提示词', 'VIDEO'],
    ['帮我写一个可灵首帧图生视频提示词', 'VIDEO'],
    ['写一个二次元女孩的生图提示词', 'IMAGE'],
    ['帮我写一段图片编辑提示词', 'IMAGE'],
    ['帮我写一段配音音频提示词', 'AUDIO'],
    ['帮我写给 Codex 的代码修复任务', 'AGENT'],
    // ★ 真实 UI 人工验收失败样本(m02408 ③):「优化一段…提示词」也是对该生成提示词的明确诉求
    ['帮我优化一段可灵图生视频提示词：一个女孩在雨夜街道上缓慢行走，镜头从侧面跟拍。', 'VIDEO'],
    // ★ 反向保护:只是提到「优化」+ 代码/流程,不是在要生成提示词 → 仍是 GENERAL
    ['帮我优化一下这段代码', 'GENERAL'],
    ['帮我优化这个流程', 'GENERAL'],
    // ★ 真实 UI 人工验收失败样本(m02408 ②):不得因为缺名字而改变用途
    ['帮我看看这个软件哪里不好用还有什么地方可以改怎么弄比较好。', 'GENERAL'],
  ]
  for (const [text, expected] of cases) {
    assert.equal(inferUsageMechanically(text), expected, `★ 用途判定:「${text}」应为 ${expected}`)
  }
  // 提示词里必须明确写出「关键词不算用途」的纪律(防止模型把 GENERAL 误判成 VIDEO)
  const system = buildV3Messages({ rawInput: 'x' })[0].content
  assert.match(system, /仅出现关键词不算/, '★ 系统提示必须禁止「关键词即用途」')
  assert.match(system, /我想用 DSH 控制 ComfyUI 生成视频.*GENERAL/s, '★ 提示里必须给出该反例')
  console.log('✓ v3-1 用途判定:DSH+ComfyUI+视频 → GENERAL;显式生成用途才触发特殊类型')
}

// ── 2. STRUCTURED 叠加 ─────────────────────────────────────────────────────
{
  assert.equal(looksStructured('严格 JSON 格式输出'), true)
  assert.equal(looksStructured('输出格式:字段固定'), true)
  assert.equal(looksStructured('帮我写个方案'), false)
  const r = parseV3Output(JSON.stringify({ status: 'optimized', usage: 'AGENT', structured: true, output: '## 目标\n- x' }), '严格 JSON 的 agent 任务')
  assert.equal(r.structured, true)
  assert.equal(r.usage, 'AGENT')
  console.log('✓ v3-2 STRUCTURED 可与用途叠加')
}

// ── 3. 协议解析(optimized / needs_clarification / 非 JSON 兜底) ─────────────
{
  const opt = parseV3Output('```json\n{"status":"optimized","usage":"IMAGE","structured":false,"output":"主体:女孩"}\n```', '写个生图提示词')
  assert.equal(opt.status, 'optimized')
  assert.equal(opt.usage, 'IMAGE')
  assert.equal(opt.output, '主体:女孩')

  const clar = parseV3Output(JSON.stringify({ status: 'needs_clarification', usage: 'GENERAL', structured: false, question: '「这个」指什么?' }), '帮我把这个优化一下')
  assert.equal(clar.status, 'needs_clarification')
  assert.equal(clar.question, '「这个」指什么?')

  const fallback = parseV3Output('## 目标\n- 直接用这段文字', '帮我写个方案')
  assert.equal(fallback.status, 'optimized')
  assert.equal(fallback.output.includes('直接用这段文字'), true, '非 JSON 输出必须兜底为结果,不得丢弃')

  const empty = parseV3Output('', '帮我写个方案')
  assert.equal(empty.status, 'optimized')
  assert.equal(empty.output, '', '空输出交给上层报技术错误')
  console.log('✓ v3-3 协议解析:JSON / 围栏 / 非 JSON 兜底 / 空')
}

// ── 4. 宿主端到端(mock 模型,验证调用次数与状态机) ──────────────────────────
const V3_OPTIMIZED = (usage, output) => JSON.stringify({ status: 'optimized', usage, structured: false, output })
const V3_CLARIFY = (question) => JSON.stringify({ status: 'needs_clarification', usage: 'GENERAL', structured: false, question })

async function setup({ responses }) {
  const routes = {}
  const calls = []
  const ctx = new Context()
  ctx.provide('httpServer', { register(r) { routes[r.path] = r; return () => {} } })
  ctx.provide('llm', {
    async *stream(options) {
      calls.push(options)
      const text = responses[Math.min(calls.length - 1, responses.length - 1)]
      for (const line of String(text).split('\n')) yield { type: 'text-delta', index: 0, text: line + '\n' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'p', name: 'p' }],
    listModels: async () => [{ id: 'm', provider: 'p', name: 'm' }],
    resolveModelInfo: async () => ({ id: 'm', provider: 'p', reasoning: { efforts: [{ id: 'low' }] } }),
  })
  await ctx.plugin(plugin, { v3: true })
  return { routes, calls }
}

async function call(routes, body) {
  const handler = routes['/dsh-prompt-optimizer/optimize'].handler
  const res = { status: 0, headers: {}, body: '', writableEnded: false, destroyed: false, on() {}, writeHead(s, h) { res.status = s; res.headers = h ?? {} }, write(c) { res.body += c; return true }, end(p) { if (p) res.body += p; res.writableEnded = true } }
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'
  req.headers = {}
  await handler(req, res)
  return res.body.split('\n\n').filter(Boolean).map((f) => { const l = f.split('\n').find((x) => x.startsWith('data:')); return l ? JSON.parse(l.slice(5).trim()) : null }).filter(Boolean)
}

// 4a. 正常输入:一次模型调用完成
{
  const { routes, calls } = await setup({ responses: [V3_OPTIMIZED('GENERAL', '## 目标\n- 建立 DSH 控制 ComfyUI 的能力')] })
  const events = await call(routes, { text: '我想用 DSH 控制 ComfyUI 生成视频', provider: 'p', model: 'm' })
  const kinds = events.filter((e) => e.type !== 'delta').map((e) => e.type)
  assert.deepEqual(kinds, ['meta', 'validating', 'done'], '★ 正常路径事件序必须是 meta→validating→done')
  assert.equal(calls.length, 1, '★ 必须只有 1 次模型调用')
  const done = events.find((e) => e.type === 'done')
  assert.equal(done.usage, 'GENERAL', '★ T1 必须识别为 GENERAL')
  assert.equal(done.v3, true)
  assert.ok(done.optimized.includes('ComfyUI'))
  assert.equal(events.some((e) => e.type === 'discovery_required'), false, '★ 不得提问')
  console.log('✓ v3-4a 正常路径:1 次模型调用 → meta→validating→done(GENERAL)')
}

// 4b. 关键歧义:一次调用 → 1 个问题;回答后继续(再一次调用)
{
  const { routes, calls } = await setup({ responses: [V3_CLARIFY('「这个」具体指什么?'), V3_OPTIMIZED('GENERAL', '## 目标\n- 优化订单服务')] })
  const first = await call(routes, { text: '帮我把这个优化一下。', provider: 'p', model: 'm' })
  const q = first.find((e) => e.type === 'discovery_required')
  assert.ok(q, '★ 关键歧义必须提问')
  assert.equal(q.status, 'needs_clarification')
  assert.equal(q.questions.length, 1, '★ 每轮恰好 1 个问题')
  assert.equal(q.questions[0].allow_blind_trust, true, '必须允许「保持未确定,直接优化」')
  assert.equal(calls.length, 1, '提问也是一次调用')

  const second = await call(routes, {
    text: '帮我把这个优化一下。',
    provider: 'p',
    model: 'm',
    discovery: { mode: 'answer', round: 1, triage: 'REBUILD', ledger: [], asked: [{ key: q.questions[0].key, question: q.questions[0].question, round: 1 }], answers: [{ key: q.questions[0].key, text: '订单服务模块' }], questions: q.questions, analysis: null },
  })
  const done = second.find((e) => e.type === 'done')
  assert.ok(done, '★ 回答后必须继续优化并交付')
  assert.equal(calls.length, 2, '回答后仅再调用一次')
  assert.equal(second.some((e) => e.type === 'discovery_required'), false, '★ 不得重复提问')
  console.log('✓ v3-4b 关键歧义:1 问 → 回答 → 再 1 次调用交付(不重复问)')
}

// 4c. 空产出:技术错误独立显示(不得伪装成澄清)
{
  const { routes } = await setup({ responses: [''] })
  const events = await call(routes, { text: '帮我写个方案', provider: 'p', model: 'm' })
  const err = events.find((e) => e.type === 'error')
  assert.ok(err, '★ 空产出必须报技术错误')
  assert.equal(err.reason_code, 'VF_EMPTY_OUTPUT')
  assert.equal(events.some((e) => e.type === 'discovery_required'), false, '★ 技术错误不得伪装成业务澄清')
  console.log('✓ v3-4c 空产出 → error(独立于业务澄清)')
}

// 4d. 硬约束保留(机械安全检查,不额外调用模型)
{
  const { routes, calls } = await setup({ responses: [V3_OPTIMIZED('AGENT', '## 目标\n- 只检查代码问题,不修改任何文件')] })
  const events = await call(routes, { text: '帮我看看代码问题。只检查,不修改任何文件。', provider: 'p', model: 'm' })
  const done = events.find((e) => e.type === 'done')
  assert.equal(done.provenance_ok, true, '★ 硬约束保留 → provenance_ok')
  assert.equal(calls.length, 1, '安全检查不得增加模型调用')
  console.log('✓ v3-4d 硬约束保留:机械检查,零额外模型调用')
}

// 4e. 模型超时:走既有统一处置(不吞错)
{
  const routes = {}
  const ctx = new Context()
  ctx.provide('httpServer', { register(r) { routes[r.path] = r; return () => {} } })
  ctx.provide('llm', {
    async *stream() {
      await new Promise((resolve) => setTimeout(resolve, 50))
      throw new Error('boom')
    },
    listProviders: () => [{ id: 'p', name: 'p' }],
    listModels: async () => [{ id: 'm', provider: 'p', name: 'm' }],
    resolveModelInfo: async () => ({ id: 'm', provider: 'p', reasoning: { efforts: [{ id: 'low' }] } }),
  })
  await ctx.plugin(plugin, { v3: true })
  const events = await call(routes, { text: '帮我写个方案', provider: 'p', model: 'm' })
  assert.ok(events.some((e) => e.type === 'error'), '★ 模型错误必须落到明确终态')
  console.log('✓ v3-4e 模型错误 → 明确 error 终态')
}

// ── 5. §十一 输入清单 → 期望用途(机械层) ───────────────────────────────────
{
  const corpus = [
    ['普通交流', '今天天气不错,随便聊聊', 'GENERAL'],
    ['想法讨论', '我想做一个 AI 知识库', 'GENERAL'],
    ['深度研究', '帮我研究一下本地大模型部署方案的优劣', 'GENERAL'],
    ['内容创作', '帮我写一篇关于咖啡的小红书文案', 'GENERAL'],
    ['图片生成', '写一个二次元女孩的生图提示词', 'IMAGE'],
    ['图片编辑', '帮我写一段图片编辑提示词,把背景换成海边', 'IMAGE'],
    ['视频生成', '帮我写一段可灵文生视频提示词', 'VIDEO'],
    ['首尾帧视频', '帮我写一个可灵首帧图生视频提示词', 'VIDEO'],
    ['音频生成', '帮我写一段配音音频提示词', 'AUDIO'],
    ['Agent 开发任务', '帮我写给 Codex 的代码修复任务', 'AGENT'],
    ['严格结构化输出', '严格 JSON 格式输出一个 agent 任务指令', 'AGENT'],
    ['关键歧义提问', '把它改成第二种', 'GENERAL'],
    ['高风险操作边界', '删除旧版本然后安装新的', 'GENERAL'],
    ['原有清晰提示词的最小修改', '请审查并重构订单服务模块。约束:仅限修改 src/order;输出格式:问题清单;验收:npm test 全绿。', 'GENERAL'],
  ]
  for (const [label, text, expected] of corpus) {
    assert.equal(inferUsageMechanically(text), expected, `★ ${label}:用途应为 ${expected}`)
  }
  console.log('✓ v3-5 §十一 输入清单:用途判定全部符合预期')
}

// ── 6. 不得擅自扩展任务方向(核心回归) ─────────────────────────────────────
{
  // 目标描述不得变成规划任务:真实失败样本
  const raw = '我想用DSH控制ComfyUI生成视频。'
  const bad = '我想用 DSH 控制 ComfyUI 来生成视频，请围绕这个目标给出可行方案。具体实现细节由执行方自行确认。'
  const good = '我想用 DSH 控制 ComfyUI 来生成视频。'
  assert.equal(detectIntentExpansion(raw, bad).expanded, true, '★ 「请围绕这个目标给出可行方案」必须判为扩展')
  assert.ok(detectIntentExpansion(raw, bad).phrases.includes('可行方案'))
  assert.equal(detectIntentExpansion(raw, good).expanded, false, '★ 只理顺措辞不算扩展')
  assert.equal(conservativeOutput(raw), raw.trim(), '★ 保守回退 = 原文(不加任何内容)')

  // 想法交流不得变成执行任务
  assert.equal(detectIntentExpansion('我想做一个 AI 知识库', '我想做一个 AI 知识库。请帮我实现并部署上线。').expanded, true)
  // 原文确实在要方案/计划/步骤 → 不算扩展
  assert.equal(detectIntentExpansion('帮我制定一下上线计划', '帮我制定一下上线计划,先给出可行方案。').expanded, false)
  assert.equal(detectIntentExpansion('帮我把这个流程梳理成步骤', '请给出可行方案与步骤。').expanded, false)
  // 用户自己写了这个短语 → 不算扩展
  assert.equal(detectIntentExpansion('请给出可行方案', '请给出可行方案。').expanded, false)
  // 空输出不误判
  assert.equal(detectIntentExpansion('随便聊聊', '').expanded, false)

  // ★ 真实 UI 人工验收失败样本(m02408 ①):运行中的旧构建把
  //   「我想用DSH控制ComfyUI生成视频。」扩展成了下面这段(含接口 / 控制流程 / 实施限制)。
  const realBad =
    '我想用 DSH 作为控制端，去驱动本地或远程的 ComfyUI 来生成视频。\n\n' +
    '请说明可行的实现方式，覆盖以下要点：\n' +
    '1. 整体思路：DSH 如何与 ComfyUI 建立连接（API / WebSocket / 自定义节点等）。\n' +
    '2. 视频生成所依赖的 ComfyUI 工作流组成。\n' +
    '3. 接口与控制流程：在 DSH 中如何下发任务。\n' +
    '4. 实施限制：依赖安装、显存要求、首次加载耗时。\n\n' +
    '如果某个环节存在多种方案，请简要列出优劣。'
  const hit = detectIntentExpansion(raw, realBad)
  assert.equal(hit.expanded, true, '★ 真实失败样本(可行的实现方式 / 控制流程 / 实施限制)必须判为扩展')
  for (const p of ['实现方式', '控制流程', '实施限制', '整体思路', '覆盖以下要点', '列出优劣']) {
    assert.ok(hit.phrases.includes(p), `★ 必须命中扩展短语「${p}」`)
  }
  // 同一段文本,若原文本来就要求这些(思路 / 要点 / 方案)→ 不算扩展,避免误伤
  assert.equal(
    detectIntentExpansion('帮我梳理整体思路，覆盖以下要点', realBad).expanded,
    false,
    '★ 原文已要求思路/要点时不得误判为扩展',
  )
  // 想法讨论里出现「思路」→ 不得误判
  assert.equal(
    detectIntentExpansion('我想做一个本地知识库工具，先聊聊思路。', '我想做一个本地知识库工具，先聊聊整体思路。').expanded,
    false,
    '★ 原文在聊思路时「整体思路」不算新增任务方向',
  )
  console.log('✓ v3-6 意图扩展检测:目标描述/想法交流不得被改成规划或执行任务')
}

// ── 6b. 提示词规则不得被静默移除(真实 UI 失败 ①②的根因防线) ──────────────
{
  const zh = buildV3Messages({ rawInput: '测试', language: 'zh' }).find((m) => m.role === 'system').content
  const en = buildV3Messages({ rawInput: 'test', language: 'en' }).find((m) => m.role === 'system').content
  const zhText = String(zh)
  const enText = String(en)

  // ① 不得扩展任务方向:硬规则 + 逐字反例必须在提示词里
  assert.ok(zhText.includes('不得扩展任务方向'), '★ 中文提示词必须保留「不得扩展任务方向」硬规则')
  assert.ok(zhText.includes('请围绕这个目标给出可行方案'), '★ 必须保留逐字反例')
  assert.ok(enText.includes('NEVER expand the task direction'), '★ 英文提示词必须保留同规则')

  // ② 缺名字不算歧义:真实失败样本「这个软件」必须作为反例写在提示词里
  assert.ok(zhText.includes('缺一个名字/标识不算歧义'), '★ 中文提示词必须写明「缺名字不算歧义」')
  assert.ok(zhText.includes('这个软件'), '★ 必须保留「这个软件」这一逐字反例')
  assert.ok(zhText.includes('请分析这个软件目前存在哪些不好用的地方'), '★ 必须给出期望输出示例')
  assert.ok(enText.includes('MISSING NAME IS NOT AMBIGUITY'), '★ 英文提示词必须保留同规则')

  // 真正无法确定用户意图时仍然要能提问(不得因修②而取消澄清能力)
  assert.ok(zhText.includes('要做的**动作/方向**本身无法确定'), '★ 必须保留真歧义的提问条件')
  assert.ok(zhText.includes('与用户输入保持同一语言'), '★ 提示词必须要求与输入同语言(中文进→英文出是真实缺陷)')
  assert.ok(enText.includes('SAME language as the user'), '★ 英文提示词同样必须要求同语言')
  assert.ok(zhText.includes('把它改成第二种'), '★ 必须保留真歧义反例')
  console.log('✓ v3-6b 提示词规则防线:不得扩展任务方向 / 缺名字不算歧义(真实 UI 失败 ①②)')
}

// ── 7. 迁移自旧版的关键用户行为(V3 保护) ──────────────────────────────────
{
  // (a) 图片/视频/音频提示词内容保护:不得被写成执行任务模板
  const agentSkeleton = '## 目标\n生成一张图\n## 前置条件\n无\n## 验收\n图像清晰\n'
  assert.equal(detectSpecialUsageTemplateDrift('IMAGE', agentSkeleton).drifted, true, '★ IMAGE 不得出现执行任务骨架')
  assert.equal(detectSpecialUsageTemplateDrift('VIDEO', agentSkeleton).drifted, true, '★ VIDEO 同上')
  assert.equal(detectSpecialUsageTemplateDrift('AUDIO', agentSkeleton).drifted, true, '★ AUDIO 同上')
  assert.equal(detectSpecialUsageTemplateDrift('AGENT', agentSkeleton).drifted, false, '★ AGENT 本来就该有骨架')
  assert.equal(
    detectSpecialUsageTemplateDrift('IMAGE', '二次元女孩,海边黄昏,柔和光,暖色调').drifted,
    false,
    '★ 正常生图提示词不得误判',
  )
  assert.equal(
    detectSpecialUsageTemplateDrift('IMAGE', '## 主体\n女孩\n## 场景\n海边').drifted,
    false,
    '★ 生图提示词自己的章节不算执行骨架',
  )

  // (b) 图片/视频提示词的系统规则必须写明用途适配且禁止执行骨架
  const imgMsg = buildV3Messages({ rawInput: '帮我写一个二次元女孩的生图提示词,海边黄昏。' })
  const sys = imgMsg.find((m) => m.role === 'system').content
  const usr = imgMsg.find((m) => m.role === 'user').content
  assert.match(sys, /IMAGE:主体/, '★ 系统规则须含图片用途适配')
  assert.match(sys, /IMAGE \/ VIDEO \/ AUDIO 的输出不得出现执行任务章节/, '★ 系统规则须禁止特殊用途写成任务书')
  assert.match(sys, /不得把 AI 推断写作用户的明确要求/, '★ 防止 AI 建议冒充用户要求')
  assert.match(sys, /不得扩展任务方向/, '★ 防止擅自扩展任务方向')
  assert.ok(usr.includes('二次元女孩'), '★ 原意必须在用户消息中原样传递')
  const vidMsg = buildV3Messages({ rawInput: '帮我写一段可灵文生视频提示词:一只猫在窗台上打哈欠。' })
  assert.match(vidMsg.find((m) => m.role === 'system').content, /VIDEO:动作/, '★ 系统规则须含视频用途适配')
  assert.ok(vidMsg.find((m) => m.role === 'user').content.includes('猫'), '★ 视频原意原样传递')

  // (c) 防止反复确认:V3 流程不存在确认状态(结构上不可能出现)
  const routes = {}
  const llmLog = []
  const ctx = new Context()
  ctx.provide('httpServer', { register(r) { routes[r.path] = r; return () => {} } })
  ctx.provide('llm', {
    stream: async function* () {
      const t = JSON.stringify({ status: 'optimized', usage: 'GENERAL', structured: false, output: '优化后的提示词' })
      yield { type: 'text-delta', index: 0, text: t }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: t } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ id: 'm', provider: 'p', name: 'm' }],
    resolveModelInfo: async () => ({ id: 'm', provider: 'p' }),
  })
  await ctx.plugin(plugin, {})
  const evs = await call(routes, { text: '请审查并重构订单服务模块。约束:仅限修改 src/order。', provider: 'p', model: 'm' })
  assert.equal(evs.filter((e) => e.type === 'requirement_confirmation').length, 0, '★ V3 不得出现确认页(防止反复确认)')
  assert.equal(evs.filter((e) => e.type === 'discovery_required').length, 0, '★ 非必要问题不得强制提问')
  assert.ok(evs.some((e) => e.type === 'done'), '★ 必须到达终态')
  console.log('✓ v3-7 迁移保护:图片/视频内容保护、无反复确认、AI 建议不得冒充用户要求')
}

// ── 8. 协议信封不得泄漏给用户 ──────────────────────────────────────────────
{
  // 真实失败样本:模型输出被截断的协议 JSON
  const truncated = '{"status":"needs_clarification","usage":"GENERAL","structured":false,"output":"","question":"「那个旧的」具体指什么？'
  assert.equal(looksLikeProtocolEnvelope(truncated), true, '★ 截断的协议信封必须被识别')
  const parsed = parseV3Output(truncated, '把那个旧的换掉。')
  assert.equal(parsed.output, '', '★ 协议信封绝不能当正文交付(应为空 → 宿主报技术错误)')
  assert.ok(!parsed.output.includes('needs_clarification'), '★ 不得泄漏内部协议')
  // 正常正文不得误判
  assert.equal(looksLikeProtocolEnvelope('请审查并重构订单服务模块。'), false)
  assert.equal(looksLikeProtocolEnvelope('{"状态":"ok"}'), false)
  console.log('✓ v3-8 协议信封泄漏防护:截断 JSON 不得作为优化结果交付')
}

// ── 9. 推理模型的思考不得混进结果(真实模型实测缺陷) ────────────────────────
{
  // 实测 minimax-m3:reasoning_content 为空,思考以思考标签(见下方 T_OPEN/T_CLOSE)直接出现在正文里,
  // 且思考里会出现 `{...}` 片段(含系统提示词里的协议示例)。按「第一个 JSON 对象」解析
  // 会取到思考里的片段 → 正常结果被判成空产出(VF_EMPTY_OUTPUT)。
  // 注:标签用字符码拼出 —— 字面标签会被工具链当成思考块吃掉。
  const T_OPEN = String.fromCharCode(60) + 'think' + String.fromCharCode(62)
  const T_CLOSE = String.fromCharCode(60) + '/think' + String.fromCharCode(62)
  const think =
    `${T_OPEN}The user wants strict JSON. Example: {"status":"optimized"|"needs_clarification"} ` +
    `so I will output {"title":"待确认"}.${T_CLOSE}`
  const envelope = JSON.stringify({
    status: 'optimized',
    usage: 'AGENT',
    structured: true,
    output: '{"title":"待确认","steps":["待确认"],"verify":"待确认"}',
  })
  const parsed = parseV3Output(`${think}${envelope}`, '严格 JSON 格式输出一个 agent 任务指令，字段固定为 title/steps/verify。')
  assert.equal(parsed.usage, 'AGENT', '★ 思考在前时仍须正确解析用途')
  assert.equal(parsed.structured, true)
  assert.ok(parsed.output.includes('"title"'), '★ 思考里的 JSON 片段不得导致空产出')
  assert.ok(!parsed.output.includes('status'), '★ 思考内容不得进入交付结果')

  // 只有思考、没有信封 → 不得把思考当优化结果交付
  assert.equal(parseV3Output(`${T_OPEN}正在推理,还没有结果`, '帮我优化一下').output, '', '★ 思考不得当正文交付')
  // 未闭合的思考(被截断)→ 其后的协议信封仍须可用
  assert.equal(
    parseV3Output(`${T_OPEN}被截断的推理…${envelope}`, '严格 JSON 格式输出一个 agent 任务指令').output.includes('"title"'),
    true,
    '★ 未闭合思考之后的结果仍须解析出来',
  )
  assert.equal(stripThinking(`${T_CLOSE}结果`).trim(), '结果', '★ 思考块剥离后保留正文')
  assert.equal(stripThinking('没有思考块').trim(), '没有思考块', '★ 无思考块时原样返回')

  // 实时预览:思考与内部协议都不得进入界面
  assert.equal(previewableText('我正在思考'), '我正在思考', '★ 普通文本照常预览')
  assert.equal(previewableText(`${T_OPEN}推理中`), '', '★ 未闭合思考不得预览')
  assert.equal(previewableText('结果在这里'), '结果在这里')
  assert.equal(
    previewableText('结果在这里{"status":"optimized","usage":"AGENT","output":"…"}'),
    '结果在这里',
    '★ 协议信封起不得进入预览',
  )
  // 协议里 output 给成对象/数组时,必须呈现为 JSON 文本,绝不能是 "[object Object]"
  // (实测 minimax-m3:严格 JSON 用例返回 `"output":{"title":"待确认"}`)
  const objOut = parseV3Output(
    JSON.stringify({ status: 'optimized', usage: 'AGENT', structured: true, output: { title: '待确认', steps: ['待确认'] } }),
    '严格 JSON 格式输出一个 agent 任务指令，字段固定为 title/steps/verify。',
  )
  assert.ok(objOut.output.includes('"title"'), '★ 对象形态的 output 必须序列化为 JSON 文本')
  assert.ok(!objOut.output.includes('[object Object]'), '★ 不得交付 [object Object]')
  console.log('✓ v3-9 推理模型思考剥离:思考里的 JSON 片段不得导致空产出,协议不得进入预览')
}

console.log('v3.test.mjs: ALL PASS')
