/**
 * Strategy Registry(完整版,P02-T08):七策略按类型索引 + general 兜底 + 版本暴露。
 *
 * 七个 `PromptStrategy`(research / planning / execution / diagnostic / review /
 * creative / general)全部在此注册:每个策略自带 sections / rules / guards /
 * provenanceRules 与独立 `version`,可独立升级(策略升级只改策略版本,不改插件版本)。
 *
 * 兜底语义:`get(type)` 对未知类型一律回退 general(不抛错),与 P01.5 最小版一致;
 * `createStrategyRegistry()` 若调用方裁掉了 general,会自动补回,保证 fallback 始终可用。
 *
 * 过渡期说明(零回归):general 的 host 编译路径仍由 `isLegacyGeneral` 标记为 legacy,
 * compiler 据此沿用 Y1X1n `prompt.ts` 的 template / intent 双模式与 ANALYSIS / OPTIMIZED
 * 解析(行为与改造前完全一致);策略对象本身的八板块契约 / 守卫已全量注册,可被 registry
 * 审计与单测,待 P05 Host 集成统一切换。本模块纯数据 + 纯函数:零 LLM 调用 / UI / Host 依赖。
 */
import type { PromptStrategy, PromptType } from "./types.js";
import { researchStrategy } from "./strategies/research.js";
import { planningStrategy } from "./strategies/planning.js";
import { executionStrategy } from "./strategies/execution.js";
import { diagnosticStrategy } from "./strategies/diagnostic.js";
import { reviewStrategy } from "./strategies/review.js";
import { creativeStrategy } from "./strategies/creative.js";
import { generalStrategy } from "./strategies/general.js";

/**
 * 标记「走 legacy 编译路径」的策略:compiler 对该策略改用 Y1X1n `prompt.ts` 的
 * template / intent 构造(需要 mode / previous 等 CompileVars 之外的参数),
 * 而非 `strategy.buildSystem / buildUser`。用 WeakSet 而非可枚举字段,避免污染
 * PromptStrategy 契约形状(G-1 冻结)。不用对象身份跨 bundle 判定——调用方与
 * registry 同 bundle 时命中,独立 bundle 的策略副本不会误判(见 core-pipeline cp3)。
 */
const LEGACY_GENERAL = new WeakSet<PromptStrategy>();

/** 该策略是否走 legacy general 编译路径(compiler 据此走既有 prompt.ts 构造)。 */
export function isLegacyGeneral(strategy: PromptStrategy): boolean {
  return LEGACY_GENERAL.has(strategy);
}

/**
 * general 兜底策略:注册 P02-T07 的 `general.ts`(八板块 + template / intent 双模式)。
 * 过渡期仍标记为 legacy(host 编译路径走 prompt.ts,零回归);`generalFallbackStrategy`
 * 作为向后兼容别名保留,旧引用(research 兜底 / 旧单测)无需改动。
 */
LEGACY_GENERAL.add(generalStrategy);

/** 向后兼容别名:registry 的 general 兜底策略。 */
export const generalFallbackStrategy: PromptStrategy = generalStrategy;

export { generalStrategy };

/** 七个类型按 UI / PromptType 顺序的规范注册顺序。 */
export const DEFAULT_STRATEGIES: readonly PromptStrategy[] = [
  researchStrategy,
  planningStrategy,
  executionStrategy,
  diagnosticStrategy,
  reviewStrategy,
  creativeStrategy,
  generalStrategy,
];

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
  /** 已注册类型清单(按注册顺序;含自动补回的 general)。 */
  types(): string[];
  /** 某类型(未知类型按 fallback 解析)的 required_sections 快照。 */
  getSections(type: PromptType | string): string[];
}

/**
 * 按策略数组创建只读注册表;缺省 = 七策略全量。
 *
 * 若数组里没有 general,自动补入 `generalStrategy`——否则 `get()` 无法兜底。
 * 重复类型后注册者覆盖先注册者(Map 语义),并保留首次出现的位置。
 */
export function createStrategyRegistry(
  strategies: readonly PromptStrategy[] = DEFAULT_STRATEGIES,
): StrategyRegistry {
  const byType = new Map<string, PromptStrategy>();
  for (const strategy of strategies) {
    byType.set(strategy.type, strategy);
  }
  let fallback = byType.get("general");
  if (!fallback) {
    // 调用方裁剪了 general 时仍保证 fallback 可用。
    byType.set(generalStrategy.type, generalStrategy);
    fallback = generalStrategy;
  }
  const general = fallback;
  return {
    get(type) {
      return byType.get(type) ?? general;
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
    types() {
      return [...byType.keys()];
    },
    getSections(type) {
      return [...(byType.get(type) ?? general).required_sections];
    },
  };
}

/** 缺省注册表(七策略全量),Host handler 直接使用。 */
export const defaultStrategyRegistry: StrategyRegistry = createStrategyRegistry();
