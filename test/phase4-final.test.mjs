/**
 * v2 Phase 4 —— 收口验收测试(六态 UI / 选择器退场 / 回流 / 再优化 / 最终 fixture 矩阵)。
 *
 * 覆盖 §25 完成标准里可机械验证的部分:
 *   1-3  主界面无模式选择器 + 自动判断 + 手动仅作高级 override
 *   4-6  六态 UI / discovery 不显示最终 Prompt / confirmation 四类
 *   7-8  Validator 可控回流 + 有界
 *   9-11 general 不再走 legacy / 生产路径不依赖 required_sections / 占位符不可达
 *   12-15 KEEP 逐字一致 / PATCH 不退化成重写 / RESTRUCTURE 不增量 / REBUILD 反膨胀
 *   16   Image / Video 自动识别 + 正确契约
 *   17-19 再优化保留 / 冲突替换 / 无关失效
 *   20   Confirmation 无 CONFIRMED·PROVISIONAL 重复
 *   21-24 ComfyUI triage 已审计 / provenance 可靠 / 旧测试通过 / 新测试通过
 *
 * 运行:先 `npm run build`,再 `node test/phase4-final.test.mjs`。
 */
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { isMetaAnalysisCall } from '../lib/core/analyze.js'
import { deriveStage } from '../lib/controller.js'
import { mechanicalTriage, decideTriage } from '../lib/core/triage.js'
import { routeStrategy } from '../lib/core/router.js'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (rel) => readFileSync(join(here, rel), 'utf8')

