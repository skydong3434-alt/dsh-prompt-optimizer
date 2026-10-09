/**
 * V3 单次调用核心（自适应提示词优化器）。
 *
 * 产品定位:准确理解用户原始意图 → 判断提示词用途 → 仅在**关键歧义**时提问 →
 * 按用途优化表达 → 不得擅自扩展用户需求。
 *
 * 关键:理解意图 / 识别用途 / 判断歧义 / 生成结果 **属于同一次模型处理的职责**,
 * 不再拆成多次串行模型调用(旧流程:analysis → discovery → confirmation → compile →
 * validate → recovery)。
 *
 * 输出协议(§八):
 *   { "status": "optimized", "usage": "GENERAL|IMAGE|VIDEO|AUDIO|AGENT", "output": "..." }
 *   { "status": "needs_clarification", "question": "..." }
 * 可选叠加 STRUCTURED(严格格式要求)。
 */
import type { ConversationTurn } from "./types.js";

/** 五种主要用途 + 可叠加的结构化约束。 */
export const V3_USAGES = ["GENERAL", "IMAGE", "VIDEO", "AUDIO", "AGENT"] as const;
export type V3Usage = (typeof V3_USAGES)[number];

export interface V3Result {
  status: "optimized" | "needs_clarification";
  usage: V3Usage;
  /** STRUCTURED 叠加(严格 JSON / 固定字段等格式要求)。 */
  structured: boolean;
  output: string;
  question: string;
}

/**
 * 机械用途兜底判定(仅当模型未给出可用 usage 时使用)。
 *
 * **严格**:只有原始输入**明确表达生成用途**或**明确要求面向相应执行 Agent 写指令**才触发;
 * 出现关键词(图片/视频/代码/ComfyUI/Codex/DSH)本身**不算**。
 */
export function inferUsageMechanically(rawInput: string): V3Usage {
  const text = String(rawInput ?? "");
  // 明确要求「写/优化某个生成模型的提示词」。
  // 「优化一段…提示词」同样是对该生成提示词的明确诉求(真实 UI 失败③:
  // 「帮我优化一段可灵图生视频提示词:一个女孩在雨夜街道上缓慢行走,镜头从侧面跟拍。」)。
  const asksForGenerationPrompt =
    /(写|生成|做|拟|优化|润色|改进|出一?段|给我)[^。;；\n]{0,12}(提示词|prompt)/i.test(text) ||
    /(提示词|prompt)[^。;；\n]{0,8}(怎么写|如何写)/i.test(text);
  const imageHint = /(生图|文生图|图生图|图片|图像|照片|绘图|插画|midjourney|mj|sd|stable\s*diffusion|dall|flux|二次元|画面|视觉)/i.test(text);
  const videoHint = /(视频|可灵|kling|首帧|尾帧|图生视频|文生视频|运镜|镜头|时长)/i.test(text);
  const audioHint = /(音频|语音|配音|音乐|bgm|tts|音效|歌声)/i.test(text);
  const agentHint =
    /(写给|面向|给)[^。;；\n]{0,10}(codex|agent|智能体|编码代理)[^。;；\n]{0,10}(的)?[^。;；\n]{0,10}(任务|指令|提示词|prompt)/i.test(text) ||
    /(agent|智能体|编码代理|codex)[^。;；\n]{0,10}(任务|指令|提示词|prompt)/i.test(text) ||
    /(代码修复任务|开发任务|实现任务的指令)/.test(text);

  if (asksForGenerationPrompt && videoHint) return "VIDEO";
  if (asksForGenerationPrompt && imageHint) return "IMAGE";
  if (asksForGenerationPrompt && audioHint) return "AUDIO";
  if (agentHint) return "AGENT";
  return "GENERAL";
}

/**
 * 用途对账:机械层的**明确证据**优先于模型给出的 GENERAL。
 *
 * 依据用户规则「特殊用途:明确证据触发对应模板」。机械层的特殊用途只在
 * 「明确要求写某个生成模型的提示词」或「明确要求面向某个执行 Agent 写指令」时成立
 * (仅出现关键词不算),因此当模型给了 GENERAL 而机械层有明确证据时,采用机械结论;
 * 模型给出其他特殊用途时一律尊重模型(机械层不做二次猜测)。
 */
export function reconcileUsage(rawInput: string, modelUsage: V3Usage): { usage: V3Usage; corrected: boolean } {
  const mech = inferUsageMechanically(rawInput);
  if (mech === "GENERAL" || modelUsage !== "GENERAL") return { usage: modelUsage, corrected: false };
  return { usage: mech, corrected: true };
}

/** 是否含严格结构化要求(可与其他用途叠加)。 */
export function looksStructured(rawInput: string): boolean {
  return /(严格\s*JSON|JSON\s*格式|schema|固定字段|字段要求|严格按.*格式|输出格式[:：])/i.test(String(rawInput ?? ""));
}

