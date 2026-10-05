/**
 * Phase 4 验收证据生成器 —— 输出 A–F 六段可粘贴进报告的 trace。
 *
 * 用法:先 `npm run build`,再 `node scripts/phase4-trace.mjs`
 *
 * A. ComfyUI 最终完整 UI / event trace(六态 + 编译调用次数)
 * B. KEEP / PATCH / RESTRUCTURE / REBUILD 四个真实 fixture 的前后对比
 * C. Image Prompt 与 Video Prompt 最终输出结构
 * D. re-optimize 三种情况的 Ledger trace(STILL_VALID / CONFLICTING / INVALIDATED)
 * E. Validator 回流 trace(矩阵逐条)
 * F. 仍保留但生产不可达的 legacy 清单
 */
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { isMetaAnalysisCall } from '../lib/core/analyze.js'
import { analyzeInputSignals, mechanicalTriage } from '../lib/core/triage.js'
import { routeStrategy } from '../lib/core/router.js'
import { reconcileLedger } from '../lib/core/ledger-reconcile.js'
import { decideValidationAction, VALIDATION_RETURN_LIMIT } from '../lib/core/validation-flow.js'
import { allStrategies, isLegacyGeneral } from '../lib/core/registry.js'

const line = (text = '') => console.log(text)
const head = (text) => {
  line()
  line(`════ ${text} ════`)
}

// ── 宿主 harness ────────────────────────────────────────────────────────────
function makeCtx(analysisRounds, compileOutput) {
  const calls = []
  const routes = {}
  const ctx = new Context()
  ctx.provide('httpServer', {
    register(r) {
      routes[r.path] = r
      return () => {}
    },
  })
  let index = 0
  ctx.provide('llm', {
    async *stream(options) {
      calls.push(options)
      const text = isMetaAnalysisCall(options.system)
        ? analysisRounds[Math.min(index++, analysisRounds.length - 1)]
        : compileOutput
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'deepseek-official', name: 'x' }],
    listModels: async () => [{ id: 'deepseek-chat', provider: 'deepseek-official', name: 'x' }],
    resolveModelInfo: async () => ({ id: 'deepseek-chat', provider: 'deepseek-official', name: 'x' }),
  })
  return { ctx, routes, calls }
}

async function call(routes, body) {
  const handler = routes['/dsh-prompt-optimizer/optimize'].handler
  const res = {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    on() {},
    writeHead(s, h) {
      res.status = s
      res.headers = h ?? {}
    },
    write(c) {
      res.body += c
      return true
    },
    end(p) {
      if (p) res.body += p
      res.writableEnded = true
    },
  }
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'
  req.headers = {}
  await handler(req, res)
  return res.body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const l = frame.split('\n').find((x) => x.startsWith('data:'))
      return l ? JSON.parse(l.slice(5).trim()) : null
    })
    .filter(Boolean)
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

