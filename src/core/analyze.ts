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
  AnalysisDecision,
  AnalysisResult,
  ClassifierResult,
  DiscoveryOption,
  DiscoveryQuestion,
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
import { containmentRatio } from './discovery.js'
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
import { decideTriage, mechanicalTriage } from "./triage.js";
import {
  applyBlindTrust,
  buildLedger,
  classifyUnknown,
  classifyUnknowns,
  computeAnalysisGate,
  decisionCategoryOfRequirement,
  hasBlindTrust,
  sameRequirement,
  scanDecisionStatements,
  tradeoffStatements,
  vagueGoalDecision,
  contentStableId,
} from "./requirements.js";
import { detectSemanticAmbiguity } from "./semantic-ambiguity.js";

/**
 * 分析调用硬参数(比分类的 512 大:结构化字段更多)。
 *
 * RC 实测(真实模型 opencode-go/deepseek-v4-flash,3 组对照):
 *   · 1024 token → 推理就吃光预算,`finish_reason=length` + **空内容** → 分析整段降级;
 *   · 2048 token → 仍 `length`(推理 ~6–7k 字符后才开始写 JSON),或只写半个 JSON;
 *   · 4096 token → `finish_reason=stop`,完整 JSON。
 * 且 `reasoning_effort` 在该模型上几乎不缩短推理(实测 minimal 仍 ~6.5k 字符)。
 * 结论:分析契约(13+ 字段、含数组与选项)必须给足预算,否则**整条 v2 主流程降级**
 * (Discovery 永不触发、target 只剩确定性兜底)。4096 仍只是**一次**小调用。
 */
