/**
 * v2 Phase 3 —— Requirement Discovery 引擎单测。
 *
 * 覆盖四件事(全部机械、可审计):
 *   1. Question Planner:四维优先级 / 依赖分轮 / 1–2(≤3) / 去重 / 不重复问;
 *   2. Answer Resolver:confirm / reject / supersede / invalidate / not_applicable / derived;
 *   3. Sufficiency Evaluator:结合**当前**台账状态重算 live blocking(不是数字段);
 *   4. 循环安全保护:最大轮次 / 无新信息 / 无高价值问题。
 * 另含:blind authorization 永不产生 USER_EXPLICIT / CONFIRMED;Edit Triage 不被 Discovery 改变。
 *
 * 运行:先 `npm run build`,再 `node test/discovery.test.mjs`。
 */
import assert from 'node:assert/strict'
import {
  DISCOVERY_DEFAULT_QUESTIONS,
  DISCOVERY_MAX_QUESTIONS_PER_ROUND,
  DISCOVERY_MAX_ROUNDS,
  buildConfirmation,
  confirmationFingerprint,
  evaluateSufficiency,
  findSessionViolations,
  isAlreadyAsked,
  normalizeQuestionText,
  planQuestions,
  questionFingerprint,
  questionSimilarity,
  recordAsked,
  reopenRequirements,
  resolvedValueOf,
  resolveAnswers,
  reviseRequirement,
  runDiscoveryTurn,
  sanitizeSession,
} from '../lib/core/discovery.js'
import { classifyUnknown, computeAnalysisGate } from '../lib/core/requirements.js'

/** 最小分析结果工厂。 */
function analysis({ blocking = [], discoverable = [], questions = [], triage = 'PATCH', primary = 'execution' } = {}) {
  const resolution = [...blocking, ...discoverable]
  const gate = computeAnalysisGate(resolution, triage)
  return {
    intent: { primary, supporting: [], work_mode: 'one_shot', rationale: 'r' },
    target: { target: 'agent_task', modality: 'text', engine: null, confidence: 'medium', evidence: [], rationale: 'r' },
    triage: { triage, reasons: [], signals: [], keep_safe: false },
    missing_resolution: resolution,
    gate,
    ledger: [],
    confidence_internal: 0.9,
    rationale: 'r',
    evidence_quotes: [],
    prompt_type: primary,
    missing_constraints: blocking.map((item) => item.text),
    ...(questions.length ? { questions } : {}),
  }
}

/** 构造一个「阻塞的用户决定」型未决项(稳定 id)。 */
function blocking(text, id) {
  const item = classifyUnknown({ text, classification: 'USER_REQUIRED', blocking: true, impact: 'high' })
  return { ...item, id, blocking: true }
}

function discoverable(text, id) {
  const item = classifyUnknown({ text, classification: 'AGENT_DISCOVERABLE' })
  return { ...item, id, blocking: false }
}

const entry = (id, text, status = 'OPEN', source = 'UNKNOWN') => ({
  id: `ledger-${id}`,
  text,
  source,
  status,
  evidence: [],
  confidence: 'low',
})

// 1. 问题规划:默认 1–2、最多 3,按四维加权排序
{
  const a = blocking('要自建工作流还是复用现有工作流', 'u1')
  const b = blocking('要长期自动化还是先验证一次', 'u2')
  const c = blocking('要支持多机还是单机', 'u3')
  const d = blocking('要有界面还是纯脚本', 'u4')
  const round = planQuestions({
    raw_input: 'x',
    triage: 'PATCH',
    ledger: [],
    blocking: [a, b, c, d],
    round: 1,
  })
  assert.equal(round.verdict, 'ASK')
  assert.equal(round.questions.length, DISCOVERY_DEFAULT_QUESTIONS, '默认 1–2 个问题')
  assert.ok(round.questions.length <= DISCOVERY_MAX_QUESTIONS_PER_ROUND)
  // 显式放宽上限也不得超过 3
  const many = planQuestions({ raw_input: 'x', triage: 'PATCH', ledger: [], blocking: [a, b, c, d], round: 1, maxQuestions: 9 })
  assert.equal(many.questions.length, DISCOVERY_MAX_QUESTIONS_PER_ROUND, '硬上限 3')
  // 没有问题就不问
  assert.equal(planQuestions({ raw_input: 'x', triage: 'PATCH', ledger: [], blocking: [], round: 1 }).verdict, 'READY_TO_CONFIRM')
  console.log('✓ d1 Planner:1–2 默认 / ≤3 硬上限 / 无阻塞直接 READY')
}

