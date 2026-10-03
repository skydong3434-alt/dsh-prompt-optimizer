/**
 * P03-T03 — 防误判 / Manual Override 测试语料（fixtures）。
 *
 * 全部为「本项目独立撰写」的合成场景，不含任何 AGPL 项目模板文本。
 * 每个 fixture 描述一条真实产品里最容易误判的输入形态，并给出：
 *   - raw_input / context_turns：喂给分类器（及 provenance 校验器）的输入；
 *   - mock_output：固定 mock LLM 返回的 ClassifierResult（JSON 字符串）；
 *   - expect：解析与来源判定的确定性断言目标。
 *
 * 覆盖任务书要求的四类场景：
 *   1. referent        —— 指代类（「上面提到的那个方案怎么样」），历史只作背景；
 *   2. multi-intent    —— 多意图（分析 + 执行），只取主类型、不拆分；
 *   3. assistant-bg    —— assistant 长讨论仅背景，不得变成用户 explicit；
 *   4. negation        —— 明确否定类（用户自己排除的选项）；
 *   5. current-vs-history —— 当前请求推翻历史话题，主类型必须以当前输入为准。
 *
 * `resolution` 期望值对应 provenance.ts 的 resolveQuoteSource 语义：
 *   raw → USER_EXPLICIT / high；context-user → CONTEXT_EXPLICIT / high；
 *   assistant-only / none → invalid / UNKNOWN / low。
 */

/** @typedef {'referent'|'multi-intent'|'assistant-bg'|'negation'|'current-vs-history'} GuardCategory */

/** 一条 quote 的来源判定期望。 */
const R = (quote, matchedIn, source, valid) => ({ quote, matchedIn, source, valid })