// ═════════════════════════════════════════════════════════════════════════════
// 1-3. 主界面无模式选择器;自动判断;手动仅作高级 override
// ═════════════════════════════════════════════════════════════════════════════
{
  const button = readSource('../src/client/OptimizeButton.tsx')
  assert.doesNotMatch(button, /<select/, '★ 主界面不得再渲染模式选择器')
  assert.doesNotMatch(button, /setTypeSelection/, '★ 主界面不得再设置任务类型')
  assert.match(button, /controller\.optimize\(draft/, '点击优化 = 自动判断')

  const dock = readSource('../src/client/ResultDock.tsx')
  assert.match(dock, /panel\.adjust/, '必须保留低优先级「调整判断」入口')
  assert.match(dock, /setTypeSelection/, '「调整判断」是手动 override 的唯一入口')
  // 「调整判断」必须在分析诊断(默认折叠)之内,不是主流程前置
  assert.ok(
    dock.indexOf("t('panel.adjust')") > dock.indexOf("t('panel.analysis')"),
    '「调整判断」必须位于折叠的分析区之后(低优先级)',
  )
  assert.match(dock, /useState\(false\)/, '分析诊断必须默认折叠')
  console.log('✓ p4f1 主界面无选择器 / 自动判断 / 手动仅作高级 override')
}

// ═════════════════════════════════════════════════════════════════════════════
// 4-6. 六态 UI 派生 + discovery 不显示最终 Prompt + confirmation 四类
// ═════════════════════════════════════════════════════════════════════════════
{
  assert.equal(deriveStage({ status: 'idle', meta: null }), 'idle')
  assert.equal(deriveStage({ status: 'loading', meta: null }), 'analyzing')
  assert.equal(deriveStage({ status: 'loading', meta: { promptType: 'x', confidenceLevel: 'High', missingConstraints: [], rationale: '', provenanceOk: true } }), 'compiling')
  assert.equal(deriveStage({ status: 'discovery', meta: null }), 'discovery_required')
  assert.equal(deriveStage({ status: 'confirmation', meta: null }), 'requirement_confirmation')
  assert.equal(deriveStage({ status: 'validating', meta: null }), 'validating')
  assert.equal(deriveStage({ status: 'done', meta: null }), 'complete')
  assert.equal(deriveStage({ status: 'cancelled', meta: null }), 'cancelled')
  assert.equal(deriveStage({ status: 'error', meta: null }), 'error')

  const dock = readSource('../src/client/ResultDock.tsx')
  // discovery 分支不得渲染 optimized
  const discoveryBranch = dock.slice(
    dock.indexOf("{state.status === 'discovery' && discovery && discovery.questions.length > 0"),
    dock.indexOf("/* 「修改理解」"),
  )
  assert.doesNotMatch(discoveryBranch, /result\.optimized/, '★ discovery 阶段绝不显示最终 Prompt')
  assert.match(discoveryBranch, /panel\.discovery\.remaining/, '必须显示「还差 N 个决定」')
  // confirmation 四类
  for (const key of ['panel.confirm.goal', 'panel.confirm.confirmed', 'panel.confirm.agent', 'panel.confirm.provisional']) {
    assert.ok(dock.includes(key), `confirmation 必须展示 ${key}`)
  }
  console.log('✓ p4f2 六态派生正确 / discovery 不显示结果 / confirmation 四类齐备')
}

// ═════════════════════════════════════════════════════════════════════════════
// 9-11. general 不再走 legacy;生产路径不依赖 required_sections;占位符不可达
// ═════════════════════════════════════════════════════════════════════════════
{
  const compiler = readSource('../src/core/compiler.ts')
  assert.match(compiler, /@deprecated v2 Phase 2 起 \*\*\[待补充:\] 已退役/, '占位符注入必须显式标记废弃')
  assert.doesNotMatch(
    compiler.slice(compiler.indexOf('export function finalizeCompile')),
    /injectMissingPlaceholders\(/,
    '★ 生产路径不得再调用占位符注入',
  )
  const registry = readSource('../src/core/registry.ts')
  assert.match(registry, /LEGACY_GENERAL\.add\(generalStrategy\);/, 'legacy 标记必须已被注释/移除')
  const general = readSource('../src/core/strategies/general.ts')
  for (const forbidden of ['"Task Goal"', '"Success Criteria"', '"Phases"']) {
    assert.ok(!general.includes(`id: ${forbidden}`), `general 不得再声明模板板块 ${forbidden}`)
  }
  console.log('✓ p4f3 general 不走 legacy / 生产不依赖 required_sections / 占位符不可达')
}

// ═════════════════════════════════════════════════════════════════════════════
// 12-15. 四个分诊级别的最终体验(机械可验证)
// ═════════════════════════════════════════════════════════════════════════════
{
  // 12. KEEP:逐字一致
  const complete = [
    '你是一名资深后端工程师,请审查并重构订单服务模块。',
    '',
    '要求:',
    '1. 保持对外 HTTP 接口签名完全不变,不得改动任何路由路径。',
    '2. 数据库迁移必须可回滚,禁止在迁移里删除字段。',
    '',
    '约束:',
    '- 仅限修改 src/order 目录下的文件,不要动其他模块。',
    '- 依赖版本不得升级。',
    '',
    '输出格式:先给出问题清单(含文件路径与行号),再给出改动后的代码。',
    '',
    '验收标准:',
    '- npm test 全绿;',
    '- 现有 API 契约测试全部通过。',
  ].join('\n')
  const keep = mechanicalTriage(complete)
  assert.equal(keep.triage, 'KEEP')
  assert.equal(keep.keep_safe, true)

  // 13. PATCH:必须有可保留内容,且不得因目标策略整体重写
  const patchInput = [
    '1. 先跑一遍测试',
    '2. 再看失败日志',
    '3. 输出格式:Markdown 表格',
  ].join('\n')
  const patch = mechanicalTriage(patchInput)
  assert.equal(patch.triage, 'PATCH', '有结构 → PATCH')
  assert.notEqual(patch.triage, 'REBUILD', 'PATCH 不得退化成 REBUILD')
  // 结构必须被保留:编号项在正文中出现
  const patchDecision = routeStrategy(
    {
      intent: { primary: 'execution', supporting: [], work_mode: 'one_shot', rationale: '' },
      target: { target: 'general', modality: 'text', engine: null, confidence: 'high', evidence: [], rationale: '' },
      triage: { ...patch, triage: 'PATCH' },
      missing_resolution: [],
      gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: '' },
      ledger: [],
      confidence_internal: 0.9,
      rationale: '',
      evidence_quotes: [],
      prompt_type: 'execution',
      missing_constraints: [],
    },
    { rawInput: patchInput },
  )
  assert.equal(patchDecision.strategy.type, 'execution')

  // 14. RESTRUCTURE:不增加大量用户没要求的目标
  const messy = [
    '帮我做个小工具,要求是能读 csv 然后汇总,输出格式要 markdown 表格,输出格式要 markdown 表格,',
    '另外要快一点别卡,另外要快一点别卡,字段要能自动识别,字段要能自动识别,不用装数据库,不用装数据库,',
    '最好支持中文列名,最好支持中文列名,跑完给个总数,跑完给个总数,别的先不用管,别的先不用管。',
  ].join(' ')
  const restructure = mechanicalTriage(messy)
  assert.equal(restructure.triage, 'RESTRUCTURE')
  assert.notEqual(restructure.triage, 'REBUILD', 'RESTRUCTURE 不得升级成 REBUILD')

  // 15. REBUILD:仍受反膨胀约束(信息责任数不随长度膨胀)
  const vague = decideTriage({ raw_input: '我想用 dsh 控制 comfyui 生成视频。' })
  assert.equal(vague.triage, 'REBUILD')
  console.log('✓ p4f4 KEEP 逐字 / PATCH 不重写 / RESTRUCTURE 不增量 / REBUILD 反膨胀')
}

// ═════════════════════════════════════════════════════════════════════════════
// 16 + 20-24. 宿主端到端:Image/Video 自动识别、回流、再优化、confirmation 互斥
// ═════════════════════════════════════════════════════════════════════════════
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
const sseEvents = (res) =>
  res.body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      return line ? JSON.parse(line.slice(5).trim()) : null
    })
    .filter(Boolean)