// 2. 四维优先级:一个答案能消除最多分支的问题优先
{
  const wide = blocking('工作流是自己写还是复用现成模板', 'w1')
  const narrow = blocking('日志要 JSON 还是纯文本', 'w2')
  const questions = [
    {
      key: 'w1::q',
      requirement_id: 'w1',
      question: '工作流怎么来?',
      options: [
        { id: 'o1', label: '复用现成模板', invalidates: ['u2', 'u3'] },
        { id: 'o2', label: '自己写' },
      ],
      why: '',
      depends_on: [],
    },
  ]
  const round = planQuestions({
    raw_input: 'x',
    triage: 'PATCH',
    ledger: [],
    blocking: [narrow, wide],
    candidates: questions,
    round: 1,
    maxQuestions: 1,
  })
  assert.equal(round.questions.length, 1)
  assert.equal(round.questions[0].requirement_id, 'w1', '分支收敛度高的优先')
  console.log('✓ d2 Planner:优先「一答消除最多分支」的问题')
}

// 3. 依赖分轮:B 是否需要问取决于 A → 不得同轮
{
  const a = blocking('要复用现有工作流还是新建', 'a1')
  const b = blocking('允许自动创建还是必须手动确认', 'b1')
  const candidates = [
    { key: 'a1::q', requirement_id: 'a1', question: '工作流来源?', options: [], why: '', depends_on: [] },
    { key: 'b1::q', requirement_id: 'b1', question: '允许自动创建还是必须手动确认?', options: [], why: '', depends_on: ['a1'] },
  ]
  const round = planQuestions({
    raw_input: 'x',
    triage: 'PATCH',
    ledger: [],
    blocking: [a, b],
    candidates,
    round: 1,
    maxQuestions: 3,
  })
  const ids = round.questions.map((q) => q.requirement_id)
  assert.ok(ids.includes('a1'), '先问无依赖的 A')
  assert.equal(ids.includes('b1'), false, '依赖 A 的 B 不得同轮(依赖分轮)')

  // A 已解决后,B 才轮到
  const second = planQuestions({
    raw_input: 'x',
    triage: 'PATCH',
    ledger: [entry('a1', '工作流来源', 'CONFIRMED', 'USER_EXPLICIT')],
    blocking: [b],
    candidates,
    asked: [{ key: 'a1::q', question: '工作流来源?', round: 1, fingerprint: questionFingerprint('a1', '工作流来源?') }],
    round: 2,
  })
  assert.equal(second.verdict, 'ASK')
  assert.equal(second.questions[0].requirement_id, 'b1')
  console.log('✓ d3 Planner:依赖分轮(A 未决不问 B;A 解决后 B 才出现)')
}

