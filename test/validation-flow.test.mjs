/**
 * v2 Phase 4 —— Validator 回流控制器单测。
 *
 * 覆盖验收矩阵里的机械部分:
 *   伪造 USER_EXPLICIT → RETURN_TO_MISSING_RESOLUTION(provenance 降级)
 *   silent assumption  → RETURN_TO_MISSING_RESOLUTION(disposition 修正)
 *   AGENT_DISCOVERABLE 被写成用户待提供 → RETURN_TO_MISSING_RESOLUTION(不问用户)
 *   错误 Target Engine assumption → RETURN_TO_ANALYSIS
 *   Image/Video 任务模板标题 → RETURN_TO_MISSING_RESOLUTION
 *   KEEP 被改写 → HARD_ERROR
 *   blocking USER_REQUIRED → RETURN_TO_DISCOVERY
 *   回流有界:同 reason_code 不重复循环 / 总次数上限
 *   正常产物 → PASS
 *
 * 运行:先 `npm run build`,再 `node test/validation-flow.test.mjs`。
 */
import assert from 'node:assert/strict'
import {
  ACTION_SEVERITY,
  VALIDATION_REASON,
  VALIDATION_RETURN_LIMIT,
  decideValidationAction,
  describeValidationOutcome,
  isHardFailure,
} from '../lib/core/validation-flow.js'

const result = (optimized = '## Request\n- ok') => ({ optimized_prompt: optimized })
const problem = (rule, detail = 'd') => ({ severity: 'error', rule, detail })

const decide = (overrides = {}) =>
  decideValidationAction({
    problems: [],
    result: result(),
    rawInput: '帮我做一件事',
    returns: [],
    round: 1,
    liveBlockingCount: 0,
    keepExpected: false,
    ...overrides,
  })

// 1. 正常产物 → PASS
{
  const outcome = decide()
  assert.equal(outcome.action, 'PASS')
  assert.equal(outcome.reason_code, undefined)
  assert.deepEqual(outcome.returns, [])
  console.log('✓ vf1 无问题 → PASS')
}

// 2. 伪造 USER_EXPLICIT → 回流 + provenance 降级
{
  const outcome = decide({
    problems: [problem('PROVENANCE_EVIDENCE_NOT_IN_RAW', '[r-1] evidence 未在 raw_input 中逐字出现')],
  })
  assert.equal(outcome.action, 'RETURN_TO_MISSING_RESOLUTION')
  assert.equal(outcome.reason_code, VALIDATION_REASON.fabricatedUserExplicit)
  assert.equal(outcome.requires, 'provenance_downgrade')
  assert.equal(outcome.returns.length, 1, '必须记录回流(有界)')
  assert.equal(outcome.returns[0].reason_code, outcome.reason_code)
  console.log('✓ vf2 伪造 USER_EXPLICIT → 回流 + provenance 降级')
}

// 3. 静默假设(无证据强断言 / 量化)→ 回流 + disposition 修正
{
  for (const rule of ['VALIDATION_UNPROVEN_STRONG_CLAIM', 'VALIDATION_UNEVIDENCED_QUANTIFICATION']) {
    const outcome = decide({ problems: [problem(rule)] })
    assert.equal(outcome.action, 'RETURN_TO_MISSING_RESOLUTION')
    assert.equal(outcome.reason_code, VALIDATION_REASON.silentAssumption)
    assert.equal(outcome.requires, 'disposition_fix')
  }
  console.log('✓ vf3 静默假设 → 回流 + disposition 修正')
}

// 4. AGENT_DISCOVERABLE 被写成用户待提供(面向用户追问)→ 回流,且**不问用户**
{
  const outcome = decide({ problems: [problem('VALIDATION_USER_FACING_QUESTION', '请先回答预算')] })
  assert.equal(outcome.action, 'RETURN_TO_MISSING_RESOLUTION')
  assert.equal(outcome.reason_code, VALIDATION_REASON.userFacingQuestion)
  assert.equal(outcome.requires, 'disposition_fix')
  assert.notEqual(outcome.action, 'RETURN_TO_DISCOVERY', '★ 可自查项不得变成问用户')
  console.log('✓ vf4 可自查项被写成追问 → 回流修正(不问用户)')
}

// 5. 已退役占位符 → 回流修正
{
  const outcome = decide({ problems: [problem('VALIDATION_RETIRED_PLACEHOLDER')] })
  assert.equal(outcome.reason_code, VALIDATION_REASON.retiredPlaceholder)
  assert.equal(outcome.requires, 'disposition_fix')
  console.log('✓ vf5 [待补充:] 残留 → 回流修正')
}

// 6. 图像/视频出现任务模板标题 → 回流修正
{
  const outcome = decide({
    problems: [problem('visual-no-task-template', '出现了任务模板标题:Goal')],
    visualContract: true,
  })
  assert.equal(outcome.action, 'RETURN_TO_MISSING_RESOLUTION')
  assert.equal(outcome.reason_code, VALIDATION_REASON.taskTemplateInVisual)
  console.log('✓ vf6 视觉契约出现 Goal/Phase/Task → 回流修正')
}

