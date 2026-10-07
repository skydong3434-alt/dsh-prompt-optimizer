/**
 * v0.2.0-apo Release Blocker Regression —— 发布冒烟发现的真实缺陷的固定断言。
 * 全部用 mock LLM(确定性、不联网):
 *   R1/R2  confirm 的两个死循环(轮次上限后永久拒绝 / 复用确认前的快照 gate)
 *   R3     re-optimize 只改措辞:STILL_VALID 保留 + 不重复询问 + 到达 complete
 *   R4     re-optimize 改变目标 → CONFLICTING(REJECTED)
 *   R5     re-optimize 更换 Prompt Target → INVALIDATED(NOT_APPLICABLE)
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../../lib/index.js'

const M = { DIAGNOSIS: '<<<DIAGNOSIS>>>', EXPLICIT: '<<<EXPLICIT>>>', CONTEXT: '<<<CONTEXT>>>', SUGGESTED: '<<<SUGGESTED>>>', UNKNOWN: '<<<UNKNOWN>>>', OPTIMIZED: '<<<OPTIMIZED>>>', END: '<<<END>>>' }

const analysisFor = ({ target = 'agent_task', decision = '复用现有 workflow 还是新建', n = 1 } = {}) =>
  JSON.stringify({
    primary_intent: 'planning', work_mode: 'exploratory', target, edit_triage: 'REBUILD',
    unknowns: [{ text: decision, classification: 'USER_REQUIRED', blocking: true, impact: 'high', rationale: '取舍' }],
    // 真实场景:模型会把用户目标抽成带逐字证据的 requirement(→ CONFIRMED USER_EXPLICIT)
    requirements: [{ text: '用 dsh 控制 comfyui 生成视频', quote: '用 dsh 控制 comfyui 生成视频' }],
    suggestions: [], confidence_internal: 0.9, rationale: 'r', evidence_quotes: ['用 dsh 控制 comfyui 生成视频'],
    questions: [{ requirement_id: `unknown-${n}`, question: `${decision}?`, options: [{ id: 'a', label: '方案A' }, { id: 'b', label: '方案B' }], why: '取舍', depends_on: [] }],
  })

const COMPILE_OUT = [M.DIAGNOSIS, 'd', M.EXPLICIT, '(无)', M.CONTEXT, '(无)', M.SUGGESTED, '(无)', M.UNKNOWN, '(无)', M.OPTIMIZED, '## 目标', '做点事', '## 执行前须知', '- 动手前先确认:现状', M.END].join('\n')

async function boot({ alwaysNewDecision = false, analysis = null } = {}) {
  const routes = {}
  let n = 0
  let compileCalls = 0
  const ctx = new Context()
  ctx.provide('httpServer', { register(r) { routes[r.path] = r; return () => {} } })
  ctx.provide('llm', {
    async *stream(options) {
      const meta = /意图编译器分析器|intent compiler analyzer/.test(String(options.system ?? ''))
      let text
      if (meta) {
        if (analysis) text = analysis
        else { n += 1; text = analysisFor({ n, decision: alwaysNewDecision ? `第${n}个只有用户能决定的取舍:方案A还是方案B` : '复用现有 workflow 还是新建' }) }
      } else { compileCalls += 1; text = COMPILE_OUT }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'p', name: 'p' }],
    listModels: async () => [{ id: 'm', provider: 'p', name: 'm' }],
    resolveModelInfo: async () => ({ id: 'm', provider: 'p', reasoning: { efforts: [{ id: 'low' }] } }),
  })
  await ctx.plugin(plugin, {})
  return { routes, compileCalls: () => compileCalls }
}

async function call(routes, body) {
  const handler = routes['/dsh-prompt-optimizer/optimize'].handler
  const res = { status: 0, headers: {}, body: '', writableEnded: false, destroyed: false, on() {}, writeHead(s, h) { res.status = s; res.headers = h ?? {} }, write(c) { res.body += c; return true }, end(p) { if (p) res.body += p; res.writableEnded = true } }
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'; req.headers = {}
  await handler(req, res)
  return res.body.split('\n\n').filter(Boolean).map((f) => { const l = f.split('\n').find((x) => x.startsWith('data:')); return l ? JSON.parse(l.slice(5).trim()) : null }).filter(Boolean)
}

const answersFor = (questions) => (questions ?? []).map((q) => {
  const pick = (q.options ?? []).find((o) => o.id === q.recommended_option_id) ?? (q.options ?? [])[0]
  return pick ? { key: q.key, option_id: pick.id, text: pick.label } : { key: q.key, text: '按你的判断继续', blind_trust: true }
})

async function runToTerminal(routes, text, { maxSteps = 6 } = {}) {
  let events = await call(routes, { text, provider: 'p', model: 'm' })
  const steps = [events.filter((e) => e.type !== 'delta').map((e) => e.type).join(',')]
  let ledger = [], analysis = null, asked = [], triage = 'REBUILD'
  for (let step = 1; step <= maxSteps; step += 1) {
    const done = events.find((e) => e.type === 'done')
    if (done) return { done, events, steps }
    const d = events.find((e) => e.type === 'discovery_required')
    const c = events.find((e) => e.type === 'requirement_confirmation')
    if (!d && !c) return { done: null, events, steps }
    ledger = d?.ledger ?? c?.ledger ?? ledger
    analysis = d?.analysis ?? c?.analysis ?? analysis
    asked = d?.asked ?? c?.asked ?? asked
    triage = d?.triage?.triage ?? c?.triage?.triage ?? triage
    events = d
      ? await call(routes, { text, provider: 'p', model: 'm', discovery: { mode: 'answer', round: step, triage, ledger, asked, questions: d.questions, answers: answersFor(d.questions), analysis } })
      : await call(routes, { text, provider: 'p', model: 'm', discovery: { mode: 'confirm', round: step, triage, ledger, asked, answers: [], questions: [], analysis } })
    steps.push(events.filter((e) => e.type !== 'delta').map((e) => e.type).join(','))
  }
  return { done: null, events, steps }
}

// R1 + R2
{
  const { routes, compileCalls } = await boot({ alwaysNewDecision: true })
  const TEXT = '帮我做一个 AI 知识库,不知道是先做个能跑的最小版本,还是直接做成以后长期用的工具。'
  const { done, steps } = await runToTerminal(routes, TEXT)
  assert.ok(done, `★ R1/R2:必须到达 complete,实际步骤:${steps.join(' → ')}`)
  assert.ok(done.optimized.length > 0, 'R1/R2:必须产出优化稿')
  assert.equal(compileCalls(), 1, '★ R1/R2:Compiler 只在 confirm 之后调用一次')
  assert.ok(steps.some((s) => s.includes('requirement_confirmation')) && steps.some((s) => s.includes('done')), 'R1/R2:必须出现 requirement_confirmation → done')
  console.log('✓ R1/R2 confirm 两个死循环已修:到达 complete,编译仅 1 次')
}

// R3
{
  const { routes } = await boot({ analysis: analysisFor({ decision: '复用现有 workflow 还是新建' }) })
  const T1 = '我想用 dsh 控制 comfyui 生成视频,已经有 workflow,先验证控制链路。'
  const first = await runToTerminal(routes, T1)
  assert.ok(first.done, 'R3:第一次优化必须 complete')
  const ledger = first.done.ledger ?? []
  assert.ok(ledger.length > 0, 'R3:第一次 complete 必须带回台账')
  const T2 = '我想用 dsh 控制 comfyui 生成视频,已经有 workflow,先验证控制链路,谢谢。'
  const re = await call(routes, { text: T2, provider: 'p', model: 'm', discovery: { mode: 'reoptimize', round: 2, triage: 'REBUILD', ledger, asked: [], answers: [], questions: [], analysis: null } })
  const reDone = re.find((e) => e.type === 'done')
  const reDiscovery = re.find((e) => e.type === 'discovery_required')
  assert.ok(reDone, '★ R3:只改措辞的 re-optimize 必须直接 complete')
  assert.equal(reDiscovery, undefined, '★ R3:不得重复询问同一决定')
  const confirmed = (reDone.ledger ?? []).filter((e) => e.status === 'CONFIRMED').length
  assert.ok(confirmed > 0, '★ R3:已确认要求必须保留(CONFIRMED > 0)')
  console.log(`✓ R3 re-optimize 只改措辞:CONFIRMED=${confirmed}、零重复询问、直达 complete`)
}

// R4
{
  const { routes } = await boot({ analysis: analysisFor({ decision: '复用现有 workflow 还是新建' }) })
  const first = await runToTerminal(routes, '我想用 dsh 控制 comfyui 生成视频,已经有 workflow,先验证控制链路。')
  const ledger = first.done?.ledger ?? []
  const re = await call(routes, { text: '现在改成建立长期自动化流程,谢谢。', provider: 'p', model: 'm', discovery: { mode: 'reoptimize', round: 2, triage: 'REBUILD', ledger, asked: [], answers: [], questions: [], analysis: null } })
  const ev = re.find((e) => e.type === 'done') ?? re.find((e) => e.type === 'discovery_required') ?? re.find((e) => e.type === 'requirement_confirmation')
  const rejected = (ev?.ledger ?? []).filter((e) => e.status === 'REJECTED').length
  assert.ok(rejected > 0, '★ R4:改变目标 → REJECTED')
  console.log(`✓ R4 re-optimize 改变目标:CONFLICTING 生效(REJECTED=${rejected})`)
}

// R5(单元级,确定性):更换 Prompt Target → INVALIDATED
{
  const { reconcileLedger } = await import('../../lib/core/ledger-reconcile.js')
  const previous = [
    { id: 'ledger-a', text: '用 dsh 控制 comfyui 生成视频', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['用 dsh 控制 comfyui 生成视频'], confidence: 'high' },
  ]
  const analysis = {
    intent: { primary: 'execution', supporting: [], work_mode: 'one_shot', rationale: '' },
    target: { target: 'image_generation', modality: 'image', engine: null, confidence: 'high', evidence: [], rationale: '' },
    triage: { triage: 'PATCH', reasons: [], signals: [], keep_safe: false },
    missing_resolution: [], gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: '' },
    ledger: [], confidence_internal: 0.9, rationale: '', evidence_quotes: [], prompt_type: 'execution', missing_constraints: [],
  }
  const r = reconcileLedger({ previous, analysis, rawInput: '帮我生成 Midjourney 图片提示词。', previousTarget: 'agent_task' })
  assert.equal(r.ledger[0].status, 'NOT_APPLICABLE', '★ R5:更换 Target → 旧要求失效(NOT_APPLICABLE)')
  assert.equal(r.invalidated.length, 1)
  console.log('✓ R5 re-optimize 更换 Target:INVALIDATED 生效(NOT_APPLICABLE=1)')
}

// R6:协议标记剥离必须覆盖**行内**标记(交付稿不得含 <<<...>>>)
{
  const { stripProtocolMarkers } = await import('../../lib/core/compiler.js')
  assert.equal(stripProtocolMarkers('<<<DIAGNOSIS>>>\n正文'), '正文', 'R6:整行标记')
  assert.equal(stripProtocolMarkers('正文 <<<END>>> 结束'), '正文 结束', '★ R6:行内标记必须就地剥离')
  assert.equal(stripProtocolMarkers('前 <<<OPTIMIZED>>> 后'), '前 后', '★ R6:行内 OPTIMIZED')
  assert.doesNotMatch(stripProtocolMarkers('a <<<UNKNOWN>>> b <<<END>>>'), /<<<[A-Z_]+>>>/, 'R6:不得残留任何标记')
  console.log('✓ R6 协议标记剥离覆盖行内标记(防 VF_PROTOCOL_LEAK)')
}

// R7:「排除」语义 —— 合法约束不得拦截,无证据结论仍须保护
{
  const { validateCompileResult } = await import('../../lib/core/validate.js')
  const { defaultStrategyRegistry } = await import('../../lib/core/registry.js')
  const strategy = defaultStrategyRegistry.get('general')
  const strongClaim = (body, raw = '原始输入') => {
    const v = validateCompileResult(
      { optimized_prompt: body, prompt_type: 'general', explicit_requirements: [], context_requirements: [], suggested_requirements: [], unknowns: [] },
      { rawInput: raw, contextTurns: [], strategy, rawOutput: '' },
    )
    return v.problems.some((p) => p.rule === 'VALIDATION_UNPROVEN_STRONG_CLAIM')
  }
  // A. 动作 / 约束(合法) → 必须通过
  for (const line of [
    '- 请排除所有不相关的方案。',
    '- 筛选结果时排除重复项。',
    '- 约束:排除需要国外付费 API 的方案。',
    '- 排除项:不相关内容',
    '- 用于排除不符合条件的候选项。',
  ]) {
    assert.equal(strongClaim(line), false, `★ R7A 合法约束不得被拦:${line}`)
  }
  // B. 事实结论且无证据 → 必须拦
  for (const line of ['- 已排除网络问题。', '- 可以排除权限问题。', '- 因此排除配置异常。']) {
    assert.equal(strongClaim(line), true, `★ R7B 无证据结论必须被拦:${line}`)
  }
  // B'. 有逐字证据的结论 → 不得误报
  assert.equal(strongClaim('- 已排除网络问题 [quote: 已排除网络问题]', '已排除网络问题'), false, '★ R7B\' 有证据不得误报')
  console.log('✓ R7「排除」语义:约束/动作放行(5 例),无证据结论拦截(3 例),有证据不误报')
}

// R8:视觉契约缺排除项 → 交付 + 提示(不得拦交付);丢用户约束仍须拦
{
  const { assessCompleteness } = await import('../../lib/core/validation-flow.js')
  const imageNoNegative = assessCompleteness({
    optimizedPrompt: '二次元女孩坐在工作台前,冷蓝光,16:9,中景。',
    responsibilities: ['Subject', 'Scene', 'Style'],
    visualContract: true,
  })
  assert.deepEqual(imageNoNegative.criticalMissing, [], '★ R8:图像 Prompt 缺排除项不得拦交付')
  assert.ok(
    imageNoNegative.nonCriticalMissing.some((x) => /排除项/.test(x)),
    'R8:应作为非关键提示可见',
  )
  const droppedConstraint = assessCompleteness({
    optimizedPrompt: '做点事。',
    responsibilities: ['Request'],
    ledger: [{ text: '不要修改任何文件', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['不要修改任何文件'] }],
  })
  assert.deepEqual(droppedConstraint.criticalMissing, ['用户已确认的要求 / 约束'], '★ R8:丢用户约束仍必须拦')
  console.log('✓ R8 视觉缺排除项 → 交付+提示;丢用户约束仍拦')
}

// R9–R11:Recoverable Provenance Correction(模型错标 → 机械修复 → 交付,而非拒交付)
{
  const { reconcileProvenance } = await import('../../lib/core/provenance-recovery.js')
  const record = (id, text, evidence = []) => ({ id, text, source: 'USER_EXPLICIT', evidence, confidence: 'high' })
  const base = {
    prompt_type: 'general', optimized_prompt: '## Request\n- x',
    explicit_requirements: [], context_requirements: [], suggested_requirements: [], unknowns: [],
  }

  // R9:模型把 optimizer 建议写进 USER_EXPLICIT(无用户证据)→ 降级 OPTIMIZER_SUGGESTED
  {
    const r = reconcileProvenance(
      { ...base, explicit_requirements: [record('e1', '建议增加缓存')] },
      { rawInput: '帮我做个工具', contextTurns: [], suggestions: ['建议增加缓存'] },
    )
    assert.equal(r.result.explicit_requirements.length, 0, '★ R9:不得留在 USER_EXPLICIT')
    assert.equal(r.result.suggested_requirements.length, 1, '★ R9:必须降级为 OPTIMIZER_SUGGESTED')
    assert.equal(r.result.suggested_requirements[0].source, 'OPTIMIZER_SUGGESTED')
    assert.equal(r.corrections[0].reason_code, 'VF_SUGGESTION_UPGRADED')
    assert.equal(r.recovered, 1)
  }

  // R10:证据不在本轮输入但在**上下文用户发言**中 → CONTEXT_EXPLICIT
  {
    const r = reconcileProvenance(
      { ...base, explicit_requirements: [record('e2', '用 Node 写 CLI', ['用 Node 写 CLI'])] },
      { rawInput: '继续上面的', contextTurns: [{ role: 'user', text: '用 Node 写 CLI' }], suggestions: [] },
    )
    assert.equal(r.result.explicit_requirements.length, 0)
    assert.equal(r.result.context_requirements.length, 1, '★ R10:必须降级为 CONTEXT_EXPLICIT')
    assert.equal(r.result.context_requirements[0].source, 'CONTEXT_EXPLICIT')
    assert.equal(r.corrections[0].reason_code, 'VF_FABRICATED_USER_EXPLICIT')
  }

  // R11:既无用户证据也不是建议 → UNKNOWN(交缺失解析),不留在用户要求里
  {
    const r = reconcileProvenance(
      { ...base, explicit_requirements: [record('e3', '支持多机部署', ['用户说过要支持多机'])] },
      { rawInput: '帮我做个工具', contextTurns: [], suggestions: ['建议增加缓存'] },
    )
    assert.equal(r.result.explicit_requirements.length, 0)
    assert.equal(r.result.unknowns.length, 1, '★ R11:必须降级为 UNKNOWN')
    assert.equal(r.unresolved.length, 1, 'R11:必须交缺失解析机械分类')
    assert.equal(r.unresolved[0].source, 'UNKNOWN')
  }

  // R11b:合法 USER_EXPLICIT 不得被误降级
  {
    const r = reconcileProvenance(
      { ...base, explicit_requirements: [record('e4', '不要引入新依赖', ['不要引入新依赖'])] },
      { rawInput: '做个工具,不要引入新依赖', contextTurns: [], suggestions: [] },
    )
    assert.equal(r.result.explicit_requirements.length, 1, '★ R11b:合法证据必须保留')
    assert.equal(r.recovered, 0)
  }
  console.log('✓ R9–R11 provenance 自动恢复:建议→OPTIMIZER_SUGGESTED、上下文→CONTEXT_EXPLICIT、无据→UNKNOWN、合法保留')
}

// R12:2b 作用域修正 —— optimized 正文不是 provenance 来源组(用户裁决 §一/§三)
{
  const { validateCompileResult } = await import('../../lib/core/validate.js')
  const { defaultStrategyRegistry } = await import('../../lib/core/registry.js')
  const strategy = defaultStrategyRegistry.get('general')
  const rec = (id, text, source, evidence) => ({ id, text, source, evidence, confidence: 'high' })
  const flagged = (explicit, suggested, optimized, raw) =>
    validateCompileResult(
      { optimized_prompt: optimized, prompt_type: 'general', explicit_requirements: explicit, context_requirements: [], suggested_requirements: suggested, unknowns: [] },
      { rawInput: raw, contextTurns: [], strategy, rawOutput: '' },
    ).problems.some((p) => p.rule === 'VALIDATION_SUGGESTED_IN_REQUIREMENTS')

  const RAW = '二次元女孩坐在未来 AI 工作台前,冷蓝色屏幕光'
  // Case A:建议在 suggested group,同文本正常出现在正文 → 不得触发
  assert.equal(
    flagged(
      [rec('r1', '冷蓝色屏幕光', 'USER_EXPLICIT', ['冷蓝色屏幕光'])],
      [rec('s1', '冷蓝色屏幕光作为主光、环境补一层低强度暗部冷色反光', 'OPTIMIZER_SUGGESTED', [])],
      '## Subject\n- 冷蓝色屏幕光作为主光、环境补一层低强度暗部冷色反光',
      RAW,
    ),
    false,
    '★ R12-A:建议出现在正文不得判为 provenance 升级',
  )
  // Case A2:短用户要求被更长建议**包含** → 也不得触发(旧口径误报)
  assert.equal(
    flagged(
      [rec('r2', '冷蓝色屏幕光', 'USER_EXPLICIT', ['冷蓝色屏幕光'])],
      [rec('s2', '冷蓝色屏幕光作为主光、环境补一层低强度暗部冷色反光', 'OPTIMIZER_SUGGESTED', [])],
      '## Subject\n- 冷蓝色屏幕光',
      RAW,
    ),
    false,
    '★ R12-A2:用户元素被建议细化 ≠ 建议升级',
  )
  // Case B:建议被错误放进 USER_EXPLICIT(同文本)→ 必须触发
  assert.equal(
    flagged(
      [rec('r3', '建议增加缓存', 'USER_EXPLICIT', [])],
      [rec('s3', '建议增加缓存', 'OPTIMIZER_SUGGESTED', [])],
      '## Request\n- x',
      '做个工具',
    ),
    true,
    '★ R12-B:建议混入 USER_EXPLICIT 必须仍然触发(红线未放松)',
  )
  // Case C:建议被错误放进 CONTEXT_EXPLICIT(同文本)→ 必须触发
  const contextFlagged = (() => {
    const v = validateCompileResult(
      { optimized_prompt: '## Request\n- x', prompt_type: 'general', explicit_requirements: [], context_requirements: [rec('c1', '建议增加缓存', 'CONTEXT_EXPLICIT', [])], suggested_requirements: [rec('s4', '建议增加缓存', 'OPTIMIZER_SUGGESTED', [])], unknowns: [] },
      { rawInput: '做个工具', contextTurns: [], strategy, rawOutput: '' },
    )
    return v.problems.some((p) => p.rule === 'VALIDATION_SUGGESTED_IN_REQUIREMENTS')
  })()
  assert.equal(contextFlagged, true, '★ R12-C:建议混入 CONTEXT_EXPLICIT 必须仍然触发')
  // Case D:合法 USER_EXPLICIT 内容也出现在正文 → 正常通过
  assert.equal(
    flagged(
      [rec('r4', '不要引入新依赖', 'USER_EXPLICIT', ['不要引入新依赖'])],
      [],
      '## Request\n- 不要引入新依赖',
      '做个工具,不要引入新依赖',
    ),
    false,
    'R12-D:合法要求出现在正文不得触发',
  )
  console.log('✓ R12 2b 作用域修正:正文出现建议不再违规(A/A2);混入 explicit/context 仍拦(B/C);合法要求不受影响(D)')
}

// R13:PATCH→RESTRUCTURE 升级漏洞(真实 B run4 证据;TRIAGE_ESCALATION)
{
  const { decideTriage, mechanicalTriage } = await import('../../lib/core/triage.js')
  const B = '1. 先跑一遍测试\n2. 再看失败日志\n3. 输出格式:Markdown 表格'
  const MESSY = '帮我做个小工具,要求是能读 csv 然后汇总,输出格式要 markdown 表格,输出格式要 markdown 表格,另外要快一点别卡,另外要快一点别卡,字段要能自动识别,字段要能自动识别,不用装数据库,不用装数据库。'
  const VAGUE = '我想用 dsh 控制 comfyui 生成视频。'
  const KEEP = ['你是一名资深后端工程师,请审查并重构订单服务模块。', '', '要求:', '1. 保持对外 HTTP 接口签名完全不变,不得改动任何路由路径。', '2. 数据库迁移必须可回滚,禁止在迁移里删除字段。', '3. 所有新增逻辑必须带单元测试,覆盖率不低于 80%。', '', '约束:', '- 仅限修改 src/order 目录下的文件,不要动其他模块。', '- 依赖版本不得升级。', '', '输出格式:先给出问题清单(含文件路径与行号),再给出改动后的代码。', '', '验收标准:', '- npm test 全绿;', '- 现有 API 契约测试全部通过。'].join('\n')

  // R13-A:mechanical=PATCH + model=REBUILD → 不得 REBUILD,也不得借道 RESTRUCTURE
  const a = decideTriage({ raw_input: B, llm_suggestion: 'REBUILD' })
  assert.equal(a.mechanical, 'PATCH', 'R13-A:机械必须是 PATCH')
  assert.equal(a.triage, 'PATCH', '★ R13-A:不得借道升级为 RESTRUCTURE')
  // R13-B:mechanical=PATCH + model=RESTRUCTURE 且无结构混乱证据 → PATCH
  assert.equal(decideTriage({ raw_input: B, llm_suggestion: 'RESTRUCTURE' }).triage, 'PATCH', '★ R13-B:无证据不得升级')
  // R13-C:真实结构混乱(证据=true)→ 允许 RESTRUCTURE(功能没被废掉)
  const messyMech = mechanicalTriage(MESSY)
  assert.equal(messyMech.triage, 'RESTRUCTURE', 'R13-C:机械判据本身认可 RESTRUCTURE')
  assert.equal(messyMech.restructure_eligible, true, 'R13-C:确定性证据=true')
  assert.equal(decideTriage({ raw_input: MESSY, llm_suggestion: 'RESTRUCTURE' }).triage, 'RESTRUCTURE', 'R13-C:有证据则采纳')
  // R13-D:REBUILD 的机械一致性行为保持
  assert.equal(decideTriage({ raw_input: VAGUE, llm_suggestion: 'REBUILD' }).triage, 'REBUILD', 'R13-D:REBUILD 双方一致 → REBUILD')
  assert.equal(decideTriage({ raw_input: B, llm_suggestion: 'REBUILD' }).triage, 'PATCH', 'R13-D:REBUILD 未被机械确认 → 不得 REBUILD')
  // R13-E:KEEP 行为保持(需双方一致)
  assert.equal(decideTriage({ raw_input: KEEP, llm_suggestion: 'KEEP' }).triage, 'KEEP', 'R13-E:KEEP 双方一致 → KEEP')
  assert.equal(decideTriage({ raw_input: KEEP, llm_suggestion: 'PATCH' }).triage, 'PATCH', 'R13-E:模型想改 → 不 KEEP')
  console.log('✓ R13 PATCH 不得被模型借道升级为 RESTRUCTURE(A/B);有证据仍可 RESTRUCTURE(C);REBUILD/KEEP 行为保持(D/E)')
}

// R13-F:最小编辑行为保护 —— PATCH 载荷必须带「不得新增章节」纪律
{
  const { compilePrompt } = await import('../../lib/core/compiler.js')
  const { decideTriage } = await import('../../lib/core/triage.js')
  const B = '1. 先跑一遍测试\n2. 再看失败日志\n3. 输出格式:Markdown 表格'
  const decision = decideTriage({ raw_input: B, llm_suggestion: 'REBUILD' })
  assert.equal(decision.triage, 'PATCH')
  const analysis = {
    intent: { primary: 'execution', supporting: [], work_mode: 'one_shot', rationale: '' },
    target: { target: 'general', modality: 'text', engine: null, confidence: 'high', evidence: [], rationale: '' },
    triage: decision,
    missing_resolution: [],
    gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: '' },
    ledger: [], confidence_internal: 0.9, rationale: '', evidence_quotes: [], prompt_type: 'execution', missing_constraints: [],
  }
  const plan = compilePrompt({ raw_input: B, analysis, language: 'zh' })
  assert.match(plan.user, /编辑分诊纪律:PATCH/, '★ R13-F:载荷必须声明 PATCH 纪律')
  assert.match(plan.user, /保持原稿的结构与措辞/, '★ R13-F:必须要求保持原结构')
  assert.match(plan.user, /不得[\s\S]{0,20}新增章节/, '★ R13-F:必须禁止新增章节(防 39→1000+ 字模板重构)')
  console.log('✓ R13-F PATCH 载荷纪律齐备(保持原结构 + 不得新增章节)')
}

// R14:deterministic Replay 1 —— 真实观察过的 FABRICATED provenance shape([r-3])
{
  const { reconcileProvenance } = await import('../../lib/core/provenance-recovery.js')
  const { classifyUnknown } = await import('../../lib/core/requirements.js')
  const RAW = '做个工具,不要引入新依赖'
  const record = (id, text, evidence) => ({ id, text, source: 'USER_EXPLICIT', evidence, confidence: 'high' })
  const base = { prompt_type: 'general', optimized_prompt: '## Request\n- x', explicit_requirements: [], context_requirements: [], suggested_requirements: [], unknowns: [] }

  // ① 真实 failure shape:quote 与 raw/context 都不匹配、也不是建议 → UNKNOWN → Missing Resolution
  const r = reconcileProvenance(
    { ...base, explicit_requirements: [record('r-3', '支持多机部署', ['用户说过要支持多机'])] },
    { rawInput: RAW, contextTurns: [], suggestions: ['建议增加缓存'] },
  )
  assert.equal(r.result.explicit_requirements.length, 0, '★ R14:不得继续显示为「你已确认」')
  assert.equal(r.result.unknowns.length, 1, '★ R14:必须降级为 UNKNOWN')
  const disposition = classifyUnknown({ text: r.unresolved[0].text, blocking: true })
  assert.ok(
    ['AGENT_DISCOVERABLE', 'OPTIONAL', 'USER_REQUIRED'].includes(disposition.classification),
    '★ R14:必须由 Missing Resolution 机械分类',
  )
  assert.equal(
    disposition.blocking === true,
    disposition.classification === 'USER_REQUIRED',
    '★ R14:只有 blocking USER_REQUIRED 才应进入 Discovery',
  )
  // ② context 有证据 → CONTEXT_EXPLICIT
  const c = reconcileProvenance(
    { ...base, explicit_requirements: [record('r-4', '用 Node 写 CLI', ['用 Node 写 CLI'])] },
    { rawInput: '继续上面的', contextTurns: [{ role: 'user', text: '用 Node 写 CLI' }], suggestions: [] },
  )
  assert.equal(c.result.context_requirements[0]?.source, 'CONTEXT_EXPLICIT', '★ R14:context 证据 → CONTEXT_EXPLICIT')
  // ③ 可确定是建议 → OPTIMIZER_SUGGESTED
  const g = reconcileProvenance(
    { ...base, explicit_requirements: [record('r-5', '建议增加缓存', [])] },
    { rawInput: RAW, contextTurns: [], suggestions: ['建议增加缓存'] },
  )
  assert.equal(g.result.suggested_requirements[0]?.source, 'OPTIMIZER_SUGGESTED', '★ R14:建议 → OPTIMIZER_SUGGESTED')
  // ④ raw 有证据 → 保持 USER_EXPLICIT
  const k = reconcileProvenance(
    { ...base, explicit_requirements: [record('r-6', '不要引入新依赖', ['不要引入新依赖'])] },
    { rawInput: RAW, contextTurns: [], suggestions: [] },
  )
  assert.equal(k.result.explicit_requirements.length, 1, '★ R14:raw 有证据 → 保持 USER_EXPLICIT')
  assert.equal(k.recovered, 0)
  console.log('✓ R14 Replay 1:FABRICATED provenance 四路机械解析(UNKNOWN→Missing Resolution / CONTEXT / SUGGESTED / 保持)')
}

// R15:PATCH 行为不变量(真实 B run2 证据:39 字 → 1109 字/11 标题/丢原条目)
{
  const { assessPatchScope, extractSemanticUnits } = await import('../../lib/core/patch-scope.js')
  const { validateCompileResult } = await import('../../lib/core/validate.js')
  const { defaultStrategyRegistry } = await import('../../lib/core/registry.js')
  const B = '1. 先跑一遍测试\n2. 再看失败日志\n3. 输出格式:Markdown 表格'
  const TEMPLATE = [
    '# 测试运行 → 失败日志 → Markdown 表格输出', '',
    '## Goal & Definition of Done', '- 运行项目现有测试。', '- 读取测试失败日志。', '',
    '## Scope & Boundaries', '- 执行范围:运行测试、查看失败日志。', '',
    '## 执行前须知', '- 动手前先确认:失败日志的来源和格式。', '',
    '## Tools & Permissions', '- 使用项目现有的测试运行入口。', '',
    '## Verification', '- 存在测试运行产生的输出结果。',
  ].join('\n')
  const LOCAL = '1. 先跑一遍测试(优先用项目现有测试命令)。\n2. 再看失败日志,输出 Markdown 表格:用例/状态/失败原因三列。'
  const RAW_MD = '## 目标\n- 做 X\n\n## 约束\n- 不改 Y'

  // P1:三条原始语义必须全部保留
  assert.deepEqual(extractSemanticUnits(B).length, 3, 'P1:输入应为 3 个语义单元')
  // P2:原始无 headings → 骨架重建必须被检出(分级:仅骨架 → warning)
  const p2 = assessPatchScope({ rawInput: B, optimizedPrompt: TEMPLATE })
  assert.equal(p2.violated, true, '★ P2:大面积模板重构必须判越界')
  assert.equal(p2.skeletonChanged, true, '★ P2:骨架被重建')
  assert.ok(p2.missingUnits.length > 0, '★ P1:丢失的原始语义必须被指出')
  // P3:原始已有 headings → 允许原结构下局部修改
  assert.equal(
    assessPatchScope({ rawInput: RAW_MD, optimizedPrompt: '## 目标\n- 做 X(补:先确认入口)\n\n## 约束\n- 不改 Y' }).violated,
    false,
    '★ P3:已有分节内局部修改不得判越界',
  )
  // P6:合理的局部补强不得被判越界(guard 不得退化成 KEEP)
  assert.equal(assessPatchScope({ rawInput: B, optimizedPrompt: LOCAL }).violated, false, '★ P6:局部补强必须放行')
  // 校验层:triage=PATCH 时才检查
  const strategy = defaultStrategyRegistry.get('general')
  const mk = (out) => ({ optimized_prompt: out, prompt_type: 'general', explicit_requirements: [], context_requirements: [], suggested_requirements: [], unknowns: [] })
  const asPatch = validateCompileResult(mk(TEMPLATE), { rawInput: B, contextTurns: [], strategy, rawOutput: '', triage: 'PATCH' })
  assert.ok(
    asPatch.problems.some((p) => p.rule === 'VALIDATION_PATCH_SCOPE_VIOLATION'),
    '★ 校验层:PATCH 越界必须产出 VALIDATION_PATCH_SCOPE_VIOLATION',
  )
  // 分级:只有骨架变化时必须是 warning(不阻塞交付);丢原始要求才是 error
  const onlySkeleton = assessPatchScope({
    rawInput: '1. 先跑一遍测试\n2. 再看失败日志',
    optimizedPrompt: '# 测试流程\n## A\n- 先跑一遍测试(现有测试命令)\n## B\n- 再看失败日志\n## C\n- 记录结果',
  })
  assert.equal(onlySkeleton.missingUnits.length, 0, '骨架型产物不得误判为丢失原始要求')
  assert.equal(onlySkeleton.skeletonChanged, true)
  const sev = validateCompileResult(
    mk('# 测试流程\n## A\n- 先跑一遍测试(现有测试命令)\n## B\n- 再看失败日志\n## C\n- 记录结果'),
    { rawInput: '1. 先跑一遍测试\n2. 再看失败日志', contextTurns: [], strategy, rawOutput: '', triage: 'PATCH' },
  ).problems.filter((p) => p.rule === 'VALIDATION_PATCH_SCOPE_VIOLATION')
  assert.deepEqual(sev.map((p) => p.severity), ['warn'], '★ 仅骨架变化必须是 warning(不阻塞交付)')
  const asRebuild = validateCompileResult(mk(TEMPLATE), { rawInput: B, contextTurns: [], strategy, rawOutput: '', triage: 'REBUILD' })
  assert.equal(
    asRebuild.problems.some((p) => p.rule === 'VALIDATION_PATCH_SCOPE_VIOLATION'),
    false,
    'REBUILD 不得触发 PATCH 不变量',
  )
  // P4/P5:回流映射存在(bounded retry 与 fail-closed 由既有 validation-flow 继承)
  const { decideValidationAction } = await import('../../lib/core/validation-flow.js')
  const outcome = decideValidationAction({
    problems: [{ severity: 'error', rule: 'VALIDATION_PATCH_SCOPE_VIOLATION', message: 'x' }],
    result: mk(TEMPLATE),
    rawInput: B,
    returns: [],
  })
  assert.equal(outcome.action, 'RETURN_TO_MISSING_RESOLUTION', '★ P4:必须进入可控回流')
  assert.equal(outcome.reason_code, 'VF_PATCH_SCOPE_VIOLATION', '★ P4:reason code 正确')
  console.log('✓ R15 PATCH 行为不变量:P1/P2 越界检出、P3/P6 放行、校验层与回流映射齐备')
}

// R17:受控回流的纠错反馈必须进入第二次编译载荷(否则重试与首次同构 → 永远 fail-closed)
{
  const { compilePrompt } = await import('../../lib/core/compiler.js')
  const { decideTriage } = await import('../../lib/core/triage.js')
  const B = '1. 先跑一遍测试\n2. 再看失败日志\n3. 输出格式:Markdown 表格'
  const analysis = {
    intent: { primary: 'execution', supporting: [], work_mode: 'one_shot', rationale: '' },
    target: { target: 'general', modality: 'text', engine: null, confidence: 'high', evidence: [], rationale: '' },
    triage: decideTriage({ raw_input: B, llm_suggestion: 'PATCH' }),
    missing_resolution: [],
    gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: '' },
    ledger: [], confidence_internal: 0.9, rationale: '', evidence_quotes: [], prompt_type: 'execution', missing_constraints: [],
  }
  const first = compilePrompt({ raw_input: B, analysis, language: 'zh' })
  assert.doesNotMatch(first.user, /上一轮校验未通过/, '首次编译不得带纠错段')
  const retry = compilePrompt({
    raw_input: B, analysis, language: 'zh',
    validationReturns: [{ reason_code: 'VF_PATCH_SCOPE_VIOLATION', action: 'RETURN_TO_MISSING_RESOLUTION', round: 1 }],
  })
  assert.match(retry.user, /上一轮校验未通过\(必须修正后才能交付\)/, '★ 重试载荷必须带纠错段')
  assert.match(retry.user, /VF_PATCH_SCOPE_VIOLATION/, '★ 必须指出上次的 reason code')
  assert.match(retry.user, /不得新增章节\/任务模板骨架/, '★ 必须给出机械纠错指令')
  // 第二次重试仍带(累积),且不因同码重复堆叠
  const retry2 = compilePrompt({
    raw_input: B, analysis, language: 'zh',
    validationReturns: [
      { reason_code: 'VF_PATCH_SCOPE_VIOLATION', action: 'RETURN_TO_MISSING_RESOLUTION', round: 1 },
      { reason_code: 'VF_PATCH_SCOPE_VIOLATION', action: 'RETURN_TO_MISSING_RESOLUTION', round: 2 },
    ],
  })
  assert.equal((retry2.user.match(/VF_PATCH_SCOPE_VIOLATION/g) ?? []).length, 1, '同一 reason 不得重复堆叠')
  console.log('✓ R17 回流纠错反馈进入重试载荷(首次无、重试有、同码不堆叠)')
}

console.log('release-blockers.test.mjs: ALL PASS')
