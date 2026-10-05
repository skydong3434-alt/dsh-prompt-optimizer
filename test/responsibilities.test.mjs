/**
 * v2 Phase 2 —— 未决项处置契约单测(用户指定的 6 条规则作为可执行规格)。
 *
 * 契约:`docs/phase2-contract.md`(选项 A:现在就切换)。
 * 逐条对应:
 *   规则 1 自然获得      → OMIT(不提示、不占位)
 *   规则 2 行动前须调查  → EXECUTION_RESPONSIBILITY(动作式)
 *   规则 3 决定分支      → CONDITIONAL_BRANCH(条件式)
 *   规则 4 可自查项      → **永不**输出 [待补充:](I-1)
 *   规则 5 OPTIONAL      → 默认省略,显著才进建议
 *   规则 6 仅 blocking USER_REQUIRED 可阻断(非阻塞用户决定不注入正文)
 * 反膨胀:不得把缺口机械改写成「由执行方自行确认 X」堆成另一种模板。
 *
 * 运行:先 `npm run build`,再 `node test/responsibilities.test.mjs`。
 */
import assert from 'node:assert/strict'
import {
  RESPONSIBILITY_CONTRACT_VERSION,
  RESPONSIBILITY_INJECTION_LIMIT,
  REQUIREMENT_DISPOSITIONS,
  classifyDisposition,
  isTradeoffStatement,
  planFromResolution,
  planFromLabels,
  planResponsibilities,
  injectResponsibilityNotes,
  renderDispositionBrief,
  renderNotes,
  executionLine,
  conditionalLine,
  RETIRED_PLACEHOLDER_RE,
  DISPOSITION_SECTION_TITLE,
} from '../lib/core/responsibilities.js'
import { classifyUnknown, classifyUnknowns } from '../lib/core/requirements.js'

const item = (text, classification, extra = {}) => ({
  id: `u-${text}`,
  text,
  classification,
  blocking: false,
  impact: 'low',
  rationale: '测试',
  user_exclusive: classification === 'USER_REQUIRED',
  ...extra,
})

// 1. 契约形状:版本 / 封闭枚举 / 正则真值
{
  assert.match(RESPONSIBILITY_CONTRACT_VERSION, /^\d+\.\d+\.\d+$/)
  assert.deepEqual([...REQUIREMENT_DISPOSITIONS].sort(), [
    'CONDITIONAL_BRANCH',
    'EXECUTION_RESPONSIBILITY',
    'OMIT',
    'OPTIONAL_ENHANCEMENT',
    'USER_DECISION',
  ])
  assert.ok(RETIRED_PLACEHOLDER_RE.test('[待补充: 预算]'))
  assert.ok(RETIRED_PLACEHOLDER_RE.test('[TODO: budget]'))
  assert.equal(RETIRED_PLACEHOLDER_RE.test('动手前先确认:预算'), false)
  assert.ok(DISPOSITION_SECTION_TITLE.execution.zh.includes('执行前须知'))
  assert.ok(DISPOSITION_SECTION_TITLE.conditional.zh.includes('分支条件'))
  console.log('✓ rc1 契约形状:版本 / 五处置 / 退役占位符正则 / 区块标题')
}

// 2. 规则 1:执行方正常工作中自然获得的纯定位信息 → OMIT
{
  for (const text of ['现有实现的路径', '相关目录与文件名', '代码在哪个文件', '仓库结构']) {
    assert.equal(
      classifyDisposition({ text, classification: 'AGENT_DISCOVERABLE' }),
      'OMIT',
      `「${text}」属自然获得 → 必须省略`,
    )
  }
  // 不在两张表里的模糊项也一律省略(默认不打扰)
  assert.equal(classifyDisposition({ text: '某个说不清的东西', classification: 'AGENT_DISCOVERABLE' }), 'OMIT')
  console.log('✓ rc2 规则 1:自然获得 / 模糊项 → OMIT(不提示、不占位)')
}