// 7. 错误的 Target Engine 假定 → 回到分析
{
  const outcome = decide({ targetAssumed: true })
  assert.equal(outcome.action, 'RETURN_TO_ANALYSIS')
  assert.equal(outcome.reason_code, VALIDATION_REASON.targetAssumption)
  assert.equal(outcome.requires, 'reanalysis')
  console.log('✓ vf7 引擎假定错误 → RETURN_TO_ANALYSIS')
}

// 8. 仍有阻塞性用户决定 → 回到 Discovery(且优先级最高)
{
  const outcome = decide({ liveBlockingCount: 2, problems: [problem('VALIDATION_UNPROVEN_STRONG_CLAIM')] })
  assert.equal(outcome.action, 'RETURN_TO_DISCOVERY', '阻塞决定优先于其它问题')
  assert.equal(outcome.reason_code, VALIDATION_REASON.blockingNotResolved)
  assert.equal(outcome.requires, 'discovery')
  assert.match(outcome.detail, /只有你能决定/)
  console.log('✓ vf8 阻塞用户决定 → RETURN_TO_DISCOVERY(优先级最高)')
}

// 9. KEEP 被改写 → HARD_ERROR(不可恢复的硬承诺破坏)
{
  const outcome = decide({
    keepExpected: true,
    rawInput: '原始提示词',
    result: result('被改写的提示词'),
  })
  assert.equal(outcome.action, 'HARD_ERROR')
  assert.equal(outcome.reason_code, VALIDATION_REASON.keepRewritten)
  assert.equal(isHardFailure(outcome.action), true)
  console.log('✓ vf9 KEEP 被改写 → HARD_ERROR')
}

// 10. 未映射的完整性 error(缺必出段落)→ 交付并警示(PASS),不回流
{
  const outcome = decide({ problems: [problem('VALIDATION_REQUIRED_SECTION_MISSING', '缺段落')] })
  assert.equal(outcome.action, 'PASS', '完整性缺陷回流解决不了,应交付 + provenance_ok=false 警示')
  assert.deepEqual(outcome.returns, [], '不得消耗回流预算')
  console.log('✓ vf10 未映射完整性缺陷 → 交付并警示(不回流)')
}

// 11. 有界性:同 reason_code 不得反复触发同一循环
{
  const first = decide({ problems: [problem('PROVENANCE_EVIDENCE_NOT_IN_RAW')] })
  assert.equal(first.action, 'RETURN_TO_MISSING_RESOLUTION')
  const second = decide({
    problems: [problem('PROVENANCE_EVIDENCE_NOT_IN_RAW')],
    returns: first.returns,
  })
  assert.equal(second.action, 'HARD_ERROR', '★ 同一失败第二次即升级为硬错误')
  assert.equal(second.reason_code, VALIDATION_REASON.repeatedFailure)
  assert.match(second.detail, /回流无法修复/)
  console.log('✓ vf11 同一失败重复 → HARD_ERROR(不无限循环)')
}

// 12. 有界性:回流总次数上限
{
  const returns = [
    { reason_code: VALIDATION_REASON.fabricatedUserExplicit, action: 'RETURN_TO_MISSING_RESOLUTION', round: 1 },
    { reason_code: VALIDATION_REASON.silentAssumption, action: 'RETURN_TO_MISSING_RESOLUTION', round: 2 },
  ]
  assert.equal(returns.length, VALIDATION_RETURN_LIMIT, 'fixture 必须正好用满预算')
  const outcome = decide({ problems: [problem('VALIDATION_USER_FACING_QUESTION')], returns })
  assert.equal(outcome.action, 'HARD_ERROR')
  assert.equal(outcome.reason_code, VALIDATION_REASON.returnBudgetExhausted)
  assert.match(outcome.detail, /上限/)
  console.log('✓ vf12 回流次数上限 → HARD_ERROR')
}

// 13. 严重度表与审计描述
{
  assert.ok(ACTION_SEVERITY.RETURN_TO_DISCOVERY > ACTION_SEVERITY.RETURN_TO_MISSING_RESOLUTION)
  assert.ok(ACTION_SEVERITY.RETURN_TO_ANALYSIS > ACTION_SEVERITY.RETURN_TO_DISCOVERY)
  assert.ok(ACTION_SEVERITY.HARD_ERROR > ACTION_SEVERITY.RETURN_TO_ANALYSIS)
  assert.equal(ACTION_SEVERITY.PASS, 0)
  assert.equal(describeValidationOutcome({ action: 'PASS', detail: '', returns: [] }), 'PASS')
  assert.match(
    describeValidationOutcome({
      action: 'RETURN_TO_DISCOVERY',
      reason_code: VALIDATION_REASON.blockingNotResolved,
      detail: '',
      returns: [],
    }),
    /RETURN_TO_DISCOVERY\(VF_BLOCKING_NOT_RESOLVED\)/,
  )
  console.log('✓ vf13 严重度单调 + 审计描述')
}

// 14. 多问题取最严重动作
{
  const outcome = decide({
    problems: [problem('VALIDATION_UNPROVEN_STRONG_CLAIM'), problem('TARGET_ENGINE_CONFLICT')],
  })
  assert.equal(outcome.action, 'RETURN_TO_ANALYSIS', '多问题取严重度更高的动作')
  console.log('✓ vf14 多问题取最严重动作')
}

console.log('validation-flow.test.mjs: ALL PASS')
