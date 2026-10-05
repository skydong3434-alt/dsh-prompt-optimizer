/**
 * v2 Phase 1 —— Edit Triage(KEEP/PATCH/RESTRUCTURE/REBUILD)单测。
 *
 * 验证 v2 §C4 的三条产品承诺:
 *   1. KEEP 必须双方一致,且机械安全阈值达标 —— 绝不误承诺「不改写」;
 *   2. REBUILD 必须机械判据同意 —— 模型无权重写用户的长成稿;
 *   3. 其余情况向更轻的一侧倒(拿不准就 PATCH)。
 *
 * 运行:先 `npm run build`,再 `node test/triage.test.mjs`。
 */
import assert from 'node:assert/strict'
import {
  analyzeInputSignals,
  mechanicalTriage,
  mergeTriage,
  decideTriage,
  triageNeedsModel,
  KEEP_MIN_LENGTH,
} from '../lib/core/triage.js'
import { TRIAGE_SEVERITY, EDIT_TRIAGE_LEVELS } from '../lib/core/types.js'

/** 一份「已完备的 agent prompt」:结构 + 约束 + 格式 + 验收,长度超过 KEEP 阈值。 */
const COMPLETE_PROMPT = [
  '你是一名资深后端工程师,请审查并重构下面这个订单服务模块。',
  '',
  '要求:',
  '1. 保持对外 HTTP 接口签名完全不变,不得改动任何路由路径。',
  '2. 数据库迁移必须可回滚,禁止在迁移里删除字段。',
  '3. 所有新增逻辑必须带单元测试,覆盖率不低于 80%。',
  '',
  '约束:',
  '- 仅限修改 src/order 目录下的文件,不要动其他模块。',
  '- 依赖版本不得升级。',
  '',
  '输出格式:先给出问题清单(每条含文件路径与行号),再给出改动后的代码。',
  '',
  '验收标准:',
  '- npm test 全绿;',
  '- 现有 API 契约测试全部通过;',
  '- 迁移脚本在空库与有数据两种情况下都能跑通。',
].join('\n')

/** 「乱但完整」:信息齐(有约束 + 有格式),但一坨长段落、还有重复句。 */
const MESSY_BUT_COMPLETE = [
  '帮我做个小工具,要求是能读 csv 然后汇总,输出格式要 markdown 表格,输出格式要 markdown 表格,',
  '另外要快一点别卡,另外要快一点别卡,字段要能自动识别,字段要能自动识别,不用装数据库,不用装数据库,',
  '最好支持中文列名,最好支持中文列名,跑完给个总数,跑完给个总数,别的先不用管,别的先不用管,',
  '反正你看着实现就行,反正你看着实现就行,记得加一点错误提示,记得加一点错误提示。',
].join(' ')

// 1. 信号抽取:确定性、可复现
{
  const signals = analyzeInputSignals(COMPLETE_PROMPT)
  assert.ok(signals.length >= KEEP_MIN_LENGTH)
  assert.equal(signals.actionable, true)
  assert.equal(signals.role, true)
  assert.equal(signals.constraint, true)
  assert.equal(signals.format, true)
  assert.equal(signals.acceptance, true)
  assert.ok(signals.structures.includes('numbered-list'))
  assert.deepEqual(analyzeInputSignals(COMPLETE_PROMPT), signals, '同一输入两次必须得到同一信号')
  console.log('✓ tr1 机械信号抽取(结构/角色/约束/格式/验收)可复现')
}

// 2. 已完备成稿 → 机械 KEEP,且 keep_safe=true
{
  const decision = mechanicalTriage(COMPLETE_PROMPT)
  assert.equal(decision.triage, 'KEEP')
  assert.equal(decision.keep_safe, true)
  assert.ok(decision.reasons.length > 0, 'KEEP 必须给出理由')
  assert.equal(triageNeedsModel('KEEP'), false, 'KEEP 不得调用模型改写')
  console.log('✓ tr2 完备成稿 → 机械 KEEP(keep_safe)')
}

// 3. KEEP 必须双方一致:模型说 KEEP 但机械不认 → 降级 PATCH
{
  const short = '帮我写个周报总结,要 300 字以内,输出 markdown。'
  const mechanical = mechanicalTriage(short)
  assert.notEqual(mechanical.triage, 'KEEP', '短输入机械判据不得 KEEP')
  const merged = mergeTriage(mechanical, 'KEEP', ['看起来不错'])
  assert.equal(merged.triage, 'PATCH')
  assert.equal(merged.keep_safe, false)
  assert.ok(merged.reasons.some((r) => r.includes('降级')), '必须记录降级理由')
  console.log('✓ tr3 KEEP 需双方一致,否则降级 PATCH')
}

// 4. 机械 + 模型都判 KEEP → KEEP,keep_safe 保持
{
  const merged = mergeTriage(mechanicalTriage(COMPLETE_PROMPT), 'KEEP')
  assert.equal(merged.triage, 'KEEP')
  assert.equal(merged.keep_safe, true)
  assert.equal(merged.llm_advised, true)
  assert.equal(merged.mechanical, 'KEEP')
  assert.equal(merged.llm_suggestion, 'KEEP')
  console.log('✓ tr4 双方一致 → KEEP')
}