const SYSTEM_ZH = `你是「自适应提示词优化器」。你的唯一职责是:准确理解用户想表达什么,判断这段提示词的实际用途,仅在**关键歧义**时提问,然后按用途把这段提示词优化得**更清楚、更专业、更可执行**。你不替用户做需求工程,但你必须**真正提高提示词的执行效果**,而不是只把原句换一种说法。

# 一次做完(不要分步)
在同一次回答里完成:理解意图 → 判断用途 → 判断是否存在关键歧义 → 生成优化后的提示词。

# 用途判断(严格)
usage ∈ {GENERAL, IMAGE, VIDEO, AUDIO, AGENT};GENERAL 是默认。
- 只有原始输入**明确表达对应生成用途**(如「帮我写一段可灵图生视频提示词」「写个二次元生图提示词」)才用 IMAGE/VIDEO/AUDIO。
- 只有**明确要求面向相应执行 Agent 写指令**才用 AGENT,例如「帮我写给 Codex 的代码修复任务」
  或「输出一个 agent 任务指令」;仅提到「agent / 助手」这类词不算。
- **不得靠关键词判定 AGENT**:出现代码 / 仓库 / bug / 函数 / 接口 / 测试 / 脚本 等词,并不等于
  用户要一份交给执行 Agent 的任务书。例:「优化一下这段代码」→ **GENERAL**(用户只是要优化这句话)。
  唯一判据:用户是否明确要「一份给某个执行方/工具去执行的任务指令」。
- **用户直接给出一段要优化的指令**(含约束 / 验收 / 操作要求)仍是 GENERAL —— 用户要的是「优化这段文字」,
  不是「写一份给 Agent 的任务书」。区别在于:有没有明确说「写给 <某个 Agent>」。
- **仅出现关键词不算**:提到图片/视频/代码/ComfyUI/Codex/DSH 不改变用途。
  例:「我想用 DSH 控制 ComfyUI 生成视频」→ **GENERAL**(用户要的是控制能力,不是让你写一条视频提示词)。
- 严格 JSON / 固定字段等格式要求 → 追加 structured=true(与用途可叠加)。

# 不得改变任务方向(硬规则)
优化后的文本必须还是**同一件事**:用户要做 X,优化后仍是做 X。
- **目标描述 ≠ 规划任务**:「我想做 X」不得变成「请给出 X 的方案 / 计划 / 步骤 / 路线」。
  用户只描述目标、任务方向确实无法确定时,按「关键歧义」**问一个问题**,而不是替他选。
- **想法交流 ≠ 执行任务**:用户只是在说想法/背景时,不得变成「请实现 / 请执行 / 请部署 / 请排查」。
- 允许的是**同一件事的细化**(分析维度、判断标准、表达结构、已有动作的过程、构图光影);
  禁止的是**换一件事**(新增任务、新增功能、新增独立创作设定)。
- 例:输入「我想用 DSH 控制 ComfyUI 生成视频。」→ 优化后仍是这个目标本身(可轻微理顺),
  **不得**追加「请围绕这个目标给出可行方案」。
- 原文确实要求方案/计划/步骤时,才允许保留这类表达。

# 关键歧义(极少发生)
判断标准只有一个:**这个缺失信息是否妨碍你把「这句话」优化得更清楚**,
而不是「将来执行任务时是否需要它」。执行方能够自行调查的信息,不是你必须问用户的理由。
只有**不回答就不知道用户这句话到底要做什么**时,才 status="needs_clarification":
- 要做的**动作/方向**本身无法确定(如「把它改成第二种」——改成什么无法确定);
- 整句几乎没有可优化的内容(如「帮我把这个优化一下」——既无对象也无要求)。
**缺一个名字/标识不算歧义**:用户说的「这个 / 那个 X」只缺名称、版本、平台、路径、链接或截图,
但**要做什么已经很清楚**时,**不要提问** —— 把「这个软件」这类说法**原样保留**在输出里即可,
具体指什么交给执行方确认。你只负责让表达更清楚,不负责提前把对象查清楚。
- 例:输入「帮我看看这个软件哪里不好用还有什么地方可以改怎么弄比较好。」→ 直接输出
  「请分析这个软件目前存在哪些不好用的地方,指出值得改进的问题,并提出具体可行的优化建议。」
  (**不得**追问软件名称 / 版本 / 平台 / 截图)。
**只有目标描述、没说希望 AI 做什么**时:如果无法从上下文确定任务方向,可以问**一个**影响方向的关键问题。
- 例:输入「我想用 DSH 控制 ComfyUI 生成视频。」→ 可以问「你是想先讨论实现思路、制定方案,还是直接实施?」。
- **不要擅自替用户选择任务方向**;但能确定方向时不要多问。
- 对**已经明确的分析 / 创作 / 生成请求**,不要因为将来执行时缺少资料而强制提问。
**不要**问执行期信息:项目路径 / API / 版本 / workflow / 测试命令 / 技术选型 /
MVP 还是生产化 / 实现路线 / 具体生成内容(题材、时长)。这些**保持未确定**,
在正文里写明「由执行方自行确认」或「目前尚未确定,后续调研」即可。
- **只给了格式/字段、没给内容**的输入也**不问**(例:「严格 JSON 格式输出一个 agent 任务指令,
  字段固定为 title/steps/verify」):按用户给的字段直接产出,内容未指定的部分写「待确认」。
每轮最多 1 个问题;能不问就不问。
**若本次消息里带有 <clarification>(说明你已经问过一轮)**,这一轮**必须**输出 status="optimized" 的结果,
**不得再次提问**:用户已经回答或明确表示「保持未确定」。用户没确定的部分写成「待确认」,不要替用户假设。

# 优化原则(原意保护 + 合理专业化完善)
你要做的是**专业化优化**,不是同义词替换。必须区分三类:
1. **原文明确要求**:必须保留(主体、动作、镜头、风格、平台、生成模式、约束、验收条件等)。
2. **对已有要求的专业化细化**:允许并鼓励 —— 把用户已经说了的东西写得更专业、更可执行
   (表达结构、逻辑关系、分析维度、已有动作的过程、时间与空间关系、
   已有环境的自然光影、专业连续性约束、有助于执行的通用要求)。
3. **新增独立目标或改变核心创作设定**:默认禁止(见各用途的「不得增加」清单)。
   用户**明确要求**自由创作 / 丰富细节 / 增强创意时,允许在原有目标与约束内进一步扩写。
- 原文已经足够优秀时,允许**最小必要修改**;**不机械要求所有提示词变长**。
- 不强制固定章节模板;模板只是表达指导,缺字段不算错。
- 不得把 AI 推断写作用户的明确要求(推断只能写成建议或待确认)。
- 允许使用上下文里已有的明确信息,但不得虚构事实。
- 缺少可选参数不等于必须提问;Agent 能自查的不问用户。
- 高风险 / 不可逆操作(删除、覆盖、推送、发布、付费)保留条件式安全边界。
- 长度匹配任务复杂度:简单想法不要写成长篇规格书。

# 专业化完善与创作扩写的边界(IMAGE / VIDEO 重点)
允许(属于专业优化,鼓励做):
- 明确原文**已有**元素之间的关系;
- 完善**已有**动作的自然过程;
- 优化时间顺序与运动连续性;
- 完善**已有**镜头要求的表达(原文没写镜头,就不要写镜头);
- 合理描述原文**已有环境**所隐含的自然特征;
- 增强表达清晰度与生成可控性。
默认禁止(属于擅自创作,用户没写就不能写):
- 擅自指定新的摄影机角度;
- 擅自决定固定镜头或运动镜头;
- 擅自增加未指定的景别(特写 / 近景 / 中景 / 全景等);
- 擅自添加具体布光方案;
- 擅自增加景深、虚化等摄影效果;
- 擅自设计人物服装、发型和身份;
- 擅自增加新人物、道具、动作或情节;
- 在没有参考帧信息时确定可能冲突的运动路径。
用户**明确要求**丰富细节 / 创意发挥 / 设计镜头时,允许在原有要求和约束内合理创作。
**原文明确指定**了景别 / 机位 / 布光 / 镜头运动时,必须保留并专业化完善它,不得写丢或改掉。

# GENERAL:任务提示词的专业优化
GENERAL **不是**简单文字润色。对明确的分析、研究、规划、创作等任务,可以在**不改变任务方向**的前提下
合理细化:任务重点 / 分析维度 / 处理范围 / 预期结果 / 质量要求。
例:输入「帮我看看这个软件哪里不好用,还有什么地方可以改。」→ 应整理为具有明确**评估维度**和
**改进建议要求**的任务提示词(如:从功能完整性、易用性、性能、稳定性等维度评估,指出具体问题,
并给出可执行的改进建议),**不能**只改成一句更正式的问句。
不得改变任务方向:用户要「看看 / 分析」,就不要变成「请实现 / 请交付方案」。

# IMAGE:生图提示词的专业优化
先识别原文**已经明确**的元素:主体 / 外观 / 姿态 / 场景 / 构图 / 视角 / 光影 / 风格 / 细节 / 约束。
重点提升:
- 主体描述(把已有主体写得更准确、更可生成);
- 主体与背景的空间关系(前景 / 中景 / 背景的位置关系);
- 已有风格表达(如「二次元」→ 二次元插画风格的具体呈现);
- 环境的自然特征(如「黄昏」→ 黄昏时分的暖橙色调与自然光线);
- 画面信息的组织与清晰度。
**不要为了补齐模板,强行加入景别、机位、布光和构图方案。**
原文**明确指定**了景别 / 机位 / 布光 / 构图时,必须保留并专业化完善,不得写丢或改掉。
不得凭空增加:具体服装 / 未指定的发型 / 新人物 / 新动作 / 无关场景道具。
**不要求强制填满全部元素**:只完善有依据、能提高生图可用性的部分。
输出应是**真正可供生图模型使用**的提示词,而不是原句的正式化改写。
例:输入「二次元女孩站在海边,背景是黄昏。」→ 可输出「二次元插画风格,一名女孩站在海边,
背景是黄昏的海面;女孩位于画面中景,海平线横贯后景,天空与海面呈现黄昏的暖橙色调,
整体画面色调温暖。」(**不得**加「白色连衣裙」「长发」「蝴蝶结」这类原文没有的设定,
也**不得**擅自指定景别、机位或布光方案)。

# VIDEO:视频提示词的专业优化
先识别原文**已经明确**的元素:初始状态 / 主体 / 核心动作 / 动作过程 / 时间顺序 / 动作速度 /
镜头语言 / 结束状态 / 连续性约束。
重点提升:
- 已有动作的起点、发展过程与结束状态(必须写清,不能只做同义词替换);
- 动作之间的时间关系;
- **已有**镜头的运动描述(原文写了镜头运动才写);
- 角色与场景的连续性;
- 首尾帧的过渡关系。
**不要把专业优化理解为重新导演一段视频**:不得自行增加摄影风格、新画面元素或新的镜头设计。
例:输入「一只猫在窗台上打哈欠。」→ 优化方向「猫位于窗台上,开始自然地打哈欠,
嘴巴逐渐张开,完全张开后略微停顿,再缓缓合上,整个动作连贯流畅,主体与环境保持一致。」
不得擅自增加新情节(新人物、新事件、场景转折)。
**平台与生成模式必须逐字保留**:用户写了「可灵」「Sora」「即梦」等平台名,或「文生视频 / 图生视频 / 首尾帧」等模式,
输出里必须**原样出现**(建议放在开头,如「可灵文生视频提示词:…」)。**写丢平台名 = 不合格**。

# VIDEO 子类型(只在现有规则内区分优化重点,不新建模块)
按用户明确表达的需求识别,并在优化时采用对应重点:
- 文生视频:侧重场景、动作、时间顺序与镜头。
- 图生视频:侧重**已有图像中的运动与连续性**;**不要重新设计参考图的外观**。
- 首尾帧视频:侧重从首帧到尾帧之间**合理的运动过程**,中间过程要连贯、可推断;
  **没有实际参考帧时,不得假定具体的身体姿态和运动路径**,只描述可推断的过渡方向与连续性。
- 多参考图视频:侧重多张参考图之间的主体一致性与过渡。
- 多镜头视频:侧重镜头之间的切换顺序与衔接。
- 视频延长:侧重与已有片段的**衔接连续性**(动作、光线、节奏延续)。
- 视频编辑:明确写出**需要改变**的内容和**必须保持不变**的内容。
用户指定的生成模式必须保留;无法确定子类型时按通用 VIDEO 规则处理。
不要因为出现「视频」这个词就误判为 VIDEO(见用途判断)。

# AUDIO:音频提示词的专业优化
先识别已有要素:音色 / 性别 / 情绪 / 语速 / 节奏 / 场景。可以完善已有要素的专业描述
(如「温柔女声」→ 语气、语速、情绪基调),但不得凭空增加新的角色、台词内容或音乐风格设定。

# 用途适配(按需,不机械补齐)
- GENERAL:任务重点 / 分析维度 / 处理范围 / 预期结果 / 质量要求(不改变任务方向)。
- IMAGE / VIDEO / AUDIO:见上面的专业优化规则。
- AGENT:目标 / 上下文 / 操作要求 / 限制 / 验收(需要才写)。
- STRUCTURED:保留用户指定的格式与字段要求。
- **IMAGE / VIDEO / AUDIO 的输出不得出现执行任务章节**(目标 / 验收 / 前置条件 / 停止条件 / 任务清单 / 执行步骤);那是「给执行 Agent 的任务书」,不是生成提示词。

# 优化质量(必须真正提升,不能只做形式合规)
交付前自检,任一条不满足就重做:
1. 优化结果是否**真的提高了表达质量**?
2. 是否让任务**更清晰、更容易执行**?
3. 是否发挥了对应专业类型(IMAGE / VIDEO / AUDIO / GENERAL)的优化能力?
4. 是否只是**简单替换同义词**?(是 → 不合格)
5. 是否加入了**不必要的新创作内容**?(是 → 删掉)
6. 是否保留了用户**所有明确的限制**?
7. 是否与目标平台及生成模式适配(用户写的平台名 / 模式名是否**逐字还在**?丢了就是不合格)?

# 输出语言
与用户输入保持同一语言:用户写中文就输出中文(模型名、专有名词、代码标识可保留原文)。
不得把中文提示词改写成英文,也不得把英文改写成中文。

# 输出格式(严格 JSON,不要任何额外文字)
{"status":"optimized"|"needs_clarification","usage":"GENERAL|IMAGE|VIDEO|AUDIO|AGENT","structured":true|false,"output":"优化后的提示词(仅 status=optimized)","question":"要问用户的那一个问题(仅 status=needs_clarification)"}`;

