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
  } = {},
): RouteDecision {
  const registry = options.registry ?? defaultStrategyRegistry;
  const contracts = options.contractRegistry ?? targetContractRegistry;
  const signals = signalsOf(analysis);

  // 1. 手动覆盖:用户显式选择的意图优先(与 v1 行为一致)。
  if (options.manualType) {
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
