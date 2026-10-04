/**
 * 意图 / 目标 / 分诊 / 缺失 分析(Analysis)—— v2 主流程第 1–4 步。
 *
 * 一次结构化 JSON 小调用,产出四件事:
 *   1. **Intent & Work-Mode**:主意图 + 辅意图 + 工作模式(不是单一标签);
 *   2. **Prompt Target / Target Engine**:给谁 / 什么引擎 / 什么模态;
 *   3. **Edit Triage**:KEEP / PATCH / RESTRUCTURE / REBUILD(最小必要干预);
 *   4. **Missing Resolution**:每个 UNKNOWN 的归属(用户专属 / 执行方可查 / 可选)
 *      与阻塞判定 —— **UNKNOWN ≠ ASK_USER**。
 *
 * 与 `classify.ts` 的关系:Analysis 是分类的**超集**,复用同一套调用机制
 * (`runJsonCallViaLlm`)与同一套容错哲学;分类路径保持原样(regression 语料与
 * 单测继续走 `classifyViaLlm`,零回归)。
 *
 * 硬参数:temperature=0,maxTokens=1024(比分类大,因为要输出结构化多字段)。
 * 纯函数解析 + 可注入 LLM 结构面,零 @deepseek-ai/* 依赖,可 mock 单测。
 */
import type {
  AnalysisResult,
  ClassifierResult,
  ConversationTurn,
  EditTriage,
  IntentProfile,
  MissingResolutionItem,
  PromptModality,
  PromptTarget,
  PromptType,
  ProvenanceRecord,
  TargetResolution,
  WorkIntent,
  WorkMode,
  TriageDecision,
} from "./types.js";
import {
  EDIT_TRIAGE_LEVELS,
  PROMPT_TARGETS,
  PROMPT_MODALITIES,
  WORK_INTENTS,
  WORK_MODES,
  toConfidenceLevel,
} from "./types.js";
import type { ClassifierLlm, ClassifierLlmMessage, ClassifierParseMeta, JsonCallOutcome, JsonCallSpec, JsonCallOptions, ClassifyViaLlmInput } from "./classify.js";
import {
  CLASSIFIER_LOW_CONFIDENCE_THRESHOLD,
  isVerbatimUserQuote,
  lastJsonRegion,
  looksMultiIntent,
  runJsonCallViaLlm,
} from "./classify.js";
import { stripThinkBlocks } from "../prompt.js";
import { getTargetSpec, modalityOf, resolveEngine, resolveTargetDeterministic } from "./targets.js";
import { decideTriage } from "./triage.js";
import { buildLedger, classifyUnknowns, computeAnalysisGate, hasBlindTrust, applyBlindTrust } from "./requirements.js";

/** 分析调用硬参数:比分类的 512 大(结构化字段更多),仍保持确定性。 */
export const ANALYSIS_MAX_TOKENS = 1024;
export const ANALYSIS_TEMPERATURE = 0;

/**
 * 元任务调用(system prompt)的稳定文案锚点。
 *
 * 用途:宿主日志与测试需要区分「分析 / 分类小调用」与「编译大调用」。
 * 历史判据是 `maxTokens === 512`,v2 分析阶段的预算改为 1024 后该判据失效,
 * 因此改为按 system 文案锚点判定(语义稳定,不随预算调整而漂移)。
 */
export const ANALYSIS_SYSTEM_MARKER = "意图编译器分析器";
/** 英文版的同一锚点(language='en' 时使用)。 */
export const ANALYSIS_SYSTEM_MARKER_EN = "intent compiler analyzer";
/** 旧分类器的 system 文案锚点(历史调用与回归路径仍可能出现)。 */
export const CLASSIFIER_SYSTEM_MARKER = "提示词任务类型分类器";

/** 该次 LLM 调用是否属于「意图分析 / 类型分类」元任务调用。 */
export function isMetaAnalysisCall(system: unknown): boolean {
  const text = typeof system === "string" ? system : "";
  return (
    text.includes(ANALYSIS_SYSTEM_MARKER) ||
    text.includes(ANALYSIS_SYSTEM_MARKER_EN) ||
    text.includes(CLASSIFIER_SYSTEM_MARKER)
  );
}

