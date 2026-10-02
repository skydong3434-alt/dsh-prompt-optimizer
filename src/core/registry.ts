/**
 * Strategy Registry(最小版,Vertical Slice):research + general fallback。
 *
 * P01.5 只打通 Research 一条验收路径;general 是 AUTO 分类失败 / 低置信时的兜底,
 * 复用 Y1X1n 既有 template / intent 双模式提示词(行为与改造前完全一致)。
 * P02-T08 会把这里扩展为七策略完整注册表;本模块的 `get()` fallback 语义
 * (未知类型 → general)在该扩展中保持不变。
 *
 * 纯数据 + 纯函数:零 ctx.llm / UI / Host 依赖,可独立测试。
 */
import type { CompileVars, PromptStrategy, PromptType } from "./types.js";
import { researchStrategy } from "./strategies/research.js";
import { buildSystemPrompt, buildUserPayload } from "../prompt.js";

/**
 * 标记「legacy general 兜底策略」:它的 system / user 由 Y1X1n prompt.ts 生成,
 * 需要 mode / previous 等 CompileVars 之外的参数,由 compiler 专门处理。
 * 用 WeakSet 而非可枚举字段,避免污染 PromptStrategy 契约形状(G-1 冻结)。
 */
const LEGACY_GENERAL = new WeakSet<PromptStrategy>();

/** 该策略是否为 legacy general 兜底(compiler 据此走既有 prompt.ts 构造)。 */
export function isLegacyGeneral(strategy: PromptStrategy): boolean {
  return LEGACY_GENERAL.has(strategy);
}

/**
 * general 兜底策略:吸收 Y1X1n 现有 template / intent 双模式。
 * buildSystem / buildUser 为契约占位实现(默认 zh/full/template);真实 Host 路径
 * 由 compiler 识别 legacy 后以 mode/previous 直接调用 prompt.ts,保证零回归。
 */
const generalFallbackStrategy: PromptStrategy = {
  type: "general",
  name: "General（通用 fallback）",
  version: "0.1.0",
  purpose:
    "AUTO 无法判定或分类失败时的兜底策略:复用既有「结构模板 / 提炼目的」双模式,把草稿改写为结构完整、可直接发送的提示词。",
  required_sections: [],
  optional_sections: [],
  preservationRules: [],
  suggestionRules: [],
  guards: [],
  provenanceRules: [],
  buildSystem(language: "zh" | "en"): string {
    return buildSystemPrompt(language, "full", "template");
  },
  buildUser(vars: CompileVars): string {
    return buildUserPayload(vars.raw_input, "zh", [...vars.context_turns]);
  },
  outputContract: {
    sections: [],
    formatNote: "沿用 Y1X1n template / intent 双模式与 ANALYSIS / OPTIMIZED 标记协议。",
  },
};
LEGACY_GENERAL.add(generalFallbackStrategy);

export { generalFallbackStrategy };

/** 注册表只读面(测试与 Host 共用)。 */
export interface StrategyRegistry {
  /** 按类型取策略;未知类型一律回退 general(不抛错)。 */
  get(type: PromptType | string): PromptStrategy;
  /** 全部已注册策略(按注册顺序)。 */
  list(): PromptStrategy[];
  /** 各策略独立版本:{ type: version }(可审计:策略升级不改插件版本)。 */
  getVersion(): Record<string, string>;
  /** 该类型是否已注册(不含 fallback)。 */
  has(type: string): boolean;
}

/** 按策略数组创建只读注册表;缺省 = [research, general]。 */
export function createStrategyRegistry(
  strategies: readonly PromptStrategy[] = [researchStrategy, generalFallbackStrategy],
): StrategyRegistry {
  const byType = new Map<string, PromptStrategy>();
  let general: PromptStrategy | undefined;
  for (const strategy of strategies) {
    byType.set(strategy.type, strategy);
    if (strategy.type === "general") general = strategy;
  }
  if (!general) {
    // 调用方裁剪了 general 时仍保证 fallback 可用(否则 get() 无法兜底)。
    byType.set(generalFallbackStrategy.type, generalFallbackStrategy);
    general = generalFallbackStrategy;
  }
  const fallback = general;
  return {
    get(type) {
      return byType.get(type) ?? fallback;
    },
    list() {
      return [...byType.values()];
    },
    getVersion() {
      const versions: Record<string, string> = {};
      for (const [type, strategy] of byType) versions[type] = strategy.version;
      return versions;
    },
    has(type) {
      return byType.has(type);
    },
  };
}

/** 缺省注册表(research + general fallback),Host handler 直接使用。 */
export const defaultStrategyRegistry: StrategyRegistry = createStrategyRegistry();