export const CLASSIFY_GUARD_FIXTURES = [
  // ── 1. 指代类：当前输入是唯一分类对象，历史只作背景 ───────────────────────
  {
    id: 'referent-plan-above',
    category: 'referent',
    desc: '指代「上面提到的那个方案」；历史里的方案字母不得覆盖当前输入的诉求',
    raw_input: '上面提到的那个方案怎么样?能不能落地?',
    context_turns: [
      { role: 'user', text: '我在方案 A(本地 ComfyUI)和方案 B(云 API)之间纠结。' },
      { role: 'assistant', text: '我建议直接用方案 B 的云 API,省去本地部署。' },
      { role: 'user', text: '先别急着定,我还想再比较一下成本。' },
    ],
    mock_output:
      '{"prompt_type":"review","confidence_internal":0.63,' +
      '"missing_constraints":["「那个方案」具体所指"],' +
      '"rationale":"用户在评估上文提到的方案",' +
      '"evidence_quotes":["上面提到的那个方案怎么样","我建议直接用方案 B 的云 API"]}',
    expect: {
      type: 'review',
      kept: ['上面提到的那个方案怎么样'],
      dropped: ['我建议直接用方案 B 的云 API'],
      lowConfidence: false,
      resolution: [
        R('上面提到的那个方案怎么样', 'raw', 'USER_EXPLICIT', true),
        R('我建议直接用方案 B 的云 API', 'assistant-only', 'UNKNOWN', false),
      ],
    },
  },

  // ── 2. 多意图：主类型 + 缺口注明，绝不拆分子请求 ─────────────────────────
  {
    id: 'multi-intent-analyze-then-execute',
    category: 'multi-intent',
    desc: '「先分析再执行」——模型给主类型 execution，缺口须注明多意图，不拆子请求',
    raw_input: '帮我分析一下这个需求,然后直接实现出来。',
    context_turns: [],
    mock_output:
      '{"prompt_type":"execution","confidence_internal":0.7,' +
      '"missing_constraints":["验收标准"],' +
      '"rationale":"主诉求是实现",' +
      '"evidence_quotes":["直接实现出来"]}',
    expect: {
      type: 'execution',
      kept: ['直接实现出来'],
      dropped: [],
      lowConfidence: false,
      multiIntent: true,
      missingIncludes: ['验收标准'],
      resolution: [R('直接实现出来', 'raw', 'USER_EXPLICIT', true)],
    },
  },

  // ── 3. assistant 长讨论仅背景：助手建议不得变成用户 explicit ──────────────
  {
    id: 'assistant-long-discussion-background',
    category: 'assistant-bg',
    desc: 'assistant 连续长建议（MiniMax API / 512x512）；用户只说「先记录、没决定」',
    raw_input: '先记录一下,我还没决定。',
    context_turns: [
      { role: 'assistant', text: '建议一:采用 MiniMax API 处理视频生成,支持 6 秒短片。' },
      { role: 'assistant', text: '建议二:如果显存不足,可以降到 512x512 分辨率。' },
      { role: 'assistant', text: '综合来看我推荐 MiniMax API + 512x512 的组合,这样最稳妥。' },
      { role: 'user', text: '嗯,我看看。' },
    ],
    mock_output:
      '{"prompt_type":"planning","confidence_internal":0.55,' +
      '"missing_constraints":["目标未确定"],' +
      '"rationale":"用户仍在收集信息,尚未决定",' +
      '"evidence_quotes":["MiniMax API + 512x512 的组合","嗯,我看看"]}',
    expect: {
      type: 'planning',
      kept: ['嗯,我看看'],
      dropped: ['MiniMax API + 512x512 的组合'],
      lowConfidence: true,
      resolution: [
        // 助手的完整建议虽在历史上,但绝不是用户 explicit —— invalid / UNKNOWN。
        R('MiniMax API + 512x512 的组合', 'assistant-only', 'UNKNOWN', false),
        // 上下文里用户自己的发言可作为 CONTEXT_EXPLICIT,但绝不是本轮 raw。
        R('嗯,我看看', 'context-user', 'CONTEXT_EXPLICIT', true),
      ],
    },
  },

  // ── 4. 明确否定类：只有用户自己的否定发言能作为排除依据 ─────────────────
  {
    id: 'user-explicit-negation',
    category: 'negation',
    desc: '用户明确否定付费 API 与 CUDA-only；assistant 的付费建议不得被当作用户决定',
    raw_input: '不要用付费 API,全部本地跑;另外别用 CUDA-only 的方案。',
    context_turns: [{ role: 'assistant', text: '我可以帮你接入 MiniMax 付费 API。' }],
    mock_output:
      '{"prompt_type":"planning","confidence_internal":0.75,' +
      '"missing_constraints":[],' +
      '"rationale":"用户明确排除付费 API 与 CUDA-only",' +
      '"evidence_quotes":["不要用付费 API","别用 CUDA-only 的方案","我可以帮你接入 MiniMax 付费 API"]}',
    expect: {
      type: 'planning',
      kept: ['不要用付费 API', '别用 CUDA-only 的方案'],
      dropped: ['我可以帮你接入 MiniMax 付费 API'],
      lowConfidence: false,
      resolution: [
        R('不要用付费 API', 'raw', 'USER_EXPLICIT', true),
        R('别用 CUDA-only 的方案', 'raw', 'USER_EXPLICIT', true),
        R('我可以帮你接入 MiniMax 付费 API', 'assistant-only', 'UNKNOWN', false),
      ],
    },
  },

  // ── 5. 当前请求 vs 历史话题：当前输入推翻历史主题 ───────────────────────
  {
    id: 'current-request-overrides-history-topic',
    category: 'current-vs-history',
    desc: '历史在聊「规划行程」，当前输入改口「写一首诗」；主类型必须是 creative',
    raw_input: '算了,直接帮我写一首关于秋天的诗。',
    context_turns: [
      { role: 'user', text: '帮我规划一个旅游行程吧。' },
      { role: 'assistant', text: '好的,我先列出行前准备与每日路线。' },
    ],
    mock_output:
      '{"prompt_type":"creative","confidence_internal":0.88,' +
      '"missing_constraints":["诗歌长度"],' +
      '"rationale":"当前请求是创意写作,历史规划话题已被推翻",' +
      '"evidence_quotes":["直接帮我写一首关于秋天的诗","帮我规划一个旅游行程"]}',
    expect: {
      type: 'creative',
      kept: ['直接帮我写一首关于秋天的诗', '帮我规划一个旅游行程'],
      dropped: [],
      lowConfidence: false,
      resolution: [
        R('直接帮我写一首关于秋天的诗', 'raw', 'USER_EXPLICIT', true),
        // 历史话题只能算上下文已确认，不能冒充本轮 explicit。
        R('帮我规划一个旅游行程', 'context-user', 'CONTEXT_EXPLICIT', true),
      ],
    },
  },
]

/** 需要 fixture 语料覆盖的场景类别（测试里断言齐全性）。 */
export const REQUIRED_GUARD_CATEGORIES = [
  'referent',
  'multi-intent',
  'assistant-bg',
  'negation',
  'current-vs-history',
]

/**
 * 稳定输入（跨 fixture 复用的「当前输入多次同结果」抽查语料）。
 * 刻意是单意图（只有 planning 关键词「方案」，无 execution 关键词）:
 * 既验证确定性，也作为「不得把单意图误判成多意图」的对照。
 */
export const STABILITY_RAW_INPUT = '帮我调研本地部署方案的显存占用差异。'
