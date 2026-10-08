/**
 * Missing Resolution + Requirement Ledger —— v2 §C6 / §C8。
 *
 * 两条铁律:
 *  1. **UNKNOWN ≠ ASK_USER**。一个未决项必须先回答「谁有权/有能力决定它」:
 *        USER_REQUIRED(只有用户能决定)/ AGENT_DISCOVERABLE(执行方自己查得到)
 *        / OPTIONAL(有更好,没有也行);只有 `USER_REQUIRED && 高影响` 才 blocking。
 *  2. **来源与状态分离**。「这条信息从哪来」(source)与「它现在确认到什么程度」
 *     (status)是两个独立维度;用户的「保持未确定」只提升到
 *     PROVISIONAL / CONDITIONAL / DEFERRED,**永不**产生 CONFIRMED / USER_EXPLICIT。
 *
 * 分类判据是**表驱动的保守规则**:拿不准 → AGENT_DISCOVERABLE + blocking=false
 * (宁可生成后标注「由执行方自行确认」,也不无谓打断用户)。
 * 纯函数,零 LLM / 零 Harness / 零 UI 依赖。
 */
import { containmentRatio } from './discovery.js'
import type {
  AnalysisGate,
  ConversationTurn,
  EditTriage,
  MissingResolutionItem,
  ProvenanceRecord,
  ProvenanceSource,
  RequirementClass,
  RequirementLedgerEntry,
  RequirementStatus,
} from "./types.js";
import { resolveQuoteSource } from "./provenance.js";

// ─────────────────────────────────────────────────────────────────────────────
// 分类判据表
// ─────────────────────────────────────────────────────────────────────────────

/** 用户专属:只有用户本人能决定(偏好 / 预算 / 受众 / 合规 …)。 */
const USER_EXCLUSIVE_RE =
  /预算|成本|花费|价格|付费|受众|目标用户|目标读者|用户画像|风格|调性|语气|口吻|品牌|人设|偏好|倾向|喜好|取舍|优先级|上线时间|截止|工期|排期|交付时间|合规|法务|版权|许可|授权|隐私|密钥|凭据|账号|署名|名字|取名|标题偏好|多少[个条张页]|规模|范围|期望|希望|要求是|必须用|不要用|是否要|要不要|能不能只|用途|场景是|给谁|面向/i;

/** 执行方可自查:仓库/代码/文档/环境里能直接读到的确定性事实。 */
const DISCOVERABLE_RE =
  /文件名|路径|目录|文件夹|仓库|代码库|分支|提交|现有|当前(?:的)?(?:实现|代码|结构|配置|版本|状态)|已有(?:的)?(?:实现|代码|接口|字段)|实现细节|依赖|版本号|框架|技术栈现状|接口(?:定义|签名|文档)|函数签名|类型定义|数据结构|表结构|数据库结构|字段(?:类型|名)|配置(?:项|文件|格式)|环境变量|日志|堆栈|报错原文|错误码|测试(?:现状|文件|覆盖)|官方文档|文档地址|api 文档|规范|协议|路由|端口|部署(?:方式|环境)现状|默认值/i;

/** 有则更好:不影响任务成立。 */
const OPTIONAL_RE =
  /可选|额外|附加|顺带|如果方便|锦上添花|示例|例子|样例|参考(?:风格|资料)|补充说明|备注|风格微调|多给|多多益善/i;

/**
 * 产品取舍 / 用户偏好(Phase 3 prerequisite)。
 *
 * 判据要点:这类问题**不存在客观唯一答案**,也不是读项目能得到的;不同选择会显著
 * 改变方案。因此必须判 `USER_REQUIRED` + 高影响(由 Discovery 追问)。
 *
 * 覆盖自然表达(不依赖「要不要 / 是否」字样):
 *   「我是先验证一下,还是直接把整套自动化做完」「先做 MVP 还是一步到位」
 *   「要保持现有架构还是允许重构」「重点是验证能跑还是做成长期使用的工具」
 */
const PRODUCT_DECISION_RE =
  /还是|要么|取舍|权衡|trade[- ]?off|先做|先验证|先跑|一步到位|分阶段推进|MVP|长期(?:使用|运行|维护)|以后长期|保持(?:现有|原|当前)|允许重构|要不要|是否要|是否应该|优先做|先做哪|哪个更重要|哪个优先|取决于(?:你|用户)|由你决定|你更希望|你希望/;

