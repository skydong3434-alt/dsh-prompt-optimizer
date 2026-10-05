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
import { containmentRatio } from "./discovery.js";

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
  /** 执行关键的信息责任缺失(用户约束 / 权限边界 / 成功标准 / 目标契约主责任)。 */
  criticalResponsibilityMissing: "VF_CRITICAL_RESPONSIBILITY_MISSING",
  /** 交付稿为空(模型没有产出可用内容)→ 可重跑一次。 */
  emptyOutput: "VF_EMPTY_OUTPUT",
  /** 交付稿残留内部协议标记 → 解析降级,剥离后重出。 */
  protocolLeak: "VF_PROTOCOL_LEAK",
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

/**
 * 完整性评估:区分**执行关键**(缺失会让 Agent 做错方向)与**非关键**(推荐信息不全)。
 *
 * 关键设计决定(RC 审计):**按信息内容判定,不按标题名判定**。
 * 要求「必须出现某个责任标题」本身就是「Target-template-expander」的病征
 * (把任务模板换成 Subject/Shot 但仍然机械套模板)——因此:
 *   · 执行关键 = ① 用户已确认的明确要求 / 约束在交付稿里找不到(丢约束);
 *                ② 视觉契约完全没有表达任何 negative / 避免项(生成模型会照做不该做的事);
 *   · 非关键   = 责任标题没出现(结构问题,由策略守卫报 error → 交付 + provenance_ok=false 警示)。
 * 「结构 ≠ 信息」:少一个标题不必然影响执行,丢一条用户约束一定会。
 */
export interface CompletenessAssessment {
  criticalMissing: string[];
  nonCriticalMissing: string[];
  /** 用户已确认但交付稿中找不到的要求(最严重的一类)。 */
  droppedUserRequirements: string[];
}

/** 约束 / 安全边界类要求:丢失会改变执行方向的只有这一类。 */
const CONSTRAINT_LIKE_RE = /不要|不得|禁止|仅限|只(?:检查|看|改|做|用)|必须|保持|不变|不得改动|不修改|不引入|不改|必须带|不少于|不低于|上限|限制|权限|安全|合规/i;

/** 否定 / 排除项的表达(概念级,不要求标题名)。 */
const NEGATIVE_CONCEPT_RE = /不要|不得|避免|排除|禁止|勿|negative|avoid|exclude|without|no\s+(?:text|watermark|logo)/i;

export function assessCompleteness(input: {
  optimizedPrompt: string;
  responsibilities: readonly string[];
  ledger?: readonly { text: string; source: string; status: string; evidence?: readonly string[] }[];
  visualContract?: boolean;
}): CompletenessAssessment {
  const text = String(input.optimizedPrompt ?? "");
  const normalized = (value: string) => value.replace(/\s+/g, "").toLowerCase();
  const haystack = normalized(text);
  /**
   * 「这条要求还在不在交付稿里」——**语义级**判定:
   *   ① 逐字/前缀命中;② 包含率(较短一方 ≥50% 的 bigram 被覆盖)命中。
   * 后者让「用 dsh 控制 comfyui 生成视频」与「验证 DSH 能成功调用现有 ComfyUI
   * 工作流并产出视频」判为同一要求,避免把正常改写误判成「丢约束」。
   */
  const present = (needle: string): boolean => {
    const target = normalized(needle);
    if (!target) return true;
    if (haystack.includes(target)) return true;
    const head = target.slice(0, 12);
    if (head.length >= 4 && haystack.includes(head)) return true;
    return containmentRatio(needle, text) >= 0.5;
  };

  const criticalMissing: string[] = [];
  const nonCriticalMissing: string[] = [];

  // ① 用户已确认的明确要求 / 约束不得丢失(证据或条目文本任一命中即算保留)
  const droppedUserRequirements: string[] = [];
  for (const entry of input.ledger ?? []) {
    if (entry.source !== "USER_EXPLICIT" && entry.source !== "CONTEXT_EXPLICIT") continue;
    if (entry.status !== "CONFIRMED") continue;
    const candidates = [...(entry.evidence ?? []), entry.text].filter(Boolean);
    if (candidates.some((candidate) => present(String(candidate)))) continue;
    droppedUserRequirements.push(entry.text);
  }
  if (droppedUserRequirements.length > 0) {
    // RC:只有**约束 / 安全边界类**的丢失才会让 Agent 做错方向;
    // 目标复述类的句子在视觉契约定式里本来就不会原样出现(实测误报 rc12/13/16),
    // 因此这类记入非关键(仍然可见),不触发回流。
    const constraintLike = droppedUserRequirements.filter((text) => CONSTRAINT_LIKE_RE.test(text));
    const goalLike = droppedUserRequirements.filter((text) => !CONSTRAINT_LIKE_RE.test(text));
    if (constraintLike.length > 0) criticalMissing.push("用户已确认的要求 / 约束");
    for (const text of goalLike) nonCriticalMissing.push(`要求复述未逐字出现:${text}`);
  }

  // ② 视觉契约必须表达排除项(概念级:出现任何一种否定表达即可)
  if (input.visualContract && !NEGATIVE_CONCEPT_RE.test(text)) {
    criticalMissing.push("排除项 / negative(视觉契约必需)");
  }

  // ③ 其余责任缺失 = 结构问题 → 非关键(交付 + 警示)
  for (const name of input.responsibilities ?? []) {
    if (present(name)) continue;
    nonCriticalMissing.push(name);
  }

  return { criticalMissing, nonCriticalMissing, droppedUserRequirements };
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
  /** 执行关键的信息责任缺失(由 assessCompleteness 给出)。 */
  criticalMissing?: readonly string[];
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
    match: /EMPTY_OUTPUT/,
    action: "RETURN_TO_MISSING_RESOLUTION",
    reason: VALIDATION_REASON.emptyOutput,
    requires: "disposition_fix",
  },
  {
    match: /PROTOCOL_LEAK/,
    action: "RETURN_TO_MISSING_RESOLUTION",
    reason: VALIDATION_REASON.protocolLeak,
    requires: "disposition_fix",
  },
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

  // ③ 执行关键的信息责任缺失 → 必须回流(不能只警示)
  if ((input.criticalMissing ?? []).length > 0) {
    return record({
      action: "RETURN_TO_MISSING_RESOLUTION",
      reason_code: VALIDATION_REASON.criticalResponsibilityMissing,
      detail: `交付稿缺少执行关键的信息:${(input.criticalMissing ?? []).join(" / ")}`,
      requires: "disposition_fix",
      returns,
    });
  }

  // ④ 问题映射
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

  // ⑤ 未映射的 error(如「非关键责任缺失」这类**完整性**问题):
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

  // ⑥ 目标/引擎由优化器假定且显著影响结果 → 回到分析
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