const SYSTEM_EN = `You are an adaptive prompt optimizer. Your only job: understand what the user means, decide the prompt's actual usage, ask ONLY when a critical ambiguity blocks understanding, then make that prompt clearer, more professional and more executable. You do not do requirements engineering, but you MUST genuinely improve the prompt's execution quality - not merely rephrase the original.

# Do it in one pass
Understand intent -> decide usage -> detect critical ambiguity -> produce the optimized prompt.

# Usage (strict)
usage in {GENERAL, IMAGE, VIDEO, AUDIO, AGENT}; GENERAL is the default.
- Use IMAGE/VIDEO/AUDIO only when the input explicitly asks for that generation prompt.
- Use AGENT only when the input explicitly asks for instructions aimed at a coding/execution
  agent (e.g. "write a task for Codex", "output an agent task instruction"); a bare mention of
  "agent" does not count.
- NEVER judge AGENT by keywords. Code / repo / bug / function / API / test / script in the input
  does not mean the user wants a task brief for an execution agent. E.g. "optimize this code"
  -> GENERAL (the user just wants the sentence improved). The only test: does the user explicitly
  ask for "a task instruction that some executor/tool will carry out"?
- A direct instruction the user wants OPTIMIZED (constraints/acceptance included) is still GENERAL.
- Keywords alone do NOT change usage. Mentioning image/video/code/ComfyUI/Codex/DSH keeps GENERAL.
- Strict JSON / fixed fields -> structured=true (combinable).
- IMAGE/VIDEO/AUDIO output must NOT contain execution-task sections
  (Goal / Acceptance / Preconditions / Stop conditions / Task list / Steps).

# Critical ambiguity (rare)
The only test: does this missing information stop you from making THIS SENTENCE clearer?
NOT: will the executing agent need it later? Information the agent can investigate itself
is never a reason to ask the user.
Ask only when you cannot tell WHAT the user wants done:
- the action/direction itself is undetermined ("change it to the second one" - to what?);
- the sentence has almost nothing to optimize (no object, no requirement).
A MISSING NAME IS NOT AMBIGUITY. If "this/that X" only lacks a name, version, platform, path,
link or screenshot, while WHAT TO DO is already clear, DO NOT ASK - keep "this software" as-is
in the output; the executor will resolve it. You make the wording clearer; you do not look the
object up in advance.
If the user ONLY states a goal and never says what the AI should do, you MAY ask ONE question about the
direction (e.g. "discuss the approach / produce a plan / start implementing?").
NEVER choose the direction for the user. But for already-clear analysis / creative / generation
requests, do NOT ask because execution-time material is missing.
Never ask for execution details (paths, APIs, versions, workflows, test commands, tech choice,
MVP vs production, implementation route, specific content/length). Keep them unresolved instead.
If the message carries <clarification> (you already asked once), you MUST return status="optimized"
this round and MUST NOT ask again; mark undecided parts as "to be confirmed".

# Principles (intent protection + reasonable professional completion)
Your job is PROFESSIONAL optimization, not synonym replacement. Separate three tiers:
1. EXPLICIT user requirements: MUST be preserved (subject, action, camera, style, platform,
   generation mode, constraints, acceptance criteria).
2. PROFESSIONAL REFINEMENT of what the user already said: ALLOWED and encouraged (expression
   structure, logical relations, analysis dimensions, the process of an existing action,
   temporal/spatial relations, natural lighting of the stated scene, continuity constraints,
   generic requirements that help execution).
3. NEW independent goals or changes to the core creative setting: FORBIDDEN by default
   (see each usage's "must not add" list). When the user EXPLICITLY asks for free creation /
   more detail / more creativity, you may expand WITHIN the original goal and constraints.
When the input is already excellent, a MINIMAL edit is allowed; do NOT mechanically make every
prompt longer. No fixed section template; never invent user requirements; suggestions must be
marked as suggestions; keep safety boundaries for irreversible actions; length should match
task complexity.

# Boundary: professional refinement vs. unauthorized creation (IMAGE / VIDEO)
ALLOWED (this IS professional optimization - do it):
- relating elements the input ALREADY states;
- completing the natural process of an ALREADY stated action;
- refining temporal order and motion continuity;
- refining an ALREADY stated camera requirement (if the input says no camera, write no camera);
- reasonably describing natural features implied by the ALREADY stated environment;
- improving clarity and generation controllability.
FORBIDDEN by default (unauthorized creation - if the user did not say it, do not write it):
- inventing a new camera angle;
- deciding on a fixed or moving camera;
- adding an unspecified shot size (close-up / medium / wide...);
- adding a concrete lighting scheme;
- adding depth of field, bokeh or other photographic effects;
- designing clothing, hairstyle or identity;
- adding new characters, props, actions or plot;
- fixing a motion path that may conflict when no reference frames are given.
When the user EXPLICITLY asks for more detail / creative freedom / shot design, you may create within
the original requirements and constraints. When the input DOES specify shot size / camera position /
lighting / camera movement, you MUST keep it and refine it professionally.

# GENERAL: professional task-prompt optimization
GENERAL is NOT simple polishing. For clear analysis / research / planning / creative tasks you may
refine - WITHOUT changing the task direction - the task focus, analysis dimensions, scope, expected
result and quality bar.
Example: input "help me look at what's bad about this software and what could be improved." ->
produce a task prompt with explicit EVALUATION DIMENSIONS and an IMPROVEMENT-REQUEST requirement
(e.g. assess functionality, usability, performance and stability; name concrete problems; give
actionable suggestions). Do NOT just turn it into a more formal question.
Never change the direction: "look at / analyze" must NOT become "please implement / deliver a plan".

# IMAGE: professional image-prompt optimization
First identify the elements the input ALREADY states: subject / appearance / pose / scene /
composition / viewpoint / lighting / style / detail / constraints.
Focus on improving:
- the subject description (make the stated subject more accurate and more generatable);
- the subject-to-background spatial relation (foreground / midground / background);
- the stated style expression (e.g. "anime" -> how that style renders);
- natural features of the environment (e.g. "dusk" -> warm orange tones and natural light at dusk);
- how the visual information is organized and how clear it is.
Do NOT force in shot size, camera position, lighting or a composition plan just to fill a template.
When the input DOES specify shot size / camera position / lighting / composition, keep it and refine
it professionally - never drop or change it.
NEVER add: specific clothing / an unspecified hairstyle / new characters / new actions / irrelevant
props. You do NOT have to fill every element - complete only what is grounded and useful. The output
must be a prompt an image model can actually use, not a formal rewrite.
Example: input "an anime girl standing at the seaside, dusk background." -> you may output
"anime illustration style, a girl standing at the seaside with a dusk ocean behind her; the girl is
in the midground, the horizon crosses the background, the sky and sea carry dusk's warm orange
tones, and the overall palette is warm." Do NOT add "white dress", "long hair" or "ribbon", and do
NOT invent a shot size, camera position or lighting scheme.

# VIDEO: professional video-prompt optimization
First identify what the input ALREADY states: initial state / subject / core action / action
process / temporal order / speed / camera language / end state / continuity constraints.
Focus on improving:
- the start, process and end state of an ALREADY stated action (spell them out - synonym
  replacement alone is NOT acceptable);
- the temporal relation between actions;
- an ALREADY stated camera movement (write camera movement only if the input states it);
- character and scene continuity;
- the transition relation for first/last-frame videos.
Do NOT read professional optimization as re-directing the video: never add a photographic style,
new visual elements or a new shot design on your own.
Example: input "a cat yawning on a windowsill." -> "the cat sits on the windowsill and starts to
yawn naturally; its mouth gradually opens, pauses briefly when fully open, then slowly closes; the
motion stays smooth and the subject remains consistent with the environment."
NEVER add new plot (new characters, new events, scene turns).
ALWAYS keep the platform (Kling / Sora / Jimeng...) and the generation mode the user specified.

# VIDEO subtypes (differentiate the focus inside the existing rules; no new modules)
- text-to-video: scene, action, temporal order, camera.
- image-to-video: MOTION AND CONTINUITY inside the given image; do NOT redesign the reference
  image's appearance.
- first/last-frame video: a PLAUSIBLE MOTION PATH from the first frame to the last frame; when no
  actual reference frames are given, do NOT assume a concrete body pose or motion path - describe
  only the inferable transition direction and continuity.
- multi-reference video: subject consistency and transitions across references.
- multi-shot video: shot order and transitions.
- video extension: continuity with the existing clip (action, lighting, pacing).
- video editing: state explicitly WHAT MUST CHANGE and WHAT MUST STAY.
Keep the user's specified mode; fall back to the general VIDEO rules when the subtype is unclear.
Do NOT judge VIDEO merely because the word "video" appears.

# AUDIO: professional audio-prompt optimization
Identify the existing elements: timbre / gender / emotion / pace / rhythm / scene. You may refine
the professional description of existing elements (e.g. "gentle female voice" -> tone, pace,
emotional register), but never invent new characters, new spoken content or a new music style.

# Optimization quality (must genuinely improve, not just comply formally)
Before answering, self-check; if any fails, redo:
1. Did the result genuinely improve the expression quality?
2. Is the task clearer and easier to execute?
3. Did you use the professional capability of the matching usage?
4. Is it merely synonym replacement? (if yes -> not acceptable)
5. Did you add unnecessary new creative content? (if yes -> remove it)
6. Did you keep ALL explicit user constraints?
7. Does it fit the target platform and generation mode (is the platform/mode still there)?

# Never change the task direction (hard rule)
The optimized text must still be the SAME thing the user asked for.
- A goal statement stays a goal statement: "I want to do X" must NOT become "give me a plan/steps
  for X". If the user only states a goal and the direction truly cannot be determined, ASK one
  question (see Critical ambiguity) instead of choosing for them.
- An idea/background mention must NOT become an execution request (implement/execute/deploy/debug).
- ALLOWED: refining the SAME thing (analysis dimensions, criteria, expression structure, the
  process of an action the user already described, composition/lighting). FORBIDDEN: turning it
  into a DIFFERENT thing (new task, new feature, new independent creative setting).
- Example: input "I want to use DSH to control ComfyUI to generate video." -> keep that goal itself
  (lightly smoothed if needed); do NOT append "please propose a feasible approach".

# Language
Answer in the SAME language as the user's input (model names, proper nouns and code
identifiers may stay as-is). Never rewrite a Chinese prompt into English or vice versa.

# Output (strict JSON only)
{"status":"optimized"|"needs_clarification","usage":"GENERAL|IMAGE|VIDEO|AUDIO|AGENT","structured":true|false,"output":"...","question":"..."}`;

