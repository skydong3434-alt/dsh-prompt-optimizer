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

/** 插件支持的提示词任务类型。`general` 是 AUTO 无法判定时的兜底,不单独出现在 UI 下拉。 */
export type PromptType =
  | "research"
  | "planning"
  | "execution"
  | "diagnostic"
  | "review"
  | "creative"
  | "general";

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

/** 策略输出契约段落(required_sections 是测试断言锚点:段落齐全性)。 */
export interface OutputContract {
  /** required_sections 按顺序出现的「编译产出段落标题」清单。 */
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
  llm_derived?: NormalizedContext["llm_derived"];
}

/** 一个完整策略:纯数据 + 纯函数,不依赖 ctx.llm / UI / Host;可独立版本化与测试。 */
export interface PromptStrategy {
  type: PromptType;
  name: string;
  version: string;
  purpose: string;
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
  confidence_level: ConfidenceLevel;
  missing_constraints: MissingConstraint[];
  rationale: string;
  provenance_ok: boolean;
}
