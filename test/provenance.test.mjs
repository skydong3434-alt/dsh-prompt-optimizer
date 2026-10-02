/**
 * provenance.ts 机械校验器单元测试(断言矩阵)。
 *
 * 运行:先 `npm run build`,再 `node test/provenance.test.mjs`。
 * 覆盖:五源判定 / quote 字面比对 / 空白与引号变体 / 大小写保守 / 整组校验 / 记录工厂。
 */
import assert from 'node:assert/strict'
import {
  PROVENANCE_RULE,
  makeProvenanceRecord,
  normalizeQuoteText,
  resolveQuoteSource,
  validateProvenance,
} from '../lib/core/provenance.js'

const assistantTurns = (text) => [{ role: 'assistant', text }]
const userTurns = (text) => [{ role: 'user', text }]
const rulesOf = (result) => result.problems.map((p) => p.rule)

// 1. normalizeQuoteText:折叠空白 / trim / 剥离首尾引号与句读;不做大小写折叠
{
  assert.equal(normalizeQuoteText('  hello   world  '), 'hello world')
  assert.equal(normalizeQuoteText('a\n\tb'), 'a b')
  assert.equal(normalizeQuoteText("'“ComfyUI”。'"), 'ComfyUI')
  assert.equal(normalizeQuoteText('“ComfyUI”'), 'ComfyUI')
  assert.equal(normalizeQuoteText('  。！？  '), '')
  assert.equal(normalizeQuoteText('ComfyUI'), 'ComfyUI', 'normalize 不得折叠大小写')
  console.log('✓ pv1 normalizeQuoteText 空白/引号/句读/大小写')
}

// 2. quote 逐字存在于 raw_input → USER_EXPLICIT / valid / raw / high
{
  const r = resolveQuoteSource('ComfyUI', '帮我用 ComfyUI 做 AI 视频', [])
  assert.equal(r.valid, true)
  assert.equal(r.matchedIn, 'raw')
  assert.equal(r.source, 'USER_EXPLICIT')
  assert.equal(r.confidence, 'high')
  console.log('✓ pv2 raw 命中 → USER_EXPLICIT')
}

// 3. quote 存在于 context user 消息 → CONTEXT_EXPLICIT / valid / context-user
{
  const r = resolveQuoteSource('32GB 内存', '继续说', userTurns('我的机器是 Mac M1 Pro 32GB 内存'))
  assert.equal(r.valid, true)
  assert.equal(r.matchedIn, 'context-user')
  assert.equal(r.source, 'CONTEXT_EXPLICIT')
  assert.equal(r.confidence, 'high')
  console.log('✓ pv3 context user 命中 → CONTEXT_EXPLICIT')
}

// 4. quote 仅存在于 assistant 消息 → invalid / assistant-only / UNKNOWN;raw 优先于 context
{
  const r = resolveQuoteSource('使用 ComfyUI', '帮我研究方案', assistantTurns('建议你使用 ComfyUI 做视频'))
  assert.equal(r.valid, false)
  assert.equal(r.matchedIn, 'assistant-only')
  assert.equal(r.source, 'UNKNOWN')
  // raw 优先:同一 quote 同时出现在 raw 与 assistant 时,仍判 raw(用户本轮输入优先)
  const both = resolveQuoteSource(
    '使用 ComfyUI',
    '我打算使用 ComfyUI',
    assistantTurns('建议你使用 ComfyUI 做视频'),
  )
  assert.equal(both.matchedIn, 'raw')
  assert.equal(both.source, 'USER_EXPLICIT')
  console.log('✓ pv4 仅助手命中 → invalid;raw 优先')
}

// 5. quote 完全不存在 → invalid / none / UNKNOWN / low
{
  const r = resolveQuoteSource('完全不存在的一句话', '帮我研究方案', assistantTurns('另一种说法'))
  assert.equal(r.valid, false)
  assert.equal(r.matchedIn, 'none')
  assert.equal(r.source, 'UNKNOWN')
  assert.equal(r.confidence, 'low')
  console.log('✓ pv5 不存在 → none')
}

// 6. 空白变体(多余空格 / 换行 / tab)→ normalize 后匹配
{
  const r = resolveQuoteSource('ComfyUI 做\n视频', '帮我用   ComfyUI\t做 视频', [])
  assert.equal(r.valid, true)
  assert.equal(r.matchedIn, 'raw')
  console.log('✓ pv6 空白变体匹配')
}