// 4. 禁止重复询问:同问题换说法也不重复问
{
  const a = blocking('要复用现有工作流还是新建', 'r1')
  const first = planQuestions({ raw_input: 'x', triage: 'PATCH', ledger: [], blocking: [a], round: 1 })
  const asked = recordAsked(first, [])
  assert.equal(asked.length, 1)

  // 完全一样 → 不问(且给出「无新信息」停止理由)
  const same = planQuestions({ raw_input: 'x', triage: 'PATCH', ledger: [], blocking: [a], asked, round: 2 })
  assert.equal(same.verdict, 'READY_TO_CONFIRM')
  assert.equal(same.questions.length, 0)
  assert.ok(['no_new_information', 'no_high_value_question'].includes(same.stopped_by))

  // 换一种措辞(同 requirement)→ 也不重复问
  const rephrased = planQuestions({
    raw_input: 'x',
    triage: 'PATCH',
    ledger: [],
    blocking: [a],
    candidates: [{ key: 'r1::q2', requirement_id: 'r1', question: '工作流是复用现成的还是重新建一个?', options: [], why: '', depends_on: [] }],
    asked,
    round: 2,
  })
  assert.equal(rephrased.questions.length, 0, '换说法也不得重复询问')

  // 两道防线都可机械验证:
  //   ① 同一 requirement(哪怕换了措辞)→ Planner 层直接不问(askedRequirementIds);
  //   ② 同一问法的改写(requirement id 不同时)→ isAlreadyAsked 用相似度拦住。
  assert.equal(questionFingerprint('r1', '工作流来源?'), questionFingerprint('r1', '工作流来源?'))
  assert.ok(questionSimilarity('要复用现有工作流还是新建', '要复用现有工作流还是新建(必答)') > 0.72)
  assert.equal(
    isAlreadyAsked({ requirement_id: 'r1', question: '要复用现有工作流还是新建(必答)', key: 'r1::other' }, asked),
    true,
    '同一问法的改写必须被判为已问过',
  )
  assert.equal(
    isAlreadyAsked({ requirement_id: 'zz', question: '完全不同的问题:要不要多机?', key: 'zz::q' }, asked),
    false,
    '语义无关的新问题不得被误判为已问过',
  )
  assert.equal(normalizeQuestionText('  请问:工作流来源?  '), '工作流来源')
  console.log('✓ d4 Planner:重复 / 换说法都不得再问')
}

// 5. Answer Resolver:confirm / invalidate / not_applicable
{
  const questions = [
    {
      key: 'w1::q',
      requirement_id: 'w1',
      question: '工作流怎么来?',
      options: [
        { id: 'use', label: '调用已存在的 workflow', value: 'USE_EXISTING', invalidates: ['create_ok'] },
        { id: 'create', label: '自动创建/修改', value: 'CREATE' },
      ],
      why: '',
      depends_on: [],
    },
    {
      key: 'create_ok::q',
      requirement_id: 'create_ok',
      question: '允许自动创建吗?',
      options: [],
      why: '',
      depends_on: ['w1'],
    },
  ]
  const ledger = [entry('w1', '工作流来源'), entry('create_ok', '是否允许自动创建')]
  const resolved = resolveAnswers({
    raw_input: '我想用 dsh 控制 comfyui 生成视频',
    ledger,
    questions,
    answers: [{ key: 'w1::q', option_id: 'use', text: '调用已存在的 workflow' }],
  })
  const byId = new Map(resolved.ledger.map((item) => [item.id, item]))
  const w1 = byId.get('ledger-w1')
  assert.equal(w1.status, 'CONFIRMED')
  assert.equal(w1.source, 'USER_EXPLICIT')
  assert.deepEqual(w1.evidence, ['调用已存在的 workflow'], '证据必须是用户原话')
  const create = byId.get('ledger-create_ok')
  assert.equal(create.status, 'NOT_APPLICABLE', '选项声明的失效项 → NOT_APPLICABLE')
  assert.ok(resolved.updates.some((update) => update.action === 'not_applicable'))
  assert.ok(resolved.updates.some((update) => update.action === 'supersede'))
  console.log('✓ d5 Resolver:确认 + 失效项 NOT_APPLICABLE')
}

// 6. Answer Resolver:否定式 → REJECTED;自由回答 → derived
{
  const questions = [{ key: 'k::q', requirement_id: 'k', question: '要不要加缓存?', options: [], why: '', depends_on: [] }]
  const rejected = resolveAnswers({
    raw_input: 'x',
    ledger: [entry('k', '要不要加缓存')],
    questions,
    answers: [{ key: 'k::q', text: '不需要缓存' }],
  })
  assert.equal(rejected.ledger[0].status, 'REJECTED')
  assert.equal(rejected.ledger[0].source, 'USER_EXPLICIT')

  const freeform = resolveAnswers({
    raw_input: 'x',
    ledger: [entry('k', '要不要加缓存')],
    questions: [{ ...questions[0], options: [] }],
    answers: [{ key: 'k::q', text: '用 Redis,key 前缀 cache:' }],
  })
  assert.ok(
    freeform.ledger.some((item) => item.status === 'CONFIRMED' && item.text.includes('Redis')),
    '自由回答产生 derived 具体取值条目',
  )
  console.log('✓ d6 Resolver:否定 → REJECTED;自由回答 → derived')
}

