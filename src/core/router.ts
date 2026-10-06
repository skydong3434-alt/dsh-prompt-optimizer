/**
 * Target-aware Strategy Router —— v2 Phase 2。
 *
 * 取代 v1 的 `registry.get(intent)` 单键路由,按**多维证据**选编译契约:
 *   Primary Intent + Supporting Intents + Prompt Target + Target Engine + Modality
 *   + Requirement State + Edit Triage
 *
 * 优先级(表驱动,可审计):
 *   1. 手动覆盖(用户在 UI 显式选的意图)→ 意图策略(最高优先级,尊重用户);
 *   2. **视觉目标**(image / video)→ 视觉契约(目标胜过意图,图像/视频不得套任务模板);
 *   3. Agent 目标 + (执行 / 通用)意图 → Agent 任务指令契约;
 *   4. 其余 → 意图策略(research/planning/execution/diagnostic/review/creative/general);
 *   5. 都不成立 → general 兜底。
 *
 * `KEEP` 分诊不影响本路由(编译根本不发生);`REBUILD` 也不改变契约选择。
 * 纯函数,零 LLM / 零 Harness / 零 UI 依赖。
 */
import type { AnalysisResult, PromptStrategy, PromptTarget, WorkIntent } from "./types.js";
import type { PromptType } from "./types.js";
import { defaultStrategyRegistry, targetContractRegistry } from "./registry.js";
import type { StrategyRegistry } from "./registry.js";

/** 路由依据(用于 UI 展示与回归断言)。 */
export type RouteBasis =
  | "explicit-constraint"
  | "manual-override"
  | "visual-target"
  | "agent-target"
  | "intent"
  | "fallback";

export interface RouteDecision {
  strategy: PromptStrategy;
  basis: RouteBasis;
  /** 参与决策的信号快照(审计用,不参与行为)。 */
  signals: {
    primary: WorkIntent | "general";
    supporting: readonly string[];
    target: PromptTarget;
    modality: string;
    engine: string | null;
    triage: string;
  };
  /** 一句话理由(用户可读)。 */
  reason: string;
  /** 编译契约形态:`structured` = 责任清单型;`descriptive` = 视觉描述式。 */
  contract: "structured" | "descriptive";
}

/**
 * 正文里的**明确意图约束**(优先级最高,高于手动 override)。
 *
 * 例:「只检查,不修改文件」→ 无论用户在下拉里选了什么,都不能变成「直接执行」。
 * 优先级(产品规则):正文明确约束 > 手动 override > 自动判断 > 优化器建议。
 */
const EXPLICIT_INTENT_PATTERNS: readonly { intent: WorkIntent; re: RegExp; label: string }[] = [
  {
    intent: "review",
    re: /只(?:检查|看|审查|评估|复核|审阅|review)|不要修改|不修改|别改|不改动|只读|只审|no edits?|review only|read[- ]?only/i,
    label: "只检查 / 不修改",
  },
  {
    intent: "research",
    re: /只(?:研究|调研|查一下|检索|对比)|research only|just research/i,
    label: "只研究",
  },
  {
    intent: "planning",
    re: /只(?:规划|计划|出方案|拆解)|不要(?:执行|动手)|plan only|just plan/i,
    label: "只规划",
  },
  {
    intent: "diagnostic",
    re: /只(?:排查|定位|找原因|诊断)|diagnos(?:e|is) only/i,
    label: "只排查",
  },
];

/** 规格行标记:出现在这里的「只检查 / 只看」是**约束**,不是意图指令。 */
const SPEC_CLAUSE_RE =
  /^\s*(?:约束|要求|限制|禁止|排除|输出格式|格式|验收|验收标准|成功标准|风格|语气|篇幅|必须|不得|不要)[:：]/;