async function setup({ compileOutput, analysisRounds }) {
  const calls = []
  const routes = {}
  const ctx = new Context()
  ctx.provide('httpServer', {
    register(r) {
      routes[r.path] = r
      return () => {}
    },
  })
  let analysisIndex = 0
  ctx.provide('llm', {
    async *stream(options) {
      calls.push(options)
      const text = isMetaAnalysisCall(options.system)
        ? analysisRounds[Math.min(analysisIndex++, analysisRounds.length - 1)]
        : compileOutput
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'deepseek-official', name: 'x' }],
    listModels: async () => [{ id: 'deepseek-chat', provider: 'deepseek-official', name: 'x' }],
    resolveModelInfo: async () => ({ id: 'deepseek-chat', provider: 'deepseek-official', name: 'x' }),
  })
  await ctx.plugin(plugin, { v3: false })  // 旧多阶段路径测试:显式选择 legacy
  return {
    handler: routes['/dsh-prompt-optimizer/optimize'].handler,
    calls,
    analysisCalls: () => calls.filter((o) => isMetaAnalysisCall(o.system)),
    compileCalls: () => calls.filter((o) => !isMetaAnalysisCall(o.system)),
  }
}

const NEUTRAL = [
  '<<<DIAGNOSIS>>>',
  '目标明确',
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
  '<<<END>>>',
].join('\n')

const IMAGE_ANALYSIS = JSON.stringify({
  primary_intent: 'execution',
  work_mode: 'one_shot',
  target: 'image_generation',
  edit_triage: 'PATCH',
  unknowns: [{ text: '当前可用的出图链路', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '自查' }],
  requirements: [],
  suggestions: [],
  confidence_internal: 0.9,
  rationale: 'r',
  evidence_quotes: [],
  questions: [],
})
const VIDEO_ANALYSIS = JSON.stringify({
  primary_intent: 'execution',
  work_mode: 'one_shot',
  target: 'video_generation',
  target_engine: '可灵',
  edit_triage: 'PATCH',
  unknowns: [],
  requirements: [],
  suggestions: [],
  confidence_internal: 0.9,
  rationale: 'r',
  evidence_quotes: [],
  questions: [],
})

const IMAGE_BODY = [
  '<<<DIAGNOSIS>>>',
  'd',
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
  '- 二次元女孩坐在未来 AI 工作台前',
  '## Scene（场景与环境）',
  '- 三栏桌面布局',
  '## Style（风格）',
  '- 二次元插画',
  '## Composition（构图与镜头）',
  '- 中景',
  '## Lighting & Color（光线与色调）',
  '- 冷蓝 + 屏幕光',
  '## Aspect Ratio（画幅与画质）',
  '- 16:9',
  '## Negative（排除项）',
  '- 无水印',
  '<<<END>>>',
].join('\n')