// 5. 模型想 REBUILD 但机械不认 → 降级 RESTRUCTURE(无权重写成稿)
{
  const merged = mergeTriage(mechanicalTriage(MESSY_BUT_COMPLETE), 'REBUILD', ['太乱了'])
  assert.equal(merged.mechanical, 'RESTRUCTURE')
  assert.equal(merged.triage, 'RESTRUCTURE')
  assert.ok(merged.reasons.some((r) => r.includes('REBUILD')), '必须记录 REBUILD 降级理由')
  console.log('✓ tr5 模型 REBUILD 无机械依据 → RESTRUCTURE')
}

// 6. 乱但完整 → RESTRUCTURE(只重组,不加语义)
{
  const decision = mechanicalTriage(MESSY_BUT_COMPLETE)
  assert.equal(decision.triage, 'RESTRUCTURE')
  assert.equal(decision.keep_safe, false)
  assert.equal(triageNeedsModel('RESTRUCTURE'), true)
  console.log('✓ tr6 乱但完整 → RESTRUCTURE')
}

// 7. PATCH 的正式语义(Phase 4 修正):必须有**可保留的东西**
//    —— 已有提示词结构,或已给出成稿要素(约束 / 格式 / 角色 / 验收)。
//    只有模糊目标(什么都没有)属于 REBUILD,不是「局部修改」。
{
  for (const text of [
    '帮我写个周报总结,要 300 字以内,输出 markdown。', // 约束 + 格式 → 可保留
    '你是一名工程师。要求:接口不变。输出格式:清单。验收:测试全绿。', // 角色 + 约束 + 格式 + 验收
    '1. 先跑测试\n2. 再看日志', // 已有结构
  ]) {
    const decision = mechanicalTriage(text)
    assert.equal(decision.triage, 'PATCH', `「${text}」应为 PATCH,实为 ${decision.triage}`)
    assert.equal(decision.keep_safe, false)
  }
  // 只有模糊目标 → REBUILD(无从「局部修改」)
  for (const text of [
    '这段 Python 报错了,帮我看看哪里有问题',
    '帮我研究一下 Mac 上怎么做 AI 视频',
    '我想用 dsh 控制 comfyui 生成视频。',
    '帮我画一张赛博朋克城市夜景海报',
  ]) {
    const decision = mechanicalTriage(text)
    assert.equal(decision.triage, 'REBUILD', `「${text}」只有模糊目标 → 应为 REBUILD,实为 ${decision.triage}`)
    assert.equal(decision.keep_safe, false)
  }
  console.log('✓ tr7 PATCH = 有可保留内容;模糊目标 → REBUILD')
}

// 8. 无法构成任务 → REBUILD(空 / 寒暄 / 过短无动词)
{
  for (const text of ['', '   ', '你好', 'hello!', '谢谢', '嗯', '?', '。。。', 'test']) {
    const decision = mechanicalTriage(text)
    assert.equal(decision.triage, 'REBUILD', `「${text}」应为 REBUILD,实为 ${decision.triage}`)
    assert.equal(decision.keep_safe, false)
  }
  // 有动词但没有任何可保留内容(3 个字的「帮我做」)→ 仍是 REBUILD
  assert.equal(mechanicalTriage('帮我做').triage, 'REBUILD')
  console.log('✓ tr8 空/寒暄/无可保留内容 → REBUILD')
}

// 9. 合并规则:严重度取大 / 模型未给建议则纯机械
{
  assert.equal(mergeTriage(mechanicalTriage('帮我写个周报,要 300 字以内,输出 markdown。'), undefined).llm_advised, undefined)
  const upgraded = mergeTriage(mechanicalTriage('帮我写个周报,要 300 字以内,输出 markdown。'), 'RESTRUCTURE')
  assert.equal(upgraded.triage, 'RESTRUCTURE', '取严重度较大者(PATCH → RESTRUCTURE)')
  const mech = mechanicalTriage(COMPLETE_PROMPT)
  assert.equal(mergeTriage(mech, 'bogus-value').triage, mech.triage, '非法建议必须被忽略')
  // 严重度表单调且覆盖全部枚举
  const severities = EDIT_TRIAGE_LEVELS.map((l) => TRIAGE_SEVERITY[l])
  assert.deepEqual([...severities].sort((a, b) => a - b), severities, '严重度必须单调递增')
  console.log('✓ tr9 合并规则:取大 / 非法建议忽略 / 严重度单调')
}

// 10. decideTriage 入口:不传建议 = 纯机械
{
  const decision = decideTriage({ raw_input: COMPLETE_PROMPT })
  assert.equal(decision.triage, 'KEEP')
  assert.equal(decision.llm_advised, undefined)
  assert.deepEqual(decision.signals, mechanicalTriage(COMPLETE_PROMPT).signals)
  console.log('✓ tr10 decideTriage 缺省 = 纯机械')
}

console.log('triage.test.mjs: ALL PASS')
