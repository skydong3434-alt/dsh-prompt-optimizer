/**
 * v2 Phase 1 —— Missing Resolution + Requirement Ledger 单测。
 *
 * 验证 v2 §C6 / §C8 的两条铁律:
 *   1. UNKNOWN ≠ ASK_USER:每个未决项必须归属 USER_REQUIRED / AGENT_DISCOVERABLE /
 *      OPTIONAL,只有「用户专属 + 高影响」才 blocking;拿不准一律不阻塞;
 *   2. 来源与状态分离:「按你的判断继续」只可产生 PROVISIONAL / CONDITIONAL /
 *      DEFERRED,**永不** CONFIRMED / USER_EXPLICIT;伪造的用户来源会被机械降级。
 *
 * 运行:先 `npm run build`,再 `node test/requirements.test.mjs`。
 */
import assert from 'node:assert/strict'
import {
  contentStableId,
  mechanicalRequirementClass,
  mechanicalImpact,
  classifyUnknown,
  classifyUnknowns,
  computeAnalysisGate,
  buildLedger,
  sanitizeLedger,
  hasBlindTrust,
  applyBlindTrust,
  findLedgerViolations,
} from '../lib/core/requirements.js'
import { makeProvenanceRecord } from '../lib/core/provenance.js'

// 1. 机械三分类:表驱动、保守
{
  assert.equal(mechanicalRequirementClass('预算范围'), 'USER_REQUIRED')
  assert.equal(mechanicalRequirementClass('目标受众是谁'), 'USER_REQUIRED')
  assert.equal(mechanicalRequirementClass('品牌调性'), 'USER_REQUIRED')
  assert.equal(mechanicalRequirementClass('截止时间'), 'USER_REQUIRED')
  assert.equal(mechanicalRequirementClass('现有实现的文件名与路径'), 'AGENT_DISCOVERABLE')
  assert.equal(mechanicalRequirementClass('依赖版本号'), 'AGENT_DISCOVERABLE')
  assert.equal(mechanicalRequirementClass('接口签名'), 'AGENT_DISCOVERABLE')
  assert.equal(mechanicalRequirementClass('可选:附带示例'), 'OPTIONAL')
  // 啥都不命中 → 默认「执行方自己确认」(不打扰用户)
  assert.equal(mechanicalRequirementClass('某个没说清的东西'), 'AGENT_DISCOVERABLE')
  console.log('✓ rq1 机械三分类表驱动 + 缺省不打扰用户')
}

// 2. 影响面判定
{
  assert.equal(mechanicalImpact('预算规模'), 'high')
  assert.equal(mechanicalImpact('输出格式'), 'high')
  assert.equal(mechanicalImpact('措辞与语气'), 'medium')
  assert.equal(mechanicalImpact('某个无关紧要的细节'), 'low')
  console.log('✓ rq2 影响面判定 high/medium/low')
}

// 3. blocking **必须由语义歧义显式支撑**(产品定位纠偏):
//    旧规则「用户专属 + 高影响 → 阻塞」已废除 —— 高影响不等于现在必须问。
{
  const notAmbiguous = classifyUnknown({ text: '预算范围', classification: 'USER_REQUIRED' })
  assert.equal(notAmbiguous.classification, 'USER_REQUIRED')
  assert.equal(notAmbiguous.blocking, false, '★ 新定义:高影响本身不得阻塞(需语义歧义)')

  const ambiguous = classifyUnknown({
    text: '「这个」指代不明',
    classification: 'USER_REQUIRED',
    semanticAmbiguity: true,
  })
  assert.equal(ambiguous.blocking, true, '★ 新定义:语义歧义才可阻塞')
  assert.equal(ambiguous.user_exclusive, true)
  assert.ok(ambiguous.question === undefined || typeof ambiguous.question === 'string')

  const blocking = ambiguous

  const vetoed = classifyUnknown({ text: '预算范围', classification: 'USER_REQUIRED', blocking: false })
  assert.equal(vetoed.blocking, false, '模型显式 blocking=false 必须被尊重')

  const lowImpact = classifyUnknown({ text: '署名怎么排', classification: 'USER_REQUIRED' })
  assert.equal(lowImpact.blocking, false, '低影响不得阻塞')

  // 机械判可自查时,模型的 USER_REQUIRED 被降级(不无谓追问)
  const downgraded = classifyUnknown({ text: '现有实现的文件名与路径', classification: 'USER_REQUIRED' })
  assert.equal(downgraded.classification, 'AGENT_DISCOVERABLE')
  assert.equal(downgraded.blocking, false)
  assert.ok(downgraded.rationale.includes('降级'), '降级必须留痕')

  // 机械判用户专属时,模型的降级不被采纳(有证据的特征保留)
  const kept = classifyUnknown({ text: '目标受众是谁', classification: 'AGENT_DISCOVERABLE' })
  assert.equal(kept.classification, 'USER_REQUIRED')
  assert.equal(kept.blocking, false, '★ 新定义:机械判用户专属也不再自动阻塞(需语义歧义)')
  assert.ok(kept.rationale.includes('保留'), '保留必须留痕')
  console.log('✓ rq3 blocking 单向收紧:仅语义歧义可阻塞;LLM 能否决 / 不能放大,降级有痕迹')
}