// 3. 规则 2:必须在行动前调查、且影响正确执行 → EXECUTION_RESPONSIBILITY(动作式)
{
  for (const text of ['当前依赖版本与可用接口', '接口签名', '现有配置项', '表结构与字段类型', '默认值规范']) {
    assert.equal(
      classifyDisposition({ text, classification: 'AGENT_DISCOVERABLE' }),
      'EXECUTION_RESPONSIBILITY',
      `「${text}」须行动前调查 → 动作式`,
    )
  }
  const plan = planFromResolution([item('当前依赖版本与可用接口', 'AGENT_DISCOVERABLE')])
  const line = renderNotes(plan).execution[0]
  assert.ok(line.startsWith('- 动手前先确认:'), `动作式指令格式:${line}`)
  assert.ok(!line.includes('[待补充:'), '动作式绝不含占位符')
  assert.equal(executionLine({ text: 'X' }, 'en'), '- Verify before acting: X')
  console.log('✓ rc3 规则 2:行动前调查项 → 动作式指令')
}

// 4. 规则 3:调查结果决定分支 → CONDITIONAL_BRANCH(条件式)
{
  for (const text of ['是否已有 workflow', '仓库里已存在同类实现', '取决于现有脚本能否复用', '若已有模板则沿用']) {
    assert.equal(
      classifyDisposition({ text, classification: 'AGENT_DISCOVERABLE' }),
      'CONDITIONAL_BRANCH',
      `「${text}」决定分支 → 条件式`,
    )
  }
  const plan = planFromResolution([item('是否已有 workflow', 'AGENT_DISCOVERABLE')])
  const line = renderNotes(plan).conditional[0]
  assert.ok(line.includes('存在则优先复用'), `条件式指令必须给出两条路径:${line}`)
  assert.ok(line.includes('不存在则'), '条件式指令必须给出 else 分支')
  assert.equal(
    conditionalLine({ text: 'X' }, 'en'),
    '- X: if it already exists, reuse it; otherwise follow the create/modify path',
  )
  console.log('✓ rc4 规则 3:决定分支项 → 条件式(存在则…,否则…)')
}

// 5. 规则 4 + I-1:可自查项永不输出成 [待补充:];注入只有两个区块
{
  const resolution = [
    item('现有实现的路径', 'AGENT_DISCOVERABLE'), // OMIT
    item('当前依赖版本与可用接口', 'AGENT_DISCOVERABLE'), // EXECUTION
    item('是否已有 workflow', 'AGENT_DISCOVERABLE'), // CONDITIONAL
    item('可选:附带示例', 'OPTIONAL'), // OMIT
  ]
  const plan = planFromResolution(resolution)
  const out = injectResponsibilityNotes('## Background\n- 已有内容', plan, 'zh')
  assert.equal(RETIRED_PLACEHOLDER_RE.test(out.prompt), false, 'I-1:注入结果不得含 [待补充:]')
  assert.ok(out.prompt.includes(DISPOSITION_SECTION_TITLE.execution.zh), '执行责任必须进「执行前须知」')
  assert.ok(out.prompt.includes(DISPOSITION_SECTION_TITLE.conditional.zh), '分支必须进「分支条件」')
  assert.ok(!out.prompt.includes('现有实现的路径'), 'OMIT 项不得出现在注入结果里')
  assert.ok(!out.prompt.includes('可选:附带示例'), '弱 OPTIONAL 不得出现在注入结果里')
  // 「另一种膨胀」的反例:不得出现机械改写句式
  assert.equal(
    /由执行方自行确认[:：]/.test(out.prompt),
    false,
    '不得把 [待补充: X] 机械改写成「由执行方自行确认 X」',
  )
  console.log('✓ rc5 规则 4:I-1 零占位符 + 只注入两个区块 + 反膨胀句式')
}

