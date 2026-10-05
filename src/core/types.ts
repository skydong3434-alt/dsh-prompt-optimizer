/**
 * dsh-adaptive-prompt-optimizer 核心契约层。
 *
 * 本模块是插件的数据契约 :Host、Client、Classifier、Strategies、Compiler、
 * Validator 全部共享同一套类型。契约分层唯一职责是「先定类型,再谈实现」——
 * 任何 UI / Host / 策略改动都不得破坏这里的形状(向后兼容优先)。
 *
 * 纯类型 + 常量,零依赖,不依赖任何 Harness API,便于测试与跨端复用。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 任务类型(封闭枚举,含 fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 插件支持的提示词类型。
 *
 * - 前七个是**工作意图**(classifier 闭集,`PROMPT_TYPES` 仍只含这七个;
 *   `general` 是 AUTO 无法判定时的兜底,不单独出现在 UI 下拉)。
 * - 后三个是 v2 的**目标派生编译契约**(不以「意图」形式出现在分类结果里,
 *   只由 Target-aware Router 按 Prompt Target 选出):图像 / 视频 / Agent 任务。
 *   它们承载完全不同的信息责任(图像/视频不得被套进 Goal/Phase/Task/Tests)。
 */
export type PromptType =
  | "research"
  | "planning"
  | "execution"
  | "diagnostic"
  | "review"
  | "creative"
  | "general"
  | "image"
  | "video"
  | "agent";

/** 目标派生的编译契约类型(不含在分类器闭集里)。 */
export const TARGET_CONTRACT_TYPES: readonly PromptType[] = ["agent", "image", "video"] as const;