// 7. Blind authorization 永不产生 USER_EXPLICIT / CONFIRMED
{
  const questions = [{ key: 'b::q', requirement_id: 'b', question: '工作流来源?', options: [], why: '', depends_on: [] }]
  const ledger = [entry('b', '工作流来源')]

  const unconditional = resolveAnswers({
    raw_input: 'x',
    ledger,
    questions,
    answers: [{ key: 'b::q', text: '按你的判断继续', blind_trust: true }],
  })
  const item = unconditional.ledger.find((i) => i.id === 'ledger-b')
  assert.equal(item.source, 'OPTIMIZER_SUGGESTED', '盲授权不得产生 USER_EXPLICIT')
  assert.equal(item.status, 'PROVISIONAL')
  assert.deepEqual(item.evidence, [], '盲授权不得留下用户证据')

  const conditional = resolveAnswers({
    raw_input: 'x',
    ledger,
    questions,
    answers: [{ key: 'b::q', text: '如果已有 workflow 就按你的判断继续', blind_trust: true }],
  })
  assert.equal(conditional.ledger.find((i) => i.id === 'ledger-b').status, 'CONDITIONAL', '条件式授权 → CONDITIONAL')

  assert.deepEqual(findSessionViolations(sanitizeSession({
    raw_input: 'x',
    triage: 'PATCH',
    ledger: unconditional.ledger,
    questions,
    answers: [],
    round: 1,
  })), [], '盲授权后的台账不得有来源违规')
  assert.ok(
    !unconditional.ledger.some((i) => i.source === 'USER_EXPLICIT' || i.status === 'CONFIRMED'),
    '盲授权绝不能制造 CONFIRMED / USER_EXPLICIT',
  )
  console.log('✓ d7 盲授权:PROVISIONAL / CONDITIONAL,永不 USER_EXPLICIT·CONFIRMED')
}

// 8. Sufficiency:结合当前状态重算(不是数 blocking 字段)
{
  const a = blocking('要长期自动化还是先验证一次', 's1')
  const b = blocking('要不要支持多机', 's2')
  const model = analysis({ blocking: [a, b], discoverable: [discoverable('ComfyUI 版本', 'd1')] })

  // 两项都 OPEN → 不充足
  const open = evaluateSufficiency({ analysis: model, ledger: [entry('s1', a.text), entry('s2', b.text)], round: 1 })
  assert.equal(open.ready, false)
  assert.equal(open.liveBlocking.length, 2)

  // 一项 CONFIRMED、一项 NOT_APPLICABLE → 决策完备
  const settled = evaluateSufficiency({
    analysis: model,
    ledger: [entry('s1', a.text, 'CONFIRMED', 'USER_EXPLICIT'), entry('s2', b.text, 'NOT_APPLICABLE')],
    round: 2,
  })
  assert.equal(settled.ready, true, '已确认 + 已不适用 → decision completeness')
  assert.equal(settled.liveBlocking.length, 0)
  assert.equal(settled.relaxed.length, 2)

  // CONDITIONAL / PROVISIONAL / DEFERRED 视为已安全处理
  for (const status of ['CONDITIONAL', 'PROVISIONAL', 'DEFERRED', 'REJECTED', 'DISCOVERABLE']) {
    const result = evaluateSufficiency({
      analysis: model,
      ledger: [entry('s1', a.text, status), entry('s2', b.text, status)],
      round: 2,
    })
    assert.equal(result.ready, true, `${status} 应视为已安全处理`)
  }

  // AGENT_DISCOVERABLE / OPTIONAL 从不阻塞(UNKNOWN 无需清零)
  const onlyDiscoverable = analysis({ discoverable: [discoverable('ComfyUI 版本', 'd1'), discoverable('workflow 文件位置', 'd2')] })
  assert.equal(evaluateSufficiency({ analysis: onlyDiscoverable, ledger: [], round: 1 }).ready, true)

  // 达到最大轮次 → 安全停止(max_rounds)
  const capped = evaluateSufficiency({
    analysis: model,
    ledger: [entry('s1', a.text), entry('s2', b.text)],
    round: DISCOVERY_MAX_ROUNDS,
  })
  assert.equal(capped.ready, true)
  assert.equal(capped.stoppedBy, 'max_rounds')
  console.log('✓ d8 Sufficiency:按当前状态重算;可自查项不阻塞;轮次上限安全停止')
}

