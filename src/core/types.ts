/**
 * 共享契约类型(V3 单次调用架构)。
 *
 * 这里只保留 V3 仍在用的最小契约:
 *  - ConversationTurn:会话上下文轮次(宿主与 prompt.ts 共用);
 *  - PromptType:UI 下拉与设置项的闭集(客户端契约);
 *  - EditTriage / TRIAGE_SEVERITY / TriageDecision:编辑分诊契约(triage.ts)。
 *
 * 旧多阶段链路(Analysis / Ledger / Discovery / Validation / Provenance /
 * Strategy)的类型已随该链路一并删除 —— 只保留一套流程,不为历史兼容留类型。
 */

/** 会话轮次。assistant 发言只能作为延续参考,永不能当作「用户意图证据」。 */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

/** 提示词类型闭集(UI 下拉与设置项校验用)。 */
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

/** 编辑分诊四级:干预强度递增。 */
export type EditTriage = "KEEP" | "PATCH" | "RESTRUCTURE" | "REBUILD";

/** 四级闭集(回归测试与审计用)。 */
export const EDIT_TRIAGE_LEVELS: readonly EditTriage[] = ["KEEP", "PATCH", "RESTRUCTURE", "REBUILD"] as const;

/** 分诊严重度(数值越大干预越强);用于机械判据的合并与单调性检查。 */
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
  /**
   * 是否存在**确定性结构混乱证据**(RESTRUCTURE 的唯一合法依据)。
   * mergeTriage 用它阻止「机械 PATCH 被模型借道升级为 RESTRUCTURE」。
   */
  restructure_eligible?: boolean;
  /** 是否由 LLM 建议参与合并(审计用)。 */
  llm_advised?: boolean;
  /** 机械判据给出的级别(审计 / 回归用)。 */
  mechanical?: EditTriage;
  /** LLM 给出的级别(审计 / 回归用)。 */
  llm_suggestion?: EditTriage;
  /** 结构性缺陷(只有 REBUILD 允许存在)。 */
  structural_problems?: string[];
}