/**
 * 环境事实(反方向保护):可被读取、可被验证的确定性事实。
 *
 * 这类项**永远不得**被升格为 `USER_REQUIRED` —— 否则会把「读一下就知道」的活推给用户。
 * 例:ComfyUI 版本 / API 地址 / workflow 文件位置 / 当前依赖 / 项目结构。
 */
const ENVIRONMENT_FACT_RE =
  // RC2 §4 补齐:当前实现 / 可用接口 / 配置字段 / 从环境可读的能力 —— 这些一律
  // **不得**升级为要问用户(读代码、读配置、读环境就能得到唯一答案)。
  /版本号?|(?:api|API|接口)\s*(?:地址|endpoint|url|URL)|地址|端口|路径|目录|文件夹|文件名|文件位置|安装位置|安装路径|依赖(?:版本)?|项目结构|仓库结构|目录结构|表结构|字段(?:类型|名)?|配置(?:项|文件|格式|值|字段)?|环境变量|默认值|日志|错误码|堆栈|签名|文档地址|规范|当前实现|现有实现|实现现状|代码现状|现有代码|可用接口|接口能力|环境能力|可读取的能力|能力清单|现有能力/;

/** 高影响:不同答案会导致**明显不同**的产出。 */
const HIGH_IMPACT_RE =
  /预算|成本|交付(?:形式|物|方式)|输出格式|交付格式|验收|完成标准|范围|规模|架构|技术栈|语言|框架选型|数据库|部署|上线|截止|工期|合规|版权|受众|目标用户|风格方向|调性|平台|渠道|量级|多少[个条张页]/i;

/** 中影响:影响细节质量,但不改变任务骨架。 */
const MEDIUM_IMPACT_RE = /命名|措辞|格式细节|排序|优先级|粒度|长度|篇[幅章]|语气|示例|顺序|维度/i;

/** 「保持未确定,直接优化」(只可产出 PROVISIONAL / CONDITIONAL / DEFERRED;不作答、不冒充用户要求)。 */
const BLIND_TRUST_RE =
  /按你的(?:判断|理解|想法|意思)|你(?:来|自己)?决定|随你|随便|都行|都可以|听你的|看着办|不用问|不用确认|你看着来|你定|自主决定|按需决定|你觉得(?:好|合适)就行/i;

/** 条件式授权:带条件的放行 → CONDITIONAL。 */
const CONDITIONAL_RE = /如果|若|除非|在.{0,10}情况下|只要|当.{0,10}时/i;

function isRequirementClass(value: unknown): value is RequirementClass {
  return value === "USER_REQUIRED" || value === "AGENT_DISCOVERABLE" || value === "OPTIONAL";
}

