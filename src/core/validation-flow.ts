/**
 * Validator 回流控制器 —— v2 Phase 4。
 *
 * Phase 3 的 Validator 只会 `fail-closed`;Phase 4 把它升级为**可控回流**:
 *
 *   PASS                         → 交付
 *   RETURN_TO_MISSING_RESOLUTION → 修正 provenance / disposition 后重新判定缺失
 *   RETURN_TO_DISCOVERY          → 产生/暴露了阻塞性的用户决定 → 回到 Discovery
 *   RETURN_TO_ANALYSIS           → 目标 / 引擎假定错误 → 回到分析
 *   HARD_ERROR                   → 不可恢复的内部契约错误
 *
 * 三条纪律:
 *   1. **纯机械规则**,不引入新的 LLM 调用(Validator 不变成另一个 Agent);
 *   2. **每次回流都有稳定 reason_code**(可测试、可审计);
 *   3. **必须有界**:同一 reason_code 不得反复触发同一循环(第二次即升级为 HARD_ERROR),
 *      且一个 optimization session 的回流总次数有上限。
 *
 * 纯函数,零 Harness / UI 依赖。
 */
import type { CompileResult, ValidationProblem } from "./types.js";

/** 回流动作(概念枚举;行为语义见文件头)。 */
export type ValidationAction =
  | "PASS"
  | "RETURN_TO_MISSING_RESOLUTION"
  | "RETURN_TO_DISCOVERY"
  | "RETURN_TO_ANALYSIS"
  | "HARD_ERROR";

/** 稳定 reason code(不得随意改名;测试与日志引用)。 */
export const VALIDATION_REASON = {
  /** 优化稿把未决项写成面向用户的追问(应交给执行方或 Discovery)。 */
  userFacingQuestion: "VF_USER_FACING_QUESTION",
  /** 已退役的 [待补充:] / [TODO:] 占位符出现。 */
  retiredPlaceholder: "VF_RETIRED_PLACEHOLDER",
  /** 无证据的 USER_EXPLICIT(伪造来源)→ 降级后回流。 */
  fabricatedUserExplicit: "VF_FABRICATED_USER_EXPLICIT",
  /** 无证据的强断言 / 量化(静默假设)。 */
  silentAssumption: "VF_SILENT_ASSUMPTION",
  /** 建议被无痕升级为用户要求。 */
  suggestionUpgraded: "VF_SUGGESTION_UPGRADED",
  /** 目标 / 引擎假定与输入证据冲突。 */
  targetAssumption: "VF_TARGET_ASSUMPTION",
  /** 图像 / 视频成品出现任务模板标题。 */
  taskTemplateInVisual: "VF_TASK_TEMPLATE_IN_VISUAL",
  /** KEEP 路径被改写(硬承诺被破坏)。 */
  keepRewritten: "VF_KEEP_REWRITTEN",
  /** 仍然存在阻塞性的用户决定,却进入了编译。 */
  blockingNotResolved: "VF_BLOCKING_NOT_RESOLVED",
  /** 回流次数超限。 */
  returnBudgetExhausted: "VF_RETURN_BUDGET_EXHAUSTED",
  /** 同一失败重复触发(无法通过回流修复)。 */
  repeatedFailure: "VF_REPEATED_FAILURE",
} as const;

export type ValidationReasonCode = (typeof VALIDATION_REASON)[keyof typeof VALIDATION_REASON];

/** 每个 session 允许的回流次数上限(安全保护,不是产品目标)。 */
export const VALIDATION_RETURN_LIMIT = 2;

/**
 * 回流记录(客户端保存并回传,宿主当不可信输入净化)。
 * 形状与 `types.ts::ValidationReturnRecord` 一致(action 用宽松 string,便于净化)。
 */
export interface ValidationReturnRecord {
  reason_code: string;
  action: string;
  round: number;
}

export interface ValidationFlowInput {
  /** 三层校验 + 策略守卫的问题清单。 */
  problems: readonly ValidationProblem[];
  result: CompileResult;
  /** 原始输入(用于 target / keep 判定)。 */
  rawInput: string;
  /** 本轮之前已经发生过的回流记录。 */
  returns?: readonly ValidationReturnRecord[];
  /** 当前轮次(session round)。 */
  round?: number;
  /** 是否仍存在 live blocking 的用户决定(由 Sufficiency 给出)。 */
  liveBlockingCount?: number;
  /** 是否为 KEEP 分诊(硬承诺:输出必须逐字等于输入)。 */
  keepExpected?: boolean;
  /** 是否为视觉(描述式)契约。 */
  visualContract?: boolean;
  /** 目标/引擎是否由优化器假定(分析侧给出的标记)。 */
  targetAssumed?: boolean;
}