// 7. 首尾引号与句读包裹 → normalize 后匹配
{
  const r = resolveQuoteSource('“ComfyUI 低显存”。', '请研究 ComfyUI 低显存 方案', [])
  assert.equal(r.valid, true)
  assert.equal(r.matchedIn, 'raw')
  console.log('✓ pv7 引号/句读包裹匹配')
}

// 8. 英文大小写变体 → 不匹配(保守原则,不做大小写折叠)
{
  const r = resolveQuoteSource('COMFYUI', 'please study comfyui workflow', [])
  assert.equal(r.valid, false)
  assert.equal(r.matchedIn, 'none')
  console.log('✓ pv8 大小写变体不匹配(保守)')
}

// 9. validateProvenance:explicit 记录 quote 在 raw → ok=true,无 issue
{
  const rec = makeProvenanceRecord({
    text: '使用 ComfyUI 生成视频',
    source: 'USER_EXPLICIT',
    evidence: ['ComfyUI'],
  })
  const res = validateProvenance([rec], '帮我用 ComfyUI 做视频', [])
  assert.equal(res.ok, true)
  assert.equal(res.problems.length, 0)
  console.log('✓ pv9 explicit 证据在 raw → ok')
}

// 10. explicit 记录 evidence 为空 → error + ok=false
{
  const rec = makeProvenanceRecord({ text: '某要求', source: 'USER_EXPLICIT', evidence: [] })
  const res = validateProvenance([rec], '随便输入', [])
  assert.equal(res.ok, false)
  assert.deepEqual(rulesOf(res), [PROVENANCE_RULE.missingEvidence])
  assert.equal(res.problems[0].severity, 'error')
  assert.match(res.problems[0].detail, new RegExp(rec.id))
  console.log('✓ pv10 explicit 空证据 → error')
}

// 11. quote 完全不存在 + explicit 记录 → error(evidenceNotInRaw)
{
  const rec = makeProvenanceRecord({
    text: '某要求',
    source: 'USER_EXPLICIT',
    evidence: ['不在任何地方的话'],
  })
  const res = validateProvenance([rec], '帮我研究方案', [])
  assert.equal(res.ok, false)
  assert.deepEqual(rulesOf(res), [PROVENANCE_RULE.evidenceNotInRaw])
  console.log('✓ pv11 explicit 证据不存在 → error')
}

// 12. quote 仅存在于 assistant 消息 + explicit 记录 → 仅 warn,不产生 error,ok=true
{
  const rec = makeProvenanceRecord({
    text: '使用 ComfyUI 生成视频',
    source: 'USER_EXPLICIT',
    evidence: ['使用 ComfyUI'],
  })
  const res = validateProvenance(
    [rec],
    '帮我研究做 AI 视频的路线',
    assistantTurns('建议你使用 ComfyUI 做视频'),
  )
  assert.equal(res.ok, true, 'assistant-only 只告警,不应把 ok 判 false')
  assert.deepEqual(rulesOf(res), [PROVENANCE_RULE.assistantOnlyEvidence])
  assert.equal(res.problems[0].severity, 'warn')
  console.log('✓ pv12 仅助手证据 → warn 且 ok=true')
}

// 13. context-explicit 记录 quote 在 context user → ok;在 raw(非 context)→ error
{
  const ctxRec = makeProvenanceRecord({
    text: '机器为 32GB 内存',
    source: 'CONTEXT_EXPLICIT',
    evidence: ['32GB 内存'],
  })
  const ctxRes = validateProvenance([ctxRec], '继续', userTurns('我的机器是 Mac M1 Pro 32GB 内存'))
  assert.equal(ctxRes.ok, true)

  const mislabeled = makeProvenanceRecord({
    text: '机器为 32GB 内存',
    source: 'CONTEXT_EXPLICIT',
    evidence: ['32GB 内存'],
  })
  const mislabeledRes = validateProvenance([mislabeled], '我的机器是 32GB 内存', [])
  assert.equal(mislabeledRes.ok, false)
  assert.deepEqual(rulesOf(mislabeledRes), [PROVENANCE_RULE.evidenceNotInContext])
  console.log('✓ pv13 context-explicit 需 context 证据')
}

// 14. context-explicit 证据仅出现在 assistant → warn,不 error
{
  const rec = makeProvenanceRecord({
    text: '使用低显存方案',
    source: 'CONTEXT_EXPLICIT',
    evidence: ['低显存方案'],
  })
  const res = validateProvenance([rec], '继续', assistantTurns('可以试试低显存方案'))
  assert.equal(res.ok, true)
  assert.deepEqual(rulesOf(res), [PROVENANCE_RULE.assistantOnlyEvidence])
  console.log('✓ pv14 context-explicit 仅助手证据 → warn')
}