/** 稳定问题 id(日志 / UI / 回归可引用;不得随意改名)。 */
export const ANALYSIS_ISSUE = {
  /** 找不到任何可用 JSON。 */
  noJson: "ANALYSIS_NO_JSON",
  /** primary_intent 非法 → general。 */
  invalidPrimary: "ANALYSIS_INVALID_PRIMARY_INTENT",
  /** work_mode 非法 → 由主意图确定性推导。 */
  invalidWorkMode: "ANALYSIS_INVALID_WORK_MODE",
  /** target 非法 → 确定性兜底。 */
  invalidTarget: "ANALYSIS_INVALID_TARGET",
  /** evidence_quotes 中逐字对不上的条数(已丢弃)。 */
  droppedEvidence: "ANALYSIS_DROPPED_EVIDENCE",
  /** 用户要求缺逐字引用 → 丢弃(不得把无据结论当用户要求)。 */
  droppedRequirement: "ANALYSIS_DROPPED_REQUIREMENT_WITHOUT_QUOTE",
  /** 模型给的 target 与用户点名的引擎冲突 → 采纳引擎(有机械证据)。 */
  targetEngineConflict: "ANALYSIS_TARGET_ENGINE_CONFLICT",
} as const;

/** JSON 输出契约的逐字段描述(system prompt 与测试断言共用同一份字面量)。 */
export const ANALYSIS_OUTPUT_FIELDS: readonly { name: string; detail: string }[] = [
  { name: "primary_intent", detail: "六值之一(research/planning/execution/diagnostic/review/creative);无法判定用 general" },
  { name: "supporting_intents", detail: "字符串数组:辅助意图(可为空),不得重复 primary" },
  { name: "work_mode", detail: "one_shot | iterative | exploratory | governed" },
  { name: "target", detail: "agent_task / research / coding / image_generation / video_generation / writing / data_analysis / general" },
  { name: "target_engine", detail: "字符串或 null:用户明确提到的模型 / 工具名(如 DSH、Claude Code、Midjourney、可灵)" },
  { name: "edit_triage", detail: "KEEP | PATCH | RESTRUCTURE | REBUILD(最小必要干预)" },
  { name: "triage_reasons", detail: "字符串数组:选择该分诊级别的理由" },
  { name: "unknowns", detail: "对象数组:{text, classification(USER_REQUIRED|AGENT_DISCOVERABLE|OPTIONAL), blocking(bool), rationale, question}" },
  { name: "requirements", detail: "对象数组:{text, quote} —— 用户明确表达的要求,quote 必须逐字来自用户发言" },
  { name: "suggestions", detail: "字符串数组:你作为优化器的建议(不是用户要求,不得混入 requirements)" },
  { name: "confidence_internal", detail: "0..1 之间的小数" },
  { name: "rationale", detail: "一句话理由" },
  { name: "evidence_quotes", detail: "字符串数组:必须逐字来自「用户本人」发言,不得引用助手" },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// system / user 提示词
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_CATALOG_ZH = [
  "六种工作意图:",
  "- research:检索 / 调研 / 对比信息",
  "- planning:制定计划 / 路线 / 任务拆解",
  "- execution:直接执行 / 改写 / 产出交付物",
  "- diagnostic:排查问题原因",
  "- review:评审 / 检查已有产物",
  "- creative:创意写作 / 风格化产出",
].join("\n");

const INTENT_CATALOG_EN = [
  "Six work intents:",
  "- research, planning, execution, diagnostic, review, creative",
].join("\n");

const TARGET_CATALOG_ZH = [
  "八种提示词目标(target):",
  "- agent_task:给 Agent / 智能体的任务指令(含控制某个 Agent)",
  "- research:调研检索类",
  "- coding:写码 / 改码",
  "- image_generation:图像生成",
  "- video_generation:视频生成",
  "- writing:文本写作 / 改写",
  "- data_analysis:数据分析",
  "- general:无法判定",
].join("\n");

const TRIAGE_CATALOG_ZH = [
  "四种编辑分诊(edit_triage,选择**最小必要干预**):",
  "- KEEP:输入已经是高质量成稿(有角色 / 约束 / 输出格式 / 验收标准且结构清楚),应原样保留,不要改写。",
  "- PATCH:任务成立、结构可用,只需补充少量缺失要求或修正少量问题。",
  "- RESTRUCTURE:信息基本完整,但组织混乱(冗长、重复、无结构),只需重组结构,不得新增语义。",
  "- REBUILD:输入无法构成有效任务(空话、寒暄、自相矛盾且无目标)。**只有这种情况才允许重写**。",
].join("\n");

const ANALYSIS_RULES_ZH = [
  "铁律(必须遵守):",
  "1. 判断对象是「用户本轮输入」;历史讨论仅供参考,不得用历史话题覆盖当前请求。",
  "2. 助手 / Agent 的发言不是用户决定:evidence_quotes 与 requirements 的 quote 只能逐字引用用户自己的发言。",
  "3. UNKNOWN 不等于「要问用户」:每个 unknown 都要判断它属于 USER_REQUIRED(只有用户能定)、AGENT_DISCOVERABLE(执行方自己能查到,如代码结构 / 依赖版本 / 现有实现)还是 OPTIONAL(有没有都行)。",
  "4. blocking 只在你确信「答案不同会明显改变产出」且「只有用户能决定」时给 true;拿不准就给 AGENT_DISCOVERABLE 且 blocking=false。",
  "5. 不得发明用户没说过的要求:你的建议写进 suggestions,不要写进 requirements。",
  "6. 分诊宁轻不重:能 PATCH 就不要 RESTRUCTURE,能 RESTRUCTURE 就不要 REBUILD。",
].join("\n");

function outputContractBlock(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "Output a single JSON object with exactly these fields:",
      "- primary_intent: one of the six intents, or \"general\"",
      "- supporting_intents: string array (may be empty; never repeat primary_intent)",
      "- work_mode: one_shot | iterative | exploratory | governed",
      "- target: one of agent_task / research / coding / image_generation / video_generation / writing / data_analysis / general",
      "- target_engine: string or null (a model/tool the user explicitly named)",
      "- edit_triage: KEEP | PATCH | RESTRUCTURE | REBUILD",
      "- triage_reasons: string array",
      "- unknowns: array of {text, classification: USER_REQUIRED|AGENT_DISCOVERABLE|OPTIONAL, blocking: boolean, rationale, question}",
      "- requirements: array of {text, quote}; quote must be a verbatim fragment of the user's own words",
      "- suggestions: string array (optimizer suggestions, never user requirements)",
      "- confidence_internal: decimal in 0..1",
      "- rationale: one sentence",
      "- evidence_quotes: string array of verbatim user fragments only",
    ].join("\n");
  }
  return [
    "只输出一个 JSON 对象,字段如下(不得增删字段名):",
    "- primary_intent:上述六种工作意图之一;无法判定用 general",
    "- supporting_intents:字符串数组(可为空,不得重复 primary_intent)",
    "- work_mode:one_shot | iterative | exploratory | governed",
    "- target:agent_task / research / coding / image_generation / video_generation / writing / data_analysis / general",
    "- target_engine:字符串或 null(用户明确点名的模型 / 工具)",
    "- edit_triage:KEEP | PATCH | RESTRUCTURE | REBUILD",
    "- triage_reasons:字符串数组",
    "- unknowns:对象数组 {text, classification: USER_REQUIRED|AGENT_DISCOVERABLE|OPTIONAL, blocking: 布尔, rationale, question}",
    "- requirements:对象数组 {text, quote};quote 必须是用户本人发言的逐字片段",
    "- suggestions:字符串数组(你的建议,绝不是用户要求)",
    "- confidence_internal:0..1 之间的小数",
    "- rationale:一句话理由",
    "- evidence_quotes:字符串数组,只含用户本人发言的逐字片段",
  ].join("\n");
}