export interface ValidationFlowOutcome {
  action: ValidationAction;
  /** PASS 时为空。 */
  reason_code?: ValidationReasonCode;
  /** 用户可读的一句话(错误态要能看懂)。 */
  detail: string;
  /** 是否需要把某个 provenance 降级后重判(动作 A/B/C 的机械含义)。 */
  requires?: "provenance_downgrade" | "disposition_fix" | "reanalysis" | "discovery";
  /** 回流记录(调用方应保存并回传)。 */
  returns: ValidationReturnRecord[];
}

/** 问题 rule id → 回流动作与 reason code 的映射(表驱动,可审计)。 */
const PROBLEM_ROUTING: readonly {
  match: RegExp;
  action: ValidationAction;
  reason: ValidationReasonCode;
  requires: ValidationFlowOutcome["requires"];
}[] = [
  {
    match: /RETIRED_PLACEHOLDER/,
    action: "RETURN_TO_MISSING_RESOLUTION",
    reason: VALIDATION_REASON.retiredPlaceholder,
    requires: "disposition_fix",
  },
  {
    match: /USER_FACING_QUESTION/,
    action: "RETURN_TO_MISSING_RESOLUTION",
    reason: VALIDATION_REASON.userFacingQuestion,
    requires: "disposition_fix",
  },
  {
    match: /PROVENANCE_EVIDENCE_NOT_IN_RAW|EVIDENCE_NOT_IN_RAW/,
    action: "RETURN_TO_MISSING_RESOLUTION",
    reason: VALIDATION_REASON.fabricatedUserExplicit,
    requires: "provenance_downgrade",
  },
  {
    match: /SUGGESTED_IN_REQUIREMENTS|SUGGESTED_UPGRADED/,
    action: "RETURN_TO_MISSING_RESOLUTION",
    reason: VALIDATION_REASON.suggestionUpgraded,
    requires: "provenance_downgrade",
  },
  {
    match: /UNPROVEN_STRONG_CLAIM|UNEVIDENCED_QUANTIFICATION/,
    action: "RETURN_TO_MISSING_RESOLUTION",
    reason: VALIDATION_REASON.silentAssumption,
    requires: "disposition_fix",
  },
  {
    match: /visual-no-task-template/,
    action: "RETURN_TO_MISSING_RESOLUTION",
    reason: VALIDATION_REASON.taskTemplateInVisual,
    requires: "disposition_fix",
  },
  {
    match: /keep-fidelity/,
    action: "HARD_ERROR",
    reason: VALIDATION_REASON.keepRewritten,
    requires: undefined,
  },
  {
    match: /TARGET_ENGINE_CONFLICT|TARGET_MISMATCH/,
    action: "RETURN_TO_ANALYSIS",
    reason: VALIDATION_REASON.targetAssumption,
    requires: "reanalysis",
  },
];

/**
 * 决定回流动作。
 *
 * 顺序:
 *   1. 仍存在阻塞性用户决定 → `RETURN_TO_DISCOVERY`(编译根本不该发生);
 *   2. 逐条问题按表映射;取「最严重」的动作(优先级见 ACTION_SEVERITY);
 *   3. 无问题 → `PASS`;
 *   4. 有界性:同一 reason_code 已出现过 → `HARD_ERROR`(回流无法修复);
 *      回流总次数达到上限 → `HARD_ERROR`;
 *   5. 目标由优化器擅自假定且显著影响结果 → `RETURN_TO_ANALYSIS`。
 */