/** 从正文里读出「明确意图约束」;没有则 null。 */
export function explicitIntentFromInput(
  rawInput: string,
): { intent: WorkIntent; label: string; matched: string } | null {
  const text = String(rawInput ?? "");
  // 逐句判断:规格行(「约束:只看本地可跑的方案」)里的动词不是意图指令 ——
  // RC2 实测它会把 research 误判成 review(用户其实是在写约束,不是要求评审)。
  const clauses = text
    .split(/[。;；!?\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    if (SPEC_CLAUSE_RE.test(clause)) continue;
    for (const pattern of EXPLICIT_INTENT_PATTERNS) {
      const match = pattern.re.exec(clause);
      if (match) return { intent: pattern.intent, label: pattern.label, matched: match[0] };
    }
  }
  return null;
}

/** 视觉目标(目标胜过意图)。 */
const VISUAL_TARGETS: readonly PromptTarget[] = ["image_generation", "video_generation"];

/** Agent 目标可直接采用 Agent 契约的意图集合(其余意图仍走意图策略)。 */
const AGENT_TARGET_INTENTS: readonly (WorkIntent | "general")[] = ["execution", "general"];

/** 意图 → 契约策略 id(与 registry 的注册类型一致;未知回落 general)。 */
function intentStrategy(primary: WorkIntent | "general", registry: StrategyRegistry): PromptStrategy {
  return registry.get(primary as PromptType);
}

function signalsOf(analysis: AnalysisResult): RouteDecision["signals"] {
  return {
    primary: analysis.intent.primary,
    supporting: [...analysis.intent.supporting],
    target: analysis.target.target,
    modality: analysis.target.modality,
    engine: analysis.target.engine?.id ?? null,
    triage: analysis.triage.triage,
  };
}

/**
 * 路由入口。
 *
 * @param analysis 分析结果(Phase 1 产出;必填 —— 没有分析就没有目标维度)
 * @param options.manualType 用户手动覆盖的意图(最高优先级);缺省 = 自动
 */
export function routeStrategy(
  analysis: AnalysisResult,
  options: {
    manualType?: PromptType;
    registry?: StrategyRegistry;
    contractRegistry?: StrategyRegistry;
    /** 用户本轮原始输入(用于「正文明确约束 > 手动 override」判定)。 */
    rawInput?: string;
  } = {},
): RouteDecision {
  const registry = options.registry ?? defaultStrategyRegistry;
  const contracts = options.contractRegistry ?? targetContractRegistry;
  const signals = signalsOf(analysis);

  // 0. 正文明确约束**高于**手动 override(产品规则:正文 > override > 自动判断 > 建议)。
  //    例:「只检查,不修改文件」+ 用户选了 Execution → 仍按评审编译。
  if (options.manualType) {
    const explicit = options.rawInput ? explicitIntentFromInput(options.rawInput) : null;
    if (explicit && explicit.intent !== options.manualType) {
      return {
        strategy: registry.get(explicit.intent),
        basis: "explicit-constraint",
        signals,
        reason: `正文里明确写了「${explicit.matched}」(${explicit.label}),优先于手动选择的类型`,
        contract: "structured",
      };
    }
    // 1. 手动覆盖:用户显式选择的意图优先(与 v1 行为一致)。
    return {
      strategy: registry.get(options.manualType),
      basis: "manual-override",
      signals,
      reason: "你手动指定了任务类型,按该类型编译",
      contract: "structured",
    };
  }

  // 2. 视觉目标:目标胜过意图。
  if (VISUAL_TARGETS.includes(analysis.target.target)) {
    const strategy = contracts.get(analysis.target.target === "video_generation" ? "video" : "image");
    return {
      strategy,
      basis: "visual-target",
      signals,
      reason: `目标是${analysis.target.target === "video_generation" ? "视频" : "图像"}生成,采用描述式视觉契约(不套任务模板)`,
      contract: "descriptive",
    };
  }

  // 3. Agent 目标 + 执行/通用意图。
  if (analysis.target.target === "agent_task" && AGENT_TARGET_INTENTS.includes(analysis.intent.primary)) {
    return {
      strategy: contracts.get("agent"),
      basis: "agent-target",
      signals,
      reason: "目标是交给 Agent 执行的任务,采用 Agent 任务指令契约",
      contract: "structured",
    };
  }

  // 4. 意图策略(含 research/planning/... 以及目标为 coding/writing/data_analysis 的情况)。
  const byIntent = intentStrategy(analysis.intent.primary, registry);
  return {
    strategy: byIntent,
    basis: byIntent.type === "general" && analysis.intent.primary !== "general" ? "fallback" : "intent",
    signals,
    reason:
      byIntent.type === "general" && analysis.intent.primary !== "general"
        ? "未找到匹配的意图策略,回退通用策略"
        : `按主意图「${analysis.intent.primary}」选择策略`,
    contract: "structured",
  };
}

/** 该路由是否为视觉(描述式)契约(Phase 2 的编译契约分支点)。 */
export function isVisualContract(decision: RouteDecision): boolean {
  return decision.contract === "descriptive";
}
