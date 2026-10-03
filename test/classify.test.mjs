/**
 * P03-T01 — Classifier 提示词与解析器(纯函数)单测矩阵。
 *
 * 覆盖:
 *  - system/user 构建:七类型 + 防误判三规则 + JSON 契约 + 逐字证据纪律;
 *  - parseClassifierOutput 容错:脏 JSON / 缺字段 / 重复输出取最后 / 未知类型→general /
 *    confidence 越界钳制 / 低于 0.6 低置信标记 / evidence_quotes 逐字子串校验;
 *  - 多意图输入 → 主类型不拆 + 缺口注明;
 *  - 可复现性:同输入两次构建/解析结果一致(无时间戳、无随机);
 *  - 纯函数:无 ctx.llm / UI / Host 依赖。
 *
 * 运行:先 `npm run build`,再 `node test/classify.test.mjs`。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CLASSIFIER_LOW_CONFIDENCE_THRESHOLD,
  CLASSIFIER_MAX_TOKENS,
  CLASSIFIER_OUTPUT_FIELDS,
  CLASSIFIER_TEMPERATURE,
  CLASSIFY_ISSUE,
  MULTI_INTENT_NOTE,
  PROMPT_TYPES,
  buildClassifierSystem,
  buildClassifierUser,
  classifierPromptFingerprint,
  fallbackClassifierResult,
  isPromptType,
  isVerbatimUserQuote,
  looksMultiIntent,
  manualClassifierResult,
  parseClassifierOutput,
  parseClassifierResult,
} from '../lib/core/classify.js'

const REAL_CASE =
  '帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频,我看到黑鹤001低显流,还有 H3……'

// c1. system prompt:七类型 + 防误判三规则 + JSON 契约字段(zh/en 同构)
{
  assert.equal(CLASSIFIER_MAX_TOKENS, 512)
  assert.equal(CLASSIFIER_TEMPERATURE, 0)
  assert.equal(CLASSIFIER_LOW_CONFIDENCE_THRESHOLD, 0.6)
  assert.deepEqual(
    [...PROMPT_TYPES],
    ['research', 'planning', 'execution', 'diagnostic', 'review', 'creative', 'general'],
  )
  for (const type of PROMPT_TYPES) {
    assert.match(buildClassifierSystem('zh'), new RegExp(`- ${type}:`), `zh 系统词须列出 ${type}`)
    assert.match(buildClassifierSystem('en'), new RegExp(`- ${type}:`), `en 系统词须列出 ${type}`)
  }

  const zh = buildClassifierSystem('zh')
  // 防误判三规则(PLAN-v1 §6)
  assert.match(zh, /以「当前输入」为判断对象/, '规则 1:以当前输入为对象')
  assert.match(zh, /区分「当前请求」与「之前讨论过的内容」/, '规则 2:区分当前请求与历史讨论')
  assert.match(zh, /助手 \/ Agent 的建议不等于用户决定/, '规则 3:assistant 建议≠用户决定')
  assert.match(zh, /不要输出任何解释、Markdown 代码块或多余文字/, 'JSON 输出纪律')

  const en = buildClassifierSystem('en')
  assert.match(en, /Judge "the current input"/, 'en 规则 1')
  assert.match(en, /Separate "the current request" from "what was discussed earlier"/, 'en 规则 2')
  assert.match(en, /Assistant\/agent suggestions are not user decisions/, 'en 规则 3')

  // 输出契约字段与代码常量同源
  for (const field of CLASSIFIER_OUTPUT_FIELDS) {
    assert.match(zh, new RegExp(`- ${field.name}:`), `zh 契约须含 ${field.name}`)
    assert.match(en, new RegExp(`- ${field.name}:`), `en 契约须含 ${field.name}`)
  }
  assert.match(zh, /逐字片段/, 'evidence_quotes 须写明「逐字」')
  assert.match(zh, /不得引用助手发言/, 'evidence_quotes 须禁止引用助手')
  console.log('✓ c1 system prompt:七类型 + 防误判三规则 + JSON 契约')
}

// c2. user 载荷:上下文仅参考 + 当前输入为唯一分类对象
{
  const withContext = buildClassifierUser(
    {
      raw_input: REAL_CASE,
      context_turns: [
        { role: 'user', text: '我的机器是 Mac M1 Pro 32GB' },
        { role: 'assistant', text: '可以试试低显存方案' },
      ],
    },
    'zh',
  )
  assert.match(withContext, /<conversation-context>/)
  assert.match(withContext, /用户: 我的机器是 Mac M1 Pro 32GB/)
  assert.match(withContext, /助手: 可以试试低显存方案/)
  assert.match(withContext, /只有「用户」的发言能作为用户意图证据/)
  assert.match(withContext, /<prompt-draft>/)
  assert.ok(withContext.includes(REAL_CASE), '当前输入必须原样出现在 <prompt-draft> 内')
  const draftIndex = withContext.indexOf('<prompt-draft>')
  const contextIndex = withContext.indexOf('<conversation-context>')
  assert.ok(contextIndex < draftIndex, '上下文在前后、当前输入在后(模型最后读到的是当前输入)')

  const noContext = buildClassifierUser({ raw_input: REAL_CASE }, 'zh')
  assert.doesNotMatch(noContext, /<conversation-context>/, '无历史时不得出现上下文块')
  assert.match(noContext, /<prompt-draft>/)

  const en = buildClassifierUser({ raw_input: 'hello world' }, 'en')
  assert.match(en, /Here is the user's current input/)
  console.log('✓ c2 user 载荷:上下文仅供参考 + 当前输入原样')
}

// c3. 有效输出解析正确(含 think 块 / Markdown 代码块 / 前后噪声文本)
{
  const raw = `<think>意图是研究</think>
模型思考完毕。

\`\`\`json
{"prompt_type":"research","confidence_internal":0.86,"missing_constraints":["产出形式"],"rationale":"用户在调研方案","evidence_quotes":["黑鹤001低显流","H3"]}
\`\`\`

以上。`
  const outcome = parseClassifierOutput(raw, {
    rawInput: REAL_CASE,
    contextTurns: [],
  })
  assert.ok(outcome.result, '合法输出必须可解析')
  assert.equal(outcome.result.prompt_type, 'research')
  assert.equal(outcome.result.confidence_internal, 0.86)
  assert.deepEqual(outcome.result.missing_constraints, ['产出形式'])
  assert.deepEqual(outcome.result.evidence_quotes, ['黑鹤001低显流', 'H3'])
  assert.equal(outcome.meta.unknownTypeFallback, false)
  assert.equal(outcome.meta.droppedEvidence, 0)
  assert.equal(outcome.meta.lowConfidence, false)
  assert.deepEqual(outcome.meta.issues, [])

  // think 块内容里的假 JSON 不得被当成输出:只有最后一个完整 JSON 生效
  const decoy = `<think>{"prompt_type":"general","confidence_internal":1}</think>
{"prompt_type":"planning","confidence_internal":0.7,"missing_constraints":[],"rationale":"要步骤","evidence_quotes":[]}`
  const decoyOutcome = parseClassifierOutput(decoy, { rawInput: '帮我规划一下' })
  assert.equal(decoyOutcome.result.prompt_type, 'planning', 'think 块内的 JSON 必须被剥离')
  console.log('✓ c3 有效输出解析(think 块/代码块/噪声)')
}

// c4. 未知类型 / 缺类型 → general 回退 + 元信息
{
  const unknown = parseClassifierOutput('{"prompt_type":"brainstorm","confidence_internal":0.9}')
  assert.equal(unknown.result.prompt_type, 'general', '未知类型必须回退 general')
  assert.equal(unknown.meta.unknownTypeFallback, true)
  assert.equal(unknown.meta.degraded, true)
  assert.ok(unknown.meta.issues.includes(CLASSIFY_ISSUE.unknownType))

  const missing = parseClassifierOutput('{"confidence_internal":0.9,"rationale":"x"}')
  assert.equal(missing.result.prompt_type, 'general', '缺 prompt_type 必须回退 general')
  assert.equal(missing.meta.unknownTypeFallback, true)

  // 大小写敏感:闭集只接受小写字面量
  const cased = parseClassifierOutput('{"prompt_type":"Research"}')
  assert.equal(cased.result.prompt_type, 'general')
  assert.equal(cased.meta.unknownTypeFallback, true)

  // 兼容别名保持旧语义:非法类型 → null
  assert.equal(parseClassifierResult('{"prompt_type":"brainstorm"}'), null)
  assert.equal(parseClassifierResult('{"prompt_type":"research","confidence_internal":0.5}').prompt_type, 'research')
  console.log('✓ c4 未知/缺失类型 → general(兼容别名仍回退 null)')
}

// c5. 缺字段补默认值 / confidence 钳制 / 低置信标记
{
  const defaults = parseClassifierOutput('{"prompt_type":"execution"}')
  assert.equal(defaults.result.confidence_internal, 0.5, '缺 confidence → 0.5')
  assert.deepEqual(defaults.result.missing_constraints, [])
  assert.deepEqual(defaults.result.evidence_quotes, [])
  assert.equal(defaults.result.rationale, '')
  assert.equal(defaults.meta.lowConfidence, true, '0.5 < 0.6 必须标低置信')
  assert.ok(defaults.meta.issues.includes(CLASSIFY_ISSUE.invalidConfidence))

  const high = parseClassifierOutput('{"prompt_type":"review","confidence_internal":9}')
  assert.equal(high.result.confidence_internal, 1, '越界上钳制到 1')
  assert.ok(high.meta.issues.includes(CLASSIFY_ISSUE.confidenceClamped))
  assert.equal(high.meta.lowConfidence, false)

  const low = parseClassifierOutput('{"prompt_type":"review","confidence_internal":-3}')
  assert.equal(low.result.confidence_internal, 0, '越界下钳制到 0')
  assert.equal(low.meta.lowConfidence, true)

  const stringy = parseClassifierOutput('{"prompt_type":"review","confidence_internal":"0.72"}')
  assert.equal(stringy.result.confidence_internal, 0.72, '数字字符串可被接受')

  const nonNumeric = parseClassifierOutput('{"prompt_type":"review","confidence_internal":"非常高"}')
  assert.equal(nonNumeric.result.confidence_internal, 0.5)
  assert.ok(nonNumeric.meta.issues.includes(CLASSIFY_ISSUE.invalidConfidence))

  // 数组字段容错:非字符串项被丢弃
  const messy = parseClassifierOutput(
    '{"prompt_type":"general","missing_constraints":["a",1,null,"  ","b"],"evidence_quotes":"nope"}',
  )
  assert.deepEqual(messy.result.missing_constraints, ['a', 'b'])
  assert.deepEqual(messy.result.evidence_quotes, [])
  console.log('✓ c5 缺字段默认 / 钳制 / 低置信标记 / 数组容错')
}

// c6. 重复输出取最后;脏 JSON / 无 JSON 回退
{
  const repeated = `第一次尝试:{"prompt_type":"general","confidence_internal":0.3,"rationale":"旧"}
修正后:{"prompt_type":"creative","confidence_internal":0.81,"missing_constraints":[],"rationale":"写标题","evidence_quotes":[]}
结束。`
  const outcome = parseClassifierOutput(repeated, { rawInput: '帮我起个标题' })
  assert.equal(outcome.result.prompt_type, 'creative', '重复输出必须取最后一个')
  assert.equal(outcome.result.rationale, '写标题')

  // 缺逗号的粘连对象:补逗号后仍取最后一个
  const glued =
    '{"prompt_type":"general","confidence_internal":0.2}{"prompt_type":"planning","confidence_internal":0.77,"evidence_quotes":[]}'
  const gluedOutcome = parseClassifierOutput(glued, { rawInput: '帮我规划' })
  assert.equal(gluedOutcome.result.prompt_type, 'planning', '粘连 JSON 必须能修复并取最后')

  // 非 JSON / 空 / 只有半个对象 / 无契约字段的残片 → null + 稳定 issue
  for (const bad of [
    '',
    'not json at all',
    '```json\n{"prompt_type": "resea',
    '{}主谓不完整',
    '{}',
    '{"foo":1,"bar":2}',
    '<think>只有思考</think>',
  ]) {
    const failed = parseClassifierOutput(bad)
    assert.equal(failed.result, null, `无法解析的输入必须返回 null: ${JSON.stringify(bad)}`)
    assert.equal(failed.meta.degraded, true)
    assert.equal(failed.meta.lowConfidence, true)
    assert.ok(
      failed.meta.issues.includes(CLASSIFY_ISSUE.noJson) ||
        failed.meta.issues.includes(CLASSIFY_ISSUE.noUsableJson),
    )
  }

  // 含契约字段但类型缺失 → 不是 null,而是按字段默认值补全为 general 兜底对象
  const partial = parseClassifierOutput('{"rationale":"类型没写出来"}')
  assert.ok(partial.result, '含契约字段的对象必须被接受')
  assert.equal(partial.result.prompt_type, 'general')
  assert.equal(partial.result.rationale, '类型没写出来')
  assert.equal(partial.meta.unknownTypeFallback, true)

  // 解析失败由调用方回退:fallbackClassifierResult 仍是 general + 低置信
  const fallback = fallbackClassifierResult('分类调用失败')
  assert.equal(fallback.prompt_type, 'general')
  assert.ok(fallback.confidence_internal < CLASSIFIER_LOW_CONFIDENCE_THRESHOLD)
  console.log('✓ c6 重复输出取最后 / 脏 JSON 回退 / 兜底')
}

// c7. evidence_quotes 只接受逐字子串(用户 raw / 上下文 user;助手发言不算)
{
  const context = [
    { role: 'user', text: '我之前说过不要用付费方案' },
    { role: 'assistant', text: '我建议你改用 MiniMax API' },
  ]
  const raw = `{"prompt_type":"research","confidence_internal":0.8,"missing_constraints":[],"rationale":"调研","evidence_quotes":["黑鹤001低显流","MiniMax API","不要用付费方案","我随手编的一句话"]}`
  const outcome = parseClassifierOutput(raw, { rawInput: REAL_CASE, contextTurns: context })
  assert.deepEqual(
    outcome.result.evidence_quotes,
    ['黑鹤001低显流', '不要用付费方案'],
    '只保留 raw / 上下文 user 的逐字片段',
  )
  assert.equal(outcome.meta.droppedEvidence, 2, '助手建议与杜撰条目必须被丢弃')
  assert.ok(outcome.meta.issues.includes(CLASSIFY_ISSUE.evidenceNotVerbatim))
  assert.equal(outcome.meta.degraded, true)
  // 丢弃证据不等于判定 provenance:结果本身仍可展示为 research
  assert.equal(outcome.result.prompt_type, 'research')

  // 连续空白折叠后仍算逐字(不新增语义、只折叠)
  const spaced = parseClassifierOutput(
    '{"prompt_type":"research","evidence_quotes":["Mac   M1    Pro 32GB"]}',
    { rawInput: REAL_CASE },
  )
  assert.deepEqual(spaced.result.evidence_quotes, ['Mac   M1    Pro 32GB'], '空白折叠后匹配')

  // 大小写不折叠(逐字要求):Mac vs mac
  const cased = parseClassifierOutput(
    '{"prompt_type":"research","evidence_quotes":["mac m1 pro"]}',
    { rawInput: REAL_CASE },
  )
  assert.deepEqual(cased.result.evidence_quotes, [], '大小写变体保守判为不匹配')

  // 纯函数级判定
  assert.equal(isVerbatimUserQuote('黑鹤001低显流', REAL_CASE, []), true)
  assert.equal(isVerbatimUserQuote('MiniMax API', REAL_CASE, context), false, '助手发言永不算用户证据')
  assert.equal(isVerbatimUserQuote('不要用付费方案', '', context), true)
  assert.equal(isVerbatimUserQuote('', REAL_CASE, []), false, '空 quote 永不算证据')

  // 可显式关闭过滤(仅调试用)
  const unfiltered = parseClassifierOutput(raw, {
    rawInput: REAL_CASE,
    contextTurns: context,
    filterEvidenceQuotes: false,
  })
  assert.equal(unfiltered.result.evidence_quotes.length, 4)
  assert.equal(unfiltered.meta.droppedEvidence, 0)
  console.log('✓ c7 evidence_quotes 逐字子串校验(助手发言不算证据)')
}

// c8. 多意图输入 → 主类型不拆 + 缺口注明
{
  const multi = '帮我分析一下这个需求,并且直接实现出来'
  assert.equal(looksMultiIntent(multi), true)
  assert.equal(looksMultiIntent(REAL_CASE), false)
  assert.equal(looksMultiIntent('帮我写一首诗'), false)

  const raw = `{"prompt_type":"execution","confidence_internal":0.7,"missing_constraints":["验收标准"],"rationale":"主诉求是实现","evidence_quotes":["直接实现出来"]}`
  const outcome = parseClassifierOutput(raw, { rawInput: multi })
  assert.equal(outcome.result.prompt_type, 'execution', '多意图仍以模型给出的主类型为准,不拆分')
  assert.ok(
    outcome.result.missing_constraints.includes(MULTI_INTENT_NOTE),
    '多意图必须在缺口清单注明',
  )
  assert.ok(outcome.result.missing_constraints.includes('验收标准'), '原有缺口不得丢失')
  assert.equal(outcome.meta.multiIntent, true)
  assert.ok(outcome.meta.issues.includes(CLASSIFY_ISSUE.multiIntent))

  // 关闭检测时不注入
  const plain = parseClassifierOutput(raw, { rawInput: multi, detectMultiIntent: false })
  assert.deepEqual(plain.result.missing_constraints, ['验收标准'])
  assert.equal(plain.meta.multiIntent, false)
  console.log('✓ c8 多意图 → 主类型 + 缺口注明(不拆分)')
}

// c9. 可复现性:同输入两次构建/解析完全一致(无时间戳、无随机、无状态)
{
  const buildOnce = () => ({
    system: buildClassifierSystem('zh'),
    user: buildClassifierUser(
      { raw_input: REAL_CASE, context_turns: [{ role: 'user', text: '我的机器是 Mac' }] },
      'zh',
    ),
  })
  const first = buildOnce()
  const second = buildOnce()
  assert.equal(first.system, second.system)
  assert.equal(first.user, second.user)
  assert.equal(
    classifierPromptFingerprint(first.system, first.user),
    classifierPromptFingerprint(second.system, second.user),
    '提示词指纹必须可复现',
  )
  assert.match(classifierPromptFingerprint(first.system, first.user), /^[0-9a-f]+$/)

  const raw = '{"prompt_type":"research","confidence_internal":0.66,"missing_constraints":["x"],"rationale":"r","evidence_quotes":["黑鹤001低显流"]}'
  const parseOnce = () => parseClassifierOutput(raw, { rawInput: REAL_CASE })
  assert.deepEqual(parseOnce(), parseOnce(), '同一输入两次解析结果深相等')

  // 稳定性抽查:分类相同输入 2 次 → 同类型同置信(纯函数下即确定性)
  const a = parseOnce().result
  const b = parseOnce().result
  assert.equal(a.prompt_type, b.prompt_type)
  assert.equal(a.confidence_internal, b.confidence_internal)
  console.log('✓ c9 可复现性:同输入两次结果一致(含提示词指纹)')
}

// c10. 纯函数:classify 模块无 ctx.llm / UI / Host 依赖(源码 + 产物双重检查)
{
  const here = fileURLToPath(new URL('.', import.meta.url))
  const source = readFileSync(`${here}../src/core/classify.ts`, 'utf8')
  const bundle = readFileSync(`${here}../lib/core/classify.js`, 'utf8')
  for (const [label, text] of [
    ['source', source],
    ['bundle', bundle],
  ]) {
    assert.doesNotMatch(text, /ctx\.llm/, `${label} 不得依赖 ctx.llm`)
    assert.doesNotMatch(text, /from ['"]react['"]/, `${label} 不得依赖 React/UI`)
    assert.doesNotMatch(text, /document\.|window\./, `${label} 不得依赖 DOM`)
    assert.doesNotMatch(text, /dsh-llm/, `${label} 不得依赖 Host LLM 包`)
  }
  // 手动覆盖仍是纯函数旁路:不触达任何调用
  const manual = manualClassifierResult('research')
  assert.equal(manual.prompt_type, 'research')
  assert.equal(manual.confidence_internal, 1)
  assert.equal(isPromptType('creative'), true)
  console.log('✓ c10 纯函数:无 ctx.llm / UI / Host 依赖')
}

console.log('test/classify.test.mjs: all classifier pure-function tests passed')
