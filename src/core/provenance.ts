/**
 * Provenance 机械校验器:五源判定 / quote 字面比对 / 整组记录校验 / 记录工厂。
 *
 * 纯函数,零依赖(不触碰任何 Harness / Node / DOM API),可独立测试与跨端复用。
 * 这是 Provenance 的第一道防线:优化器不得把自己的推断伪装成用户要求。
 *
 * ── 五类来源语义(与 PLAN-v1 §5.2 对齐)──────────────────────────────────────
 *   USER_EXPLICIT        用户本轮明确表达;必须有 raw_input 逐字子串证据。
 *   CONTEXT_EXPLICIT     最近对话中「用户」明确表达;必须有 context user 消息逐字证据。
 *   WORKSPACE_FACT       workspace metadata 可验证的确定性事实;可无证据,
 *                        有证据时仅做提示性校验(warn),不产生 error。
 *   OPTIMIZER_SUGGESTED  优化器主动建议;无证据要求(但必须显式标注「建议」),
 *                        永不进入「用户要求」段。
 *   UNKNOWN              证据不足;不得假设,编译为 [待补充: …]。
 *
 * ── 校验规则(机械字面比对,无 LLM)────────────────────────────────────────
 *   1. 一切比对先 normalize(折叠空白 / 去首尾引号句读),再逐字 `includes`;
 *      **不做大小写折叠**——逐字要求,大小写变体保守判为不匹配。
 *   2. assistant / agent 发言永不能作为用户意图证据:命中时只发 warn,
 *      且不得同时发 error(该记录不能验证为 explicit/context)。
 *   3. explicit / context 记录 evidence 为空 → error。
 *   4. suggested / unknown 记录完全豁免,不产生任何 issue。
 *   5. ValidationResult.ok = 不存在 error 级问题;warn 只提示不改变 ok。
 *
 * 设计来源:quote-audit / 分段来源身份的思想借鉴自 WestFox(BSD-3,合法);
 * 实现、模板与测试均为本项目独立编写,未复制任何 AGPL 项目代码。
 */
import type {
  ConversationTurn,
  ProvenanceRecord,
  ProvenanceSource,
  ValidationResult,
} from "./types.js";

/** 一条来源校验问题:带记录定位与稳定规则 id,便于 UI 标注与回归断言。 */
export interface ProvenanceIssue {
  /** 出问题的记录 id(用于 UI 定位)。 */
  recordId: string;
  /** 稳定规则 id(见 PROVENANCE_RULE)。 */
  rule: string;
  /** 人类可读的问题描述。 */
  problem: string;
  severity: "warn" | "error";
}

/** 单条 quote 的解析结果:valid 时 source 为 USER_EXPLICIT / CONTEXT_EXPLICIT。 */
export interface QuoteResolution {
  /** 该 quote 能否作为对应来源的合法证据。 */
  valid: boolean;
  /** 实际去向:raw=本轮用户输入;context-user=上下文用户消息;assistant-only=仅助手;none=无处。 */
  matchedIn: "raw" | "context-user" | "assistant-only" | "none";
  /** 建议来源;invalid 时一律 UNKNOWN(不得把助手发言升格为用户意图)。 */
  source: ProvenanceSource;
  /** 建议把握度;invalid 时为 low。 */
  confidence: ProvenanceRecord["confidence"];
}

/** 稳定规则 id(对外契约,回归/UI 可引用;不得随意改名)。 */
export const PROVENANCE_RULE = {
  /** explicit/context 记录未携带任何证据。 */
  missingEvidence: "PROVENANCE_MISSING_EVIDENCE",
  /** USER_EXPLICIT 的证据未在 raw_input 中逐字出现。 */
  evidenceNotInRaw: "PROVENANCE_EVIDENCE_NOT_IN_RAW",
  /** CONTEXT_EXPLICIT 的证据未在上下文用户消息中逐字出现。 */
  evidenceNotInContext: "PROVENANCE_EVIDENCE_NOT_IN_CONTEXT",
  /** 证据仅出现在助手发言中,不能作为用户意图证据(仅告警)。 */
  assistantOnlyEvidence: "PROVENANCE_ASSISTANT_ONLY_EVIDENCE",
  /** WORKSPACE_FACT 的证据无法验证(仅告警)。 */
  workspaceEvidenceUnverified: "PROVENANCE_WORKSPACE_EVIDENCE_UNVERIFIED",
} as const;

