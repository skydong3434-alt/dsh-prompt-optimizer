/**
 * Recoverable Provenance Correction —— v0.2.0-apo release blocker 修复。
 *
 * 问题（真实冒烟取证）:模型偶尔把**不属于用户**的内容写进 USER_EXPLICIT 组
 * （自己的建议 / 对不上逐字证据的引用）。provenance 守卫**正确**地拒绝交付
 * （`VF_SUGGESTION_UPGRADED` / `VF_FABRICATED_USER_EXPLICIT`）——但 provider 已成功返回、
 * 用户输入也没有错，把模型的**内部分组错误**转嫁给用户（只能重试）不是可接受的体验。
 *
 * 本模块补上 controlled-return 设计中尚未闭环的一环:**可机械安全修复的 provenance 错误
 * 自动修复后再校验**,不可安全确定的才 fail closed。
 *
 * 机械解析顺序（用户裁决 §三/§四）:
 *   1. 证据能在 raw_input 找到        → 保持 USER_EXPLICIT
 *   2. 证据能在 context 用户发言找到   → CONTEXT_EXPLICIT
 *   3. 能确定属于 optimizer 自己的建议 → OPTIMIZER_SUGGESTED（不得显示为「你已确认」）
 *   4. 其余                            → UNKNOWN → 交 Missing Resolution 机械分类
 *      （分类出 blocking USER_REQUIRED 才进 Discovery,否则继续交付）
 *
 * 纯函数、零 Harness/UI 依赖;不改 provenance 红线(不放松校验),只是把可机械纠正的
 * 分组错误就地纠正。
 */
import type { CompileResult, ConversationTurn, ProvenanceRecord, ProvenanceSource } from "./types.js";
import { resolveQuoteSource } from "./provenance.js";
import { sameRequirement } from "./requirements.js";

export type ProvenanceRecoveryReason = "VF_SUGGESTION_UPGRADED" | "VF_FABRICATED_USER_EXPLICIT";

export interface ProvenanceCorrection {
  id: string;
  text: string;
  from: ProvenanceSource;
  to: ProvenanceSource;
  reason_code: ProvenanceRecoveryReason;
  detail: string;
}

export interface ProvenanceRecoveryResult {
  /** 校正后的编译结果(调用方应改用这一份)。 */
  result: CompileResult;
  corrections: ProvenanceCorrection[];
  /** 降级为 UNKNOWN 的条目(交 Missing Resolution 机械分类)。 */
  unresolved: ProvenanceRecord[];
  /** 机械修复条数(审计:recovered_provenance_count)。 */
  recovered: number;
}

export interface ProvenanceRecoveryInput {
  rawInput: string;
  contextTurns: readonly ConversationTurn[];
  /** 分析阶段识别出的 optimizer 建议文本(用于判定「这是它自己的建议」)。 */
  suggestions?: readonly string[];
}

/** 该条目是否属于 optimizer 自己的建议(文本级重合即可,含被改写的措辞)。 */
function matchesSuggestion(record: ProvenanceRecord, suggestions: readonly string[]): boolean {
  const candidates = [record.text, ...(record.evidence ?? [])].filter(Boolean);
  return candidates.some((candidate) =>
    suggestions.some((suggestion) => sameRequirement(candidate, suggestion)),
  );
}

/**
 * 机械对账编译结果里的 provenance 分组。
 *
 * 只处理 `explicit_requirements` / `context_requirements`（有来源权威性的两组）;
 * suggested / unknowns 不参与(它们本来就没有用户权威性)。
 */