export const ANALYSIS_MAX_TOKENS = 4096;
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
  /** RC2:用户原文出现高影响决策,但分析没列出 → 机械安全层补齐(采样无关)。 */
  tradeoffNotSurfaced: "ANALYSIS_DECISION_NOT_SURFACED_BY_MODEL",
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
  {
    name: "decisions",
    detail:
      "对象数组:{text, kind(PRODUCT_DECISION|USER_PREFERENCE|FACT_GAP), impact(high|medium|low), needs_user_decision(bool), note} —— 需要用户拍板的事项(产品取舍 / 偏好),不是缺事实",
  },
  {
    name: "questions",
    detail:
      "对象数组:{requirement_id, question, options:[{id,label,description,value,invalidates}], recommended_option_id, recommendation_reason, why, depends_on:[requirement_id]} —— 面向用户目标的问题(禁止暴露内部枚举),1 个答案能消除最多分支的优先",
  },
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
  "产品定位(最高优先级):你的职责是**忠实理解并清晰表达用户真正想说的意思**,不是替用户补成执行规格。优化后的 Prompt **允许保留未知**。",
  "两类缺失必须严格区分:",
  "  · **语义歧义(SEMANTIC_AMBIGUITY)**:不回答就不知道用户这句话到底是什么意思(指代不明:「把这个优化一下」「把它改成第二种」而不知「这个/它」指什么;对象缺失)。**只有这一类**才允许 blocking=true。",
  "  · **执行信息不完整(EXECUTION_INCOMPLETENESS)**:已经知道用户想表达什么,只是将来执行时还需要项目路径 / API / 版本 / workflow / 测试命令 / 技术选型 / MVP 还是生产化 / 实现路线 / 参数 / 环境配置 / 具体生成内容。这类**一律不得 blocking**,不得要求用户现在回答;写入 unknowns(classification=AGENT_DISCOVERABLE 或 OPTIONAL,blocking=false),或在正文里明确「目前尚未确定,后续根据环境调研」。",
  "拒绝这种默认逻辑:high impact + user exclusive = blocking USER_REQUIRED。**高影响不等于现在必须问**。MVP vs full / reuse vs create / lifecycle / 架构选择 / 交付深度 / 生产化 vs 原型 / workflow 策略 / 实现路线 都属未来执行阶段的选择 → 一律 blocking=false(可选建议或允许未决)。",
  "想法型输入(「我想做一个 X」「我想用 A 控制 B」「我想让 Agent 自动处理…」)不是错误:它们可以 REBUILD,但 REBUILD 只重建**表达**,不得重建**需求**,更不得因为 vague_goal_scope 自动阻塞。",
  "反向保护(同样重要):ComfyUI 版本 / API 地址 / workflow 文件位置 / 当前依赖 / 项目结构 / 接口签名这类**环境事实**永远不是用户决定,必须写进 unknowns 的 AGENT_DISCOVERABLE,不得问用户。",
  "提问纪律:进入 questions 的问题必须用**用户能理解的业务语言**,禁止暴露内部枚举(不要问「这是 Planning 还是 Execution」「请选择 Prompt Target」);每个问题给 2–4 个具体选项 + 有合理推荐时给 recommended_option_id 与一句理由;推荐只是建议,不是用户决定。",
  "依赖分轮:如果 B 是否需要问取决于 A 的答案,用 depends_on 声明,不要在同一个问题组里自相矛盾地问。",
  "铁律(必须遵守):",
  "1. 判断对象是「用户本轮输入」;历史讨论仅供参考,不得用历史话题覆盖当前请求。",
  "2. 助手 / Agent 的发言不是用户决定:evidence_quotes 与 requirements 的 quote 只能逐字引用用户自己的发言。",
  "3. UNKNOWN 不等于「要问用户」:每个 unknown 都要判断它属于 USER_REQUIRED(只有用户能定)、AGENT_DISCOVERABLE(执行方自己能查到,如代码结构 / 依赖版本 / 现有实现)还是 OPTIONAL(有没有都行)。",
  "4. blocking **只允许**由语义歧义支撑(不回答就不知道用户到底指什么);其余一律 blocking=false。拿不准 → false。",
  "4b. questions 只在存在语义歧义时才给;问题必须直指「你这句话指的是什么」,不得询问未来实施方案(生成什么内容 / 时长 / MVP / 生产化 / 选型 / 路线)。",
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
    "- decisions:对象数组 {text, kind: PRODUCT_DECISION|USER_PREFERENCE|FACT_GAP, impact: high|medium|low, needs_user_decision: 布尔, note}",
    "- questions:对象数组 {requirement_id, question, options:[{id,label,description,value,invalidates}], recommended_option_id, recommendation_reason, why, depends_on}",
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

  // ── RC2 安全层:机械补齐 / 纠正高影响用户决策(与模型质量、采样无关)──────
  //   与兜底路径共用同一实现:applyDecisionSafety。
  const safety = applyDecisionSafety({
    missingResolution,
    rawInput,
    contextTurns,
    triage: triage.triage,
    target: target.target,
  });
  if (safety.added.length > 0) issues.push(ANALYSIS_ISSUE.tradeoffNotSurfaced);

  // ── 产品取舍安全网(RC1 保留:句子级「还是 / 取舍」表达)────────────────────
  for (const statement of tradeoffStatements(rawInput)) {
    const already = missingResolution.some((item) => sameRequirement(item.text, statement));
    if (already) continue;
    issues.push(ANALYSIS_ISSUE.tradeoffNotSurfaced);
    const item = classifyUnknown({ text: statement, blocking: true });
    if (!item.blocking) {
      missingResolution.push(item);
      continue;
    }
    missingResolution.push({
      ...item,
      rationale: `${item.rationale ? `${item.rationale};` : ""}机械识别:用户原文出现产品取舍,分析未列出(安全网补齐)`,
    });
  }

  // ── RC2 §5:阻塞决策不得被「优化器建议」替代(PROVISIONAL 不能绕过 Discovery)──
  // 与**仍然阻塞的**决策语义重合的建议,直接丢弃 —— 它会让确认页看起来
  // 「已经替你暂定好了」,而实际上用户从未回答过这个高影响决策。
  const blockingDecisionTexts = missingResolution
    .filter((item) => item.blocking && item.classification === "USER_REQUIRED")
    .map((item) => item.text);
  const filteredSuggested = suggested.filter(
    (entry) => !blockingDecisionTexts.some((text) => sameRequirement(entry.text, text)),
  );

  const gate = computeAnalysisGate(missingResolution, triage.triage);
  const baseLedger = buildLedger({
    raw_input: rawInput,
    context_turns: contextTurns,
    explicit,
    suggested: filteredSuggested,
    resolution: missingResolution,
  });
  const ledger = applyBlindTrust(baseLedger, rawInput);

  const decisions = normalizeDecisions(record.decisions);
  const questions = remapQuestionRequirements(normalizeQuestions(record.questions), missingResolution);

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
    ...(decisions.length ? { decisions } : {}),
    ...(questions.length ? { questions } : {}),
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