export function decideValidationAction(input: ValidationFlowInput): ValidationFlowOutcome {
  const returns = [...(input.returns ?? [])];
  const round = input.round ?? 1;
  const seen = new Set(returns.map((record) => record.reason_code));
  const budgetExhausted = returns.length >= VALIDATION_RETURN_LIMIT;

  const record = (outcome: ValidationFlowOutcome): ValidationFlowOutcome => {
    if (outcome.action === "PASS" || outcome.action === "HARD_ERROR" || !outcome.reason_code) return outcome;
    if (seen.has(outcome.reason_code)) {
      // 同一失败重复出现 → 回流修不掉,升级为硬错误(避免无限循环)
      return {
        action: "HARD_ERROR",
        reason_code: VALIDATION_REASON.repeatedFailure,
        detail: `同一校验失败重复出现(${outcome.reason_code}),回流无法修复:${outcome.detail}`,
        returns,
      };
    }
    if (budgetExhausted) {
      return {
        action: "HARD_ERROR",
        reason_code: VALIDATION_REASON.returnBudgetExhausted,
        detail: `回流次数已达上限(${VALIDATION_RETURN_LIMIT}),为避免无限循环停止:${outcome.detail}`,
        returns,
      };
    }
    const next = [...returns, { reason_code: outcome.reason_code, action: outcome.action, round }];
    return { ...outcome, returns: next };
  };

  // ① 阻塞性用户决定仍在 → 绝不能编译(§21 fail-closed 的可控版本:回到 Discovery)
  if ((input.liveBlockingCount ?? 0) > 0) {
    return record({
      action: "RETURN_TO_DISCOVERY",
      reason_code: VALIDATION_REASON.blockingNotResolved,
      detail: `仍有 ${input.liveBlockingCount} 个只有你能决定的问题没有确认,先确认再生成`,
      requires: "discovery",
      returns,
    });
  }

  // ② KEEP 硬承诺:输出必须逐字等于输入
  if (input.keepExpected && input.result.optimized_prompt !== input.rawInput) {
    return {
      action: "HARD_ERROR",
      reason_code: VALIDATION_REASON.keepRewritten,
      detail: "KEEP 分诊要求原样保留,但产出与输入不一致(内部契约错误)",
      returns,
    };
  }

  // ③ 问题映射
  const errors = input.problems.filter((problem) => problem.severity === "error");
  const matched = errors
    .map((problem) => PROBLEM_ROUTING.find((route) => route.match.test(problem.rule)))
    .filter((route): route is (typeof PROBLEM_ROUTING)[number] => route !== undefined);

  if (matched.length > 0) {
    const worst = matched.sort((a, b) => ACTION_SEVERITY[b.action] - ACTION_SEVERITY[a.action])[0]!;
    return record({
      action: worst.action,
      reason_code: worst.reason,
      detail: errors
        .filter((problem) => worst.match.test(problem.rule))
        .map((problem) => problem.detail)
        .slice(0, 3)
        .join("; "),
      requires: worst.requires,
      returns,
    });
  }

  // ④ 未映射的 error(如「必出段落缺失」这类**完整性**问题):
  //    回流解决不了它 —— 它需要模型重写,而不是重新判定缺失或再问用户。
  //    因此**交付并警示**(provenance_ok=false,UI 顶部提示),不静默丢弃内容。
  //    只有能通过「改 provenance / 改处置 / 重判目标」修好的问题才回流(见 ③)。
  if (errors.length > 0) {
    return {
      action: "PASS",
      detail: errors.map((problem) => problem.detail).slice(0, 3).join("; "),
      returns,
    };
  }

  // ⑤ 目标/引擎由优化器假定且显著影响结果 → 回到分析
  if (input.targetAssumed) {
    return record({
      action: "RETURN_TO_ANALYSIS",
      reason_code: VALIDATION_REASON.targetAssumption,
      detail: "提示词目标/引擎是优化器推断的,可能显著影响产出,需重新判断",
      requires: "reanalysis",
      returns,
    });
  }

  return { action: "PASS", detail: "", returns };
}

/** 动作严重度(数值越大越需要「往上走」)。 */
export const ACTION_SEVERITY: Record<ValidationAction, number> = {
  PASS: 0,
  RETURN_TO_MISSING_RESOLUTION: 1,
  RETURN_TO_DISCOVERY: 2,
  RETURN_TO_ANALYSIS: 3,
  HARD_ERROR: 4,
};

/** 该动作是否需要用户可见的错误提示(HARD_ERROR / 超限)。 */
export function isHardFailure(action: ValidationAction): boolean {
  return action === "HARD_ERROR";
}

/** 审计快照(日志 / 测试用)。 */
export function describeValidationOutcome(outcome: ValidationFlowOutcome): string {
  return `${outcome.action}${outcome.reason_code ? `(${outcome.reason_code})` : ""}`;
}