// 4. 批量分类:丢弃空文本、id 稳定
{
  const items = classifyUnknowns([{ text: '预算' }, { text: '   ' }, { text: '依赖版本' }])
  assert.equal(items.length, 2)
  // v2 Phase 3:id 由**内容**派生(跨轮次稳定),不再是数组下标 —— 否则 Discovery
  // 每轮重新分析都会让同一个决策换 id,台账与回答就对不上了。
  assert.equal(items[0].id, contentStableId('预算'))
  assert.equal(items[1].id, contentStableId('依赖版本'))
  assert.notEqual(items[0].id, items[1].id)
  assert.ok(items.every((i) => /^unknown-[0-9a-f]{8}$/.test(i.id)))
  console.log('✓ rq4 classifyUnknowns 稳定 id / 过滤空项')
}

// 5. 分析门:只有**语义歧义**导致的 blocking USER_REQUIRED 才阻断;KEEP 永不追问
{
  const blockingItem = classifyUnknown({
    text: '「这个」指代不明:无法从当前输入确定它指的是什么',
    classification: 'USER_REQUIRED',
    semanticAmbiguity: true,
  })
  const discoverableItem = classifyUnknown({ text: '现有实现的路径' })

  const blocked = computeAnalysisGate([blockingItem, discoverableItem], 'PATCH')
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.blocking_items.length, 1)
  assert.equal(blocked.discoverable_items.length, 1)
  assert.match(blocked.reason, /只有你本人能决定/)
  // 非歧义的高影响项(预算/范围)不再进入阻塞集合
  assert.equal(classifyUnknown({ text: '预算范围' }).blocking, false, '★ 新定义:预算不再自动阻塞')

  const notBlocked = computeAnalysisGate([discoverableItem], 'PATCH')
  assert.equal(notBlocked.blocked, false)
  assert.match(notBlocked.reason, /没有阻塞项/)

  const keptGate = computeAnalysisGate([blockingItem], 'KEEP')
  assert.equal(keptGate.blocked, false, 'KEEP 不追问(追问与「原样保留」自相矛盾)')
  assert.deepEqual(keptGate.blocking_items, [])
  assert.match(keptGate.reason, /KEEP/)
  console.log('✓ rq5 分析门:仅**语义歧义**可阻断 / KEEP 永不追问')
}

// 6. 台账:来源与状态分离
{
  const ledger = buildLedger({
    raw_input: '帮我做个小工具,预算 5000 以内',
    explicit: [makeProvenanceRecord({ text: '预算 5000 以内', source: 'USER_EXPLICIT', evidence: ['预算 5000 以内'], confidence: 'high' })],
    suggested: [makeProvenanceRecord({ text: '建议加个导出按钮', source: 'OPTIMIZER_SUGGESTED' })],
    resolution: [classifyUnknown({ text: '目标受众是谁' })],
  })
  const byId = (prefix) => ledger.filter((e) => e.id.startsWith(prefix))
  const explicit = byId('ledger-r-')[0]
  assert.equal(explicit.source, 'USER_EXPLICIT')
  assert.equal(explicit.status, 'CONFIRMED')
  assert.deepEqual(explicit.evidence, ['预算 5000 以内'])

  const suggested = ledger.find((e) => e.source === 'OPTIMIZER_SUGGESTED')
  assert.ok(suggested, '建议必须入台账')
  assert.equal(suggested.status, 'PROVISIONAL', '优化器建议绝不能是 CONFIRMED')

  const unknown = ledger.find((e) => e.id.startsWith('ledger-unknown-'))
  assert.equal(unknown.source, 'UNKNOWN', '未决项来源恒为 UNKNOWN')
  assert.equal(unknown.status, 'OPEN')

  assert.deepEqual(findLedgerViolations(ledger), [], '合法台账不得有违规')
  console.log('✓ rq6 台账来源/状态分离 + 不变量干净')
}