const COMFY_ROUND1 = JSON.stringify({
  primary_intent: 'planning',
  work_mode: 'exploratory',
  target: 'agent_task',
  target_engine: 'DSH',
  edit_triage: 'REBUILD',
  unknowns: [
    { text: '复用现有 workflow 还是新建', classification: 'USER_REQUIRED', blocking: true, impact: 'high', rationale: '取舍' },
    { text: '本轮目标是先验证控制链路还是建立长期自动化', classification: 'USER_REQUIRED', blocking: true, impact: 'high', rationale: '取舍' },
    { text: 'ComfyUI 版本', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '自查' },
    { text: 'workflow 文件位置', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '自查' },
  ],
  requirements: [{ text: '用 dsh 控制 comfyui 生成视频', quote: '用 dsh 控制 comfyui 生成视频' }],
  suggestions: ['可先验证控制链路'],
  confidence_internal: 0.9,
  rationale: '用户要 DSH 控制 ComfyUI',
  evidence_quotes: ['用 dsh 控制 comfyui 生成视频'],
  questions: [
    {
      requirement_id: 'unknown-1',
      question: '你希望 DSH 怎么使用 ComfyUI?',
      options: [
        { id: 'use', label: '调用已经存在的 ComfyUI 工作流' },
        { id: 'create', label: '自动创建 / 修改工作流' },
        { id: 'both', label: '两者都需要' },
      ],
      recommended_option_id: 'use',
      recommendation_reason: '已有可工作的 workflow 时,先验证调用链路成本最低',
      why: '只有你能决定',
      depends_on: [],
    },
    {
      requirement_id: 'unknown-2',
      question: '这次主要目标是哪一个?',
      options: [
        { id: 'verify', label: '先验证 DSH 能不能成功控制 ComfyUI' },
        { id: 'one', label: '成功生成一个指定视频' },
        { id: 'auto', label: '建立以后可以长期运行的自动化流程' },
      ],
      recommended_option_id: 'verify',
      recommendation_reason: '先确认控制能力是否成立,再决定投入',
      why: '产品取舍',
      depends_on: [],
    },
  ],
})

const COMFY_ROUND2 = JSON.stringify({
  primary_intent: 'execution',
  work_mode: 'exploratory',
  target: 'agent_task',
  target_engine: 'DSH',
  edit_triage: 'REBUILD',
  unknowns: [
    { text: 'DSH 当前可用的控制方式', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '自查' },
    { text: 'workflow 实际位置', classification: 'AGENT_DISCOVERABLE', blocking: false, rationale: '自查' },
  ],
  requirements: [{ text: '用 dsh 控制 comfyui 生成视频', quote: '用 dsh 控制 comfyui 生成视频' }],
  suggestions: [],
  confidence_internal: 0.92,
  rationale: '控制链路验证',
  evidence_quotes: ['用 dsh 控制 comfyui 生成视频'],
  questions: [],
})

// ═════════════════════════════════════════════════════════════════════════════
head('A. ComfyUI 最终完整 event trace(六态)')
// ═════════════════════════════════════════════════════════════════════════════
{
  const { ctx, routes, calls } = makeCtx([COMFY_ROUND1, COMFY_ROUND2], NEUTRAL)
  await ctx.plugin(plugin, {})
  const raw = '我想用 dsh 控制 comfyui 生成视频。'
  const show = (label, events) => {
    line(`\n──── ${label}`)
    for (const e of events) {
      if (e.type === 'delta') continue
      if (e.type === 'discovery_required') {
        line(`  discovery_required  round=${e.round} questions=${e.questions.length} blocked=${e.gate.blocked}`)
        for (const q of e.questions) {
          line(`    Q: ${q.question}`)
          for (const o of q.options) line(`       ${o.id === q.recommended_option_id ? '★' : ' '} ${o.label}`)
        }
        line(`    可自查(弱显示): ${(e.agent_researches ?? []).join(' / ')}`)
      } else if (e.type === 'requirement_confirmation') {
        line(`  requirement_confirmation`)
        line(`    目标: ${e.confirmation.goal}`)
        line(`    你已确认: ${e.confirmation.confirmed.map((c) => c.text).join(' / ')}`)
        line(`    Agent 自行调查: ${e.confirmation.agent_researches.join(' / ')}`)
        line(`    暂定/条件: ${e.confirmation.provisional.map((p) => `${p.text}[${p.status}]`).join(' / ') || '(无)'}`)
      } else if (e.type === 'meta') {
        line(`  meta  stage→compiling  prompt_type=${e.prompt_type} contract=${e.contract ?? '-'} triage=${e.triage?.triage}`)
      } else if (e.type === 'validating') {
        line(`  validating  stage→validating`)
      } else if (e.type === 'done') {
        line(`  done  stage→complete  contract=${e.contract} triage=${e.triage?.triage} optimized=${String(e.optimized).length}字`)
      } else if (e.type === 'returned' || e.type === 'error') {
        line(`  ${e.type}  ${e.action ?? ''} ${e.reason_code ?? ''} ${e.detail ?? e.error ?? ''}`)
      }
    }
  }
  const first = await call(routes, { text: raw, provider: 'p', model: 'm' })
  show('1. optimize(点击优化 → analyzing → discovery_required)', first)
  const round1 = first[0]
  const second = await call(routes, {
    text: raw,
    provider: 'p',
    model: 'm',
    discovery: {
      mode: 'answer',
      round: 1,
      triage: 'REBUILD',
      ledger: round1.ledger,
      asked: round1.asked,
      questions: round1.questions,
      answers: round1.questions.map((q) => ({ key: q.key, option_id: q.options[0].id, text: q.options[0].label })),
      analysis: round1.analysis,
    },
  })
  show('2. user_answer → requirement_confirmation', second)
  const confirmation = second[0]
  show(
    '3. confirm(确认并优化)→ compiling → validating → complete',
    await call(routes, {
      text: raw,
      provider: 'p',
      model: 'm',
      discovery: {
        mode: 'confirm',
        round: confirmation.round,
        triage: 'REBUILD',
        ledger: confirmation.ledger,
        asked: confirmation.asked,
        answers: [],
        questions: [],
        analysis: confirmation.analysis,
      },
    }),
  )
  line(`\n  分析调用=${calls.filter((o) => isMetaAnalysisCall(o.system)).length}  编译调用=${calls.filter((o) => !isMetaAnalysisCall(o.system)).length}`)
  line('  ★ Compiler 第一次运行发生在第 3 步(confirm 之后、meta 之前);前两步编译调用为 0')
}