// 6. 规则 5:OPTIONAL 默认省略,显著(high impact)才进建议
{
  assert.equal(classifyDisposition({ text: '可选:加个动画', classification: 'OPTIONAL', impact: 'low' }), 'OMIT')
  assert.equal(
    classifyDisposition({ text: '可选:补一份导出格式说明', classification: 'OPTIONAL', impact: 'high' }),
    'OPTIONAL_ENHANCEMENT',
  )
  const plan = planFromResolution([
    item('可选:加个动画', 'OPTIONAL'),
    item('可选:补一份导出格式说明', 'OPTIONAL', { impact: 'high' }),
  ])
  assert.equal(plan.enhancements.length, 1)
  assert.equal(plan.omitted.length, 1)
  const out = injectResponsibilityNotes('body', plan, 'zh')
  assert.equal(out.prompt, 'body', '可选增强不进正文')
  assert.ok(renderNotes(plan).enhancements.length === 1, '可选增强走建议通道')
  console.log('✓ rc6 规则 5:OPTIONAL 默认省略,显著项走建议段')
}

// 7. 规则 6:非阻塞 USER_REQUIRED 不注入正文;blocking 由分析门负责
{
  const plan = planFromResolution([
    item('期望的视频产出形式与时长', 'USER_REQUIRED'),
    item('预算范围', 'USER_REQUIRED', { blocking: true, impact: 'high' }),
  ])
  assert.equal(plan.userDecisions.length, 2, '非阻塞用户决定项进入 userDecisions')
  const out = injectResponsibilityNotes('## Body\n- x', plan, 'zh')
  assert.equal(out.prompt, '## Body\n- x', '用户决定项不得写进编译稿')
  assert.equal(out.injected.length, 0)
  // blocking 项也不注入:它由分析门拦下(不进入编译)
  const notes = renderNotes(plan)
  assert.deepEqual(notes.userDecisions, ['期望的视频产出形式与时长', '预算范围'])
  console.log('✓ rc7 规则 6:用户决定项不注入正文(留台账 / 门禁)')
}

// 8. 反膨胀硬上限 + 去重(I-4)
{
  const many = Array.from({ length: 9 }, (_, i) => item(`当前依赖版本${i}`, 'AGENT_DISCOVERABLE'))
  const plan = planFromResolution(many)
  assert.equal(plan.execution.length, RESPONSIBILITY_INJECTION_LIMIT, `注入条数必须封顶 ${RESPONSIBILITY_INJECTION_LIMIT}`)
  assert.equal(plan.truncated, true)

  const dupes = planFromResolution([
    item('当前依赖版本与可用接口', 'AGENT_DISCOVERABLE'),
    item('当前依赖版本与可用接口', 'AGENT_DISCOVERABLE'),
  ])
  assert.equal(dupes.execution.length, 1, '同文本必须去重')
  console.log('✓ rc8 反膨胀:去重 + 条数上限')
}

// 9. I-2:不得把未决项写成面向用户的追问
{
  const plan = planFromResolution([
    item('当前依赖版本与可用接口', 'AGENT_DISCOVERABLE'),
    item('期望的视频产出形式与时长', 'USER_REQUIRED'),
  ])
  const out = injectResponsibilityNotes('body', plan, 'zh')
  assert.equal(/请先回答|请你确认|请先补充/.test(out.prompt), false, 'I-2:注入不得反问用户')
  const brief = renderDispositionBrief({ dispositions: plan.items }, 'zh', 'hint', 'hint')
  assert.ok(brief.includes('不要'), 'user 载荷必须明确「不要问用户」')
  console.log('✓ rc9 I-2:注入与载荷都不得反问用户')
}