/** A.分类输出(classifier 的 JSON 契约;LLM 必须逐字段输出,解析层容错降级)。 */
export interface ClassifierResult {
  /** 识别出的任务类型。 */
  prompt_type: PromptType;
  /** 内部置信度 0..1,仅供工程决策/日志/回归使用;UI 一律不展示此数值。 */
  confidence_internal: number;
  /** 编译期将注入 [待补充: …] 的缺口清单。 */
  missing_constraints: string[];
  /** 一句话理由(UI「需求诊断」区展示)。 */
  rationale: string;
  /**
   * 分类依据:必须逐字存在于 raw_input 或上下文 user 消息中的字符串片段,
   * 宿主/validator 会做机械比对,对不上的条目丢弃并告警。
   */
  evidence_quotes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 归一化上下文:deterministic 与 LLM-derived 严格分离
// ─────────────────────────────────────────────────────────────────────────────

/** 会话历史里的一条往返(沿用 Y1X1n prompt.ts 的 ConversationTurn 口径)。 */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * 归一化上下文。
 *
 * deterministic 字段(原样/预算截断/确定性 metadata)由 context.ts 直接产生,
 * 不经过 LLM;LLM-derived 字段只允许由 classifier / compiler 产出,且每条
 * 必须携带 ProvenanceRecord 与逐字 evidence —— assistant 发言永不能作为
 * 用户意图证据。
 */
export interface NormalizedContext {
  /** 用户本轮原始输入(原样保留,不截断)。 */
  raw_input: string;
  /** 预算内的最近会话轮次(沿用既有 8 轮 / 1600 字符口径)。 */
  bounded_turns: ConversationTurn[];
  /** 确定性 workspace metadata(仅取可直接验证的字段)。 */
  workspace_metadata: {
    cwd?: string;
    workspace_name?: string;
  };
  /** LLM 派生字段(可选;出现时必须带 provenance)。 */
  llm_derived?: {
    user_goals: ProvenanceRecord[];
    /** 仅用户自己的否定/推翻发言可入,assistant 建议一律不算。 */
    rejected_directions: ProvenanceRecord[];
    known_constraints: ProvenanceRecord[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance(来源标注)——MVP 第一优先级
// ─────────────────────────────────────────────────────────────────────────────

/** 信息来源的五分类。 */
export type ProvenanceSource =
  | "USER_EXPLICIT" // 用户本轮明确表达
  | "CONTEXT_EXPLICIT" // 最近对话中「用户」明确表达
  | "WORKSPACE_FACT" // workspace metadata 可验证的确定性事实
  | "OPTIMIZER_SUGGESTED" // 优化器为提高质量主动建议补充
  | "UNKNOWN"; // 当前证据不足,不得自行假设

/** 一条来源记录:最小粒度的要求 / 事实 / 建议。 */
export interface ProvenanceRecord {
  /** 稳定 id(用于 UI 定位 / 回归断言)。 */
  id: string;
  /** 语义单元文本(该要求 / 事实 / 建议的原文描述)。 */
  text: string;
  source: ProvenanceSource;
  /** 逐字证据:必须匹配 raw_input 或上下文中 user 消息;suggested/unknown 可为空。 */
  evidence: string[];
  /** 用于展示的把握度(高/中/低),不做小数伪精确。 */
  confidence: "high" | "medium" | "low";
  /** 补充说明(如:为什么标 unknown / 该建议的触发理由)。 */
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 编译输出(compiler 协议)
// ─────────────────────────────────────────────────────────────────────────────

/** 内部置信度 → UI 展示档位的映射阈值(仅 UI 层使用;未经校准,非发布标准)。 */
export const CONFIDENCE_LEVEL_THRESHOLDS = {
  high: 0.8,
  medium: 0.6,
} as const;

export type ConfidenceLevel = "High" | "Medium" | "Low";

/** 由内部置信度数值映射到展示档位(UI 不得直接展示小数)。 */
export function toConfidenceLevel(confidenceInternal: number): ConfidenceLevel {
  if (confidenceInternal >= CONFIDENCE_LEVEL_THRESHOLDS.high) return "High";
  if (confidenceInternal >= CONFIDENCE_LEVEL_THRESHOLDS.medium) return "Medium";
  return "Low";
}

/** 一条缺失约束(展示 + 编译注入 [待补充:] 共用)。 */
export interface MissingConstraint {
  id: string;
  /** 缺失项描述(如「输出格式」「检索时间范围」)。 */
  label: string;
  /** 缺失为什么重要(一句话,UI tooltip 用)。 */
  reason?: string;
}

/** 编译器一次性输出(user 可直接检查的全部内容)。 */
export interface CompileResult {
  prompt_type: PromptType;
  /** UI 展示档位(内部 confidence_internal 不展示)。 */
  confidence_level: ConfidenceLevel;
  /** 需求诊断文本(UI「需求诊断」区)。 */
  diagnosis: string;
  /** 来源:用户本轮明确要求(每条约带 quote 证据)。 */
  explicit_requirements: ProvenanceRecord[];
  /** 来源:上下文已确认(仅 user 消息证据;WORKSPACE_FACT 会标注)。 */
  context_requirements: ProvenanceRecord[];
  /** 来源:优化器建议(独立段落,禁止混入以上两组)。 */
  suggested_requirements: ProvenanceRecord[];
  /** 来源:证据不足(不得自行假设)。 */
  unknowns: ProvenanceRecord[];
  missing_constraints: MissingConstraint[];
  /** 优化后的完整 Prompt(交付给用户检查 / 替换输入框)。 */
  optimized_prompt: string;
  /** 实际使用的策略版本(可审计:策略升级不改变插件版本)。 */
  strategy_version: string;
  /** validate 机械比对是否通过;false 时 UI 必须顶部警示。 */
  provenance_ok: boolean;
  // ── v2(全部可选:旧消费方零改动)────────────────────────────────────────
  /** 意图画像(主/辅 + 工作模式)。 */
  intent?: IntentProfile;
  /** 提示词目标 / 目标引擎(目标感知编译的依据)。 */
  target?: TargetResolution;
  /** 编辑分诊结果(KEEP 时 optimized_prompt 必须与输入等价)。 */
  triage?: TriageDecision;
  /** 需求台账(来源与状态分离)。 */
  ledger?: RequirementLedgerEntry[];
  /** v2:实际采用的编译契约 id(Target-aware Router 的裁决结果)。 */
  contract?: string;
  /** 缺失解析结果(UNKNOWN 三分类 + 阻塞判定)。 */
  missing_resolution?: MissingResolutionItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 策略契约(Strategy Registry 的成员形状)
// ─────────────────────────────────────────────────────────────────────────────

/** 保真规则:重组不改语义(对象/方向/数量/范围/禁止项/术语)。 */
export interface PreservationRule {
  id: string;
  description: string;
  /** 机械检查器(可选;无则只在提示词层约束 + 测试断言)。 */
  check?: (
    output: string,
    rawInput: string,
    contextTurns: ConversationTurn[],
  ) => boolean;
}

/** 建议规则:优化器建议的边界(不允许把建议伪装成用户要求)。 */
export interface SuggestionRule {
  id: string;
  description: string;
}

/** 输出守卫:anti-drift 检查(见 validate.ts)。 */
export interface Guard {
  id: string;
  description: string;
  /** 守卫检查器;返回问题描述,无问题返回 null。 */
  check: (
    output: string,
    result: CompileResult,
    rawInput: string,
  ) => string | null;
}

/** Provenance 规则:该策略对来源标注的额外要求。 */
export interface ProvenanceRule {
  id: string;
  description: string;
}

/**
 * 策略输出契约(v2 §C5:策略定义的是**信息责任**,不是必备标题)。
 *
 * - `responsibilities`:必须**逐项交代清楚**的信息责任(id 作为机械核对锚点);
 *   标题可自拟、顺序可调整,但不得遗漏任何一项;
 * - `sections`:仅保留给旧消费方(等价于 responsibilities,标记为 deprecated)。
 */
export interface OutputContract {
  /** 必须交代的信息责任清单(id 即核对锚点)。 */
  responsibilities: string[];
  /**
   * @deprecated v2 起改用 `responsibilities`;两者内容一致,仅为向后兼容保留。
   */
  sections: string[];
  /** 输出格式说明(给 compiler 的提示词片段)。 */
  formatNote: string;
}

/** 编译阶段变量(compiler 组装 user 消息时注入)。 */
export interface CompileVars {
  raw_input: string;
  context_turns: ConversationTurn[];
  workspace_metadata: NormalizedContext["workspace_metadata"];
  missing_constraints: MissingConstraint[];
  /**
   * v2:带三分类的未决项(有则优先用于处置分派;无则按 label 做机械三分类)。
   * 处置计划由 `responsibilities.ts` 的纯函数按需推导 —— 确定性且开销可忽略,
   * 因此不缓存进 CompileVars(避免类型环与状态不一致)。
   */
  missing_resolution?: MissingResolutionItem[];
  /**
   * v2:编译器算好的处置分派(策略侧只渲染,不重算)。
   * `missing_constraints` 是「有什么缺口」,这里是「每个缺口该怎么处置」。
   */
  missing_dispositions?: readonly DispositionedRequirementItem[];
  llm_derived?: NormalizedContext["llm_derived"];
}

/** 一个完整策略:纯数据 + 纯函数,不依赖 ctx.llm / UI / Host;可独立版本化与测试。 */
export interface PromptStrategy {
  type: PromptType;
  name: string;
  version: string;
  purpose: string;
  /**
   * v2:必须交代的**信息责任**(顺序即建议顺序;每项 id 作为机械核对锚点)。
   * 这是 v2 的主字段 —— 策略不再强制「必备模板段落」。
   */
  informationResponsibilities: string[];
  /**
   * @deprecated v2 起改用 `informationResponsibilities`(内容一致,向后兼容保留)。
   */
  required_sections: string[];
  optional_sections: string[];
  preservationRules: PreservationRule[];
  suggestionRules: SuggestionRule[];
  guards: Guard[];
  provenanceRules: ProvenanceRule[];
  buildSystem(language: "zh" | "en"): string;
  buildUser(vars: CompileVars): string;
  outputContract: OutputContract;
}

// ─────────────────────────────────────────────────────────────────────────────
// 校验结果
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationProblem {
  severity: "warn" | "error";
  rule: string;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: ValidationProblem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Optimize 请求 / SSE 事件协议扩展(保持向后兼容)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /dsh-prompt-optimizer/optimize 请求体扩展。
 * 仅新增可选字段;旧字段(text/provider/model/reasoningEffort/context/previous)
 * 语义与 Y1X1n 完全一致。
 */
export interface OptimizeRequestV2 {
  /** 手动类型覆盖;缺省 = AUTO。AUTO 时先分类再编译,override 时跳过分类调用。 */
  promptType?: PromptType;
}

/** SSE meta 事件载荷(在既有 delta/done/error 之前推送一次)。 */
export interface OptimizeMetaEvent {
  type: "meta";
  prompt_type: PromptType;
  /** v2:实际采用的编译契约 id(与 prompt_type 不同时才出现;如 image / video / agent)。 */
  contract?: string;
  confidence_level: ConfidenceLevel;
  missing_constraints: MissingConstraint[];
  rationale: string;
  provenance_ok: boolean;
  // ── v2 加法字段(可选;旧客户端忽略即可)────────────────────────────────
  intent?: IntentProfile;
  target?: TargetResolution;
  triage?: TriageDecision;
  ledger?: RequirementLedgerEntry[];
  /** 缺失解析(含阻塞判定);blocked=true 时 meta 不会出现,走 discovery_required。 */
  missing_resolution?: MissingResolutionItem[];
  /** 分析门(blocked 时 meta 不会出现;此处供 UI 展示可自查项计数)。 */
  gate?: AnalysisGate;
}

// ─────────────────────────────────────────────────────────────────────────────
// v2:工作意图(主 + 辅)—— 取代「单一标签」心智,但保留 PromptType 作为投影
// ─────────────────────────────────────────────────────────────────────────────

/** 六种工作意图(不含 general;general 只作为 primary 的兜底取值)。 */
export type WorkIntent =
  | "research"
  | "planning"
  | "execution"
  | "diagnostic"
  | "review"
  | "creative";

export const WORK_INTENTS: readonly WorkIntent[] = [
  "research",
  "planning",
  "execution",
  "diagnostic",
  "review",
  "creative",
] as const;

/** 工作模式:下游执行方应以什么节奏工作(影响信息责任与建议,不影响是否可编译)。 */
export type WorkMode =
  /** 一次性交付:拿到 prompt 即可产出最终结果。 */
  | "one_shot"
  /** 迭代式:需要多轮往返打磨。 */
  | "iterative"
  /** 探索式:先调研/试验再定方案。 */
  | "exploratory"
  /** 受控式:需要人工审批 / 门禁 / 不可逆操作前确认。 */
  | "governed";

export const WORK_MODES: readonly WorkMode[] = ["one_shot", "iterative", "exploratory", "governed"] as const;

/** 意图画像:Primary + Supporting(不是单一标签)。 */
export interface IntentProfile {
  /** 主工作意图(general = 无法判定;此时沿用既有 general 策略兜底)。 */
  primary: WorkIntent | "general";
  /** 辅助意图(按重要性降序;不含 primary 自身;可为空)。 */
  supporting: WorkIntent[];
  /** 每个辅助意图的一句话说明(与 supporting 同序;缺失则省略)。 */
  supporting_notes?: string[];
  /** 工作模式。 */
  work_mode: WorkMode;
  /** 一句话理由(用户可读)。 */
  rationale: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// v2:提示词目标 / 目标引擎(表驱动,可扩展)
// ─────────────────────────────────────────────────────────────────────────────

/** 提示词的产物目标(与「工作意图」正交:意图=要做什么,目标=给谁/产出什么)。 */
export type PromptTarget =
  | "agent_task" // 交给 Agent 执行任务(含控制 Agent 自身)
  | "research" // 检索 / 调研 / 对比
  | "coding" // 写码 / 改码
  | "image_generation" // 图像生成
  | "video_generation" // 视频生成
  | "writing" // 文本创作 / 改写
  | "data_analysis" // 数据分析
  | "general";

export const PROMPT_TARGETS: readonly PromptTarget[] = [
  "agent_task",
  "research",
  "coding",
  "image_generation",
  "video_generation",
  "writing",
  "data_analysis",
  "general",
] as const;

/** 产物模态:决定编译契约形态(图像/视频不得被编译成 Goal/Phase/Task/Tests)。 */
export type PromptModality = "text" | "code" | "image" | "video" | "structured_data";

export const PROMPT_MODALITIES: readonly PromptModality[] = [
  "text",
  "code",
  "image",
  "video",
  "structured_data",
] as const;

/** 目标引擎(模型 / 工具)的归一化引用;id 为封闭目录键,不认识的引擎落 raw。 */
export interface ResolvedEngine {
  /** 目录 id(如 "dsh" / "claude-code" / "midjourney");未识别时为 null。 */
  id: string | null;
  /** 展示名(未识别时为用户原话片段)。 */
  name: string;
  /** 该引擎归属的目标(未识别时为 null)。 */
  target: PromptTarget | null;
  /** 该引擎的原生产物模态。 */
  modality: PromptModality | null;
}

/** 目标解析结果(给路由 / 编译契约 / UI 共用)。 */
export interface TargetResolution {
  target: PromptTarget;
  modality: PromptModality;
  /** 命中的引擎;用户没提引擎或识别不出时为 null。 */
  engine: ResolvedEngine | null;
  /** 判断把握度(不做小数伪精确)。 */
  confidence: "high" | "medium" | "low";
  /** 逐字证据(用户在输入里提到的目标/引擎线索)。 */
  evidence: string[];
  /** 一句话理由(用户可读)。 */
  rationale: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// v2:编辑分诊(KEEP / PATCH / RESTRUCTURE / REBUILD)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 编辑分诊:对「用户已有输入」的最小必要干预级别。
 *  - KEEP        输入已是高质量成稿 → **原样保留,绝不改写**;
 *  - PATCH       结构可用,只补少量缺失要求 / 修少量问题;
 *  - RESTRUCTURE 信息已完整,但组织混乱 → 只重组结构,不新增语义;
 *  - REBUILD     输入无法构成有效任务(空/寒暄/自相矛盾且无目标)→ 才允许重写。
 */
export type EditTriage = "KEEP" | "PATCH" | "RESTRUCTURE" | "REBUILD";

export const EDIT_TRIAGE_LEVELS: readonly EditTriage[] = ["KEEP", "PATCH", "RESTRUCTURE", "REBUILD"] as const;

/** 分诊严重度(数值越大干预越强);用于 LLM 建议与机械判据的合并。 */
export const TRIAGE_SEVERITY: Record<EditTriage, number> = {
  KEEP: 0,
  PATCH: 1,
  RESTRUCTURE: 2,
  REBUILD: 3,
};

export interface TriageDecision {
  triage: EditTriage;
  /** 判据说明(用户可读;至少一条)。 */
  reasons: string[];
  /** 触发该级别所依据的机械证据(输入片段或结构信号)。 */
  signals: string[];
  /** KEEP 才为 true:机械判据确认「原样可用」(含安全阈值)。 */
  keep_safe: boolean;
  /** 是否由 LLM 建议参与合并(审计用)。 */
  llm_advised?: boolean;
  /** 机械判据给出的级别(审计 / 回归用)。 */
  mechanical?: EditTriage;
  /** LLM 给出的级别(审计 / 回归用)。 */
  llm_suggestion?: EditTriage;
  /** 结构性缺陷(只有 REBUILD 允许存在)。 */
  structural_problems?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// v2:缺失解析(UNKNOWN ≠ ASK_USER)与需求台账(来源 / 状态分离)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 未决项分类(取代「UNKNOWN 一律提问 / 一律 [待补充:]」):
 *  - USER_REQUIRED       只有用户本人能决定(偏好 / 预算 / 目标受众 / 合规 …);
 *  - AGENT_DISCOVERABLE  执行方自己能查到(仓库结构 / 依赖版本 / 现有实现 / 官方文档 …);
 *  - OPTIONAL            有则更好,没有也不影响任务成立。
 */
export type RequirementClass = "USER_REQUIRED" | "AGENT_DISCOVERABLE" | "OPTIONAL";

export const REQUIREMENT_CLASSES: readonly RequirementClass[] = [
  "USER_REQUIRED",
  "AGENT_DISCOVERABLE",
  "OPTIONAL",
] as const;

/** 一条缺失解析结果。 */
export interface MissingResolutionItem {
  id: string;
  /** 未决项描述(用户可读)。 */
  text: string;
  classification: RequirementClass;
  /** 是否阻塞生成:仅 `USER_REQUIRED && 高影响 && 用户专属` 才可为 true。 */
  blocking: boolean;
  /** 为什么这样分类(用户可读)。 */
  rationale: string;
  /** 对方案的影响面(Solution Impact)。 */
  impact: "high" | "medium" | "low";
  /** 是否用户专属决策(User Exclusivity)。 */
  user_exclusive: boolean;
  /** 若进入 Discovery,建议的问法(1–2 句;Phase 1 只记录不提问)。 */
  question?: string;
}

/** 分析门:是否必须进入 Discovery(只有它允许阻断生成)。 */
export interface AnalysisGate {
  /** true = 存在未决的用户专属阻塞项 → 不得进入编译。 */
  blocked: boolean;
  /** 阻塞项(blocking=true 的 USER_REQUIRED)。 */
  blocking_items: MissingResolutionItem[];
  /** 执行方可自行确认项(不阻塞;编译时标注「由执行方自行确认」)。 */
  discoverable_items: MissingResolutionItem[];
  /** 可选项(不阻塞;编译时可选补充)。 */
  optional_items: MissingResolutionItem[];
  /** 一句话门禁理由(用户可读)。 */
  reason: string;
}

/**
 * 需求状态与来源**严格分离**:
 *  - source 回答「这条信息从哪来」;
 *  - status 回答「这条信息现在的确认程度」。
 * 「按你的判断继续」这类授权只可产生 PROVISIONAL / CONDITIONAL / DEFERRED,
 * **永不**产生 CONFIRMED / USER_EXPLICIT。
 */
export type RequirementStatus =
  | "CONFIRMED" // 用户已明确确认
  | "OPEN" // 尚未解决,等待 Discovery
  | "DISCOVERABLE" // 由执行方自行确认
  | "PROVISIONAL" // 用户授权优化器代为暂定
  | "CONDITIONAL" // 在明确条件下成立
  | "DEFERRED" // 本轮不决定,后续再说
  | "REJECTED" // 用户明确否决
  | "NOT_APPLICABLE"; // 经判定与本任务无关

export const REQUIREMENT_STATUSES: readonly RequirementStatus[] = [
  "CONFIRMED",
  "OPEN",
  "DISCOVERABLE",
  "PROVISIONAL",
  "CONDITIONAL",
  "DEFERRED",
  "REJECTED",
  "NOT_APPLICABLE",
] as const;

/** 只有用户本人表达才能产生的高权威来源(伪造 = 严重缺陷)。 */
export const USER_AUTHORITY_SOURCES: readonly ProvenanceSource[] = [
  "USER_EXPLICIT",
  "CONTEXT_EXPLICIT",
] as const;

/** 一条需求台账记录:值 + 来源 + 状态(三者独立)。 */
export interface RequirementLedgerEntry {
  id: string;
  /** 需求 / 事实 / 建议的语义单元文本。 */
  text: string;
  source: ProvenanceSource;
  status: RequirementStatus;
  /** 逐字证据(USER_EXPLICIT / CONTEXT_EXPLICIT 必须非空)。 */
  evidence: string[];
  confidence: "high" | "medium" | "low";
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 Phase 2:未决项的编译处置(disposition)
// 契约全文见 docs/phase2-contract.md(用户指定,选项 A)。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 未决项的编译处置:
 *  - `OMIT`                     自然获得 / 弱可选 → 任何位置都不出现;
 *  - `EXECUTION_RESPONSIBILITY` 行动前须调查且影响正确执行 → 动作式指令;
 *  - `CONDITIONAL_BRANCH`       调查结果决定后续分支 → 条件式指令;
 *  - `USER_DECISION`            非阻塞的用户决定 → **不注入编译稿**(留台账 / Phase 3 追问);
 *  - `OPTIONAL_ENHANCEMENT`     可选增强 → 只进建议段。
 *
 * `AGENT_DISCOVERABLE` 永远不得再渲染成面向用户的 `[待补充:]`。
 */
export type RequirementDisposition =
  | "OMIT"
  | "EXECUTION_RESPONSIBILITY"
  | "CONDITIONAL_BRANCH"
  | "USER_DECISION"
  | "OPTIONAL_ENHANCEMENT";

export const REQUIREMENT_DISPOSITIONS: readonly RequirementDisposition[] = [
  "OMIT",
  "EXECUTION_RESPONSIBILITY",
  "CONDITIONAL_BRANCH",
  "USER_DECISION",
  "OPTIONAL_ENHANCEMENT",
] as const;

/** 一条「已判定处置」的未决项(编译器算好 → 策略侧只负责渲染)。 */
export interface DispositionedRequirementItem {
  id: string;
  text: string;
  classification: RequirementClass;
  blocking: boolean;
  impact: "high" | "medium" | "low";
  disposition: RequirementDisposition;
}

/** 分析阶段的完整产出(宿主 / UI / 编译器 / 校验器共用)。 */
export interface AnalysisResult {
  intent: IntentProfile;
  target: TargetResolution;
  triage: TriageDecision;
  /** 全部 UNKNOWN 及三分类 / 阻塞判定。 */
  missing_resolution: MissingResolutionItem[];
  gate: AnalysisGate;
  ledger: RequirementLedgerEntry[];
  /** 内部置信度 0..1(UI 不展示小数)。 */
  confidence_internal: number;
  rationale: string;
  evidence_quotes: string[];
  /** 向后兼容投影:等价于 `intent.primary`(general 兜底)。 */
  prompt_type: PromptType;
  /** 向后兼容:分诊为 PATCH/RESTRUCTURE/REBUILD 且可编译时,建议补充项。 */
  missing_constraints: string[];
  // ── v2 Phase 3 加法字段(可选;旧消费方零改动)──────────────────────────
  /**
   * 模型判定的**产品取舍 / 用户偏好**型决策(语义第一来源;
   * 机械判据 `isProductDecision` 只作安全网)。
   */
  decisions?: AnalysisDecision[];
  /** 模型给出的候选问题(面向用户目标 + 2–4 选项 + 推荐 + 依赖)。 */
  questions?: DiscoveryQuestion[];
}

/** 分析阶段识别出的一个需要用户决定的事项。 */
export interface AnalysisDecision {
  text: string;
  /** PRODUCT_DECISION = 产品取舍 / 偏好;USER_PREFERENCE = 个人口味;FACT_GAP = 只是缺事实。 */
  kind: "PRODUCT_DECISION" | "USER_PREFERENCE" | "FACT_GAP";
  impact: "high" | "medium" | "low";
  /** 是否必须问用户(模型判断;机械层可向安全方向纠正)。 */
  needs_user_decision: boolean;
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 Phase 3:Requirement Discovery(动态多轮,决策完备即停)
// ─────────────────────────────────────────────────────────────────────────────

/** 一个可选答案(面向用户的目标语言,不暴露内部枚举)。 */
export interface DiscoveryOption {
  id: string;
  /** 用户可读的选项文案(业务语言,如「先验证控制链路」)。 */
  label: string;
  /** 可选:一句话补充说明。 */
  description?: string;
  /** 选中该项时,内部写回 Ledger 的取值(可选;缺省用 label)。 */
  value?: string;
  /** 该选项被选中时,哪些 requirement 应失效/不适用(Answer Resolver 用)。 */
  invalidates?: string[];
}

/** 本轮要问用户的一个问题。 */
export interface DiscoveryQuestion {
  /** 稳定 key(去重 / 防重复询问用;= requirement id 或规范化文本)。 */
  key: string;
  /** 对应的 requirement(台账条目 id)。 */
  requirement_id: string;
  /** 面向用户的问题正文(业务语言,**不得**暴露内部枚举)。 */
  question: string;
  /** 2–4 个具体选项;为空 = 开放回答。 */
  options: DiscoveryOption[];
  /** 推荐项(仍是 OPTIMIZER_SUGGESTED,绝不等于用户已决定)。 */
  recommended_option_id?: string;
  /** 推荐理由(一句话)。 */
  recommendation_reason?: string;
  /** 为什么必须由用户决定(一句话;UI tooltip)。 */
  why: string;
  /** 该问题依赖的其他 requirement id:未解决前不得同轮提出(依赖分轮)。 */
  depends_on: string[];
  /** 是否允许「按你的判断继续」(默认 true)。 */
  allow_blind_trust?: boolean;
}

/** 用户的回答(客户端提交;宿主一律视为不可信输入)。 */
export interface DiscoveryAnswer {
  /** 对应 DiscoveryQuestion.key。 */
  key: string;
  /** 用户提交的**原话**(逐字证据来源;自由回答或选项文案)。 */
  text: string;
  /** 选中的选项 id(自由回答时为空)。 */
  option_id?: string;
  /** 用户点了「按你的判断继续」时为 true(只可产生 PROVISIONAL/CONDITIONAL/DEFERRED)。 */
  blind_trust?: boolean;
  /** 用户在「修改理解」里重新决定的 requirement id(重开该项)。 */
  reopen?: boolean;
}

/** 已被问过的记录(防重复询问)。 */
export interface AskedQuestion {
  key: string;
  question: string;
  round: number;
  /** 规范化指纹(同义改写去重用)。 */
  fingerprint: string;
}

/** Discovery 轮次的判决。 */
export type DiscoveryVerdict = "ASK" | "READY_TO_CONFIRM";

/** 一轮 Discovery 的完整结果(宿主下发,客户端保存并回传)。 */
export interface DiscoveryRound {
  round: number;
  verdict: DiscoveryVerdict;
  /** ASK 时 1–3 个高影响问题(默认 1–2)。 */
  questions: DiscoveryQuestion[];
  /** READY 时的确认摘要。 */
  confirmation?: RequirementConfirmation;
  /** 判决理由(用户可读)。 */
  rationale: string;
  /** 本轮之后仍然阻塞的项数(0 = 决策完备)。 */
  blocking_count: number;
  /** 安全保护是否触发(达到最大轮次 / 无新信息 / 无法形成高价值问题)。 */
  stopped_by?: "max_rounds" | "no_new_information" | "no_high_value_question";
}

/** Requirement Confirmation 摘要(只给用户看关键三/四组,不是完整台账)。 */
export interface RequirementConfirmation {
  /** 一句话:这次要做什么。 */
  goal: string;
  /** 你已确认(USER_EXPLICIT / CONTEXT_EXPLICIT → CONFIRMED)。 */
  confirmed: { text: string; value?: string }[];
  /** 执行 Agent 自行调查(AGENT_DISCOVERABLE / DISCOVERABLE)。 */
  agent_researches: string[];
  /** 暂定 / 条件事项(仅存在时显示)。 */
  provisional: { text: string; status: RequirementStatus; note?: string }[];
  /** 摘要指纹(确认时回传,防止「确认了另一个版本」)。 */
  fingerprint: string;
}

/** 客户端持有的 Discovery 会话(每轮回传;宿主重新净化)。 */
export interface DiscoverySessionState {
  /** 原始 Prompt(逐字;HOST 以 body.text 为准,此字段用于一致性校验)。 */
  raw_input: string;
  round: number;
  triage: EditTriage;
  ledger: RequirementLedgerEntry[];
  asked: AskedQuestion[];
  answers: DiscoveryAnswer[];
  /** 上一轮实际提出的问题(回答解析需要 options / invalidates)。 */
  questions: DiscoveryQuestion[];
  /** 上一次的分析结论(confirm 时直接用于编译,避免重复分析调用)。 */
  analysis?: AnalysisResult;
  /** Phase 4:已发生的 Validator 回流记录(有界;宿主当不可信输入净化)。 */
  validationReturns?: ValidationReturnRecord[];
}

/** Validator 回流记录(Phase 4;契约见 core/validation-flow.ts)。 */
export interface ValidationReturnRecord {
  reason_code: string;
  action: string;
  round: number;
}

/** SSE `returned` 事件:Validator 判定需要回流(不交付结果)。 */
export interface OptimizeReturnedEvent {
  type: "returned";
  action: string;
  reason_code?: string;
  detail: string;
  requires: string | null;
  returns: ValidationReturnRecord[];
  provenance_ok: boolean;
}

/** SSE `discovery_required` 事件:唯一允许「不生成」的出口。 */
export interface OptimizeDiscoveryRequiredEvent {
  type: "discovery_required";
  intent: IntentProfile;
  target: TargetResolution;
  triage: TriageDecision;
  ledger: RequirementLedgerEntry[];
  gate: AnalysisGate;
  rationale: string;
  provenance_ok: boolean;
  // ── Phase 3 加法字段 ────────────────────────────────────────────────────
  /** 当前轮次(1 起;首轮为 1)。 */
  round?: number;
  /** 本轮要问的 1–3 个高影响问题。 */
  questions?: DiscoveryQuestion[];
  /** 已问过的问题(客户端保存并回传,防重复询问)。 */
  asked?: AskedQuestion[];
  /** 执行 Agent 自行调查项(弱显示,不做待填字段)。 */
  agent_researches?: string[];
  /** 安全保护触发原因(达到轮次上限等)。 */
  stopped_by?: DiscoveryRound["stopped_by"];
  /**
   * 本轮分析结论(客户端**不解读**,原样保存并在 confirm 时回传,避免重复分析调用)。
   * 宿主回传时会重新做结构与不变量校验(不可信输入)。
   */
  analysis?: AnalysisResult;
}

/** SSE `requirement_confirmation` 事件:决策完备,等用户确认后才编译。 */
export interface OptimizeRequirementConfirmationEvent {
  type: "requirement_confirmation";
  intent: IntentProfile;
  target: TargetResolution;
  triage: TriageDecision;
  ledger: RequirementLedgerEntry[];
  gate: AnalysisGate;
  confirmation: RequirementConfirmation;
  rationale: string;
  provenance_ok: boolean;
  round: number;
  asked: AskedQuestion[];
  /** 安全保护:为何在仍有未决项时停下了追问(达到轮次上限 / 无新信息 / 无高价值问题)。 */
  stopped_by?: DiscoveryRound["stopped_by"];
  /** 同 discovery_required:客户端保存并在 confirm 时回传的分析结论(不解读)。 */
  analysis?: AnalysisResult;
}

