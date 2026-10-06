/**
 * RC 回归 —— v2 Release Candidate 验证中发现的**真实问题**的固定断言。
 *
 * 每个 fix 对应一条 RC 失败案例;这些是 release blocker 的护栏,不得回退。
 * 运行:先 `npm run build`,再 `node test/rc/rc-regression.test.mjs`。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANALYSIS_MAX_TOKENS } from '../../lib/core/analyze.js'
import { compilePrompt, parseCompileOutput, finalizeCompile } from '../../lib/core/compiler.js'
import { normalizeItemText, conditionalLine, executionLine, rewriteRetiredPlaceholders } from '../../lib/core/disposition-render.js'
import { assessCompleteness, decideValidationAction } from '../../lib/core/validation-flow.js'
import { validateCompileResult } from '../../lib/core/validate.js'

const here = dirname(fileURLToPath(import.meta.url))

const analysis = (triage) => ({
  intent: { primary: 'diagnostic', supporting: [], work_mode: 'one_shot', rationale: '' },
  target: { target: 'general', modality: 'text', engine: null, confidence: 'high', evidence: [], rationale: '' },
  triage: { triage, reasons: [], signals: [], keep_safe: false },
  missing_resolution: [],
  gate: { blocked: false, blocking_items: [], discoverable_items: [], optional_items: [], reason: '' },
  ledger: [],
  confidence_internal: 0.9,
  rationale: '',
  evidence_quotes: [],
  prompt_type: 'diagnostic',
  missing_constraints: [],
})

// ── RC-0:语言判定:中文技术写作(含英文产品名)必须走中文载荷 ────────────────
{
  const { detectLanguage } = await import('../../lib/core/strategies/_shared.js')
  assert.equal(detectLanguage('我想用 dsh 控制 comfyui 生成视频。'), 'zh', '★ 中英混排必须判中文')
  assert.equal(detectLanguage('请 review 一下这段代码'), 'zh')
  assert.equal(detectLanguage('x'), 'en', '纯英文短输入行为不变')
  assert.equal(detectLanguage('review this code please'), 'en')
  console.log('✓ rc0 语言判定:中文技术写作不再被判成英文')
}

// ── RC-1:PATCH 必须真的「局部修改」,不得重排/新增章节 ──────────────────────
{
  const patch = compilePrompt({ raw_input: '1. 先跑一遍测试\n2. 再看失败日志\n3. 输出格式:Markdown 表格', analysis: analysis('PATCH'), language: 'zh' })
  assert.match(patch.user, /编辑分诊纪律:PATCH/, 'PATCH 必须带上编辑分诊纪律')
  assert.match(patch.user, /保持原稿的结构与措辞/, 'PATCH 必须要求保持原结构')
  assert.match(patch.user, /不得[\s\S]{0,20}新增章节/, 'PATCH 必须禁止新增章节')

  const restructure = compilePrompt({ raw_input: '帮我做个小工具,要求是能读 csv', analysis: analysis('RESTRUCTURE'), language: 'zh' })
  assert.match(restructure.user, /编辑分诊纪律:RESTRUCTURE/)
  assert.match(restructure.user, /不得[\s\S]{0,30}新增用户没提出的目标/, 'RESTRUCTURE 不得新增目标')

  // 顺带覆盖 RC 的语言判定:中文技术写作(含英文产品名)必须判为 zh
const rebuild = compilePrompt({ raw_input: '我想用 dsh 控制 comfyui 生成视频。', analysis: analysis('REBUILD') })
  assert.match(rebuild.user, /编辑分诊纪律:REBUILD/)
  assert.match(rebuild.user, /Minimum Sufficient Prompt/, 'REBUILD 必须以最小充分 Prompt 为目标')
  assert.match(rebuild.user, /不得为了套结构而生成空段落/, 'REBUILD 必须反膨胀')

  // 分诊未知时不注入(不猜)
  const none = compilePrompt({ raw_input: 'x', promptType: 'general' })
  assert.doesNotMatch(none.user, /编辑分诊纪律/, '没有分诊结论时不得凭空注入纪律')
  console.log('✓ rc1 PATCH/RESTRUCTURE/REBUILD 的分诊纪律已注入(局部 / 只重组 / 最小充分)')
}

// ── RC-2:分析预算必须 ≥4096(真实推理模型实测 1024/2048 会写不出 JSON)────────
{
  assert.ok(ANALYSIS_MAX_TOKENS >= 4096, `分析预算 ${ANALYSIS_MAX_TOKENS} 过小:推理模型会 finish_reason=length`)
  const host = readFileSync(join(here, '../../src/index.ts'), 'utf8')
  assert.match(host, /maxTokensOverride/, '分析调用必须支持临时覆盖预算')
  assert.match(host, /ANALYSIS_MAX_TOKENS \* 2/, '截断后必须有一次性加预算重试')
  console.log('✓ rc2 分析预算 ≥4096 + 截断后一次性翻倍重试')
}

// ── RC-3:交付稿不得泄漏内部协议标记;不得为空 ────────────────────────────────
{
  const degraded = parseCompileOutput(['<<<DIAGNOSIS>>>', 'd', '<<<EXPLICIT>>>', '- x [quote: y]', '<<<END>>>'].join('\n'))
  assert.doesNotMatch(degraded.optimized_prompt, /<<<[A-Z_]+>>>/, '降级路径也必须剥掉协议标记')

  const withMarker = '<<<OPTIMIZED>>>\n## Request\n- 做点事\n<<<END>>>'
  const sections = parseCompileOutput(withMarker)
  assert.doesNotMatch(sections.optimized_prompt, /<<<[A-Z_]+>>>/)

  // 校验规则:空交付稿 / 标记残留 → error
  const strategy = { type: 'general', informationResponsibilities: ['Request'], required_sections: ['Request'] }
  const empty = validateCompileResult(
    { optimized_prompt: '', prompt_type: 'general', explicit_requirements: [], context_requirements: [], suggested_requirements: [], unknowns: [] },
    { rawInput: 'x', contextTurns: [], strategy },
  )
  assert.ok(empty.problems.some((p) => p.rule === 'VALIDATION_EMPTY_OUTPUT'), '空交付稿必须报 error')

  const leaked = validateCompileResult(
    { optimized_prompt: '<<<DIAGNOSIS>>>\n正文', prompt_type: 'general', explicit_requirements: [], context_requirements: [], suggested_requirements: [], unknowns: [] },
    { rawInput: 'x', contextTurns: [], strategy },
  )
  assert.ok(leaked.problems.some((p) => p.rule === 'VALIDATION_PROTOCOL_LEAK'), '协议标记残留必须报 error')

  // 回流动作:空输出 / 标记残留 → 可恢复回流
  const action = decideValidationAction({
    problems: [{ severity: 'error', rule: 'VALIDATION_EMPTY_OUTPUT', detail: '空' }],
    result: { optimized_prompt: '' },
    rawInput: 'x',
    returns: [],
    round: 1,
  })
  assert.equal(action.action, 'RETURN_TO_MISSING_RESOLUTION')
  assert.equal(action.reason_code, 'VF_EMPTY_OUTPUT')
  console.log('✓ rc3 空交付稿 / 协议标记残留 → error + 可控回流')
}

// ── RC-4:处置注入行不得与句末标点拼成畸形句 ────────────────────────────────
{
  assert.equal(normalizeItemText('人物A 的形象设定未给出。'), '人物A 的形象设定未给出')
  assert.equal(normalizeItemText('…保持一致。'), '…保持一致')
  assert.equal(
    conditionalLine({ text: '人物A 的形象设定未给出。' }),
    '- 人物A 的形象设定未给出:存在则优先复用/沿用,不存在则按新建路径处理',
    '★ 不得出现「保持一致。:存在则…」这种畸形拼接',
  )
  assert.doesNotMatch(conditionalLine({ text: 'X。' }), /。:/)
  assert.equal(executionLine({ text: '待检查代码的获取方式。' }), '- 动手前先确认:待检查代码的获取方式')
  console.log('✓ rc4 处置行标点归一化(不再出现「X。:存在则…」)')
}

// ── RC-5:完整性按**信息**判定,不按标题名判定(避免模板套用) ────────────────
{
  // 责任标题缺失 = 非关键(交付 + 警示)
  const missingHeadings = assessCompleteness({
    optimizedPrompt: '做点事,输出 Markdown。',
    responsibilities: ['Request', 'Context & Inputs', 'Constraints & Exclusions', 'Deliverable Shape'],
  })
  assert.deepEqual(missingHeadings.criticalMissing, [], '★ 缺标题不得判为执行关键(结构 ≠ 信息)')
  assert.equal(missingHeadings.nonCriticalMissing.length, 4)

  // 丢用户明确约束 = 关键
  const dropped = assessCompleteness({
    optimizedPrompt: '做点事,输出 Markdown。',
    responsibilities: ['Request'],
    ledger: [{ text: '不要引入新依赖', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['不要引入新依赖'] }],
  })
  assert.deepEqual(dropped.criticalMissing, ['用户已确认的要求 / 约束'])
  assert.deepEqual(dropped.droppedUserRequirements, ['不要引入新依赖'])

  // 语义改写(同一个要求换措辞)不算丢
  const reworded = assessCompleteness({
    optimizedPrompt: '验证 DSH 能成功调用现有 ComfyUI 工作流并产出视频。',
    responsibilities: ['Request'],
    ledger: [{ text: '用 dsh 控制 comfyui 生成视频', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: [] }],
  })
  assert.deepEqual(reworded.criticalMissing, [], '★ 正常改写不得误判为丢约束')

  // 视觉契约缺排除项:**非关键**(v0.2.0-apo release blocker 修复:
  // 缺一行 negative 不会让 Prompt 变错,拦交付会让用户拿不到生图提示词)
  const visual = assessCompleteness({ optimizedPrompt: '二次元女孩,冷蓝光,16:9', responsibilities: ['Subject'], visualContract: true })
  assert.deepEqual(visual.criticalMissing, [], '视觉缺 negative 不得拦交付')
  assert.ok(visual.nonCriticalMissing.some((x) => /排除项/.test(x)), '应作为非关键提示可见')
  const visualOk = assessCompleteness({ optimizedPrompt: '二次元女孩,冷蓝光,16:9,不要水印', responsibilities: ['Subject'], visualContract: true })
  assert.deepEqual(visualOk.criticalMissing, [])

  // 关键缺失 → 回流(带 reason code)
  const action = decideValidationAction({
    problems: [],
    result: { optimized_prompt: 'x' },
    rawInput: 'x',
    returns: [],
    round: 1,
    criticalMissing: ['用户已确认的要求 / 约束'],
  })
  assert.equal(action.action, 'RETURN_TO_MISSING_RESOLUTION')
  assert.equal(action.reason_code, 'VF_CRITICAL_RESPONSIBILITY_MISSING')
  console.log('✓ rc5 完整性按信息判定:丢约束/视觉缺排除项 = 关键;缺标题 = 非关键')
}

// ── RC-6:退役占位符必须被**机械改写**(I-1 由构造保证,不依赖回流) ──────────
{
  assert.equal(
    rewriteRetiredPlaceholders('- [待补充: 测试框架与运行命令]'),
    '- 动手前先确认:测试框架与运行命令',
    '★ 独立占位符行 → 动作式指令',
  )
  assert.equal(
    rewriteRetiredPlaceholders('下一个 Task：[待补充: 本次输入未指明]'),
    '下一个 Task：由执行方动手前确认:本次输入未指明',
    '★ 行内占位符 → 就地改写',
  )
  assert.equal(rewriteRetiredPlaceholders('正文没有占位符'), '正文没有占位符')
  assert.equal(rewriteRetiredPlaceholders(''), '')

  // 端到端:finalizeCompile 的交付稿不得再出现退役占位符
  const { defaultStrategyRegistry } = await import('../../lib/core/registry.js')
  const strategy = defaultStrategyRegistry.get('general')
  const outcome = finalizeCompile(
    strategy,
    [
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
      '- [待补充: 具体验收口径]',
      '<<<END>>>',
    ].join('\n'),
    {
      rawInput: '做点事',
      contextTurns: [],
      classifier: { prompt_type: 'general', confidence_internal: 0.5 },
      missing: [],
      mode: 'full',
      language: 'zh',
    },
  )
  assert.doesNotMatch(outcome.result.optimized_prompt, /\[(?:待补充|TODO)\s*[:：]/, '★ 交付稿必须已机械改写')
  assert.match(outcome.result.optimized_prompt, /动手前先确认:具体验收口径/)
  console.log('✓ rc6 退役占位符机械改写(I-1 由构造保证)')
}

// ── RC-7:丢要求判「关键」只限约束/安全类(避免视觉·复述型误报) ──────────────
{
  const visual = assessCompleteness({
    optimizedPrompt: 'Shot:以首帧为起点,人物抬头,最后看向镜头。不要出现水印。',
    responsibilities: ['Shot'],
    ledger: [{ text: '基于首尾两张图生成视频提示词', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['我有首尾两张图'] }],
    visualContract: true,
  })
  assert.deepEqual(visual.criticalMissing, [], '★ 视觉契约里「目标复述」未逐字出现不得判关键(实测误报 rc12/13/16)')
  assert.deepEqual(visual.droppedUserRequirements, ['基于首尾两张图生成视频提示词'], '确实未被逐字命中')
  assert.ok(
    visual.nonCriticalMissing.some((x) => /要求复述未逐字出现/.test(x)),
    '仍要可见(非关键),只是不回流',
  )

  const droppedConstraint = assessCompleteness({
    optimizedPrompt: '做点事。',
    responsibilities: ['Request'],
    ledger: [{ text: '只检查,不修改文件', source: 'USER_EXPLICIT', status: 'CONFIRMED', evidence: ['只检查,不修改文件'] }],
  })
  assert.deepEqual(droppedConstraint.criticalMissing, ['用户已确认的要求 / 约束'], '★ 丢约束仍然必须回流')
  console.log('✓ rc7 关键性只认约束 / 安全边界(目标复述记非关键)')
}

console.log('rc-regression.test.mjs: ALL PASS')
