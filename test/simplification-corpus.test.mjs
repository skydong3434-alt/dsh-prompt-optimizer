/**
 * 产品定位纠偏语料(T1–T15)—— deterministic,不调用真实模型。
 *
 * 验收的是**产品语义行为**(不是模型措辞):
 *   · 想法/意图型输入 → 不进入 Discovery(允许未知、不追问执行期信息)
 *   · 只有**语义歧义**(指代无先行词)才允许 1 个澄清问题
 *   · KEEP / PATCH / RESTRUCTURE / REBUILD 仍正常
 *   · Image / Video 仍走描述式契约;硬约束保留
 */
import assert from 'node:assert/strict'
import { detectSemanticAmbiguity, allowsBlockingQuestion } from '../lib/core/semantic-ambiguity.js'
import { parseAnalysisResult } from '../lib/core/analyze.js'
import { mechanicalTriage } from '../lib/core/triage.js'
import { classifyUnknown, decisionCategoryOfRequirement } from '../lib/core/requirements.js'

/** 用「模型什么都没说」的分析输出探测机械层行为(采样无关)。 */
const NEUTRAL_ANALYSIS = JSON.stringify({
  primary_intent: 'execution',
  supporting_intents: [],
  work_mode: 'one_shot',
  target: 'agent_task',
  edit_triage: 'REBUILD',
  triage_reasons: [],
  unknowns: [],
  requirements: [],
  suggestions: [],
  confidence_internal: 0.9,
  rationale: '',
  evidence_quotes: [],
  questions: [],
})

const gateOf = (text, contextTurns = []) =>
  parseAnalysisResult(NEUTRAL_ANALYSIS, { rawInput: text, contextTurns }).result.gate

const noBlocking = (label, text, ctx = []) => {
  const gate = gateOf(text, ctx)
  assert.equal(gate.blocked, false, `★ ${label}:不得进入 Discovery(想法型输入)`)
  assert.equal(gate.blocking_items.length, 0, `★ ${label}:阻塞项必须为 0`)
}

const mustAsk = (label, text, ctx = []) => {
  const gate = gateOf(text, ctx)
  assert.equal(gate.blocked, true, `★ ${label}:语义歧义必须追问`)
  assert.ok(gate.blocking_items.length >= 1, `★ ${label}:必须有阻塞项`)
  assert.match(gate.blocking_items[0].text, /指代不明/, `★ ${label}:阻塞原因必须是语义歧义`)
}

// ── T1:本轮最重要的验收样例 ────────────────────────────────────────────────
{
  const T1 = '我想用 dsh 控制 comfyui 生成视频。'
  noBlocking('T1', T1)
  assert.equal(allowsBlockingQuestion(T1), false, '★ T1:不得进入 Discovery')
  assert.equal(mechanicalTriage(T1).triage, 'REBUILD', 'T1:表达零散 → REBUILD(只重建表达)')
  // 决策类别不得成为阻塞来源
  const gate = gateOf(T1)
  assert.ok(
    gate.blocking_items.every((item) => decisionCategoryOfRequirement(item.text) === null),
    '★ T1:任何阻塞项都不得来自执行期取舍类别',
  )
  console.log('✓ T1 dsh→comfyui:不 Discovery、不阻塞、可 REBUILD')
}

// ── T2/T3:想法型输入不得因 vague_goal_scope 阻塞 ────────────────────────────
noBlocking('T2', '我想做一个 AI 知识库。')
noBlocking('T3', '我想做一个语言交换 App。')
console.log('✓ T2/T3 想法型输入:不因 vague_goal_scope 自动阻塞')

// ── T4:可行性/调研型(有上下文)不得因 analysis_vs_execution 阻塞 ─────────────
noBlocking('T4', '先看看能不能实现这个功能。', [{ role: 'user', text: '我在做一个 CSV 汇总工具' }])
console.log('✓ T4 可行性调研:不因 analysis_vs_execution 阻塞')

// ── T5:有上下文可确定;无上下文才是语义歧义 ────────────────────────────────
noBlocking('T5+ctx', '继续做这个项目。', [{ role: 'user', text: '我们在做爬虫项目' }])
mustAsk('T5 无ctx', '继续做这个项目。')
console.log('✓ T5 继续做这个项目:有上下文不问;无上下文问「哪个项目」')

// ── T6/T7:无对象/无先行词 → 恰好 1 个澄清问题 ──────────────────────────────
mustAsk('T6', '帮我把这个优化一下。')
mustAsk('T7', '把它改成第二种。')
{
  const t6 = detectSemanticAmbiguity('帮我把这个优化一下。')
  assert.equal(t6.length, 1, '★ T6:只应产生 1 个澄清问题(每轮最多 1 个)')
  console.log('✓ T6/T7 无对象指代:各 1 个语义澄清')
}