/** 首尾需剥离的「包装噪声」:引号 + 句读(半角/全角句读一并收)。 */
const EDGE_NOISE = new Set([
  "'",
  '"',
  "`",
  "‘",
  "’",
  "“",
  "”",
  "。",
  "！",
  "？",
  ",",
  ".",
  "!",
  "?",
  ";",
  "；",
]);

/**
 * 文本规范化:折叠连续空白为单空格 → trim → 反复剥离首尾引号/句读。
 * **不做大小写折叠**——逐字要求,保守优先(大小写变体判为不匹配)。
 */
export function normalizeQuoteText(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  while (out.length > 0 && EDGE_NOISE.has(out.charAt(0))) {
    out = out.slice(1).trim();
  }
  while (out.length > 0 && EDGE_NOISE.has(out.charAt(out.length - 1))) {
    out = out.slice(0, -1).trim();
  }
  return out;
}

/** 规范化后的包含判定;空 quote 永不匹配(避免 `includes("")` 恒真)。 */
function containsQuote(text: string, normalizedQuote: string): boolean {
  return (
    normalizedQuote !== "" && normalizeQuoteText(text).includes(normalizedQuote)
  );
}

function userTurnContains(turn: ConversationTurn, quote: string): boolean {
  return turn.role === "user" && containsQuote(turn.text, quote);
}

function assistantTurnContains(turn: ConversationTurn, quote: string): boolean {
  return turn.role === "assistant" && containsQuote(turn.text, quote);
}

/**
 * 判别单条 quote 的来源(机械字面比对,无 LLM)。
 *
 * - raw_input 命中        → valid / "raw" / USER_EXPLICIT / high;
 * - 上下文 user 消息命中   → valid / "context-user" / CONTEXT_EXPLICIT / high;
 * - 仅 assistant 命中      → invalid / "assistant-only" / UNKNOWN / low;
 * - 无处命中              → invalid / "none" / UNKNOWN / low。
 */
export function resolveQuoteSource(
  quote: string,
  rawInput: string,
  contextTurns: ConversationTurn[],
): QuoteResolution {
  const normalized = normalizeQuoteText(quote);
  if (containsQuote(rawInput, normalized)) {
    return {
      valid: true,
      matchedIn: "raw",
      source: "USER_EXPLICIT",
      confidence: "high",
    };
  }
  if (contextTurns.some((turn) => userTurnContains(turn, normalized))) {
    return {
      valid: true,
      matchedIn: "context-user",
      source: "CONTEXT_EXPLICIT",
      confidence: "high",
    };
  }
  if (contextTurns.some((turn) => assistantTurnContains(turn, normalized))) {
    return {
      valid: false,
      matchedIn: "assistant-only",
      source: "UNKNOWN",
      confidence: "low",
    };
  }
  return {
    valid: false,
    matchedIn: "none",
    source: "UNKNOWN",
    confidence: "low",
  };
}

/**
 * 逐条收集校验问题。explicit/context 缺证据或证据对不上 → error;
 * 证据仅出现在助手发言、或 WORKSPACE_FACT 证据无法验证 → warn。
 * OPTIMIZER_SUGGESTED / UNKNOWN 完全豁免。
 */
