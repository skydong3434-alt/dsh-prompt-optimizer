/**
 * v2 Release Candidate corpus —— 25 条真实 Prompt（重质量不重数量）。
 *
 * 来源：项目既有 fixture（P07 语料 / Phase 1–4 验收语料）+ 用户真实历史需求 +
 * 按 §4 覆盖面补写的真实场景。每条都标注：
 *   category  覆盖类别（§4 的 25 类）
 *   expect    RC 关注点（triage / target / discovery / 完整性 / 结构…）
 *   must      deterministic 不变量（必须出现 / 必须不出现）
 *
 * 用法：`node scripts/rc-validate.mjs`（真实 LLM，old v0.1.0 vs v2 同语料对比）。
 */

export const RC_CORPUS = [
  {
    id: 'rc01-keep-complete',
    category: '已经非常好的完整 Prompt',
    expect: { triage: 'KEEP', target: 'coding' },
    must: { keepVerbatim: true },
    text: [
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
      '输出格式:先给出问题清单(每条含文件路径与行号),再给出改动后的代码。',
      '',
      '验收标准:',
      '- npm test 全绿;',
      '- 现有 API 契约测试全部通过。',
    ].join('\n'),
  },
  {
    id: 'rc02-patch-small-defect',
    category: '只有一个小缺陷',
    expect: { triage: 'PATCH' },
    text: ['1. 先跑一遍测试', '2. 再看失败日志', '3. 输出格式:Markdown 表格'].join('\n'),
  },
  {
    id: 'rc03-restructure-messy',
    category: '内容完整但结构混乱',
    expect: { triage: 'RESTRUCTURE' },
    text: [
      '帮我做个小工具,要求是能读 csv 然后汇总,输出格式要 markdown 表格,输出格式要 markdown 表格,',
      '另外要快一点别卡,另外要快一点别卡,字段要能自动识别,字段要能自动识别,不用装数据库,不用装数据库,',
      '最好支持中文列名,最好支持中文列名,跑完给个总数,跑完给个总数,别的先不用管,别的先不用管。',
    ].join(' '),
  },
  {
    id: 'rc04-vague-needs-discovery',
    category: '极模糊任务',
    expect: { triage: 'REBUILD', discovery: true },
    text: '我想用 dsh 控制 comfyui 生成视频。',
  },
  {
    id: 'rc05-research-deep',
    category: '深度研究',
    expect: { target: 'research' },
    text: '帮我研究一下 Mac M1 Pro 32GB 上做 AI 视频的可行路线,我看到黑鹤001低显流,还有 H3,帮我判断哪条值得投入。',
  },
  {
    id: 'rc06-planning-project',
    category: '项目规划',
    expect: { target: 'general' },
    text: '帮我规划一下把现有的 Node CLI 工具迁移到 TypeScript 的步骤,要求不中断现有发布,分几个阶段做,每个阶段要有验收标准。',
  },
  {
    id: 'rc07-execution-direct',
    category: '直接执行',
    expect: {},
    text: '把下面这段 Python 改成用 pandas 读 CSV 并输出 Markdown 表格,保留原有函数名和参数。',
  },
  {
    id: 'rc08-diagnostic',
    category: '故障排查',
    expect: {},
    text: '线上服务每隔几小时就会 OOM 重启一次,日志里看到 heap out of memory,帮我排查可能原因和验证方法。',
  },
  {
    id: 'rc09-review-architecture',
    category: '架构 / 代码评审',
    expect: {},
    text: '帮我评审这个模块的分层设计是否合理,重点看依赖方向和可测试性,按原设计目标评估,不要发散到无关重构。',
  },
  {
    id: 'rc10-creative',
    category: 'Creative',
    expect: {},
    text: '给下面这段分镜写一版视频生成提示词:镜头1 人物A 在雨夜天台回头,镜头2 切换到他手中的旧照片。保持人物A的形象不变。',
  },
  {
    id: 'rc11-image-prompt',
    category: 'Image Generation',
    expect: { target: 'image_generation' },
    must: { noTaskTemplate: true },
    text: '二次元女孩坐在未来 AI 工作台前,三栏桌面布局,冷蓝色屏幕光,帮我生成生图提示词。',
  },
  {
    id: 'rc12-text-to-video',
    category: 'Text-to-Video',
    expect: { target: 'video_generation' },
    must: { noTaskTemplate: true },
    text: '生成一段 8 秒的视频:雨夜街道,镜头从远处缓慢推近到一个撑着伞的人,电影感。',
  },
  {
    id: 'rc13-image-to-video',
    category: 'Image-to-Video',
    expect: { target: 'video_generation' },
    text: '根据这张首帧,写一段视频提示词,让人物缓缓抬头看向镜头,镜头轻微上摇。',
  },
  {
    id: 'rc14-first-last-frame',
    category: 'First / Last Frame Video',
    expect: { target: 'video_generation' },
    text: '我有首尾两张图:首帧是白天街道,尾帧是夜晚同一条街。帮我写视频提示词表达这个时间变化过程。',
  },
  {
    id: 'rc15-named-video-model',
    category: '明确具体模型的视频 Prompt',
    expect: { target: 'video_generation', engine: 'kling' },
    text: '根据这张首帧写可灵视频提示词,让人物拔刀向前冲,镜头持续后拉。',
  },
  {
    id: 'rc16-generic-video',
    category: 'Generic Video Prompt',
    expect: { target: 'video_generation' },
    text: '我有首尾两张图,帮我生成视频提示词。',
  },
  {
    id: 'rc17-claude-code',
    category: 'Claude Code / Coding Agent',
    expect: { target: 'coding' },
    text: '用 Claude Code 把这个仓库的 eslint 报错全部修掉,只改报错涉及的代码,不要动业务逻辑,修完跑一遍 lint 和测试给我结果。',
  },
  {
    id: 'rc18-dsh-agent',
    category: 'DSH Agent',
    expect: { target: 'agent_task' },
    text: '让 DSH 去把项目的依赖升级到最新小版本,升级前先确认没有 breaking change,失败就回滚并告诉我原因。',
  },
  {
    id: 'rc19-strict-no-modify',
    category: '含严格“不要修改”约束',
    expect: {},
    must: { keepReviewIntent: true },
    text: '帮我看看这段代码有没有并发问题,只检查,不修改文件。',
  },
  {
    id: 'rc20-mixed-intents',
    category: '混合 Research → Planning → Execution 意图',
    expect: {},
    text: '先调研一下现在主流的向量库有哪些,再帮我选一个并规划接入步骤,最后给出接入的代码骨架。',
  },
  {
    id: 'rc21-explicit-acceptance',
    category: '用户已经写了详细验收标准',
    expect: {},
    text: '帮我写一个批量重命名脚本。验收标准:1) 支持正则匹配;2) dry-run 模式只打印不执行;3) 冲突时跳过并记录;4) 有单元测试且全部通过。',
  },
  {
    id: 'rc22-preserve-format',
    category: '用户明确要求保持原格式',
    expect: {},
    text: '帮我润色下面这段产品说明,保持原有的 Markdown 结构和标题层级不变,只改措辞,不要增删章节。',
  },
  {
    id: 'rc23-long-prompt',
    category: '很长 Prompt',
    expect: {},
    text: [
      '背景:我们在做一个内部的提示词优化插件,需要在 DSH Desktop 里运行。',
      '当前问题:优化后的提示词经常把用户没说过的约束写进去,而且把助手的历史建议当成了用户要求。',
      '目标:让优化结果只表达用户真实说过的要求,优化器自己的建议必须单独标注。',
      '约束:1) 不得引入新的第三方依赖;2) 必须保持现有设置项兼容;3) 不能修改其他插件的代码;4) 所有新增逻辑必须有单元测试。',
      '输入材料:src/core 下的现有实现、test 下的现有用例、README 里的产品说明。',
      '输出格式:先给问题清单(按严重程度排序,每条含文件与行号),再给改动后的代码,最后给验证步骤。',
      '验收:现有测试全绿 + 新增测试覆盖新逻辑 + 手工回归三条真实提示词。',
      '如果遇到必须改变产品语义的取舍,先停下来问我,不要自己决定。',
    ].join('\n'),
  },
  {
    id: 'rc24-short-but-complete',
    category: '很短但已经完整的 Prompt',
    expect: { triage: 'PATCH' },
    text: '把这段英文翻译成中文,保持术语一致,输出 Markdown 表格:英文 | 中文。',
  },
  {
    id: 'rc25-needs-discovery-tradeoff',
    category: '需要 Requirement Discovery 的 Prompt',
    expect: { discovery: true },
    text: '帮我做一个 AI 知识库,不知道是先做个能跑的最小版本,还是直接做成以后长期用的工具。',
  },
]

export default RC_CORPUS