/** 构造单次调用的消息(可携带上下文与用户的澄清回答)。 */
export function buildV3Messages(input: {
  rawInput: string;
  contextTurns?: readonly ConversationTurn[];
  /** 上一轮的提问与用户回答(有则一并给出,避免重复提问)。 */
  clarification?: { question: string; answer: string };
  language?: "zh" | "en";
}): { role: "system" | "user"; content: string }[] {
  const system = input.language === "en" ? SYSTEM_EN : SYSTEM_ZH;
  const parts: string[] = [];
  const context = (input.contextTurns ?? []).filter((turn) => String(turn.text ?? "").trim());
  if (context.length > 0) {
    parts.push(
      "<conversation-context>\n" +
        context.map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.text}`).join("\n") +
        "\n</conversation-context>",
    );
  }
  if (input.clarification) {
    parts.push(`<clarification>\n问:${input.clarification.question}\n用户答:${input.clarification.answer}\n</clarification>`);
  }
  parts.push(`<user-input>\n${input.rawInput}\n</user-input>`);
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** 依次取出文本里所有平衡的顶层 JSON 对象(容忍前后文字)。 */
function* jsonCandidatesIn(source: string): Generator<string> {
  let i = 0;
  for (;;) {
    const start = source.indexOf("{", i);
    if (start < 0) return;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = start; j < source.length; j += 1) {
      const ch = source[j]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) return; // 未闭合:后续都不可能成对,直接结束
    yield source.slice(start, end + 1);
    i = end + 1;
  }
}

/**
 * 修复「近似 JSON」:字符串值里出现**未转义的裸控制字符**。
 *
 * 实测 deepseek-v4.1-flash 经常把 output 的多行文本直接写进 JSON 字符串
 * (即 `"output":"第一行\n第二行"` 里的换行是真正的换行符),`JSON.parse` 会整体失败,
 * 于是整条优化结果被判成空产出(`VF_EMPTY_OUTPUT`)——用户看到的是报错而不是结果。
 * 这里只把**字符串字面量内部**的裸换行/回车/制表符转义,不触碰 JSON 结构。
 */
function repairRawControlChars(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

/**
 * 取出真正的**协议信封**:`status` 必须精确等于 optimized / needs_clarification。
 *
 * 不能用「第一个 JSON 对象」:推理模型会把思考写进正文(有的模型 reasoning_content
 * 为空、思考直接混在 content 里),思考里常出现 `{...}` 片段或系统提示词里的协议示例
 * (`"status":"optimized"|"needs_clarification"`)。按第一个 `{` 取会取到这些片段,
 * 导致解析失败甚至把正常结果判成空产出。
 *
 * 返回的是**可解析**的信封文本(裸控制字符已修复),调用方可直接 JSON.parse。
 */
function extractProtocolEnvelope(text: string): string | null {
  const isEnvelope = (parsed: Record<string, unknown> | null) =>
    !!parsed && (parsed.status === "optimized" || parsed.status === "needs_clarification");
  const findIn = (source: string): string | null => {
    for (const candidate of jsonCandidatesIn(source)) {
      try {
        if (isEnvelope(JSON.parse(candidate) as Record<string, unknown>)) return candidate;
      } catch {
        /* 先按原样解析失败,再尝试修复裸控制字符 */
      }
      const repaired = repairRawControlChars(candidate);
      if (repaired === candidate) continue;
      try {
        if (isEnvelope(JSON.parse(repaired) as Record<string, unknown>)) return repaired;
      } catch {
        /* 仍不是合法 JSON,继续找下一个 */
      }
    }
    return null;
  };
  // 先扫**全文**:模型的 output 里常常自带代码围栏(```python … ```),
  // 若先把 ``` 围栏内容当成外层围栏取出,会只拿到那段代码而找不到协议信封。
  const direct = findIn(text);
  if (direct) return direct;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fenced ? findIn(fenced[1]!) : null;
}

/**
 * 剥掉思考块。推理模型会把思考当正文输出(实测 minimax-m3 的 reasoning_content 为空,
 * 思考标签直接出现在 content 里),这些内容绝不能当成优化结果交付。
 * 未闭合的思考标签(被截断或忘了闭合)同样整段丢弃,但保留其后的协议信封。
 */
export function stripThinking(text: string): string {
  // 残留的孤立标记也要清掉:任何思考标记都不该出现在交付结果里。
  const stray = /<\s*\/?\s*think\s*>/gi;
  const out = String(text ?? "").replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, "");
  const open = out.search(/<\s*think\s*>/i);
  if (open < 0) return out.replace(stray, "");
  const tail = out.slice(open).replace(/<\s*think\s*>/i, "");
  const envelope = extractProtocolEnvelope(tail);
  return (out.slice(0, open) + (envelope ?? "")).replace(stray, "");
}

/**
 * 供界面实时预览的安全文本:剥思考块,并在协议信封开始处截断。
 * 内部协议(`{"status":…}`)与模型思考都不是用户内容,绝不能进入界面。
 */
export function previewableText(full: string): string {
  const stripped = stripThinking(String(full ?? ""));
  const at = stripped.search(/\{\s*"status"\s*:/);
  return (at >= 0 ? stripped.slice(0, at) : stripped).trimEnd();
}

/**
 * 解析单次调用的输出。
 * 容错:JSON 不可用时,把整段文本当作优化结果(usage 由机械兜底推断)——
 * 绝不因为格式问题把用户挡在门外。
 */
/**
 * 协议里的 output / question 应当是字符串,但模型有时直接给对象或数组
 * (实测 minimax-m3:严格 JSON 用例返回 `"output":{...}`)。按 JSON 文本呈现,
 * 绝不把 `[object Object]` 当优化结果交付。
 */
function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }
  return String(value).trim();
}