// 9. Confirmation 摘要:四组 + 指纹;不含完整台账
{
  const model = analysis({ blocking: [blocking('要不要支持多机', 'c1')] })
  const ledger = [
    entry('k1', '已经有可工作的 workflow', 'CONFIRMED', 'USER_EXPLICIT'),
    { ...entry('k2', '先验证控制链路', 'CONFIRMED', 'USER_EXPLICIT'), evidence: ['先验证控制链路'] },
    entry('d1', 'ComfyUI 版本', 'DISCOVERABLE'),
    entry('p1', '暂定优先复用现有 workflow', 'PROVISIONAL', 'OPTIMIZER_SUGGESTED'),
  ]
  const confirmation = buildConfirmation({ analysis: model, ledger, raw_input: '我想用 dsh 控制 comfyui 生成视频' })
  assert.ok(confirmation.goal.length > 0)
  assert.equal(confirmation.confirmed.length, 2)
  assert.ok(confirmation.agent_researches.some((item) => item.includes('ComfyUI')))
  // RC2 §5:只要还有阻塞的用户决策,确认页就**不得**出现暂定项
  // (否则用户会以为优化器已经替他定了)。这里 blocking=['要不要支持多机'] → 暂定为空。
  assert.equal(confirmation.provisional.length, 0, '阻塞决策在场时不得展示暂定项')
  // 无阻塞时才允许暂定(同一台账、去掉阻塞项)
  const open = buildConfirmation({
    analysis: analysis({}),
    ledger,
    raw_input: '我想用 dsh 控制 comfyui 生成视频',
  })
  assert.equal(open.provisional.length, 1, '无阻塞时暂定项照常展示')
  assert.equal(open.provisional[0].status, 'PROVISIONAL')
  assert.match(confirmation.fingerprint, /^[0-9a-f]{8}$/)
  // 指纹稳定:同输入一致、改一项即变
  assert.equal(
    confirmationFingerprint({ goal: confirmation.goal, confirmed: confirmation.confirmed, agentResearches: confirmation.agent_researches, provisional: confirmation.provisional }),
    confirmation.fingerprint,
  )
  assert.notEqual(
    confirmationFingerprint({ goal: confirmation.goal, confirmed: [...confirmation.confirmed, { text: '变化' }], agentResearches: confirmation.agent_researches, provisional: confirmation.provisional }),
    confirmation.fingerprint,
  )
  // 不含完整台账字段(只有四组 + 指纹)
  assert.deepEqual(Object.keys(confirmation).sort(), ['agent_researches', 'confirmed', 'fingerprint', 'goal', 'provisional'])
  console.log('✓ d9 Confirmation:四组摘要 + 稳定指纹(不暴露完整台账)')
}

// 9b. Phase 4 §2:四类必须互斥(同 id 或语义等价的决定只能出现一次)
{
  const model = analysis({ blocking: [blocking('要不要支持多机', 'c1')] })
  const ledger = [
    { ...entry('k1', '本轮目标是先验证控制链路还是建立长期自动化', 'CONFIRMED', 'USER_EXPLICIT'), evidence: ['先验证控制链路'] },
    // 与上面指向同一决定,只是换了个措辞的「建议」→ 不得再以 PROVISIONAL 出现
    { ...entry('s1', '可先验证控制链路', 'PROVISIONAL', 'OPTIMIZER_SUGGESTED'), note: '建议' },
    { ...entry('d1', 'ComfyUI 版本', 'DISCOVERABLE'), },
    // 与可自查项同 id 的重复条目 → 不得重复
    { ...entry('d1', 'ComfyUI 版本', 'DISCOVERABLE'), },
    // 真正的独立暂定项 → 保留
    { ...entry('p2', '暂定使用 9:16 画幅', 'PROVISIONAL', 'OPTIMIZER_SUGGESTED') },
  ]
  const confirmation = buildConfirmation({ analysis: model, ledger, raw_input: '我想用 dsh 控制 comfyui 生成视频' })
  const all = [
    ...confirmation.confirmed.map((c) => c.text),
    ...confirmation.agent_researches,
    ...confirmation.provisional.map((p) => p.text),
  ]
  assert.equal(new Set(all).size, all.length, '四类之间不得有字面重复')
  assert.equal(
    confirmation.provisional.some((p) => p.text.includes('可先验证控制链路')),
    false,
    '★ 与已确认项语义等价的暂定项必须被剔除',
  )
  assert.equal(confirmation.agent_researches.length, 1, '同 id 的可自查项只出现一次')
  // RC2 §5:该 fixture 的 model 带 blocking('要不要支持多机') → 暂定组整体为空;
  // 去掉阻塞项后,独立暂定项应保留(且与已确认项语义等价的仍被剔除)。
  assert.equal(confirmation.provisional.length, 0, '阻塞决策在场时不得展示暂定项')
  const open = buildConfirmation({ analysis: analysis({}), ledger, raw_input: '我想用 dsh 控制 comfyui 生成视频' })
  assert.equal(open.provisional.length, 1, '无阻塞时独立暂定项保留')
  assert.equal(open.provisional[0].text, '暂定使用 9:16 画幅')
  console.log('✓ d9b Confirmation 四类互斥(id + 语义双重去重)')
}