// 7. 台账净化:伪造的用户来源被降级(provenance 不回退)
{
  const raw = '帮我做个小工具'
  const contextTurns = [{ role: 'assistant', text: '预算大概是 5000 吧' }]
  const sanitized = sanitizeLedger(
    [
      // 证据根本不在输入里 → 降级
      { id: 'a', text: '预算 5000', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['预算 5000'], confidence: 'high' },
      // 证据只在助手发言里 → 不算用户
      { id: 'b', text: '预算是 5000', source: 'CONTEXT_EXPLICIT', status: 'CONFIRMED', evidence: ['预算大概是 5000 吧'], confidence: 'high' },
      // 合法证据 → 保留
      { id: 'c', text: '做个小工具', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['做个小工具'], confidence: 'high' },
    ],
    raw,
    contextTurns,
  )
  const a = sanitized.find((e) => e.id === 'a')
  assert.equal(a.source, 'OPTIMIZER_SUGGESTED', '无证据的 USER_EXPLICIT 必须降级')
  assert.equal(a.status, 'PROVISIONAL', '状态必须一并降级')
  assert.ok(a.note.includes('降级'))

  const b = sanitized.find((e) => e.id === 'b')
  assert.equal(b.source, 'OPTIMIZER_SUGGESTED', '仅助手发言不能作为用户证据')

  const c = sanitized.find((e) => e.id === 'c')
  assert.equal(c.source, 'USER_EXPLICIT')
  assert.equal(c.status, 'CONFIRMED')
  assert.deepEqual(findLedgerViolations(sanitized), [], '净化后必须无违规')
  console.log('✓ rq7 台账净化:伪造来源降级 / 助手发言不算用户证据')
}

// 8. 盲授权:「按你的判断继续」只降不升
{
  assert.equal(hasBlindTrust('按你的判断继续'), true)
  assert.equal(hasBlindTrust('你看着办'), true)
  assert.equal(hasBlindTrust('预算 5000,用 React'), false)

  const base = [
    { id: 'x', text: '目标受众', source: 'UNKNOWN', status: 'OPEN', evidence: [], confidence: 'low' },
    { id: 'y', text: '预算 5000', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['预算 5000'], confidence: 'high' },
  ]
  const applied = applyBlindTrust(base, '按你的判断继续')
  assert.equal(applied.find((e) => e.id === 'x').status, 'PROVISIONAL', 'OPEN → PROVISIONAL')
  assert.equal(applied.find((e) => e.id === 'y').status, 'CONFIRMED', '用户已确认的条目不得被改写')
  assert.equal(applied.find((e) => e.id === 'y').source, 'USER_EXPLICIT')
  assert.ok(!applied.some((e) => e.source === 'USER_EXPLICIT' && e.id === 'x'), '盲授权不得产生 USER_EXPLICIT')
  assert.ok(!applied.some((e) => e.id === 'x' && e.status === 'CONFIRMED'), '盲授权绝不能产生 CONFIRMED')

  const conditional = applyBlindTrust(base, '如果没有特别要求,按你的判断继续')
  assert.equal(conditional.find((e) => e.id === 'x').status, 'CONDITIONAL', '条件式授权 → CONDITIONAL')

  // 无授权话术 → 原样返回
  assert.deepEqual(applyBlindTrust(base, '帮我写个周报'), base)
  console.log('✓ rq8 盲授权只降不升(PROVISIONAL/CONDITIONAL,永不 CONFIRMED)')
}

// 9. 违规检测器本身有效(反向用例)
{
  const violations = findLedgerViolations([
    { id: 'v1', text: '没证据的要求', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: [], confidence: 'high' },
    { id: 'v2', text: '建议', source: 'OPTIMIZER_SUGGESTED', status: 'CONFIRMED', evidence: [], confidence: 'high' },
  ])
  assert.equal(violations.length, 2)
  assert.ok(violations.some((v) => v.includes('缺少逐字证据')))
  assert.ok(violations.some((v) => v.includes('不得为 CONFIRMED')))
  console.log('✓ rq9 findLedgerViolations 反向用例有效')
}

console.log('requirements.test.mjs: ALL PASS')