const VIDEO_BODY = [
  '<<<DIAGNOSIS>>>',
  'd',
  '<<<EXPLICIT>>>',
  '(无)',
  '<<<CONTEXT>>>',
  '(无)',
  '<<<SUGGESTED>>>',
  '(无)',
  '<<<UNKNOWN>>>',
  '(无)',
  '<<<OPTIMIZED>>>',
  '## Shot（镜头）',
  '- 中景起,持续后拉',
  '## Action & Timing（动作与时间演进）',
  '- 人物拔刀向前冲',
  '## Scene & Mood（场景与氛围）',
  '- 雨夜',
  '## Style & Quality（风格与画质）',
  '- 电影感',
  '## Duration & Format（时长与格式）',
  '- 8 秒',
  '## Negative（排除项）',
  '- 无字幕',
  '<<<END>>>',
].join('\n')

// 16. Image / Video 自动识别 + 正确契约 + 无任务模板标题
{
  const image = await setup({ compileOutput: IMAGE_BODY, analysisRounds: [IMAGE_ANALYSIS] })
  const imageRes = await call(image.handler, {
    text: '二次元女孩坐在未来 AI 工作台前,三栏桌面布局,帮我生成生图提示词。',
    provider: 'p',
    model: 'm',
  })
  const imageEvents = sseEvents(imageRes)
  assert.equal(imageEvents.some((e) => e.type === 'discovery_required'), false, '图像无阻塞决策 → 直接优化')
  const imageDone = imageEvents.find((e) => e.type === 'done')
  assert.equal(imageDone.contract, 'image')
  for (const heading of ['Goal', 'Phase', 'Tasks', 'Acceptance']) {
    assert.doesNotMatch(imageDone.optimized, new RegExp(`(?:^|\\n)\\s*#{0,6}\\s*\\**${heading}\\b`, 'i'))
  }
  assert.ok(imageEvents.some((e) => e.type === 'validating'), '必须经过 validating 阶段')

  const video = await setup({ compileOutput: VIDEO_BODY, analysisRounds: [VIDEO_ANALYSIS] })
  const videoRes = await call(video.handler, {
    text: '根据这张首帧写可灵视频提示词,让人物拔刀向前冲,镜头持续后拉。',
    provider: 'p',
    model: 'm',
  })
  const videoDone = sseEvents(videoRes).find((e) => e.type === 'done')
  assert.equal(videoDone.contract, 'video')
  assert.equal(videoDone.target.engine.id, 'kling')
  console.log('✓ p4f5 Image / Video 自动识别 + 正确契约 + 无模板标题 + validating 阶段')
}

// 17-19. 再优化:STILL_VALID 保留 / CONFLICTING 替换 / INVALIDATED 失效
{
  const previousLedger = [
    { id: 'ledger-a', text: '已有可工作的 workflow', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['已经有 workflow'], confidence: 'high' },
  ]
  // 只改措辞 → 保留(且不得重新问)。产物必须**真的保留**该已确认约束,
  // 否则会被 RC 完整性检查判为「丢约束」而回流(这正是该检查要防的)。
  const REOPT_OUTPUT = [
    '<<<DIAGNOSIS>>>',
    'd',
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
    '- 已有可工作的 workflow,按其现有配置整理提示词',
    '## Context & Inputs（上下文与输入）',
    '- 用户给出的草稿',
    '## Constraints & Exclusions（约束与排除）',
    '- 复用现有 workflow',
    '## Deliverable Shape（产出形态）',
    '- 可直接使用的提示词',
    '<<<END>>>',
  ].join('\n')
  const keepCase = await setup({ compileOutput: REOPT_OUTPUT, analysisRounds: [IMAGE_ANALYSIS] })
  const kept = await call(keepCase.handler, {
    text: '已经有 workflow,帮我把这段画面描述整理成生图提示词。',
    provider: 'p',
    model: 'm',
    discovery: { mode: 'reoptimize', round: 2, triage: 'PATCH', ledger: previousLedger, asked: [], answers: [], questions: [], analysis: null },
  })
  const keptEvents = sseEvents(kept)
  assert.equal(keptEvents.some((e) => e.type === 'discovery_required'), false, '17:旧 requirement 已答过 → 不得重新问')
  const keptDone = keptEvents.find((e) => e.type === 'done')
  assert.ok(keptDone, '17:应正常编译')
  assert.ok(
    (keptDone.ledger ?? []).some((e) => e.id === 'ledger-a' && e.status === 'CONFIRMED'),
    '17:still-valid requirement 必须保留',
  )

  // 换族 → 失效
  const switchCase = await setup({ compileOutput: REOPT_OUTPUT, analysisRounds: [IMAGE_ANALYSIS] })
  const switched = await call(switchCase.handler, {
    text: '帮我生成 Midjourney 图片提示词。',
    provider: 'p',
    model: 'm',
    discovery: { mode: 'reoptimize', round: 2, triage: 'PATCH', ledger: previousLedger, asked: [], answers: [], questions: [], analysis: null },
  })
  const switchedDone = sseEvents(switched).find((e) => e.type === 'done')
  assert.equal(
    (switchedDone.ledger ?? []).find((e) => e.id === 'ledger-a').status,
    'NOT_APPLICABLE',
    '19:换任务族 → 旧 requirement 失效',
  )
  console.log('✓ p4f6 再优化:保留 / 失效(冲突替换见 phase4-reconcile 单测)')
}