function buildSystem(language: "zh" | "en"): string {
  const zh = language !== "en";
  const parts = zh
    ? [
        "你是「意图编译器分析器」。你的工作不是改写提示词,而是先**看清**它:用户到底要做什么、产给谁、该改到什么程度、还缺什么。只输出一个 JSON 对象,不要输出解释、代码块或多余文字。",
        INTENT_CATALOG_ZH,
        TARGET_CATALOG_ZH,
        TRIAGE_CATALOG_ZH,
        ANALYSIS_RULES_ZH,
        outputContractBlock("zh"),
      ]
    : [
        'You are the "intent compiler analyzer". Do not rewrite the prompt — first see it clearly. Output a single JSON object only.',
        INTENT_CATALOG_EN,
        outputContractBlock("en"),
      ];
  return parts.join("\n\n");
}

const SYSTEM_ZH = buildSystem("zh");
const SYSTEM_EN = buildSystem("en");

/** 分析 system 提示词(中英;zh 优先)。 */
export function buildAnalysisSystem(language: "zh" | "en" = "zh"): string {
  return language === "en" ? SYSTEM_EN : SYSTEM_ZH;
}

/** 分析 user 提示词(结构沿用分类器:上下文参考块 + 本轮输入块)。 */
export function buildAnalysisUser(
  input: { raw_input: string; context_turns?: readonly ConversationTurn[] },
  language: "zh" | "en" = "zh",
): string {
  const zh = language !== "en";
  const sections: string[] = [];
  const turns = input.context_turns ?? [];
  if (turns.length) {
    const lines = turns.map((turn) => {
      const role = turn.role === "user" ? (zh ? "用户" : "User") : zh ? "助手" : "Assistant";
      return `${role}: ${turn.text}`;
    });
    sections.push(
      zh
        ? `以下是当前会话的近期对话(仅供参考;只有「用户」的发言能作为用户意图证据):\n\n<conversation-context>\n${lines.join("\n")}\n</conversation-context>`
        : `Recent conversation (reference only; only "user" messages count as user intent):\n\n<conversation-context>\n${lines.join("\n")}\n</conversation-context>`,
    );
  }
  sections.push(
    zh
      ? `以下是用户本轮输入(你唯一需要分析的对象):\n\n<prompt-draft>\n${input.raw_input}\n</prompt-draft>`
      : `Here is the user's current input (the only thing to analyze):\n\n<prompt-draft>\n${input.raw_input}\n</prompt-draft>`,
  );
  return sections.join("\n\n");
}