function asImpact(value: unknown): "high" | "medium" | "low" | undefined {
  return value === "high" || value === "medium" || value === "low" ? value : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// UNKNOWN 三分类
// ─────────────────────────────────────────────────────────────────────────────

export interface UnknownInput {
  text: string;
  /** LLM 给出的分类(可选;只能用于**收紧**,不能用于放大阻塞)。 */
  classification?: unknown;
  /** LLM 的 blocking 判断(可选;`false` 一律尊重,`true` 不单独成立)。 */
  blocking?: unknown;
  rationale?: string;
  impact?: unknown;
  user_exclusive?: unknown;
  question?: string;
  /** 是否由**语义歧义**支撑(唯一允许 blocking 的来源)。 */
  semanticAmbiguity?: boolean;
}

/** 机械影响面判定。 */
export function mechanicalImpact(text: string): "high" | "medium" | "low" {
  // 产品取舍的定义就包含「不同答案显著改变方案」→ 恒为高影响。
  if (isProductDecision(text)) return "high";
  if (HIGH_IMPACT_RE.test(text)) return "high";
  if (MEDIUM_IMPACT_RE.test(text)) return "medium";
  return "low";
}

/**
 * 机械三分类(保守,可单测):
 *  1. 命中 OPTIONAL 且不命中用户专属 / 可自查 → OPTIONAL;
 *  2. 命中可自查且**不**命中用户专属 → AGENT_DISCOVERABLE;
 *  3. 命中用户专属 → USER_REQUIRED;
 *  4. 都没命中 → AGENT_DISCOVERABLE(默认不打扰用户)。
 */
export function mechanicalRequirementClass(text: string): RequirementClass {
  const value = String(text ?? "");
  // ⓪ RC2:高影响决策**类别**优先(与采样无关)——模型某一轮把它写成普通 missing
  //    甚至 AGENT_DISCOVERABLE,也不能改变它是「只有用户能决定」的事实。
  if (decisionCategoryOfRequirement(value)) return "USER_REQUIRED";
  // ① 产品取舍 / 用户偏好优先:没有客观唯一答案、读项目也得不到 → 必须问用户。
  //    放在环境事实之前,避免「最小可用版本 vs 完整平台」这类取舍被「版本」二字吃掉。
  if (isProductDecision(value)) return "USER_REQUIRED";
  // ② 反向保护:环境事实**永远**是可自查项(读一下就知道,不得推给用户)。
  if (ENVIRONMENT_FACT_RE.test(value)) return "AGENT_DISCOVERABLE";
  const userExclusive = USER_EXCLUSIVE_RE.test(value);
  const discoverable = DISCOVERABLE_RE.test(value);
  const optional = OPTIONAL_RE.test(value);
  if (optional && !userExclusive && !discoverable) return "OPTIONAL";
  if (discoverable && !userExclusive) return "AGENT_DISCOVERABLE";
  if (userExclusive) return "USER_REQUIRED";
  return "AGENT_DISCOVERABLE";
}

/**
 * 该文本是否为「产品取舍 / 用户偏好」型决策(单一真源)。
 *
 * 注意:这只是**安全网**(机械判据)。语义判断的第一来源是分析契约里模型给出的
 * `decisions[].kind === 'PRODUCT_DECISION'`(见 analyze.ts);机械规则负责在模型
 * 判错或漏判时把结论**向安全方向纠正**(取舍 → USER_REQUIRED),绝不反向降级。
 */
// ─────────────────────────────────────────────────────────────────────────────
// RC2 —— Decision Stability 安全层(通用语义类别,不是固定问题模板)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 高影响用户决策的**语义类别**。
 *
 * 判据(用户给定,机械可判定):
 *   ① 不能通过环境 / 代码 / 文件 / API / 网络调查得到唯一答案;
 *   ② 不同答案会显著改变 scope / lifecycle / authority / mutation /
 *      delivery depth / implementation direction 之一;
 *   ③ 不存在真正安全且等价的默认值。
 *
 * 满足三条 → 必须 USER_REQUIRED + impact=high + blocking=true,
 * **不得**因为模型某一轮把它写成普通 missing 就降级为 AGENT_DISCOVERABLE。
 *
 * 这里只有「类别语义」,没有任何具体问题文案(文案由模型/Planner 生成)。
 */
export const DECISION_CATEGORIES = [
  "scope",
  "lifecycle",
  "mvp_vs_full",
  "analysis_vs_execution",
  "reuse_vs_create",
  "architecture_change",
  "mutation_permission",
  "irreversible_permission",
  "delivery_depth",
  "product_direction",
] as const;

export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

/**
 * 类别 → 识别模式。
 *
 * 注意:这些是**决策语义**的识别(选择 / 授权 / 方向),不是问题模板;
 * 每条都要求出现「二选一 / 授权 / 方向」这类信号,避免把普通陈述误判成决策。
 */
const DECISION_CATEGORY_PATTERNS: readonly { category: DecisionCategory; re: RegExp }[] = [
  // 变更授权 / 不可逆动作:必须由用户授予,读环境读不出来
  {
    category: "mutation_permission",
    re: /允许(?:我|你)?(?:改|修改|删除|覆盖|写|创建|推送)|可以(?:改|修改|删|删除|覆盖|推送)|要不要(?:改|修改|删除|覆盖)|自动(?:创建|修改|删除|覆盖|重命名)|是否(?:修改|删除|覆盖)|权限|授权/,
  },
  {
    category: "irreversible_permission",
    re: /(?:推送|发布|上线|部署|删除|清空|覆盖|回滚|付费|购买|调用付费)[^。;\n]{0,12}(?:吗|可以|允许|要不要|是否)|不可逆|(?:是否|要不要)[^。;\n]{0,10}(?:推送|发布|部署|删除|付费)/,
  },
  // 生命周期:一次性验证 vs 长期自动化
  {
    category: "lifecycle",
    re: /长期(?:自动)?(?:运行|使用|维护|自动)|以后(?:都|长期|每次)|自动(?:化)?(?:流程|运行|处理|执行|完成|管理)|定时(?:执行|运行)|周期性|一次性|(?:每|逐)(?:天|周|次)自动|持续(?:运行|集成)|常态(?:化|运行)|以后能自动|(?:都|能|要)?自动(?:跑|做|完成)/,
  },
  // MVP vs 完整系统
  {
    category: "mvp_vs_full",
    re: /(?:最小|最简|可跑|能跑)(?:可用|闭环|版本|实现)?|MVP|先(?:做个|搞个|来)(?:能跑|最简|最小)|原型|做完整|做成完整|完整(?:系统|平台|方案)|一步到位|分阶段/,
  },
  // 只分析 vs 真正执行(授权范围)
  {
    category: "analysis_vs_execution",
    re: /先(?:看看|评估|调研|确认)(?:能不能|是否|可行性)|能不能(?:实现|做|搞)|可行性|只(?:检查|分析|评估|看)|不要(?:改|动|执行)|仅(?:分析|评估)|先不(?:改|动手|执行)/,
  },
  // 复用现有 vs 新建 / 改造
  {
    category: "reuse_vs_create",
    re: /复用|沿用|用现有|基于现有|现有的?[^。;\n]{0,8}(?:还是|或者)|(?:新建|重写|重做|从零|重新做)[^。;\n]{0,10}(?:还是|或者)|(?:还是|或者)[^。;\n]{0,10}(?:新建|重写|复用|沿用)/,
  },
  // 架构:保持 vs 允许重构
  {
    category: "architecture_change",
    re: /(?:保持|不动|不要动|维持)[^。;\n]{0,10}(?:架构|结构|设计|分层)|(?:重构|重新设计|重新架构|改造|推翻|优化|调整)[^。;\n]{0,10}(?:架构|结构|设计|分层)|(?:架构|分层)[^。;\n]{0,10}(?:要不要|是否|需不需要|优化|调整|改造|重构)/,
  },
  // 交付深度
  {
    category: "delivery_depth",
    re: /(?:原型|demo|演示|能跑通|跑通|可用|生产可用|正式可用|可上线)[^。;\n]{0,10}(?:就行|即可|就好|还是)|做到(?:什么|哪)(?:程度|一步)|交付(?:到|深度)|先(?:做到|交付)/,
  },
  // 范围边界
  {
    category: "scope",
    re: /(?:范围|边界|口径)[^。;\n]{0,10}(?:怎么|如何|要不要|是否|是)|只(?:做|要|需|处理)|仅(?:做|限)|顺便|一起(?:做|改)|(?:还是|要么)[^。;\n]{0,14}(?:还是|要么)|二选一|取舍|权衡|继续(?:做|推进|下去|完善)|接着(?:做|推进)|下一步(?:做|推进)/,
  },
  // 产品方向 / 优先级
  {
    category: "product_direction",
    re: /哪个(?:更|比较)?(?:重要|优先|值得)|优先(?:做|考虑|保证)|先做哪|(?:方向|路线|方案)[^。;\n]{0,8}(?:取舍|权衡|选择)|取决于(?:你|用户)|由你决定|你(?:更)?希望|你(?:更)?想/,
  },
];

/** 该文本属于哪个高影响决策类别(无则 null)。 */
export function decisionCategoryOf(text: string): DecisionCategory | null {
  const value = String(text ?? "");
  if (!value.trim()) return null;
  for (const { category, re } of DECISION_CATEGORY_PATTERNS) {
    if (re.test(value)) return category;
  }
  return null;
}

/**
 * 环境事实的**强**判定:出现环境名词且**没有**选择 / 授权 / 方向信号。
 *
 * 这是 §4 的反向保护:加强决策识别之后,不能把「版本 / 路径 / API 地址 /
 * workflow 文件位置 / 依赖 / 项目结构 / 配置字段」这类可读事实又推回给用户。
 */
const CHOICE_OR_AUTHORITY_SIGNAL_RE =
  /还是|要么|或者|取舍|权衡|二选一|哪个|哪种|要不要|是否|允许|授权|权限|可以(?:改|删|推送|发布)|取决于|由你决定|你(?:更)?希望|你(?:更)?想|优先/;

export function isReadableEnvironmentFact(text: string): boolean {
  const value = String(text ?? "");
  if (!ENVIRONMENT_FACT_RE.test(value)) return false;
  return !CHOICE_OR_AUTHORITY_SIGNAL_RE.test(value);
}

/**
 * 机械判定的「决策安全层」:返回必须阻塞的用户决策类别。
 *
 * 只做**安全纠偏**(把该问的拉回 USER_REQUIRED),不生成问题文案。
 */
/**
 * 「已写明的规格」不算决策。
 *
 * RC2 实测误报:「约束:只看本地可跑的方案,不引入付费 API」被
 * analysis_vs_execution 模式命中 → 把用户**已经决定好**的约束当成待决策项。
 * 用户写出来的规格就是答案本身,不得再问一遍。
 */
const STATED_SPEC_RE =
  /^\s*(?:约束|要求|限制|禁止|排除|输出格式|格式|验收|验收标准|成功标准|风格|语气|篇幅|必须|不得|不要)[:：]/;

export function isStatedSpecification(text: string): boolean {
  return STATED_SPEC_RE.test(String(text ?? ""));
}

export function decisionCategoryOfRequirement(text: string): DecisionCategory | null {
  const value = String(text ?? "");
  if (!value.trim()) return null;
  // 反向保护优先:① 已写明的规格 ② 明确的可读事实(且无选择/授权信号)→ 都不是决策
  if (isStatedSpecification(value)) return null;
  if (isReadableEnvironmentFact(value)) return null;
  return decisionCategoryOf(value);
}

/**
 * 模糊目标本身就是一个未定的**范围 / 交付深度**决策。
 *
 * 判据用**机械分诊**的 REBUILD(「没有可保留的提示词结构或成稿要素」)——
 * 完全确定性,与模型采样无关。这类输入必须先问清范围再构建,不能靠
 * PROVISIONAL 暂定「先跑最小闭环」把用户的范围决定替掉。
 *
 * 只返回类别与用户原句(不生成问题文案)。
 */
export function vagueGoalDecision(
  rawInput: string,
  mechanicalTriageLevel: string,
  options: { visualTarget?: boolean } = {},
): { category: DecisionCategory; text: string } | null {
  if (mechanicalTriageLevel !== "REBUILD") return null;
  // 视觉目标(生图 / 视频)有**安全且等价的默认值**:构图 / 画幅 / 运镜可由执行方
  // 按通用做法决定,不改变用户最终意图 → 不构成高影响决策(否则会无谓打断出图)。
  // 任务型目标(Agent / 编码 / 规划 / 研究)的模糊范围则会真正改变执行方向 → 必须问。
  if (options.visualTarget) return null;
  const first = String(rawInput ?? "")
    .split(/[。;；!?\n]/)
    .map((part) => part.trim())
    .filter(Boolean)[0];
  if (!first || first.length < 4) return null;
  return { category: "scope", text: first };
}

/**
 * 扫描用户原文里的高影响决策(机械、确定性 → 采样无关)。
 *
 * 用途:模型某一轮**没有**把决策列出来时,机械层补齐阻塞项
 * (文本用用户自己的原句,不生成新问题文案)。
 */
export function scanDecisionStatements(rawInput: string): { category: DecisionCategory; text: string }[] {
  const text = String(rawInput ?? "");
  const sentences = text
    .split(/[。;；!?\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 6);
  const found: { category: DecisionCategory; text: string }[] = [];
  const seen = new Set<DecisionCategory>();
  for (const sentence of sentences) {
    if (isStatedSpecification(sentence)) continue;
    if (isReadableEnvironmentFact(sentence)) continue;
    const category = decisionCategoryOf(sentence);
    if (!category || seen.has(category)) continue;
    seen.add(category);
    found.push({ category, text: sentence });
  }
  return found;
}

export function isProductDecision(text: string): boolean {
  return PRODUCT_DECISION_RE.test(String(text ?? ""));
}

/** 该文本是否为可读取/可验证的环境事实(反方向保护判据)。 */
/**
 * 从用户原文里机械提取「产品取舍句」——RC 安全网。
 *
 * 实测问题:模型倾向把「先做能跑的最小版本,还是直接做成长期用的工具」这类
 * **真正的产品取舍**归类成可自查项,导致 Discovery 漏问(false negative)。
 * 这里在分析结果之上做机械兜底:只要用户原句里出现明确的二选一/取舍表达,
 * 而分析**没有**把它列为未知项,就补一条 `USER_REQUIRED + blocking`。
 *
 * 保守起见:只认明确的取舍句式,且要求句子有实义长度,避免误报阻塞。
 */
export function tradeoffStatements(rawInput: string): string[] {
  const text = String(rawInput ?? "");
  const sentences = text
    .split(/[。;；!?\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 6);
  return sentences.filter((sentence) => isProductDecision(sentence));
}

/**
 * 两条文本是否**确实是同一条要求**(RC2 修正)。
 *
 * 只靠「包含率 / 子串」会把「ComfyUI 版本」(11 字)误判成
 * 「帮我把这段描述整理成提示词,ComfyUI 版本我用最新的」(24 字)的同一条 ——
 * 后者只是**句子**里含有一个环境事实,不是同一个要求。
 * 因此加长度比护栏:短的一方必须至少有长的一方的 60%,再看语义重合。
 */
export function sameRequirement(a: string, b: string): boolean {
  const left = String(a ?? "").trim();
  const right = String(b ?? "").trim();
  if (!left || !right) return false;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  if (shorter / longer < 0.6) return false;
  return containmentRatio(left, right) >= 0.8 || left.includes(right) || right.includes(left);
}

export function isEnvironmentFact(text: string): boolean {
  return ENVIRONMENT_FACT_RE.test(String(text ?? ""));
}

/**
 * 一条 UNKNOWN → MissingResolutionItem。
 *
 * 合并规则(与 triage 同一哲学:保守、单向收紧):
 *  - 机械判为 USER_REQUIRED 时,LLM 的降级**不被采纳**(有证据的「用户专属」特征保留);
 *  - 机械判为可自查 / 可选时,LLM 的 USER_REQUIRED 会被**降级**(不无谓追问);
 *  - `blocking` 仅在 `USER_REQUIRED && impact==='high'` 且 LLM 未显式否决时为 true。
 */
export function classifyUnknown(input: UnknownInput, index = 0): MissingResolutionItem {
  const text = (input.text ?? "").trim();
  const mechanical = mechanicalRequirementClass(text);
  const llm = isRequirementClass(input.classification) ? input.classification : undefined;

  let classification: RequirementClass = mechanical;
  const notes: string[] = [];
  if (mechanical === "USER_REQUIRED") {
    if (llm && llm !== "USER_REQUIRED") {
      notes.push(`模型判为 ${llm},但文本含用户专属特征,保留 USER_REQUIRED`);
    }
  } else if (llm && llm !== mechanical) {
    classification = mechanical;
    notes.push(`模型判为 ${llm},按保守规则降级为 ${mechanical}`);
  }

  const impact = asImpact(input.impact) ?? mechanicalImpact(text);
  // 语义歧义天然是**用户专属**的:只有用户知道「这个/它」指的是什么,
  // 执行方无法调查出来 → 不允许被机械/模型降级为可自查。
  if (input.semanticAmbiguity === true) classification = "USER_REQUIRED";
  // 语义歧义必然**高影响**(不澄清就会误解用户的意思)。
  const ambiguityForcedHigh = input.semanticAmbiguity === true;
  const userExclusive = classification === "USER_REQUIRED";
  const llmBlocking = input.blocking === true ? true : input.blocking === false ? false : undefined;
  // ★ 产品定位纠偏:高影响 **不再** 自动等于阻塞。
  //   blocking 必须由**语义歧义**显式支撑(input.semanticAmbiguity),
  //   否则一律不阻塞(执行期信息不完整 / 未来取舍 → 保持未决,不打扰用户)。
  const blocking =
    classification === "USER_REQUIRED" &&
    llmBlocking !== false &&
    input.semanticAmbiguity === true;
  // 语义歧义必然高影响(不澄清就会误解用户意思)→ 归一到 high,便于 UI 展示与统计
  const finalImpact: "high" | "medium" | "low" = input.semanticAmbiguity === true ? "high" : impact;

  const baseRationale =
    input.rationale?.trim() ||
    (classification === "USER_REQUIRED"
      ? "只有用户本人能决定,且会影响产出方向"
      : classification === "AGENT_DISCOVERABLE"
        ? "执行方可以直接从代码 / 文档 / 环境中查到,不需要问用户"
        : "有没有都不影响任务成立");

  return {
    id: `unknown-${index + 1}`,
    text,
    classification,
    blocking,
    rationale: [baseRationale, ...notes].join(";"),
    impact: finalImpact,
    user_exclusive: userExclusive,
    ...(input.question?.trim() ? { question: input.question.trim() } : {}),
  };
}

/**
 * 批量分类(保持输入顺序;空文本条目被丢弃)。
 *
 * **id 由内容派生**(`unknown-<hash>`),不是数组下标 —— 这一点对 Phase 3 至关重要:
 * Discovery 每轮都会重新分析,模型的下标编号会随回答变化;若 id 用下标,同一个
 * 决策在第二轮就会换 id,台账与回答无法对上(会导致「已问过/已回答」判定失效)。
 * 内容派生保证「同一件事永远是同一个 id」。
 */
export function classifyUnknowns(inputs: readonly UnknownInput[]): MissingResolutionItem[] {
  return inputs
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (item.text ?? "").trim().length > 0)
    .map(({ item, index }) => {
      const classified = classifyUnknown(item, index);
      return { ...classified, id: contentStableId(classified.text) };
    });
}

/** 内容稳定 id(FNV-1a 32 位;同文本恒等,跨轮次不变)。 */
export function contentStableId(text: string): string {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `unknown-${hash.toString(16).padStart(8, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 分析门(唯一允许阻断生成的开关)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计算分析门。
 *
 * 产品规则:**KEEP 不追问**。输入既然是可用成稿,就不该因为「我们没看懂」而打断用户
 * ——KEEP 的语义是原样保留,追问与「原样保留」自相矛盾。
 */
export function computeAnalysisGate(items: readonly MissingResolutionItem[], triage: EditTriage): AnalysisGate {
  const all = [...items];
  const userRequired = all.filter((item) => item.classification === "USER_REQUIRED");
  const discoverable = all.filter((item) => item.classification === "AGENT_DISCOVERABLE");
  const optional = all.filter((item) => item.classification === "OPTIONAL");

  if (triage === "KEEP") {
    return {
      blocked: false,
      blocking_items: [],
      discoverable_items: discoverable,
      optional_items: optional,
      reason: "输入已是可用成稿(分诊 KEEP):原样保留,不追问也不改写",
    };
  }

  const blockingItems = userRequired.filter((item) => item.blocking);
  return {
    blocked: blockingItems.length > 0,
    blocking_items: blockingItems,
    discoverable_items: discoverable,
    optional_items: optional,
    reason:
      blockingItems.length > 0
        ? `有 ${blockingItems.length} 项只有你本人能决定的信息缺失,确认后再生成`
        : "没有阻塞项,可以直接生成",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Requirement Ledger
// ─────────────────────────────────────────────────────────────────────────────

/** 台账记录的来源权威性:只有用户本人表达才可产生高权威来源。 */
function isUserAuthority(source: ProvenanceSource): boolean {
  return source === "USER_EXPLICIT" || source === "CONTEXT_EXPLICIT";
}

function statusForSource(source: ProvenanceSource): RequirementStatus {
  switch (source) {
    case "USER_EXPLICIT":
    case "CONTEXT_EXPLICIT":
      return "CONFIRMED";
    case "WORKSPACE_FACT":
      return "CONFIRMED";
    case "OPTIMIZER_SUGGESTED":
      return "PROVISIONAL";
    default:
      return "OPEN";
  }
}

/**
 * 台账净化(provenance 不可回退的机械保证):
 *  - USER_EXPLICIT / CONTEXT_EXPLICIT 必须携带**逐字且来自用户**的证据,
 *    否则降级为 OPTIMIZER_SUGGESTED + PROVISIONAL(并把状态一并降级);
 *  - CONTEXT_EXPLICIT 的证据只认上下文中的 user 消息(助手发言永不算);
 *  - 任何情况下都不会把条目**升级**为更高权威来源。
 */
export function sanitizeLedger(
  entries: readonly RequirementLedgerEntry[],
  rawInput: string,
  contextTurns: readonly ConversationTurn[],
): RequirementLedgerEntry[] {
  return entries.map((entry) => {
    if (!isUserAuthority(entry.source)) return entry;
    const evidence = entry.evidence.filter((quote) => {
      const resolution = resolveQuoteSource(quote, rawInput, [...contextTurns]);
      return entry.source === "USER_EXPLICIT"
        ? resolution.matchedIn === "raw"
        : resolution.matchedIn === "context-user";
    });
    if (evidence.length > 0) return { ...entry, evidence };
    return {
      ...entry,
      source: "OPTIMIZER_SUGGESTED",
      status: "PROVISIONAL",
      evidence: [],
      confidence: "low",
      note: [entry.note, "证据不成立,已降级为优化器暂定(不得当作你的要求)"]
        .filter(Boolean)
        .join(";"),
    };
  });
}

function fromProvenanceRecord(record: ProvenanceRecord): RequirementLedgerEntry {
  return {
    id: `ledger-${record.id}`,
    text: record.text,
    source: record.source,
    status: statusForSource(record.source),
    evidence: [...record.evidence],
    confidence: record.confidence,
    ...(record.note ? { note: record.note } : {}),
  };
}

function statusForResolution(item: MissingResolutionItem): RequirementStatus {
  switch (item.classification) {
    case "AGENT_DISCOVERABLE":
      return "DISCOVERABLE";
    case "OPTIONAL":
      return "DEFERRED";
    default:
      return "OPEN";
  }
}

function fromResolutionItem(item: MissingResolutionItem): RequirementLedgerEntry {
  return {
    id: `ledger-${item.id}`,
    text: item.text,
    // 未决项的来源恒为 UNKNOWN:我们**不知道**它的值,更不知道用户有没有要求过。
    source: "UNKNOWN",
    status: statusForResolution(item),
    evidence: [],
    confidence: "low",
    note: `${item.classification}${item.blocking ? "(阻塞)" : ""}:${item.rationale}`,
  };
}

/**
 * 组装台账:用户要求 / 上下文要求(→CONFIRMED)+ 优化器建议(→PROVISIONAL)
 * + 未决项(→OPEN / DISCOVERABLE / DEFERRED)。来源与状态分离,且经过净化。
 */
export function buildLedger(input: {
  raw_input: string;
  context_turns?: readonly ConversationTurn[];
  explicit?: readonly ProvenanceRecord[];
  context?: readonly ProvenanceRecord[];
  suggested?: readonly ProvenanceRecord[];
  resolution?: readonly MissingResolutionItem[];
}): RequirementLedgerEntry[] {
  const entries: RequirementLedgerEntry[] = [
    ...(input.explicit ?? []).map(fromProvenanceRecord),
    ...(input.context ?? []).map(fromProvenanceRecord),
    ...(input.suggested ?? []).map(fromProvenanceRecord),
    ...(input.resolution ?? []).map(fromResolutionItem),
  ];
  return sanitizeLedger(entries, input.raw_input, input.context_turns ?? []);
}

// ─────────────────────────────────────────────────────────────────────────────
// 「保持未确定」处理(仅作用于当前问题)
// ─────────────────────────────────────────────────────────────────────────────

/** 本轮输入里是否出现盲授权话术。 */
export function hasBlindTrust(rawInput: string): boolean {
  return BLIND_TRUST_RE.test(rawInput ?? "");
}

/**
 * 应用盲授权:**只**把 OPEN 项降到 PROVISIONAL / CONDITIONAL / DEFERRED,
 * 绝不产生 CONFIRMED / USER_EXPLICIT,也不改动用户自己已确认的条目。
 */
export function applyBlindTrust(
  entries: readonly RequirementLedgerEntry[],
  rawInput: string,
): RequirementLedgerEntry[] {
  if (!hasBlindTrust(rawInput)) return [...entries];
  const conditional = CONDITIONAL_RE.test(rawInput ?? "");
  return entries.map((entry) => {
    if (entry.status !== "OPEN") return entry;
    const status: RequirementStatus = conditional ? "CONDITIONAL" : "PROVISIONAL";
    return {
      ...entry,
      status,
      note: [entry.note, conditional ? "据你的条件式授权暂定(条件成立时生效)" : "据你的「保持未确定」暂定"]
        .filter(Boolean)
        .join(";"),
    };
  });
}

/**
 * 机械不变量(供校验器 / 单测调用):
 *  - 不存在「高权威来源但状态不是 CONFIRMED」的条目;
 *  - 不存在「USER_EXPLICIT / CONTEXT_EXPLICIT 但无证据」的条目;
 *  - 不存在「OPTIMIZER_SUGGESTED 但状态为 CONFIRMED」的条目。
 */
export function findLedgerViolations(entries: readonly RequirementLedgerEntry[]): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (isUserAuthority(entry.source)) {
      if (entry.evidence.length === 0) {
        problems.push(`${entry.id}: ${entry.source} 缺少逐字证据`);
      }
      if (entry.status !== "CONFIRMED") {
        problems.push(`${entry.id}: ${entry.source} 的状态应为 CONFIRMED,实为 ${entry.status}`);
      }
    }
    if (entry.source === "OPTIMIZER_SUGGESTED" && entry.status === "CONFIRMED") {
      problems.push(`${entry.id}: 优化器建议不得为 CONFIRMED`);
    }
  }
  return problems;
}