function collectIssues(
  records: ProvenanceRecord[],
  rawInput: string,
  contextTurns: ConversationTurn[],
): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = [];

  for (const record of records) {
    if (record.source === "OPTIMIZER_SUGGESTED" || record.source === "UNKNOWN") {
      continue;
    }

    const quotes = (record.evidence ?? []).map((quote) =>
      normalizeQuoteText(quote),
    );

    // WORKSPACE_FACT 允许零证据(metadata 本身是确定性事实)。
    if (quotes.length === 0) {
      if (record.source === "WORKSPACE_FACT") continue;
      issues.push({
        recordId: record.id,
        rule: PROVENANCE_RULE.missingEvidence,
        severity: "error",
        problem: "缺少证据:explicit / context 记录必须携带至少一条逐字 evidence",
      });
      continue;
    }

    const inRaw = (quote: string) => containsQuote(rawInput, quote);
    const inUserTurn = (quote: string) =>
      contextTurns.some((turn) => userTurnContains(turn, quote));
    const onlyInAssistant = (quote: string) =>
      !inRaw(quote) &&
      !inUserTurn(quote) &&
      contextTurns.some((turn) => assistantTurnContains(turn, quote));

    const hasRaw = quotes.some(inRaw);
    const hasContextUser = quotes.some(inUserTurn);
    const hasAssistantOnly = quotes.some(onlyInAssistant);

    if (hasAssistantOnly) {
      issues.push({
        recordId: record.id,
        rule: PROVENANCE_RULE.assistantOnlyEvidence,
        severity: "warn",
        problem: "证据仅出现在助手发言中,不能作为用户意图证据",
      });
    }

    if (record.source === "USER_EXPLICIT" && !hasRaw && !hasAssistantOnly) {
      issues.push({
        recordId: record.id,
        rule: PROVENANCE_RULE.evidenceNotInRaw,
        severity: "error",
        problem:
          "evidence 未在 raw_input 中逐字出现(USER_EXPLICIT 需要本轮用户输入证据)",
      });
    }

    if (
      record.source === "CONTEXT_EXPLICIT" &&
      !hasContextUser &&
      !hasAssistantOnly
    ) {
      issues.push({
        recordId: record.id,
        rule: PROVENANCE_RULE.evidenceNotInContext,
        severity: "error",
        problem:
          "evidence 未在上下文用户消息中逐字出现(CONTEXT_EXPLICIT 需要上下文证据)",
      });
    }

    if (
      record.source === "WORKSPACE_FACT" &&
      !hasContextUser &&
      !hasAssistantOnly
    ) {
      issues.push({
        recordId: record.id,
        rule: PROVENANCE_RULE.workspaceEvidenceUnverified,
        severity: "warn",
        problem: "WORKSPACE_FACT 的 evidence 无法验证(仅提示)",
      });
    }
  }

  return issues;
}

/**
 * 校验整组记录的逐字证据。ok = 无 error 级问题;
 * warn 仅提示(如证据仅出现在助手发言中),不影响 ok。
 */
export function validateProvenance(
  records: ProvenanceRecord[],
  rawInput: string,
  contextTurns: ConversationTurn[],
): ValidationResult {
  const issues = collectIssues(records, rawInput, contextTurns);
  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    problems: issues.map((issue) => ({
      severity: issue.severity,
      rule: issue.rule,
      detail: `[${issue.recordId}] ${issue.problem}`,
    })),
  };
}

/** 记录 id 序号:同一模块生命周期内单调递增,确定性可测(不用随机,便于回归断言)。 */
let recordSeq = 0;

/** 记录工厂:补全默认值(evidence 缺省为空数组、confidence 缺省 "medium"),id 形如 `r-<n>`。 */
export function makeProvenanceRecord(input: {
  text: string;
  source: ProvenanceSource;
  evidence?: string[];
  confidence?: ProvenanceRecord["confidence"];
  note?: string;
}): ProvenanceRecord {
  recordSeq += 1;
  return {
    id: `r-${recordSeq}`,
    text: input.text,
    source: input.source,
    evidence: [...(input.evidence ?? [])],
    confidence: input.confidence ?? "medium",
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
}