/** 提示词指纹(与分类器同构,便于日志关联与可复现性断言)。 */
export function analysisPromptFingerprint(system: string, user: string): string {
  const payload = `${system}\u0000${user}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ─────────────────────────────────────────────────────────────────────────────
// 字段归一化
// ─────────────────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkIntent(value: unknown): value is WorkIntent {
  return typeof value === "string" && (WORK_INTENTS as readonly string[]).includes(value);
}

function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === "string" && (WORK_MODES as readonly string[]).includes(value);
}

function isPromptTargetValue(value: unknown): value is PromptTarget {
  return typeof value === "string" && (PROMPT_TARGETS as readonly string[]).includes(value);
}

function isPromptModalityValue(value: unknown): value is PromptModality {
  return typeof value === "string" && (PROMPT_MODALITIES as readonly string[]).includes(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/** 主意图 → 默认工作模式(LLM 未给或给错时的确定性推导)。 */
const DEFAULT_WORK_MODE: Record<string, WorkMode> = {
  research: "exploratory",
  planning: "iterative",
  execution: "one_shot",
  diagnostic: "iterative",
  review: "one_shot",
  creative: "iterative",
  general: "one_shot",
};

function toWorkIntent(value: unknown): WorkIntent | "general" {
  if (isWorkIntent(value)) return value;
  // 兼容旧分类器的 prompt_type(general 之外的六值同名)。
  if (value === "general") return "general";
  return "general";
}

function toPromptType(primary: WorkIntent | "general"): PromptType {
  return primary;
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalysisParseContext {
  rawInput: string;
  contextTurns: readonly ConversationTurn[];
}

export interface AnalysisParseOutcome {
  result: AnalysisResult | null;
  meta: ClassifierParseMeta;
}

function emptyMeta(issues: string[] = []): ClassifierParseMeta {
  return {
    jsonCandidates: 0,
    degraded: issues.length > 0,
    issues,
    unknownTypeFallback: false,
    droppedEvidence: 0,
    lowConfidence: false,
    multiIntent: false,
  };
}

/**
 * 解析分析输出(容错最大化,确定性)。
 *
 * 关键点:
 *  - 无 JSON → `result: null`(调用方走兜底);
 *  - 字段缺失 / 类型不符一律补默认;
 *  - **目标与引擎冲突**:用户点名的引擎有机械证据,优先于模型给的 target;
 *  - evidence_quotes 逐字校验,对不上的一律丢弃(助手发言永不算);
 *  - `requirements` 缺逐字 quote 的一律丢弃(不得把无据结论升级为用户要求);
 *  - 台账经 `buildLedger` 净化,来源与状态分离。
 */
export function parseAnalysisResult(raw: string, ctx: AnalysisParseContext): AnalysisParseOutcome {
  const stripped = stripThinkBlocks(typeof raw === "string" ? raw : "");
  const region = lastJsonRegion(stripped);
  if (!region) {
    return { result: null, meta: emptyMeta([ANALYSIS_ISSUE.noJson]) };
  }
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(region);
    if (!isPlainObject(parsed)) return { result: null, meta: emptyMeta([ANALYSIS_ISSUE.noJson]) };
    record = parsed;
  } catch {
    return { result: null, meta: emptyMeta([ANALYSIS_ISSUE.noJson]) };
  }

  const issues: string[] = [];
  const rawInput = ctx.rawInput ?? "";
  const contextTurns = ctx.contextTurns ?? [];

  // ── 意图 ────────────────────────────────────────────────────────────────
  const rawPrimary = record.primary_intent ?? record.prompt_type;
  const primary = toWorkIntent(rawPrimary);
  if (primary === "general" && rawPrimary !== undefined && rawPrimary !== "general") {
    issues.push(ANALYSIS_ISSUE.invalidPrimary);
  }
  const supporting: WorkIntent[] = [];
  for (const value of Array.isArray(record.supporting_intents) ? record.supporting_intents : []) {
    if (!isWorkIntent(value) || value === primary || supporting.includes(value)) continue;
    supporting.push(value);
    if (supporting.length >= 3) break;
  }
  const rawMode = record.work_mode;
  let workMode: WorkMode;
  if (isWorkMode(rawMode)) {
    workMode = rawMode;
  } else {
    workMode = DEFAULT_WORK_MODE[primary] ?? "one_shot";
    if (rawMode !== undefined) issues.push(ANALYSIS_ISSUE.invalidWorkMode);
  }
  const intent: IntentProfile = {
    primary,
    supporting,
    ...(supporting.length > 0 ? { supporting_notes: [] } : {}),
    work_mode: workMode,
    rationale: typeof record.rationale === "string" ? record.rationale.trim() : "",
  };

  // ── 目标 / 引擎 ─────────────────────────────────────────────────────────
  const evidenceQuotes: string[] = [];
  let droppedEvidence = 0;
  for (const quote of asStringArray(record.evidence_quotes)) {
    if (isVerbatimUserQuote(quote, rawInput, contextTurns)) evidenceQuotes.push(quote);
    else droppedEvidence += 1;
  }
  if (droppedEvidence > 0) issues.push(ANALYSIS_ISSUE.droppedEvidence);

  const target = resolveAnalysisTarget({
    record,
    rawInput,
    contextTurns,
    issues,
  });

  // ── 分诊 ────────────────────────────────────────────────────────────────
  const triage = decideTriage({
    raw_input: rawInput,
    llm_suggestion: record.edit_triage,
    llm_reasons: asStringArray(record.triage_reasons),
  });

  // ── 缺失解析(UNKNOWN ≠ ASK_USER)────────────────────────────────────────
  const unknownInputs = normalizeUnknownInputs(record);
  const missingResolution = classifyUnknowns(unknownInputs);
  const gate = computeAnalysisGate(missingResolution, triage.triage);

  // ── 台账(来源 / 状态分离)────────────────────────────────────────────────
  const explicit: ProvenanceRecord[] = [];
  let requirementSeq = 0;
  for (const entry of Array.isArray(record.requirements) ? record.requirements : []) {
    if (!isPlainObject(entry)) continue;
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    const quote = typeof entry.quote === "string" ? entry.quote.trim() : "";
    if (!text) continue;
    if (!quote || !isVerbatimUserQuote(quote, rawInput, contextTurns)) {
      // 没有逐字用户证据 → 不可能是 USER_EXPLICIT(丢弃,不用建议冒充要求)。
      issues.push(ANALYSIS_ISSUE.droppedRequirement);
      continue;
    }
    requirementSeq += 1;
    explicit.push({
      id: `analysis-req-${requirementSeq}`,
      text,
      source: "USER_EXPLICIT",
      evidence: [quote],
      confidence: "high",
    });
  }
  const suggested: ProvenanceRecord[] = asStringArray(record.suggestions).map((text, index) => ({
    id: `analysis-sug-${index + 1}`,
    text,
    source: "OPTIMIZER_SUGGESTED" as const,
    evidence: [],
    confidence: "medium" as const,
  }));

  const baseLedger = buildLedger({
    raw_input: rawInput,
    context_turns: contextTurns,
    explicit,
    suggested,
    resolution: missingResolution,
  });
  const ledger = applyBlindTrust(baseLedger, rawInput);

  const confidence = clampConfidence(record.confidence_internal);
  const lowConfidence = confidence < CLASSIFIER_LOW_CONFIDENCE_THRESHOLD;

  // 向后兼容:可编译时把缺口文本继续交给编译器注入占位符。
  // (v2 §C11 的「可自查项不得标 [待补充:]」属编译契约调整,在 Phase 2 落地。)
  const missingConstraints =
    triage.triage === "KEEP"
      ? []
      : missingResolution.filter((item) => item.classification !== "OPTIONAL").map((item) => item.text);

  const result: AnalysisResult = {
    intent,
    target,
    triage,
    missing_resolution: missingResolution,
    gate,
    ledger,
    confidence_internal: confidence,
    rationale: intent.rationale,
    evidence_quotes: evidenceQuotes,
    prompt_type: toPromptType(primary),
    missing_constraints: missingConstraints,
  };

  return {
    result,
    meta: {
      jsonCandidates: 1,
      degraded: issues.length > 0,
      issues,
      unknownTypeFallback: issues.includes(ANALYSIS_ISSUE.invalidPrimary),
      droppedEvidence,
      lowConfidence,
      multiIntent: supporting.length > 0 || looksMultiIntent(rawInput),
    },
  };
}

/** unknown 字段归一化:兼容对象数组 / 字符串数组 / 旧 missing_constraints。 */
function normalizeUnknownInputs(record: Record<string, unknown>): { text: string; classification?: unknown; blocking?: unknown; rationale?: string; impact?: unknown; question?: string }[] {
  const out: { text: string; classification?: unknown; blocking?: unknown; rationale?: string; impact?: unknown; question?: string }[] = [];
  const source = Array.isArray(record.unknowns)
    ? record.unknowns
    : Array.isArray(record.missing_constraints)
      ? record.missing_constraints
      : [];
  for (const entry of source) {
    if (typeof entry === "string") {
      out.push({ text: entry });
      continue;
    }
    if (!isPlainObject(entry)) continue;
    const text = typeof entry.text === "string" ? entry.text : typeof entry.label === "string" ? entry.label : "";
    out.push({
      text,
      classification: entry.classification,
      blocking: entry.blocking,
      rationale: typeof entry.rationale === "string" ? entry.rationale : undefined,
      impact: entry.impact,
      question: typeof entry.question === "string" ? entry.question : undefined,
    });
  }
  return out;
}

/**
 * 目标解析:模型给的目标 + 模型给的引擎 + 确定性兜底三方合并。
 * 冲突时以「用户点名的引擎」为准(它是机械可验证的证据,模型判断是推断)。
 */
function resolveAnalysisTarget(input: {
  record: Record<string, unknown>;
  rawInput: string;
  contextTurns: readonly ConversationTurn[];
  issues: string[];
}): TargetResolution {
  const { record, rawInput, contextTurns, issues } = input;
  const deterministic = resolveTargetDeterministic({
    raw_input: rawInput,
    context_texts: contextTurns.filter((turn) => turn.role === "user").map((turn) => turn.text),
  });

  const llmEngine = resolveEngine(typeof record.target_engine === "string" ? record.target_engine : null);
  const engine = llmEngine ?? deterministic.engine ?? null;

  const llmTargetRaw = record.target;
  const llmTarget = isPromptTargetValue(llmTargetRaw) ? llmTargetRaw : undefined;
  if (llmTargetRaw !== undefined && !llmTarget && llmTargetRaw !== null) {
    issues.push(ANALYSIS_ISSUE.invalidTarget);
  }

  // 引擎有机械证据时,目标必须与引擎一致;不一致则采纳引擎并记 issue。
  if (engine?.target) {
    if (llmTarget && llmTarget !== engine.target) {
      issues.push(ANALYSIS_ISSUE.targetEngineConflict);
    }
    const modality = isPromptModalityValue(record.modality) ? record.modality : engine.modality ?? modalityOf(engine.target);
    return {
      target: engine.target,
      modality,
      engine,
      confidence: "high",
      evidence: deterministic.evidence,
      rationale: `用户点名了 ${engine.name},目标按引擎归为「${getTargetSpec(engine.target).nameZh}」`,
    };
  }

  const target = llmTarget ?? deterministic.target;
  const modality = isPromptModalityValue(record.modality) ? record.modality : modalityOf(target);
  return {
    target,
    modality,
    engine: null,
    confidence: llmTarget ? "medium" : deterministic.confidence,
    evidence: deterministic.evidence,
    rationale: deterministic.rationale,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 兜底 / 手动路径
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 兜底分析结果(解析失败 / 调用失败 / 取消时使用)。
 *
 * 保守原则:主意图 general、目标按确定性线索、分诊按机械判据、无未决项。
 * **不制造阻塞**:兜底绝不把用户挡在门外(拿不准就照常生成)。
 */
export function fallbackAnalysisResult(
  reason = "分析失败,按通用目标与最小干预处理",
  ctx: { rawInput?: string; contextTurns?: readonly ConversationTurn[] } = {},
): AnalysisResult {
  const rawInput = ctx.rawInput ?? "";
  const contextTurns = ctx.contextTurns ?? [];
  const target = resolveTargetDeterministic({
    raw_input: rawInput,
    context_texts: contextTurns.filter((turn) => turn.role === "user").map((turn) => turn.text),
  });
  const triage: TriageDecision = decideTriage({ raw_input: rawInput });
  return {
    intent: {
      primary: "general",
      supporting: [],
      work_mode: "one_shot",
      rationale: reason,
    },
    target,
    triage,
    missing_resolution: [],
    gate: computeAnalysisGate([], triage.triage),
    ledger: [],
    confidence_internal: 0.5,
    rationale: reason,
    evidence_quotes: [],
    prompt_type: "general",
    missing_constraints: [],
  };
}

/**
 * 手动覆盖路径:用户明确选了类型 → 跳过分析 LLM 调用(省一次调用,尊重用户选择)。
 * 目标仍按确定性线索解析(这不是「分类」,而是识别产物形态)。
 */
export function manualAnalysisResult(
  promptType: PromptType,
  ctx: { rawInput?: string; contextTurns?: readonly ConversationTurn[] } = {},
): AnalysisResult {
  const rawInput = ctx.rawInput ?? "";
  const contextTurns = ctx.contextTurns ?? [];
  const primary: WorkIntent | "general" = promptType === "general" ? "general" : promptType;
  const target = resolveTargetDeterministic({
    raw_input: rawInput,
    context_texts: contextTurns.filter((turn) => turn.role === "user").map((turn) => turn.text),
  });
  const triage = decideTriage({ raw_input: rawInput });
  return {
    intent: {
      primary,
      supporting: [],
      work_mode: DEFAULT_WORK_MODE[primary] ?? "one_shot",
      rationale: "你在设置 / 下拉里手动指定了任务类型,已跳过自动判断",
    },
    target,
    triage,
    missing_resolution: [],
    gate: computeAnalysisGate([], triage.triage),
    ledger: [],
    confidence_internal: 1,
    rationale: "手动指定类型",
    evidence_quotes: [],
    prompt_type: promptType,
    missing_constraints: [],
  };
}

/** 分诊级别是否合法(供宿主 / UI 归一化请求体使用)。 */
export function isEditTriage(value: unknown): value is EditTriage {
  return typeof value === "string" && (EDIT_TRIAGE_LEVELS as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM 调用侧封装
// ─────────────────────────────────────────────────────────────────────────────

const ANALYSIS_SPEC: JsonCallSpec<AnalysisResult> = {
  label: "意图分析",
  maxTokens: ANALYSIS_MAX_TOKENS,
  temperature: ANALYSIS_TEMPERATURE,
  buildSystem: buildAnalysisSystem,
  buildUser: (input, language) =>
    buildAnalysisUser({ raw_input: input.raw_input, context_turns: input.context_turns }, language),
  parse: (raw, ctx) => parseAnalysisResult(raw, ctx),
  fallback: fallbackAnalysisResult,
  messages: {
    abortedBeforeStart: "分析已取消,按通用目标继续",
    invalidOutput: "分析输出无法解析,已按通用目标与最小干预继续",
    timedOut: "分析调用超时,已按通用目标与最小干预继续",
    aborted: "分析调用已取消,已按通用目标与最小干预继续",
    failed: "分析调用失败,已按通用目标与最小干预继续",
    truncated: "analysis output truncated at maxTokens",
  },
};

/** analyzeViaLlm 结果(与分类同构:泛型结构化调用结果)。 */
export type AnalyzeViaLlmOutcome = JsonCallOutcome<AnalysisResult>;

/**
 * analyzeViaLlm —— 一次意图 / 目标 / 分诊 / 缺失分析小调用。
 * 机制与 `classifyViaLlm` 完全一致(hard params / thinkFilter / 超时 / 认证归类)。
 */
export async function analyzeViaLlm<Message = ClassifierLlmMessage>(
  llm: ClassifierLlm<Message>,
  route: { provider: string; model: string },
  input: ClassifyViaLlmInput,
  options: JsonCallOptions<Message> = {},
): Promise<AnalyzeViaLlmOutcome> {
  return runJsonCallViaLlm(llm, route, input, options, ANALYSIS_SPEC);
}

/** 供 UI / 宿主复用的展示投影(不暴露内部小数)。 */
export function analysisDisplay(input: AnalysisResult): {
  primary: string;
  supporting: string[];
  target: string;
  engine: string | null;
  modality: string;
  triage: EditTriage;
  blocked: boolean;
  confidence: string;
} {
  return {
    primary: input.intent.primary,
    supporting: [...input.intent.supporting],
    target: input.target.target,
    engine: input.target.engine?.name ?? null,
    modality: input.target.modality,
    triage: input.triage.triage,
    blocked: input.gate.blocked,
    confidence: toConfidenceLevel(input.confidence_internal),
  };
}

/** 导出给宿主做类型收窄(避免宿主直接 import types 里的常量表)。 */
export { PROMPT_TARGETS, PROMPT_MODALITIES, WORK_INTENTS as ANALYSIS_WORK_INTENTS };

/**
 * AnalysisResult → ClassifierResult 投影(向后兼容)。
 *
 * 编译器 / 策略注册表 / 校验器的既有入口都吃 `ClassifierResult`,v2 不改这些
 * 契约的形状,而是把分析结果**投影**回旧形状:主意图即 `prompt_type`,
 * 缺口列表沿用 `missing_constraints`。这样零改编译管线即可接入分析阶段。
 */
export function analysisToClassifier(analysis: AnalysisResult): ClassifierResult {
  return {
    prompt_type: analysis.prompt_type,
    confidence_internal: analysis.confidence_internal,
    missing_constraints: [...analysis.missing_constraints],
    rationale: analysis.rationale,
    evidence_quotes: [...analysis.evidence_quotes],
  };
}

/** 内部使用:让 ClassifierResult 类型在本模块的兼容分支里可见。 */
export type { ClassifierResult };

/** 未使用但保留给 Phase 2 的缺失项导出(便于 UI 分组渲染)。 */
export type { MissingResolutionItem, PromptTarget, PromptModality };