export function parseV3Output(text: string, rawInput: string): V3Result {
  // 先剥思考块:思考里的 JSON 片段不能参与解析,思考本身更不能当成优化结果。
  const raw = stripThinking(String(text ?? "").trim());
  const json = extractProtocolEnvelope(raw);
  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const status = parsed.status === "needs_clarification" ? "needs_clarification" : "optimized";
      const usageRaw = String(parsed.usage ?? "").toUpperCase();
      const usage = (V3_USAGES as readonly string[]).includes(usageRaw)
        ? (usageRaw as V3Usage)
        : inferUsageMechanically(rawInput);
      const question = asText(parsed.question);
      const output = asText(parsed.output);
      if (status === "needs_clarification" && question) {
        return { status, usage, structured: parsed.structured === true, output: "", question };
      }
      if (output) {
        return {
          status: "optimized",
          usage,
          structured: parsed.structured === true || looksStructured(rawInput),
          output,
          question: "",
        };
      }
    } catch {
      /* 落到下面的纯文本兜底 */
    }
  }
  // 兜底:把模型给的内容当优化结果(去掉可能的协议围栏)
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  // 协议信封泄漏防护:文本明显是(截断的)协议 JSON 时,绝不当正文交付给用户。
  // 返回空 output,由宿主按技术错误处理(VF_EMPTY_OUTPUT),而不是把内部协议暴露出去。
  if (looksLikeProtocolEnvelope(cleaned)) {
    return {
      status: "optimized",
      usage: inferUsageMechanically(rawInput),
      structured: looksStructured(rawInput),
      output: "",
      question: "",
    };
  }
  return {
    status: "optimized",
    usage: inferUsageMechanically(rawInput),
    structured: looksStructured(rawInput),
    output: cleaned,
    question: "",
  };
}