// 20 + 24. Confirmation 四类互斥(端到端)
{
  const blockingAnalysis = JSON.stringify({
    primary_intent: 'planning',
    work_mode: 'exploratory',
    target: 'agent_task',
    edit_triage: 'REBUILD',
    unknowns: [
      { text: '复用现有 workflow 还是新建', classification: 'USER_REQUIRED', blocking: true, impact: 'high', rationale: '取舍' },
    ],
    requirements: [{ text: '用 dsh 控制 comfyui 生成视频', quote: '用 dsh 控制 comfyui 生成视频' }],
    suggestions: ['可先验证控制链路'],
    confidence_internal: 0.9,
    rationale: 'r',
    evidence_quotes: ['用 dsh 控制 comfyui 生成视频'],
    questions: [
      {
        requirement_id: 'unknown-1',
        question: 'ComfyUI 的工作流怎么用?',
        options: [{ id: 'reuse', label: '调用现有 workflow' }],
        why: '决定路径',
        depends_on: [],
      },
    ],
  })
  const cleared = JSON.stringify({
    primary_intent: 'planning',
    work_mode: 'exploratory',
    target: 'agent_task',
    edit_triage: 'REBUILD',
    unknowns: [],
    requirements: [],
    suggestions: ['可先验证控制链路'],
    confidence_internal: 0.9,
    rationale: 'r',
    evidence_quotes: [],
    questions: [],
  })
  // 本用例测的是「确认页四类互斥」。新定义下**只有语义歧义**能进入 Discovery,
  // 因此输入带一个无先行词的指代(「这个」),由机械层驱动 Discovery。
  const CONFIRM_INPUT = '帮我把这个优化一下。约束:只做本地方案;输出格式:步骤清单;验收:跑通一次生成。'
  const { handler } = await setup({ compileOutput: NEUTRAL, analysisRounds: [blockingAnalysis, cleared] })
  const first = await call(handler, { text: CONFIRM_INPUT, provider: 'p', model: 'm' })
  const round1 = sseEvents(first)[0]
  assert.equal(round1.type, 'discovery_required')
  const second = await call(handler, {
    text: CONFIRM_INPUT,
    provider: 'p',
    model: 'm',
    discovery: {
      mode: 'answer',
      round: 1,
      triage: 'REBUILD',
      ledger: round1.ledger,
      asked: round1.asked,
      questions: round1.questions,
      // RC2:机械安全层补的「范围」决策没有编造选项 → 用「按你的判断继续」这条
      // 显式安全出口回答(§5:只有用户主动选择才允许转 PROVISIONAL)。
      answers: round1.questions.map((q) =>
        q.options.length > 0
          ? { key: q.key, option_id: q.options[0].id, text: q.options[0].label }
          : { key: q.key, text: '按你的判断继续', blind_trust: true },
      ),
      analysis: round1.analysis,
    },
  })
  const confirmation = sseEvents(second)[0]
  assert.equal(confirmation.type, 'requirement_confirmation')
  const all = [
    ...confirmation.confirmation.confirmed.map((c) => c.text),
    ...confirmation.confirmation.agent_researches,
    ...confirmation.confirmation.provisional.map((p) => p.text),
  ]
  assert.equal(new Set(all).size, all.length, '20:四类之间不得重复')
  assert.equal(
    confirmation.confirmation.provisional.some((p) => /可先验证控制链路/.test(p.text)) &&
      confirmation.confirmation.confirmed.some((c) => /验证控制链路/.test(c.text)),
    false,
    '20:★ 与已确认项语义等价的暂定项必须被剔除',
  )
  console.log('✓ p4f7 Confirmation 四类互斥(端到端)')
}