// 10. Edit Triage 不被 Discovery 改变
{
  for (const triage of ['KEEP', 'PATCH', 'RESTRUCTURE', 'REBUILD']) {
    const model = analysis({ blocking: [blocking('要不要支持多机', 't1')], triage })
    const turn = runDiscoveryTurn({
      raw_input: 'x',
      analysis: model,
      ledger: [entry('t1', '要不要支持多机')],
      questions: [{ key: 't1::q', requirement_id: 't1', question: '要支持多机吗?', options: [], why: '', depends_on: [] }],
      answers: [{ key: 't1::q', text: '要支持多机' }],
      asked: [],
      round: 1,
    })
    assert.equal(turn.sufficiency.ready, true, `${triage}:回答后应决策完备`)
    assert.equal(model.triage.triage, triage, 'Discovery 不得改写 Edit Triage')
    assert.ok(turn.ledger.find((i) => i.id === 'ledger-t1').status === 'CONFIRMED')
  }
  // 多轮:第一轮答案消除第二项(动态重算,不照旧问题队列)
  const wa = blocking('要复用现有工作流还是新建', 'm1')
  const wb = blocking('允许自动创建还是必须手动确认', 'm2')
  const model = analysis({
    blocking: [wa, wb],
    questions: [
      {
        key: 'm1::q',
        requirement_id: 'm1',
        question: '工作流怎么来?',
        options: [{ id: 'use', label: '复用现有', invalidates: ['m2'] }],
        why: '',
        depends_on: [],
      },
      { key: 'm2::q', requirement_id: 'm2', question: '允许自动创建还是必须手动确认?', options: [], why: '', depends_on: ['m1'] },
    ],
  })
  const first = planQuestions({
    raw_input: 'x',
    triage: 'PATCH',
    ledger: [entry('m1', wa.text), entry('m2', wb.text)],
    blocking: [wa, wb],
    candidates: model.questions,
    round: 1,
    maxQuestions: 3,
  })
  assert.deepEqual(first.questions.map((q) => q.requirement_id), ['m1'], '同轮只问无依赖的 m1')
  const turn = runDiscoveryTurn({
    raw_input: 'x',
    analysis: model,
    ledger: [entry('m1', wa.text), entry('m2', wb.text)],
    questions: first.questions,
    answers: [{ key: first.questions[0].key, option_id: 'use', text: '复用现有的' }],
    asked: recordAsked(first, []),
    round: 1,
  })
  assert.equal(turn.sufficiency.ready, true, 'm1 的答案使 m2 失效 → 决策完备')
  assert.ok(turn.ledger.find((i) => i.id === 'ledger-m2').status === 'NOT_APPLICABLE')
  assert.equal(turn.next.questions.length, 0, '不再问 m2(已失效)')
  console.log('✓ d10 动态重算:一轮答案使后续问题失效;Edit Triage 不变')
}