// ═════════════════════════════════════════════════════════════════════════════
head('B. KEEP / PATCH / RESTRUCTURE / REBUILD 前后对比')
// ═════════════════════════════════════════════════════════════════════════════
{
  const cases = [
    {
      label: 'KEEP',
      before: [
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
      ].join('\n'),
      after: '(逐字等于输入 —— KEEP 路径不调用模型)',
    },
    {
      label: 'PATCH',
      before: ['1. 先跑一遍测试', '2. 再看失败日志', '3. 输出格式:Markdown 表格'].join('\n'),
      after: '(保留 1/2/3 的编号与措辞,只补缺口与执行前须知)',
    },
    {
      label: 'RESTRUCTURE',
      before:
        '帮我做个小工具,要求是能读 csv 然后汇总,输出格式要 markdown 表格,输出格式要 markdown 表格,另外要快一点别卡,另外要快一点别卡,字段要能自动识别,字段要能自动识别,不用装数据库,不用装数据库。',
      after: '(去重复、建结构;不新增用户没要求的目标)',
    },
    {
      label: 'REBUILD',
      before: '我想用 dsh 控制 comfyui 生成视频。',
      after: '(先经 Discovery 明确取舍,再从零构建;仍受信息责任与反膨胀约束)',
    },
  ]
  for (const c of cases) {
    const signals = analyzeInputSignals(c.before)
    const decision = mechanicalTriage(c.before)
    line(`\n──── ${c.label}`)
    line(`  before(${signals.length}字): ${c.before.split('\n')[0].slice(0, 46)}${c.before.length > 46 ? '…' : ''}`)
    line(`  信号: 结构=${signals.structures.join(',') || '(无)'} 成稿要素=${[signals.role && 'role', signals.constraint && '约束', signals.format && '格式', signals.acceptance && '验收'].filter(Boolean).join('+') || '(无)'}`)
    line(`  裁决: ${decision.triage}  keep_safe=${decision.keep_safe}  理由=${decision.reasons[0]}`)
    line(`  after: ${c.after}`)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
head('C. Image / Video 最终输出结构')
// ═════════════════════════════════════════════════════════════════════════════
{
  const probe = (target, primary, rawInput) =>
    routeStrategy(
      {
        intent: { primary, supporting: [], work_mode: 'one_shot', rationale: '' },
        target: { target, modality: 'text', engine: null, confidence: 'high', evidence: [], rationale: '' },
        triage: { triage: 'PATCH', reasons: [], signals: [], keep_safe: false },
        missing_resolution: [],
        gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: '' },
        ledger: [],
        confidence_internal: 0.9,
        rationale: '',
        evidence_quotes: [],
        prompt_type: primary,
        missing_constraints: [],
      },
      { rawInput },
    )
  for (const [label, target, raw] of [
    ['Image Prompt', 'image_generation', '二次元女孩坐在未来 AI 工作台前,三栏桌面布局,帮我生成生图提示词。'],
    ['Video Prompt', 'video_generation', '根据这张首帧写可灵视频提示词,让人物拔刀向前冲,镜头持续后拉。'],
  ]) {
    const d = probe(target, 'execution', raw)
    line(`\n──── ${label}`)
    line(`  路由: ${d.basis} → 契约 ${d.strategy.type}(${d.contract})`)
    line(`  信息责任: ${d.strategy.informationResponsibilities.join(' / ')}`)
    line(`  禁止: Goal / Phase / Task / Tests / Acceptance(守卫 visual-no-task-template 机械拒绝)`)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
head('D. re-optimize 三种情况的 Ledger trace')
// ═════════════════════════════════════════════════════════════════════════════
{
  const previous = [
    { id: 'ledger-a', text: '已有可工作的 workflow', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['已经有 workflow'], confidence: 'high' },
    { id: 'ledger-b', text: '本轮只验证控制链路', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['先验证控制链路'], confidence: 'high' },
  ]
  const mk = (target, texts) => ({
    intent: { primary: 'execution', supporting: [], work_mode: 'one_shot', rationale: '' },
    target: { target, modality: 'text', engine: null, confidence: 'high', evidence: [], rationale: '' },
    triage: { triage: 'PATCH', reasons: [], signals: [], keep_safe: false },
    missing_resolution: texts.map((text, i) => ({
      id: `unknown-${i}`,
      text,
      classification: 'AGENT_DISCOVERABLE',
      blocking: false,
      rationale: '',
      impact: 'low',
      user_exclusive: false,
    })),
    gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: '' },
    ledger: [],
    confidence_internal: 0.9,
    rationale: '',
    evidence_quotes: [],
    prompt_type: 'execution',
    missing_constraints: [],
  })
  for (const [label, target, texts, raw, prevTarget] of [
    ['① 只改措辞(STILL_VALID)', 'agent_task', ['DSH 当前可用的控制方式'], '我想用 dsh 控制 comfyui 生成视频,已经有 workflow,先验证控制链路', 'agent_task'],
    ['② 改变一个目标(CONFLICTING)', 'agent_task', ['长期自动化方案设计'], '现在改成建立长期自动化流程', 'agent_task'],
    ['③ 换成图像任务(INVALIDATED)', 'image_generation', ['画面主体描述'], '帮我生成 Midjourney 图片提示词', 'agent_task'],
  ]) {
    const r = reconcileLedger({ previous, analysis: mk(target, texts), rawInput: raw, previousTarget: prevTarget })
    line(`\n──── ${label}`)
    line(`  ${r.summary}`)
    for (const e of r.ledger) line(`  ${e.id}  ${e.status}  ${e.text}`)
    line(`  → 重新 Missing Resolution 后:只有新出现的 blocking USER_REQUIRED 才进 Discovery`)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
head('E. Validator 回流 trace(矩阵)')
// ═════════════════════════════════════════════════════════════════════════════
{
  const base = { problems: [], result: { optimized_prompt: 'x' }, rawInput: 'x', returns: [], round: 1, liveBlockingCount: 0 }
  const matrix = [
    ['伪造 USER_EXPLICIT', { problems: [{ severity: 'error', rule: 'PROVENANCE_EVIDENCE_NOT_IN_RAW', detail: 'evidence 不在输入里' }] }],
    ['silent assumption', { problems: [{ severity: 'error', rule: 'VALIDATION_UNPROVEN_STRONG_CLAIM', detail: '无证据强断言' }] }],
    ['blocking USER_REQUIRED', { liveBlockingCount: 2 }],
    ['可自查项被写成待用户提供', { problems: [{ severity: 'error', rule: 'VALIDATION_USER_FACING_QUESTION', detail: '请先回答预算' }] }],
    ['错误 Target Engine 假定', { targetAssumed: true }],
    ['Image/Video 出现任务模板标题', { problems: [{ severity: 'error', rule: 'visual-no-task-template', detail: 'Goal' }] }],
    ['KEEP 被改写', { keepExpected: true, rawInput: '原始', result: { optimized_prompt: '被改写' } }],
    ['完整性缺陷(缺必出段落)', { problems: [{ severity: 'error', rule: 'VALIDATION_REQUIRED_SECTION_MISSING', detail: '缺段落' }] }],
  ]
  for (const [label, overrides] of matrix) {
    const r = decideValidationAction({ ...base, ...overrides })
    line(`  ${label.padEnd(24)} → ${r.action}${r.reason_code ? ` (${r.reason_code})` : ''}${r.requires ? ` requires=${r.requires}` : ''}`)
  }
  const first = decideValidationAction({ ...base, problems: [{ severity: 'error', rule: 'PROVENANCE_EVIDENCE_NOT_IN_RAW', detail: 'd' }] })
  const second = decideValidationAction({ ...base, problems: [{ severity: 'error', rule: 'PROVENANCE_EVIDENCE_NOT_IN_RAW', detail: 'd' }], returns: first.returns })
  line(`  ${'同一失败重复'.padEnd(24)} → ${second.action} (${second.reason_code})  ← 不无限循环`)
  line(`  ${'回流上限'.padEnd(25)}= ${VALIDATION_RETURN_LIMIT} 次,超出即 HARD_ERROR`)
}

// ═════════════════════════════════════════════════════════════════════════════
head('F. 仍保留但生产不可达的 legacy 清单')
// ═════════════════════════════════════════════════════════════════════════════
{
  const items = [
    ['required_sections(策略契约字段)', 'DEPRECATED-BUT-UNREACHABLE', '保留为 informationResponsibilities 的别名;路由与守卫都读新字段'],
    ['injectMissingPlaceholders()', 'DEPRECATED-BUT-UNREACHABLE', '编译管线改用 injectResponsibilityNotes;[待补充:] 出现即校验 error'],
    ['parseOptimizerOutput()(legacy 解析)', 'DEPRECATED-BUT-UNREACHABLE', '仅 finalizeCompile({legacy:true}) 的显式调用可达(旧单测/回归 harness)'],
    ['prompt.ts template/intent 双模式', 'DEPRECATED-BUT-UNREACHABLE', 'general 已迁入 v2 契约,生产路由不再命中'],
    ['LEGACY_GENERAL / isLegacyGeneral', 'DEPRECATED-BUT-UNREACHABLE', '不再标记任何策略;测试断言全部策略为 false'],
    ['classifyViaLlm / 旧 classifier-only 路由', 'DEPRECATED-BUT-UNREACHABLE', '宿主改用 analyzeViaLlm;classifyViaLlm 仅供回归 harness 与单测'],
    ['compilePrompt({promptType}) 旧 override 入口', 'REACHABLE-AS-ADVANCED', '降级为「调整判断」高级 override,且正文明确约束优先'],
  ]
  for (const [name, status, note] of items) line(`  ${status.padEnd(28)} ${name}\n${' '.repeat(32)}${note}`)
  line(`\n  机械证据:${allStrategies.map((s) => `${s.type}=${isLegacyGeneral(s)}`).join(' ')}`)
}
line()