export function reconcileProvenance(
  result: CompileResult,
  input: ProvenanceRecoveryInput,
): ProvenanceRecoveryResult {
  const suggestions = (input.suggestions ?? []).filter(Boolean);
  const corrections: ProvenanceCorrection[] = [];
  const unresolved: ProvenanceRecord[] = [];

  const keepExplicit: ProvenanceRecord[] = [];
  const keepContext: ProvenanceRecord[] = [];
  const suggested: ProvenanceRecord[] = [...result.suggested_requirements];
  const unknowns: ProvenanceRecord[] = [...result.unknowns];

  const demote = (
    record: ProvenanceRecord,
    from: ProvenanceSource,
    to: ProvenanceSource,
    detail: string,
  ): void => {
    corrections.push({
      id: record.id,
      text: record.text,
      from,
      to,
      reason_code: to === "OPTIMIZER_SUGGESTED" ? "VF_SUGGESTION_UPGRADED" : "VF_FABRICATED_USER_EXPLICIT",
      detail,
    });
    if (to === "OPTIMIZER_SUGGESTED") {
      suggested.push({ ...record, source: "OPTIMIZER_SUGGESTED", evidence: [], confidence: "low" });
    } else {
      const unknown: ProvenanceRecord = { ...record, source: "UNKNOWN", evidence: [], confidence: "low" };
      unknowns.push(unknown);
      unresolved.push(unknown);
    }
  };

  for (const record of result.explicit_requirements) {
    const quote = record.evidence[0] ?? "";
    const resolution = quote
      ? resolveQuoteSource(quote, input.rawInput, [...input.contextTurns])
      : { valid: false, matchedIn: "none" as const };
    if (resolution.valid && resolution.matchedIn === "raw") {
      keepExplicit.push(record);
      continue;
    }
    if (resolution.valid && resolution.matchedIn === "context-user") {
      corrections.push({
        id: record.id,
        text: record.text,
        from: "USER_EXPLICIT",
        to: "CONTEXT_EXPLICIT",
        reason_code: "VF_FABRICATED_USER_EXPLICIT",
        detail: "逐字证据不在本轮输入,但在上下文用户发言中找到 → 降级为 CONTEXT_EXPLICIT",
      });
      keepContext.push({ ...record, source: "CONTEXT_EXPLICIT" });
      continue;
    }
    if (matchesSuggestion(record, suggestions)) {
      demote(record, "USER_EXPLICIT", "OPTIMIZER_SUGGESTED", "内容属于优化器自己的建议 → 降级为 OPTIMIZER_SUGGESTED(不得作为用户要求)");
      continue;
    }
    demote(record, "USER_EXPLICIT", "UNKNOWN", "找不到逐字用户证据,也无法归属优化器建议 → 降级为 UNKNOWN 并交缺失解析");
  }

  for (const record of result.context_requirements) {
    const quote = record.evidence[0] ?? "";
    const resolution = quote
      ? resolveQuoteSource(quote, input.rawInput, [...input.contextTurns])
      : { valid: false, matchedIn: "none" as const };
    if (resolution.valid) {
      keepContext.push(record);
      continue;
    }
    if (matchesSuggestion(record, suggestions)) {
      demote(record, "CONTEXT_EXPLICIT", "OPTIMIZER_SUGGESTED", "内容属于优化器自己的建议 → 降级为 OPTIMIZER_SUGGESTED");
      continue;
    }
    demote(record, "CONTEXT_EXPLICIT", "UNKNOWN", "上下文证据不成立 → 降级为 UNKNOWN 并交缺失解析");
  }

  return {
    result: {
      ...result,
      explicit_requirements: keepExplicit,
      context_requirements: keepContext,
      suggested_requirements: suggested,
      unknowns,
    },
    corrections,
    unresolved,
    recovered: corrections.length,
  };
}

/** 审计一行(日志/测试共用)。 */
export function describeProvenanceRecovery(corrections: readonly ProvenanceCorrection[]): string {
  if (corrections.length === 0) return "provenance 对账:无需修正";
  return (
    `provenance 对账:自动修正 ${corrections.length} 项 —— ` +
    corrections
      .map((c) => `${c.from}→${c.to}(${c.reason_code})「${c.text.slice(0, 24)}」`)
      .join(";")
  );
}