// 10. 编译说明:按处置分类交付(而不是「必须落成 [待补充:]」)
{
  const plan = planFromResolution([
    item('当前依赖版本与可用接口', 'AGENT_DISCOVERABLE'),
    item('是否已有 workflow', 'AGENT_DISCOVERABLE'),
    item('期望的视频时长', 'USER_REQUIRED'),
    item('可选:补示例', 'OPTIONAL', { impact: 'high' }),
  ])
  const brief = renderDispositionBrief({ dispositions: plan.items }, 'zh', 'HINT', 'hint')
  assert.match(brief, /执行前须知/, '必须指示写入执行前须知')
  assert.match(brief, /分支条件/, '必须指示写入分支条件')
  assert.match(brief, /只有用户能决定/, '用户决定项必须单独成类')
  assert.match(brief, /可选增强/, '可选增强必须单独成类')
  // 说明里允许「禁令式提及」(禁止输出 [待补充:]),但每次提及都必须紧跟在禁令措辞之后。
  for (const hit of [...brief.matchAll(/\[待补充:/g)]) {
    const before = brief.slice(Math.max(0, hit.index - 14), hit.index)
    assert.match(before, /禁止输出|不要写成|不得|不要|禁止/, `说明中的占位符提及必须是禁令式:…${before}`)
  }

  const empty = renderDispositionBrief({}, 'zh', 'HINT', 'hint')
  assert.match(empty, /未提供未决项/, '无缺口时给出保守指引')
  assert.match(empty, /不得.*\[待补充:\]/, '无缺口时也必须禁止占位符')
  console.log('✓ rc10 编译说明:按处置分类交付 + 禁用占位符')
}

// 11. 回退路径(只有裸标签)与 resolution 路径一致性
{
  const labels = [{ id: 'm1', label: '当前依赖版本与可用接口' }, { id: 'm2', label: '现有实现的路径' }]
  const fromLabels = planFromLabels(labels)
  assert.equal(fromLabels.execution.length, 1, '裸标签也能识别出执行责任')
  assert.equal(fromLabels.omitted.length, 1, '裸标签也能识别出可省略项')

  const resolution = labels.map((l) => item(l.label, 'AGENT_DISCOVERABLE'))
  const fromResolution = planFromResolution(resolution)
  assert.deepEqual(
    fromResolution.items.map((i) => i.disposition),
    fromLabels.items.map((i) => i.disposition),
    '两条路径的处置必须一致(同一套判据)',
  )
  // resolution 优先
  assert.equal(planResponsibilities({ resolution, labels }).execution.length, 1)
  console.log('✓ rc11 回退路径与 resolution 路径判据一致')
}

// 12. Phase 3 前置断言:取舍型陈述永远不能靠检查环境得到答案
//
// 本块把「现状」与「目标」同时钉住,避免 Phase 3 悄悄跳过:
//   · 已达成:`isTradeoffStatement` 提供取舍型判据原语;含明确偏好措辞的取舍已判
//     USER_REQUIRED(如「要不要…」匹配用户专属词表);
//   · **未达成(Phase 3 必须修)**:纯取舍句式(「只验证一次链路还是建设长期自动化」)
//     在当前保守 fallback 下仍会落到 AGENT_DISCOVERABLE —— 这正是用户要求记入
//     Phase 3 的风险。下面的断言写的是**现状**,Phase 3 修好后必须把 expected 改成
//     'USER_REQUIRED',本次改动即为 Phase 3 的入口证据。
{
  for (const text of [
    '只验证一次链路还是建设长期自动化',
    '要么先用最小方案要么直接上完整平台',
    '这个优先级更重要',
    '方案 A 还是方案 B',
  ]) {
    assert.equal(isTradeoffStatement(text), true, `「${text}」必须被取舍型判据识别`)
  }

  // 已达成:明确偏好措辞 → USER_REQUIRED
  assert.equal(
    classifyUnknown({ text: '要不要保留旧接口' }).classification,
    'USER_REQUIRED',
    '「要不要」= 用户决定',
  );

  // Phase 3 目标(当前未达成):纯取舍句式必须判 USER_REQUIRED,且高影响时 blocking。
  const tradeoff = '只验证一次链路还是建设长期自动化'
  const current = classifyUnknown({ text: tradeoff })
  assert.equal(
    current.classification,
    'AGENT_DISCOVERABLE',
    'PHASE3-TARGET:现状仍是保守 fallback;Phase 3 必须改为 USER_REQUIRED(见 docs/phase3-prerequisites.md)',
  );
  assert.equal(current.blocking, false, 'PHASE3-TARGET:现状不阻塞;Phase 3 必须按影响面决定 blocking')
  assert.ok(
    !current.blocking || current.classification === 'USER_REQUIRED',
    'blocking 只允许出现在 USER_REQUIRED 上(硬不变量,Phase 3 也不得破坏)',
  );
  console.log('✓ rc12 Phase 3 前置:取舍型判据已就位,误降级现状已显式钉住')
}

console.log('responsibilities.test.mjs: ALL PASS')