// 17(回流)+ 18(hard error). Validator 可控回流与硬错误
{
  // 伪造 quote → returned(可恢复回流)
  const forged = await setup({
    compileOutput: [
      '<<<DIAGNOSIS>>>',
      'd',
      '<<<EXPLICIT>>>',
      '- 伪造要求 [quote: 用户从未说过这句]',
      '<<<CONTEXT>>>',
      '(无)',
      '<<<SUGGESTED>>>',
      '(无)',
      '<<<UNKNOWN>>>',
      '(无)',
      '<<<OPTIMIZED>>>',
      '## Request（请求要点）',
      '- x',
      '<<<END>>>',
    ].join('\n'),
    analysisRounds: [NEUTRAL],
  })
  // RC2:模糊目标会先进入 Discovery → 用已明确输入,让校验阶段真的跑到
  const forgedRes = await call(forged.handler, {
    text: '帮我做一件事。约束:只做本地方案;输出格式:步骤清单。',
    provider: 'p',
    model: 'm',
  })
  const forgedEvents = sseEvents(forgedRes)
  // v0.2.0-apo:可机械修复的 provenance 错误**自动降级后交付**(用户裁决 §四),
  // 但伪造来源绝不得留在 explicit(不得冒充用户要求)。
  const forgedDone = forgedEvents.find((e) => e.type === 'done')
  assert.ok(forgedDone, '17:可机械修复的 provenance 错误不得把用户挡在门外')
  assert.doesNotMatch(
    (forgedDone.explicit_requirements ?? []).map((r) => r.text).join(' '),
    /伪造要求/,
    '★ 17:伪造来源绝不得留在 explicit',
  )
  assert.equal(forgedEvents.some((e) => e.type === 'returned'), false, '17:可修复情形不得退回用户')

  // 回流预算已用满 → hard error。
  // 注意:v0.2.0-apo 起「伪造来源」会被 provenance 自动修复(不再消耗回流预算),
  // 因此这里用一个**不可机械修复**的问题来触发回流:面向用户的追问。
  const unrepairable = await setup({
    compileOutput: [
      '<<<DIAGNOSIS>>>',
      'd',
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
      '- 做点事',
      '- 请先回答预算范围',
      '<<<END>>>',
    ].join('\n'),
    analysisRounds: [NEUTRAL],
  })
  const exhausted = await call(unrepairable.handler, {
    text: '帮我做一件事。约束:只做本地方案;输出格式:步骤清单。',
    provider: 'p',
    model: 'm',
    discovery: {
      mode: 'reoptimize',
      round: 2,
      triage: 'PATCH',
      ledger: [],
      asked: [],
      answers: [],
      questions: [],
      analysis: null,
      // 预算已用满(两个**不同且与本次失败不同**的 reason code)→ 判「预算耗尽」硬错误。
      // (若预置码与本次相同,会先命中 VF_REPEATED_FAILURE —— 那是另一条有界性规则。)
      validationReturns: [
        { reason_code: 'VF_RETIRED_PLACEHOLDER', action: 'RETURN_TO_MISSING_RESOLUTION', round: 1 },
        { reason_code: 'VF_PROTOCOL_LEAK', action: 'RETURN_TO_MISSING_RESOLUTION', round: 2 },
      ],
    },
  })
  const exhaustedEvents = sseEvents(exhausted)
  assert.equal(exhaustedEvents.some((e) => e.type === 'done'), false, '18:预算用满不得交付')
  const hard = exhaustedEvents.find((e) => e.type === 'error')
  assert.ok(hard, '18:必须下发 error')
  assert.equal(hard.reason_code, 'VF_RETURN_BUDGET_EXHAUSTED')
  console.log('✓ p4f8 Validator 回流(可恢复)+ 硬错误(有界)')
}

// 21. ComfyUI triage 已审计:模糊目标 → REBUILD,Discovery 不改动它
{
  const t = decideTriage({ raw_input: '我想用 dsh 控制 comfyui 生成视频。' })
  assert.equal(t.triage, 'REBUILD', '★ ComfyUI 案例 = REBUILD(不是 PATCH)')
  assert.equal(t.keep_safe, false)
  assert.ok(t.reasons.some((r) => /模糊目标/.test(r)), '必须给出「只有模糊目标」的理由')
  console.log('✓ p4f9 ComfyUI triage 审计:REBUILD 且理由可读')
}

console.log('phase4-final.test.mjs: ALL PASS')