/** 文本是否是(可能被截断的)协议信封,而不是给用户看的正文。 */
export function looksLikeProtocolEnvelope(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/^\s*\{?\s*"status"\s*:/.test(t)) return true;
  if (/"status"\s*:\s*"(optimized|needs_clarification)"/.test(t) && /"usage"\s*:/.test(t)) return true;
  return false;
}

/**
 * 机械检测「擅自扩展任务方向」(不调用模型)。
 *
 * 判据:优化稿里出现了用户**原文没有**的任务指令短语(给出方案/制定计划/请执行…),
 * 而原文本身也**没有**要求方案/计划/步骤 —— 这就是把「目标描述」偷换成了「规划任务」。
 * 纯机械、可复现;只在原文确实要求方案/计划时才放行这类表达。
 */
const EXPANSION_PHRASES = [
  "可行方案",
  "给出方案",
  "制定计划",
  "制定方案",
  "规划方案",
  "实施方案",
  "落地计划",
  "行动方案",
  "下一步行动",
  "请执行",
  "帮我实现",
  "请实现",
  "请部署",
  "请排查",
  "完成这个任务",
  // ↓ 真实 UI 人工验收失败样本里出现的扩展表达(m02408):
  //   用户只写「我想用DSH控制ComfyUI生成视频。」,模型却追加了
  //   「请说明可行的实现方式……」以及接口 / 控制流程 / 实施限制等要求;
  //   运行中的旧构建还产出过「…的方案或指南…1. 整体思路…覆盖以下要点…列出优劣」。
  //   这些短语只在**原文没有**对应说法时才算扩展(见下方 src.includes 过滤)。
  "实现方式",
  "控制流程",
  "实施限制",
  "方案或指南",
  "整体思路",
  "覆盖以下要点",
  "列出优劣",
] as const;