/**
 * 把问题里的 `requirement_id` 重映射到**内容稳定 id**。
 *
 * 模型通常按自己输出的 unknowns 顺序编号(unknown-1 / unknown-2 …),而下标会在每轮
 * 重新分析时漂移。这里按「下标 → 第 N 个未决项」的约定重映射;已经直接命中稳定 id 的
 * 保持不变;命中不了的保留原值(由 Discovery 侧按 key 兜底)。
 */
function remapQuestionRequirements(
  questions: DiscoveryQuestion[],
  resolution: readonly MissingResolutionItem[],
): DiscoveryQuestion[] {
  const byId = new Set(resolution.map((item) => item.id));
  const remapOne = (raw: string): string | undefined => {
    if (byId.has(raw)) return raw;
    const positional = /^unknown-(\d+)$/.exec(raw);
    const index = positional ? Number(positional[1]) - 1 : Number.NaN;
    return Number.isInteger(index) && index >= 0 ? resolution[index]?.id : undefined;
  };
  return questions.map((question) => {
    const mapped = remapOne(question.requirement_id);
    // depends_on 同样按「下标 → 第 N 个未决项」的约定重映射(否则依赖分轮会失效)
    const dependsOn = question.depends_on
      .map((id) => remapOne(id))
      .filter((id): id is string => typeof id === "string");
    if (!mapped) {
      return dependsOn.length === question.depends_on.length
        ? { ...question, depends_on: dependsOn }
        : question;
    }
    return {
      ...question,
      requirement_id: mapped,
      key: `${mapped}::${question.key.split("::").slice(1).join("::")}`,
      depends_on: dependsOn,
    };
  });
}

/** decisions 归一化(kind / impact / needs_user_decision 容错)。 */
function normalizeDecisions(value: unknown): AnalysisDecision[] {
  if (!Array.isArray(value)) return [];
  const out: AnalysisDecision[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!text) continue;
    const kind =
      entry.kind === "PRODUCT_DECISION" || entry.kind === "USER_PREFERENCE" || entry.kind === "FACT_GAP"
        ? entry.kind
        : "PRODUCT_DECISION";
    const impact = entry.impact === "high" || entry.impact === "medium" || entry.impact === "low" ? entry.impact : "high";
    out.push({
      text,
      kind,
      impact,
      // 缺省按「必须问用户」处理(安全方向:宁可问,不可替用户决定)
      needs_user_decision: entry.needs_user_decision !== false,
      ...(typeof entry.note === "string" && entry.note ? { note: entry.note } : {}),
    });
    if (out.length >= 8) break;
  }
  return out;
}

/** questions 归一化(选项 / 推荐 / 依赖容错,并禁止暴露内部枚举)。 */
function normalizeQuestions(value: unknown): DiscoveryQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: DiscoveryQuestion[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const question = typeof entry.question === "string" ? entry.question.trim() : "";
    const requirementId = typeof entry.requirement_id === "string" ? entry.requirement_id.trim() : "";
    if (!question || !requirementId) continue;
    const options: DiscoveryOption[] = [];
    if (Array.isArray(entry.options)) {
      for (const option of entry.options) {
        if (!isPlainObject(option)) continue;
        const label = typeof option.label === "string" ? option.label.trim() : "";
        if (!label) continue;
        options.push({
          id: typeof option.id === "string" && option.id ? option.id : `opt-${options.length + 1}`,
          label,
          ...(typeof option.description === "string" && option.description ? { description: option.description } : {}),
          ...(typeof option.value === "string" && option.value ? { value: option.value } : {}),
          ...(Array.isArray(option.invalidates)
            ? { invalidates: option.invalidates.filter((v): v is string => typeof v === "string") }
            : {}),
        });
        if (options.length >= 4) break;
      }
    }
    out.push({
      key: `${requirementId}::${question.slice(0, 24)}`,
      requirement_id: requirementId,
      question,
      options,
      ...(typeof entry.recommended_option_id === "string" && entry.recommended_option_id
        ? { recommended_option_id: entry.recommended_option_id }
        : {}),
      ...(typeof entry.recommendation_reason === "string" && entry.recommendation_reason
        ? { recommendation_reason: entry.recommendation_reason }
        : {}),
      why: typeof entry.why === "string" ? entry.why : "",
      depends_on: Array.isArray(entry.depends_on)
        ? entry.depends_on.filter((v): v is string => typeof v === "string")
        : [],
      ...(entry.allow_blind_trust === false ? { allow_blind_trust: false } : {}),
    });
    if (out.length >= 3) break;
  }
  return out;
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