// 15. suggested 记录无 evidence → 完全豁免,无 issue,ok=true
{
  const rec = makeProvenanceRecord({
    text: '建议补充输出格式',
    source: 'OPTIMIZER_SUGGESTED',
  })
  const res = validateProvenance([rec], '帮我研究方案', [])
  assert.equal(res.ok, true)
  assert.equal(res.problems.length, 0)
  assert.deepEqual(rec.evidence, [], 'evidence 缺省应为空数组')
  console.log('✓ pv15 suggested 无证据 → 豁免')
}

// 16. unknown 记录无 evidence → 豁免
{
  const rec = makeProvenanceRecord({ text: '未确定的预算', source: 'UNKNOWN', note: '证据不足' })
  const res = validateProvenance([rec], '帮我研究方案', [])
  assert.equal(res.ok, true)
  assert.equal(res.problems.length, 0)
  console.log('✓ pv16 unknown 无证据 → 豁免')
}

// 17. workspace_fact 无 evidence → 豁免;有但无法验证 → 仅 warn,ok 不变
{
  const noEvidence = makeProvenanceRecord({ text: 'workspace 名为 demo', source: 'WORKSPACE_FACT' })
  const okRes = validateProvenance([noEvidence], '随便', [])
  assert.equal(okRes.ok, true)
  assert.equal(okRes.problems.length, 0)

  const withEvidence = makeProvenanceRecord({
    text: 'workspace 名为 demo',
    source: 'WORKSPACE_FACT',
    evidence: ['demo'],
  })
  const warnRes = validateProvenance([withEvidence], '随便', [])
  assert.equal(warnRes.ok, true, 'workspace_fact 证据不可验证只告警')
  assert.deepEqual(rulesOf(warnRes), [PROVENANCE_RULE.workspaceEvidenceUnverified])
  assert.equal(warnRes.problems[0].severity, 'warn')
  console.log('✓ pv17 workspace_fact 空证据豁免 / 不可验证仅 warn')
}

// 18. makeProvenanceRecord:默认 confidence 'medium'、稳定唯一 id、evidence 拷贝隔离、note 透传
{
  const a = makeProvenanceRecord({ text: 'A', source: 'UNKNOWN' })
  const b = makeProvenanceRecord({ text: 'B', source: 'UNKNOWN' })
  assert.equal(a.confidence, 'medium')
  assert.match(a.id, /^r-\d+$/)
  assert.notEqual(a.id, b.id, 'id 必须唯一')
  assert.equal(a.id, a.id, 'id 稳定可复读')
  assert.equal(a.note, undefined, '无 note 时不得出现 note 字段')
  assert.deepEqual(Object.keys(a).sort(), ['confidence', 'evidence', 'id', 'source', 'text'])

  const src = ['证据']
  const c = makeProvenanceRecord({ text: 'C', source: 'UNKNOWN', evidence: src, note: '说明' })
  src.push('被外部修改')
  assert.deepEqual(c.evidence, ['证据'], 'evidence 必须拷贝,隔离外部修改')
  assert.equal(c.note, '说明')
  console.log('✓ pv18 makeProvenanceRecord 默认值/唯一 id/隔离')
}

// 19. 组合:一条合法 explicit + 一条 assistant-only + 一条 suggested → 单个 warn,ok=true
{
  const records = [
    makeProvenanceRecord({ text: '研究 ComfyUI', source: 'USER_EXPLICIT', evidence: ['ComfyUI'] }),
    makeProvenanceRecord({
      text: '采用 H3',
      source: 'USER_EXPLICIT',
      evidence: ['H3'],
    }),
    makeProvenanceRecord({ text: '补充来源优先级', source: 'OPTIMIZER_SUGGESTED' }),
  ]
  const res = validateProvenance(
    records,
    '帮我研究 ComfyUI 做 AI 视频',
    assistantTurns('可以考虑 H3'),
  )
  assert.equal(res.ok, true)
  assert.equal(res.problems.filter((p) => p.severity === 'warn').length, 1)
  assert.equal(res.problems.filter((p) => p.severity === 'error').length, 0)
  console.log('✓ pv19 组合校验:单 warn 不影响 ok')
}

console.log('\nprovenance: all passed')