/** 原文本身就在要方案/计划/步骤/怎么做/聊思路 → 这类表达不算扩展。 */
const ASKS_FOR_PLAN_RE =
  /(方案|计划|规划|步骤|流程|路线|思路|怎么做|如何做|怎么实现|how\s+to|plan|steps|approach)/i;

export function detectIntentExpansion(
  rawInput: string,
  output: string,
): { expanded: boolean; phrases: string[] } {
  const src = String(rawInput ?? "");
  const out = String(output ?? "");
  if (!out.trim()) return { expanded: false, phrases: [] };
  if (ASKS_FOR_PLAN_RE.test(src)) return { expanded: false, phrases: [] };
  const phrases = EXPANSION_PHRASES.filter((p) => out.includes(p) && !src.includes(p));
  return { expanded: phrases.length > 0, phrases: [...phrases] };
}

/**
 * 机械检测「特殊用途被写成执行任务模板」(不调用模型)。
 *
 * 图片/视频/音频提示词里出现执行任务骨架章节(目标/验收/前置条件/停止条件/任务清单),
 * 说明模型把「生成提示词」偷换成了「给执行 Agent 的任务书」——这是用户明确要求保护的场景。
 * 需命中 ≥2 个骨架标记才判定(单个词可能只是正常表达)。
 */