/**
 * 机械决策安全层(可复用)——**不依赖模型输出质量**。
 *
 * RC2 根因:原先这段逻辑只写在 JSON 解析路径里,一旦模型输出不可解析
 * (真实环境 6–8/25),整层保证就消失 → 同一输入有时阻塞、有时不阻塞。
 * 现在抽成纯函数,解析路径与**兜底路径**都必须调用 → 与采样/模型质量无关。
 */
function applyDecisionSafety(input: {
  missingResolution: MissingResolutionItem[];
  rawInput: string;
  triage: EditTriage;
  target: PromptTarget;
  contextTurns?: readonly ConversationTurn[];
}): { items: MissingResolutionItem[]; added: string[]; blocked: string[] } {
  const { rawInput } = input;
  const items = input.missingResolution;
  const added: string[] = [];
  const blocked: string[] = [];

  // ── 产品定位纠偏(核心规则)────────────────────────────────────────────────
  //   高影响决策 **不再** 自动等于阻塞。执行期信息不完整(项目路径 / API / 版本 /
  //   workflow / 测试命令 / MVP 还是生产化 / 实现路线 / 具体生成内容)与「未来取舍」
  //   (scope / lifecycle / mvp_vs_full / reuse_vs_create / architecture_change /
  //   delivery_depth / product_direction)一律**不阻塞**,记录为允许未决即可。
  //   唯一允许阻塞的是**语义歧义**(不回答就不知道用户当前这句话是什么意思),
  //   由 detectSemanticAmbiguity 机械判定(保守:指代无先行词 ∧ 无可用上下文)。
  //
  //   例外(保留 Decision Safety 的真实危险保护):mutation_permission /
  //   irreversible_permission 这类**变更授权**仍可阻塞 —— 它们关乎会不会破坏用户数据。
  const DANGEROUS_CATEGORIES = new Set(["mutation_permission", "irreversible_permission"]);
  const decisions: { category: string; text: string }[] = [
    ...scanDecisionStatements(rawInput).map((d) => ({ ...d })),
  ];
  const vague = vagueGoalDecision(rawInput, mechanicalTriage(rawInput).triage, {
    visualTarget: input.target === "image_generation" || input.target === "video_generation",
  });
  if (vague) decisions.push(vague);

  const surfacedCategories = new Set(
    items
      .map((item) => decisionCategoryOfRequirement(item.text))
      .filter((category) => category !== null) as string[],
  );
  const findCovering = (decision: { category: string; text: string }): number =>
    items.findIndex((item) => {
      const itemCategory = decisionCategoryOfRequirement(item.text);
      if (itemCategory !== null) return itemCategory === decision.category;
      return sameRequirement(decision.text, item.text);
    });

  for (const decision of decisions) {
    const dangerous = DANGEROUS_CATEGORIES.has(String(decision.category));
    const coveringIndex = findCovering(decision);
    const demoted: Pick<MissingResolutionItem, "classification" | "impact" | "blocking" | "user_exclusive" | "rationale"> = {
      // 保留「用户以后可能要决定」的事实,但**现在不阻塞**语义优化
      classification: dangerous ? "USER_REQUIRED" : "OPTIONAL",
      impact: dangerous ? "high" : "medium",
      blocking: false,
      user_exclusive: dangerous,
      rationale: dangerous
        ? "涉及变更授权(可能影响你的文件/数据),需要你确认"
        : `未来执行期的选择(${decision.category}),不影响当前语义;可在实施阶段再定,也可能由执行方按环境调查后提出方案`,
    };
    if (coveringIndex >= 0) {
      const existing = items[coveringIndex]!;
      if (existing.blocking && dangerous) continue;
      // 已经由模型标成阻塞、但属于执行期取舍 → 降级为允许未决
      if (existing.blocking && !dangerous) blocked.push(existing.text);
      items[coveringIndex] = { ...existing, ...demoted };
      continue;
    }
    if (surfacedCategories.has(String(decision.category))) continue;
    const base = classifyUnknown({ text: decision.text, blocking: dangerous, impact: demoted.impact });
    base.id = contentStableId(decision.text);
    items.push({ ...base, ...demoted });
    added.push(decision.text);
    surfacedCategories.add(String(decision.category));
  }

  // ── 模型把执行期取舍标成阻塞时,一并降级(机械层兜底)──────────────────────
  for (const [index, item] of items.entries()) {
    if (!item.blocking) continue;
    const category = decisionCategoryOfRequirement(item.text);
    const dangerous = category !== null && DANGEROUS_CATEGORIES.has(category);
    if (dangerous) continue;
    blocked.push(item.text);
    items[index] = {
      ...item,
      classification: "OPTIONAL",
      blocking: false,
      user_exclusive: false,
      rationale:
        "执行期信息不完整或未来取舍,不影响当前语义 → 保持未决(需要时可在实施阶段决定或由执行方调查)",
    };
  }

  // ── 唯一允许的阻塞来源:语义歧义 ─────────────────────────────────────────
  for (const ambiguity of detectSemanticAmbiguity(rawInput, input.contextTurns ?? [])) {
    if (items.some((item) => sameRequirement(item.text, ambiguity.text))) continue;
    const base = classifyUnknown({
      text: ambiguity.text,
      blocking: true,
      impact: "high",
      semanticAmbiguity: true,
    });
    // ★ id 必须**内容派生**(不能是下标):否则会与台账条目 id 撞车,
    //   planner 会把歧义项误判为「已解决」而直接跳到确认页。
    base.id = contentStableId(ambiguity.text);
    // 面向用户的问法(不得暴露内部枚举;选项由 UI 追加「保持未确定,直接优化」)
    base.question =
      ambiguity.kind === "unresolved_old_new"
        ? "要替换的具体对象是哪个?(请说明旧/新分别指什么,或选择「保持未确定,直接优化」)"
        : "你提到的指代具体是指什么?(请补充对象,或选择「保持未确定,直接优化」)";
    items.push({
      ...base,
      classification: "USER_REQUIRED",
      blocking: true,
      impact: "high",
      user_exclusive: true,
      rationale: "语义歧义:不澄清就无法确定你这句话的意思(唯一的阻塞来源)",
    });
  }
  return { items, added, blocked };
}

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
  // ★ RC2:兜底路径同样必须跑机械决策安全层 —— 否则「模型输出不可解析」的那一轮
  //   就会丢失全部阻塞保证(这正是 Decision Stability 的根因)。
  const safety = applyDecisionSafety({
    missingResolution: [],
    rawInput,
    contextTurns,
    triage: triage.triage,
    target: target.target,
  });
  return {
    intent: {
      primary: "general",
      supporting: [],
      work_mode: "one_shot",
      rationale: reason,
    },
    target,
    triage,
    missing_resolution: safety.items,
    gate: computeAnalysisGate(safety.items, triage.triage),
    ledger: [],
    confidence_internal: 0.5,
    rationale: reason,
    evidence_quotes: [],
    prompt_type: "general",
    missing_constraints: safety.items
      .filter((item) => item.classification !== "OPTIONAL")
      .map((item) => item.text),
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
  // 手动覆盖只允许六个真实意图(parsePromptTypeInput 已收窄);目标派生契约类型
  // ('image'/'video'/'agent')不是意图 → 归 general(契约:意图与编译契约分离)。
  const primary: WorkIntent | "general" = isWorkIntent(promptType) ? promptType : "general";
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