// 11. 修改理解:重开 / 改值保持台账
{
  const ledger = [
    entry('a', '要复用现有 workflow', 'CONFIRMED', 'USER_EXPLICIT'),
    entry('b', '长期自动化', 'CONFIRMED', 'USER_EXPLICIT'),
  ]
  const reopened = reopenRequirements(ledger, ['a'])
  assert.equal(reopened.find((i) => i.id === 'ledger-a').status, 'OPEN')
  assert.equal(reopened.find((i) => i.id === 'ledger-a').source, 'UNKNOWN', '重开后来源回退,不得保留用户证据')
  assert.equal(reopened.find((i) => i.id === 'ledger-b').status, 'CONFIRMED', '其余台账保留')

  const revised = reviseRequirement(ledger, 'b', '先验证一次,不做长期自动化', '先验证一次')
  const b = revised.find((i) => i.id === 'ledger-b')
  assert.equal(b.text, '先验证一次,不做长期自动化')
  assert.equal(b.status, 'CONFIRMED')
  assert.equal(b.source, 'USER_EXPLICIT')
  assert.deepEqual(b.evidence, ['先验证一次'])
  console.log('✓ d11 修改理解:重开 / 改值且保持台账')
}

// 12. 会话净化与不变量(不可信输入)
{
  const session = sanitizeSession({
    raw_input: '我想用 dsh 控制 comfyui 生成视频',
    triage: 'PATCH',
    ledger: [
      { id: 'ledger-x', text: '凭空捏造的要求', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['用户没说过'], confidence: 'high' },
      { id: 'ledger-y', text: 'ComfyUI 版本', source: 'UNKNOWN', status: 'DISCOVERABLE', evidence: [], confidence: 'low' },
    ],
    asked: [{ key: 'a::q', question: 'Q?', round: 1, fingerprint: 'f' }],
    questions: [{ key: 'a::q', requirement_id: 'a', question: 'Q?', options: [], why: '', depends_on: [] }],
    round: 2,
  })
  assert.equal(session.round, 2)
  const x = session.ledger.find((i) => i.id === 'ledger-x')
  assert.equal(x.source, 'OPTIMIZER_SUGGESTED', '伪造的 USER_EXPLICIT 必须被净化降级')
  assert.equal(x.status, 'PROVISIONAL')
  assert.deepEqual(findSessionViolations(session), [], '净化后不得有违规')
  console.log('✓ d12 会话净化:客户端回传的伪造来源被降级,不变量干净')
}

// 14. RC 风险 1:「你已确认」必须展示**用户答案语义**,问题名只作辅助 label
{
  const questions = [
    {
      key: 'w::q',
      requirement_id: 'w',
      question: '复用现有 workflow 还是创建?',
      options: [{ id: 'reuse', label: '调用已经存在的 workflow', value: 'REUSE' }],
      why: '',
      depends_on: [],
    },
  ]
  const resolved = resolveAnswers({
    raw_input: '我想用 dsh 控制 comfyui 生成视频',
    ledger: [entry('w', '复用现有 workflow 还是创建')],
    questions,
    answers: [{ key: 'w::q', option_id: 'reuse', text: '调用已经存在的 workflow' }],
  })
  const model = analysis({})
  const confirmation = buildConfirmation({
    analysis: model,
    ledger: resolved.ledger,
    raw_input: '我想用 dsh 控制 comfyui 生成视频',
  })
  assert.equal(confirmation.confirmed.length, 1)
  const item = confirmation.confirmed[0]
  assert.equal(item.text, '调用已经存在的 workflow', '★ 展示的必须是用户答案(value)')
  assert.equal(item.label, '复用现有 workflow 还是创建', '问题名只作辅助 label')
  assert.notEqual(item.text, item.label, 'value 不得等于问题名')
  assert.ok(!/还是|\?|？/.test(item.text), 'value 不得是问题句式')
  // resolvedValueOf 的三级取值
  assert.equal(resolvedValueOf({ text: 'Q?', evidence: ['A'] }), 'A', '优先逐字证据')
  assert.equal(resolvedValueOf({ text: 'Q?', note: '你选择了:X' }), 'X', '其次「你选择了:」')
  assert.equal(resolvedValueOf({ text: 'Q?' }), 'Q?', '最后回落条目文本')
  console.log('✓ d14 RC 风险 1:Confirmation 展示 resolved value(问题名仅辅助)')
}

console.log('discovery.test.mjs: ALL PASS')