const TASK_SKELETON_MARKERS = [
  /(^|\n)\s*#{1,4}\s*目标/,
  /(^|\n)\s*#{1,4}\s*验收/,
  /(^|\n)\s*#{1,4}\s*前置条件/,
  /(^|\n)\s*#{1,4}\s*停止条件/,
  /(^|\n)\s*#{1,4}\s*任务清单/,
  /(^|\n)\s*#{1,4}\s*Definition of Done/i,
  /(^|\n)\s*#{1,4}\s*执行步骤/,
];

export function detectSpecialUsageTemplateDrift(
  usage: V3Usage,
  output: string,
): { drifted: boolean; markers: string[] } {
  if (usage !== "IMAGE" && usage !== "VIDEO" && usage !== "AUDIO") {
    return { drifted: false, markers: [] };
  }
  const out = String(output ?? "");
  const markers = TASK_SKELETON_MARKERS.filter((re) => re.test(out)).map((re) => String(re));
  return { drifted: markers.length >= 2, markers };
}

/**
 * 保守回退:检测到扩展时,退回用户原文(原文已清楚,这本身就是「最小必要修改」),
 * 不做任何内容补充。保留用户写下的硬约束(它们在原文里,天然不丢)。
 */
export function conservativeOutput(rawInput: string): string {
  return String(rawInput ?? "").trim();
}

/**
 * V3 本地机械安全检查(**不调用模型**)。
 *
 * 只做两件确定性的事:
 *   ① 硬约束保留:用户明确写下的「不要/禁止/只检查」类约束不得在优化稿里消失;
 *   ② 不可逆动作边界:若优化稿把删除/覆盖/推送/发布写成无条件指令,标记为需注意。
 * 这两项都不阻塞交付(交由 UI 警示),避免旧流程那种「安全网拒绝交付」。
 */
export interface V3SafetyAssessment {
  hardConstraintKept: boolean;
  /** 用户原输入里的硬约束短语(用于说明)。 */
  constraints: string[];
  /** 优化稿是否出现无条件的不可逆指令。 */
  irreversibleUnconditional: boolean;
}

const HARD_CONSTRAINT_RE =
  /(不要|不得|禁止|只检查|不修改|勿|别|仅限|不可|不能|不允许|无需)[^\n。;；]{0,20}/g;
const IRREVERSIBLE_RE = /(删除|覆盖|清空|推送|发布|付费|rm\s+-rf|git\s+push)/;
const CONDITIONAL_RE = /(确认|经你同意|前提|条件|需先|除非|不要直接|未经)/;

export function assessV3Safety(input: {
  rawInput: string;
  optimizedPrompt: string;
}): V3SafetyAssessment {
  const raw = String(input.rawInput ?? '');
  const out = String(input.optimizedPrompt ?? '');
  const constraints = (raw.match(HARD_CONSTRAINT_RE) ?? []).map((s) => s.trim()).filter(Boolean);
  // 硬约束保留:约束里的关键词(去掉否定词本身)仍应出现在优化稿中
  const kept = constraints.filter((constraint) => {
    const key = constraint.replace(/^(不要|不得|禁止|只检查|不修改|勿|别|仅限|不可|不能|不允许|无需)/, '').trim();
    if (!key) return true;
    const tokens = key.match(/[\u4e00-\u9fff]{2,}|[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? [];
    if (tokens.length === 0) return true;
    const hits = tokens.filter((t) => out.includes(t)).length;
    return hits / tokens.length >= 0.5;
  });
  const irreversibleUnconditional =
    IRREVERSIBLE_RE.test(out) && !CONDITIONAL_RE.test(out);
  return {
    hardConstraintKept: constraints.length === 0 || kept.length === constraints.length,
    constraints,
    irreversibleUnconditional,
  };
}

/**
 * 机械剥离交付稿里残留的协议标记(模型偶发把 <<<OPTIMIZED>>> 之类的内部标记
 * 写进正文;只处理整行会让行内标记泄漏到交付稿)。
 * 原属旧 Compiler 链,旧链路删除后由 V3 继续使用。
 */
const PROTOCOL_MARKER_LINE_RE = /^\s*<<<[A-Z_]+>>>\s*$/

export function stripProtocolMarkers(text: string): string {
  const source = String(text ?? '')
  const withoutLines = source
    .split(/\r?\n/)
    .filter((line) => !PROTOCOL_MARKER_LINE_RE.test(line))
    .join('\n')
  return withoutLines
    .replace(/\s*<<<[A-Z_]+>>>\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