// ── T8:三条清单 → PATCH,不扩成模板 ─────────────────────────────────────────
{
  const T8 = '1. 先跑一遍测试\n2. 再看失败日志\n3. 输出 Markdown 表格'
  assert.equal(mechanicalTriage(T8).triage, 'PATCH', '★ T8:机械判 PATCH')
  noBlocking('T8', T8)
  console.log('✓ T8 三条清单:PATCH 且不阻塞')
}

// ── T9:硬约束保留(且 workspace 指代不算歧义) ──────────────────────────────
{
  const T9 = '只检查这个项目的问题,不修改任何文件。'
  noBlocking('T9', T9)
  assert.equal(allowsBlockingQuestion(T9), false, '★ T9:「这个项目」属可自查的环境指代,不追问')
  console.log('✓ T9 硬约束:保留约束且不追问')
}

// ── T10:完整成熟 Prompt → KEEP ─────────────────────────────────────────────
{
  // 与 release-blockers R13-E 同一份「已成熟成稿」fixture(机械判 KEEP)
  const T10 = [
    '你是一名资深后端工程师,请审查并重构订单服务模块。',
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
    '输出格式:先给出问题清单(含文件路径与行号),再给出改动后的代码。',
    '',
    '验收标准:',
    '- npm test 全绿;',
    '- 现有 API 契约测试全部通过。',
  ].join('\n')
  assert.equal(mechanicalTriage(T10).triage, 'KEEP', '★ T10:完整成稿 → KEEP')
  noBlocking('T10', T10)
  console.log('✓ T10 完整 Prompt:KEEP 且不阻塞')
}

// ── T11/T12:Image / Video 不套 Agent 任务模板(由策略契约保证) ──────────────
{
  const { defaultStrategyRegistry } = await import('../lib/core/registry.js')
  const image = defaultStrategyRegistry.get('image')
  const video = defaultStrategyRegistry.get('video')
  assert.ok(image && video, 'Image / Video 策略必须存在')
  assert.equal(
    /Goal|Definition of Done|Verification/.test(String(image.system ?? '')),
    false,
    '★ T11:Image 契约不得出现 Goal/DoD/Verification',
  )
  assert.equal(
    /Goal|Definition of Done|Verification/.test(String(video.system ?? '')),
    false,
    '★ T12:Video 契约不得出现 Goal/DoD/Verification',
  )
  console.log('✓ T11/T12 Image/Video:描述式契约,无 Agent 任务模板')
}

// ── T13:有上下文的执行请求 → 不追问可自查信息 ──────────────────────────────
{
  const T13 = '根据上面的方案,现在开始实现。'
  noBlocking('T13', T13, [{ role: 'user', text: '方案:先做 CLI,再补 Web' }])
  for (const fact of ['项目路径', '依赖版本', '当前实现', '测试命令']) {
    assert.equal(
      classifyUnknown({ text: fact, classification: 'USER_REQUIRED' }).blocking,
      false,
      `★ T13:可自查项「${fact}」不得阻塞`,
    )
  }
  console.log('✓ T13 执行请求:不追问可自查信息')
}

// ── T14:旧/新指代不明 → 必须问 ─────────────────────────────────────────────
mustAsk('T14', '删除旧版本然后安装新的。')
console.log('✓ T14 旧版本/新的:指代不明 → 必须问')

// ── T15:有指代但上下文明确 → 不问;无上下文 → 只问「指哪些」 ────────────────
{
  const T15 = '我想让 Agent 自动处理这些任务。'
  noBlocking('T15+ctx', T15, [{ role: 'user', text: '任务有:抓取、清洗、入库' }])
  mustAsk('T15 无ctx', T15)
  const q = detectSemanticAmbiguity(T15)[0]
  assert.match(q.text, /这些|指代不明/, '★ T15:只问「这些任务指哪些」')
  console.log('✓ T15 这些任务:有上下文不问;无上下文只问指代')
}

// ── 执行期取舍类别不得成为阻塞来源(§二十六) ────────────────────────────────
{
  const tradeoffs = [
    '先做 MVP 还是一步到位',
    '复用现有 workflow 还是新建',
    '保持现有架构还是允许重构',
    '先验证还是直接做完',
    '单机自用还是多人协作',
  ]
  let recognized = 0
  for (const text of tradeoffs) {
    assert.equal(
      classifyUnknown({ text }).blocking,
      false,
      `★ 执行期取舍「${text}」不得阻塞`,
    )
    if (decisionCategoryOfRequirement(text) !== null) recognized += 1
  }
  assert.ok(recognized >= 3, `决策类别仍应可识别(用于诊断);实际识别 ${recognized}/${tradeoffs.length}`)
  console.log('✓ §二十六 执行期取舍:仍识别类别,但一律不阻塞')
}

console.log('simplification-corpus.test.mjs: ALL PASS')
