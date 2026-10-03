/**
 * Intent Classifier —— 提示词与解析器(纯函数层)。
 *
 * 本模块负责「分类提示词构建 + JSON 契约容错解析 + 失败回退 + 确定性辅助检测」,
 * 以及 P03-T02 的调用侧封装 classifyViaLlm:一次分类小调用 + 失败回退。
 * 调用侧只依赖**结构化最小 LLM 接口**(不 import @deepseek-ai/*),
 * 因此可在完全脱离 Host ctx / UI 的前提下用 mock llm 单测;真实宿主
 * handler 主路径的接入在 P05(P03-T02 不修改现有 optimize 流)。
 *
 * 防误判三规则(PLAN-v1 §6,写进 system prompt + 测试):
 *   1. 以「当前输入」为判断对象;历史讨论仅供参考;
 *   2. 区分「当前请求」与「之前讨论过的内容」;
 *   3. 助手 / Agent 的建议不等于用户决定:evidence_quotes 只能引用用户自己的发言。
 *
 * 输出契约:ClassifierResult(types.ts ①)。temperature=0 / maxTokens=512 / lowest reasoning。
 * 解析失败 → general + 低置信(fallbackClassifierResult);confidence_internal < 0.6 → 低把握标记。
 *
 * 全部文案为本项目独立撰写;未复制任何 AGPL 项目源码 / 模板 / 测试。
 */
import type { ClassifierResult, ConversationTurn, PromptType } from "./types.js";
import { createThinkFilter, stripThinkBlocks } from "../prompt.js";

/** 任务类型封闭枚举(AUTO 分类器的合法取值;与 types.ts PromptType 对齐)。 */
export const PROMPT_TYPES: readonly PromptType[] = [
  "research",
  "planning",
  "execution",
  "diagnostic",
  "review",
  "creative",
  "general",
] as const;

/** 分类调用的硬参数(PLAN-v1 §2/§6):temperature=0、maxTokens=512、lowest reasoning。 */
export const CLASSIFIER_MAX_TOKENS = 512;
export const CLASSIFIER_TEMPERATURE = 0;

/** 低置信阈值(< 0.6 → UI 提示「低把握 + 建议检查类型」)。 */
export const CLASSIFIER_LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * 多意图确定性标记(不拆分子请求——NON-GOAL)。
 * 解析层只在「模型自己给出的缺口清单」里补一条注明,不新增模型没有的结论。
 */
export const MULTI_INTENT_NOTE =
  "疑似包含多种意图(如规划+执行);MVP 只按主类型编译,不自动拆分";

/** 类型守卫:任意值是否为合法 PromptType。 */
export function isPromptType(value: unknown): value is PromptType {
  return typeof value === "string" && (PROMPT_TYPES as readonly string[]).includes(value);
}

/** 分类语言(与策略文案一致,zh 优先)。 */
export type ClassifierLanguage = "zh" | "en";

// ─────────────────────────────────────────────────────────────────────────────
// 输出契约(单一真源:system prompt 与测试断言共用同一份字面量)
// ─────────────────────────────────────────────────────────────────────────────

/** JSON 输出契约的逐字段描述(供测试锚定 / 文档引用,避免文案与断言两处漂移)。 */
export const CLASSIFIER_OUTPUT_FIELDS: readonly { name: string; detail: string }[] = [
  { name: "prompt_type", detail: "七值之一(research/planning/execution/diagnostic/review/creative/general)" },
  { name: "confidence_internal", detail: "0..1 之间的小数" },
  { name: "missing_constraints", detail: "字符串数组:编译期需注入 [待补充: …] 的缺口" },
  { name: "rationale", detail: "一句话理由(UI 需求诊断区展示)" },
  { name: "evidence_quotes", detail: "字符串数组:必须是用户发言中的逐字片段,不得引用助手发言" },
] as const;

/** 给 LLM 的 JSON 契约块(中英各一份,与 CLASSIFIER_OUTPUT_FIELDS 同构)。 */
function outputContractBlock(language: ClassifierLanguage): string {
  if (language === "en") {
    return [
      "Output a single JSON object with exactly these fields:",
      "- prompt_type: one of the seven values above",
      "- confidence_internal: a decimal in 0..1",
      "- missing_constraints: string array — gaps that become [TODO: ...] placeholders; if the input seems to carry more than one intent, note it here",
      "- rationale: one-sentence reason",
      "- evidence_quotes: string array; every element must be a verbatim fragment of the user's own words (current input or historical user messages), never the assistant's",
    ].join("\n");
  }
  return [
    "只输出一个 JSON 对象,字段如下(不得增删字段名):",
    "- prompt_type:上述七值之一",
    "- confidence_internal:0..1 之间的小数",
    "- missing_constraints:字符串数组,列出编译时需注入 [待补充: …] 的缺口;若输入疑似包含多种意图,在这里注明",
    "- rationale:一句话理由",
    "- evidence_quotes:字符串数组,每个元素都必须是「用户本人发言」中的逐字片段(本轮输入或历史用户消息),不得引用助手发言",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// system / user 提示词
// ─────────────────────────────────────────────────────────────────────────────

/** 七类型说明(中英同构)。 */
const TYPE_CATALOG_ZH = [
  "七种任务类型:",
  "- research:需要检索 / 调研 / 对比信息后回答(如「帮我研究…」「查一下…」「哪个方案更好」)",
  "- planning:要制定计划 / 路线 / 任务拆解(如「帮我规划…」「分几步做…」)",
  "- execution:要直接执行 / 改写 / 生成交付物(如「帮我写一段代码」「把这段翻译成英文」)",
  "- diagnostic:要排查问题原因(如「为什么报错」「哪里出了问题」)",
  "- review:要评审 / 检查已有产物(如「帮我 review 这段代码」「检查这份文档」)",
  "- creative:创意写作 / 风格化产出(如「写一首诗」「起个标题」)",
  "- general:无法判定或不属于以上任何类型",
].join("\n");

const TYPE_CATALOG_EN = [
  "Seven task types:",
  '- research: needs searching / investigation / comparison (e.g. "research ...", "look up ...", "which option is better")',
  '- planning: needs a plan / roadmap / task breakdown (e.g. "plan ...", "what are the steps")',
  '- execution: needs direct execution / rewrite / a deliverable (e.g. "write a snippet", "translate this")',
  '- diagnostic: needs troubleshooting of a cause (e.g. "why does it fail", "what went wrong")',
  '- review: needs review / inspection of an existing artifact (e.g. "review this code", "check this doc")',
  '- creative: creative writing / stylized output (e.g. "write a poem", "brainstorm titles")',
  "- general: undecidable or none of the above",
].join("\n");

/** 防误判三规则(中英同构;测试锚点)。 */
const ANTI_MISCLASSIFICATION_ZH = [
  "防误判规则(必须遵守):",
  "1. 以「当前输入」为判断对象;历史讨论仅供参考,不得用历史话题覆盖当前请求。",
  "2. 区分「当前请求」与「之前讨论过的内容」:当前请求是用户最新一条消息的主谓,历史讨论只辅助判断意图方向。",
  "3. 助手 / Agent 的建议不等于用户决定:evidence_quotes 只能引用用户自己的发言,不得把助手的提议、结论或猜测当作依据。",
].join("\n");

const ANTI_MISCLASSIFICATION_EN = [
  "Anti-misclassification rules (mandatory):",
  '1. Judge "the current input"; earlier discussion is reference only.',
  '2. Separate "the current request" from "what was discussed earlier": the current request is the subject-predicate of the user\'s latest message.',
  "3. Assistant/agent suggestions are not user decisions: evidence_quotes may only quote the user's own words, never the assistant's proposals, conclusions or guesses.",
].join("\n");

function buildSystem(language: ClassifierLanguage): string {
  const zh = language !== "en";
  const parts = zh
    ? [
        "你是「提示词任务类型分类器」。只输出一个 JSON 对象,不要输出任何解释、Markdown 代码块或多余文字。",
        "分类对象是「用户本轮输入」;历史讨论仅供参考。",
        TYPE_CATALOG_ZH,
        ANTI_MISCLASSIFICATION_ZH,
        outputContractBlock("zh"),
      ]
    : [
        'You are the "prompt task-type classifier". Output a single JSON object only — no explanation, no Markdown code fences, no extra text.',
        'Classify "the user\'s current input"; earlier discussion is reference only.',
        TYPE_CATALOG_EN,
        ANTI_MISCLASSIFICATION_EN,
        outputContractBlock("en"),
      ];
  return parts.join("\n\n");
}

const SYSTEM_ZH = buildSystem("zh");
const SYSTEM_EN = buildSystem("en");

/** 分类 system prompt(双语同构,zh 优先)。 */
export function buildClassifierSystem(language: ClassifierLanguage = "zh"): string {
  return language === "en" ? SYSTEM_EN : SYSTEM_ZH;
}

/** 分类 user 载荷:可选上下文(仅作参考)+ 当前输入。 */
export function buildClassifierUser(
  input: { raw_input: string; context_turns?: readonly ConversationTurn[] },
  language: ClassifierLanguage = "zh",
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
      ? `以下是用户本轮输入(你唯一需要分类的对象):\n\n<prompt-draft>\n${input.raw_input}\n</prompt-draft>`
      : `Here is the user's current input (the only thing to classify):\n\n<prompt-draft>\n${input.raw_input}\n</prompt-draft>`,
  );
  return sections.join("\n\n");
}

/**
 * 提示词指纹(FNV-1a 32 位十六进制):同一输入两次构建必须得到同一指纹。
 * 仅用于「可复现性」断言与日志关联,不参与任何业务判定,不写入用户数据。
 */
export function classifierPromptFingerprint(system: string, user: string): string {
  const payload = `${system}\u0000${user}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析:JSON 契约容错
// ─────────────────────────────────────────────────────────────────────────────

/** 解析器稳定 issue id(对外契约;UI / 回归可引用,不得随意改名)。 */
export const CLASSIFY_ISSUE = {
  /** 全文找不到任何 JSON 对象。 */
  noJson: "CLASSIFY_NO_JSON",
  /** 存在 JSON 对象但没有一个满足字段契约。 */
  noUsableJson: "CLASSIFY_NO_USABLE_JSON",
  /** prompt_type 缺失或不在七值闭集 → 回退 general。 */
  unknownType: "CLASSIFY_UNKNOWN_TYPE",
  /** confidence_internal 缺失或非数值 → 取默认 0.5 并标低把握。 */
  invalidConfidence: "CLASSIFY_INVALID_CONFIDENCE",
  /** confidence_internal 越界 → 钳制到 0..1。 */
  confidenceClamped: "CLASSIFY_CONFIDENCE_CLAMPED",
  /** 解析到多个合法 JSON 对象 → 只取最后一个(模型复述 / 重复输出)。 */
  duplicateOutput: "CLASSIFY_DUPLICATE_OUTPUT",
  /** evidence_quotes 中存在非用户逐字片段的条目 → 丢弃。 */
  evidenceNotVerbatim: "CLASSIFY_EVIDENCE_NOT_VERBATIM",
  /** 多意图确定性检测命中 → 在缺口清单注明(不拆分)。 */
  multiIntent: "CLASSIFY_MULTI_INTENT",
} as const;

/** 解析元信息:调用方据此区分「模型给出 general」与「解析降级为 general」,并做日志/审计。 */
export interface ClassifierParseMeta {
  /** 校验过 schema 的 JSON 对象总数(≥1 才可能产出非空结果)。 */
  jsonCandidates: number;
  /** 是否发生了降级(缺字段补默认 / 未知类型 / 证据被丢弃 / 越界钳制 / 无合法 JSON)。 */
  degraded: boolean;
  /** 解析器问题 id 列表(稳定字符串,见 CLASSIFY_ISSUE)。 */
  issues: string[];
  /** prompt_type 非法而回退 general 时为 true。 */
  unknownTypeFallback: boolean;
  /** evidence_quotes 中被丢弃的条数。 */
  droppedEvidence: number;
  /** confidence_internal < 0.6(或非法值):UI 应提示「低把握 + 建议检查类型」。 */
  lowConfidence: boolean;
  /** 确定性多意图检测是否命中。 */
  multiIntent: boolean;
}

/** 解析结果:result 为 null 表示连兜底对象都不应被信任,调用方应回退 general。 */
export interface ClassifierParseOutcome {
  result: ClassifierResult | null;
  meta: ClassifierParseMeta;
}

/**
 * 解析选项:默认最保守(证据必须逐字可验证)。
 */
export interface ClassifierParseOptions {
  /** 逐字证据校验的比对源(user 本轮输入 + 上下文 user 消息)。 */
  rawInput?: string;
  contextTurns?: readonly ConversationTurn[];
  /** 是否丢弃非逐字证据,默认 true。仅调试时置 false。 */
  filterEvidenceQuotes?: boolean;
  /** 是否执行确定性多意图检测(仅补缺口注明),默认 true。 */
  detectMultiIntent?: boolean;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function clampConfidence(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0.5;
  return Math.min(1, Math.max(0, num));
}

/** 从原始文本中截出最后一个「已完整出现的顶层 JSON 对象」。 */
function lastJsonRegion(text: string): string | null {
  const end = text.lastIndexOf("}");
  if (end === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = end; index >= 0; index -= 1) {
    const char = text.charAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "}") {
      depth += 1;
    } else if (char === "{") {
      depth -= 1;
      if (depth === 0) return text.slice(index, end + 1);
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 契约字段名集合(与 CLASSIFIER_OUTPUT_FIELDS 同源,防止两处漂移)。 */
const CONTRACT_FIELD_NAMES: readonly string[] = CLASSIFIER_OUTPUT_FIELDS.map(
  (field) => field.name,
);

/**
 * 「可用 JSON」判定:至少含一个契约字段名。
 * 用于拒绝 `{}`、代码块残留或误截获的无关对象——它们不是分类输出。
 */
function hasContractField(record: Record<string, unknown>): boolean {
  return CONTRACT_FIELD_NAMES.some((name) => Object.prototype.hasOwnProperty.call(record, name));
}

/** 把 JSON.parse 的产物收敛成 ClassifierResult + 元信息(字段缺失一律补默认值,不抛错)。 */
function readClassifierResult(
  record: Record<string, unknown>,
  options: Required<Pick<ClassifierParseOptions, "rawInput" | "contextTurns" | "filterEvidenceQuotes" | "detectMultiIntent">>,
): { result: ClassifierResult; meta: ClassifierParseMeta } {
  const issues: string[] = [];
  let degraded = false;

  let promptType: PromptType = "general";
  let unknownTypeFallback = false;
  if (isPromptType(record.prompt_type)) {
    promptType = record.prompt_type;
  } else {
    unknownTypeFallback = true;
    degraded = true;
    issues.push(CLASSIFY_ISSUE.unknownType);
  }

  const rawConfidence = record.confidence_internal;
  const numericConfidence =
    typeof rawConfidence === "number" ? rawConfidence : Number(rawConfidence);
  let confidence = clampConfidence(rawConfidence);
  if (!Number.isFinite(numericConfidence)) {
    degraded = true;
    issues.push(CLASSIFY_ISSUE.invalidConfidence);
    confidence = 0.5;
  } else if (numericConfidence < 0 || numericConfidence > 1) {
    degraded = true;
    issues.push(CLASSIFY_ISSUE.confidenceClamped);
  }

  let missingConstraints = asStringArray(record.missing_constraints);
  let multiIntent = false;
  if (options.detectMultiIntent) {
    multiIntent = looksMultiIntent(options.rawInput);
    if (multiIntent && !missingConstraints.includes(MULTI_INTENT_NOTE)) {
      missingConstraints = [...missingConstraints, MULTI_INTENT_NOTE];
      degraded = true;
      issues.push(CLASSIFY_ISSUE.multiIntent);
    }
  }

  const rationale =
    typeof record.rationale === "string" ? record.rationale.trim() : "";

  const quotes = asStringArray(record.evidence_quotes);
  let acceptedQuotes = quotes;
  let droppedEvidence = 0;
  if (options.filterEvidenceQuotes) {
    acceptedQuotes = quotes.filter((quote) =>
      isVerbatimUserQuote(quote, options.rawInput, options.contextTurns),
    );
    droppedEvidence = quotes.length - acceptedQuotes.length;
    if (droppedEvidence > 0) {
      degraded = true;
      issues.push(CLASSIFY_ISSUE.evidenceNotVerbatim);
    }
  }

  return {
    result: {
      prompt_type: promptType,
      confidence_internal: confidence,
      missing_constraints: missingConstraints,
      rationale,
      evidence_quotes: acceptedQuotes,
    },
    meta: {
      jsonCandidates: 1,
      degraded,
      issues,
      unknownTypeFallback,
      droppedEvidence,
      lowConfidence: confidence < CLASSIFIER_LOW_CONFIDENCE_THRESHOLD,
      multiIntent,
    },
  };
}

function normalizeComparable(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 逐字子串判定:quote 必须出现在用户本轮输入或上下文 user 消息中。
 * 只折叠空白,不做大小写折叠(逐字要求,保守优先)。
 */
export function isVerbatimUserQuote(
  quote: string,
  rawInput: string,
  contextTurns: readonly ConversationTurn[],
): boolean {
  const needle = normalizeComparable(quote);
  if (!needle) return false;
  if (normalizeComparable(rawInput).includes(needle)) return true;
  return contextTurns.some(
    (turn) => turn.role === "user" && normalizeComparable(turn.text).includes(needle),
  );
}

/**
 * 多意图确定性检测(仅提示,不拆分):同一句里同时出现「规划」与「执行」诉求。
 * 纯字符串规则,可单测;模型自己的 missing_constraints 优先,本函数只补一条注明。
 */
export function looksMultiIntent(rawInput: string): boolean {
  const text = normalizeComparable(rawInput);
  if (!text) return false;
  const hasPlanning =
    /规划|计划|方案|步骤|路线|拆解|分析|需求|plan\b|roadmap|steps?\b|analyz|analys|requirement/i.test(
      text,
    );
  const hasExecution =
    /执行|实现|写(?:一|个|段|出)?|改(?:一下|成)|生成|落地|翻译|重构|做出来|implement|execute|write\b|refactor|translate|build\b/i.test(
      text,
    );
  return hasPlanning && hasExecution;
}

/**
 * 解析模型原始输出为 ClassifierResult(P03-T01 契约入口)。
 *
 * 容错策略(确定性,无 LLM):
 *   1. 先剥 `<think>` 思考块;截取**最后一个**已完整出现的顶层 JSON 对象
 *      (模型复述/重复输出时取最后);若整段解析失败,退一步做「重复对象拼接」修复。
 *   2. 字段缺失 / 类型不符一律补默认值(prompt_type→general、confidence→0.5、
 *      数组→[]、rationale→"")。
 *   3. prompt_type 不在七值闭集 → general + 低置信 + unknownTypeFallback 元信息。
 *   4. confidence_internal 非数值 → 0.5;越界 → 钳制到 0..1;结果 < 0.6 → lowConfidence。
 *   5. evidence_quotes 逐字校验:对不上 raw_input / 上下文 user 消息的条目一律丢弃
 *      (助手发言也不算证据)。
 *   6. 多意图 → 在 missing_constraints 注明(不拆分子请求)。
 *
 * 全文找不到任何可用 JSON 时返回 `{ result: null, meta }`;调用方按契约回退
 * `fallbackClassifierResult()`(general + 低置信)。
 */
export function parseClassifierOutput(
  raw: string,
  options: ClassifierParseOptions = {},
): ClassifierParseOutcome {
  const settings = {
    rawInput: options.rawInput ?? "",
    contextTurns: options.contextTurns ?? [],
    filterEvidenceQuotes: options.filterEvidenceQuotes !== false,
    detectMultiIntent: options.detectMultiIntent !== false,
  };

  const text = stripThinkBlocks(String(raw ?? ""));
  const region = lastJsonRegion(text);
  let parsed: unknown = null;
  if (region !== null) {
    try {
      parsed = JSON.parse(region);
    } catch {
      // 模型有时把多个对象粘在一起(缺逗号):补逗号后重试一次。
      try {
        parsed = JSON.parse(region.replace(/\}\s*\{/g, "},{"));
      } catch {
        parsed = null;
      }
    }
  }

  // 必须是对象,且至少含一个契约字段名——`{}` 或误截获的无关对象不算「可用 JSON」。
  const usable = isPlainObject(parsed) && hasContractField(parsed);
  if (!usable) {
    return {
      result: null,
      meta: {
        jsonCandidates: 0,
        degraded: true,
        issues: [region === null ? CLASSIFY_ISSUE.noJson : CLASSIFY_ISSUE.noUsableJson],
        unknownTypeFallback: false,
        droppedEvidence: 0,
        lowConfidence: true,
        multiIntent: false,
      },
    };
  }

  const { result, meta } = readClassifierResult(parsed as Record<string, unknown>, settings);
  return { result, meta };
}

/**
 * 兼容别名(P01.5 / P05 旧调用点)。
 *
 * 语义差异:仅「非法类型」与「非 JSON 对象」两种情况返回 null,与旧行为一致;
 * 未知/缺失字段仍按默认值补全。需要「未知类型 → general」时用 parseClassifierOutput。
 */
export function parseClassifierResult(raw: string): ClassifierResult | null {
  const outcome = parseClassifierOutput(raw, {
    filterEvidenceQuotes: false,
    detectMultiIntent: false,
  });
  if (outcome.result === null) return null;
  if (outcome.meta.unknownTypeFallback) return null;
  return outcome.result;
}

/** 分类失败 / 低置信时的兜底:general + 低置信,UI 提示可手动选择类型。 */
export function fallbackClassifierResult(reason?: string): ClassifierResult {
  return {
    prompt_type: "general",
    confidence_internal: 0.2,
    missing_constraints: [],
    rationale:
      typeof reason === "string" && reason.trim()
        ? `${reason.trim()}`
        : "分类失败,回退通用模式;可手动选择任务类型",
    evidence_quotes: [],
  };
}

/** 手动覆盖(UI 最高优先级):不调用分类,直接产出确定结果。 */
export function manualClassifierResult(promptType: PromptType): ClassifierResult {
  return {
    prompt_type: promptType,
    confidence_internal: 1,
    missing_constraints: [],
    rationale: "用户手动指定任务类型",
    evidence_quotes: [],
  };
}

/** 从请求体解析手动类型:非法或缺失返回 undefined(走 AUTO)。 */
export function parsePromptTypeInput(value: unknown): PromptType | undefined {
  return isPromptType(value) ? value : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// P03-T02:LLM 调用侧封装(classifyViaLlm)
//
// 只做「一次分类小调用 + 失败回退」,不解析路由、不发起重试、不接入 handler
// 主路径(P05 才编排)。硬参数:temperature=0 / maxTokens=512 / lowest reasoning;
// 流式文本先过 thinkFilter 再走 parseClassifierOutput。
//
// 依赖面刻意收敛为结构化最小接口(不 import 任何 Harness LLM 包 / cordis),
// 好处:core 保持可独立构建、mock llm 即可完整覆盖各失败分支;真实宿主 LLM 与
// Message 在结构上可直接传入(宿主可注入 buildMessage 以带上 id/source)。
// ─────────────────────────────────────────────────────────────────────────────

/** 分类调用里一条消息的最小结构面(真实宿主 Message 满足之)。 */
export interface ClassifierLlmMessage {
  role: string;
  content: unknown;
}

/** 一个流式分片的最小结构面(与官方流式分片结构兼容)。 */
export interface ClassifierLlmChunk {
  type: string;
  text?: string;
  index?: number;
  block?: { type: string; text?: string };
  reason?: {
    kind: string;
    failure?: { code?: string; message?: string };
  };
}

/** 模型目录信息的最小结构面(只取推理档位表)。 */
export interface ClassifierModelInfoLike {
  reasoning?: { efforts?: readonly { id: unknown; name?: string }[] };
}

/** 分类调用 GenerateOptions 的最小结构面。 */
export interface ClassifierLlmStreamOptions<Message = ClassifierLlmMessage> {
  provider: string;
  model: string;
  system?: string;
  messages: readonly Message[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

/** 分类调用依赖的 LLM 结构面(真实宿主 LLM 满足;mock 亦可)。 */
export interface ClassifierLlm<Message = ClassifierLlmMessage> {
  stream(options: ClassifierLlmStreamOptions<Message>): AsyncIterable<ClassifierLlmChunk>;
  resolveModelInfo?(provider: string, model: string): Promise<ClassifierModelInfoLike>;
}

/** 调用侧稳定 issue id(与 CLASSIFY_ISSUE 同层;UI / 回归可引用,不得随意改名)。 */
export const CLASSIFY_LLM_ISSUE = {
  /** 外部 signal 已取消 / 调用中途被中止。 */
  aborted: "CLASSIFY_LLM_ABORTED",
  /** 包装层硬超时(不是解析问题,调用方应走超时错误通道,而非兜底结果)。 */
  timedOut: "CLASSIFY_LLM_TIMED_OUT",
  /** 认证 / 授权类失败(API key 无效、401/403 等)。 */
  authFailed: "CLASSIFY_LLM_AUTH_FAILED",
  /** 其余传输 / 流中断失败。 */
  streamError: "CLASSIFY_LLM_STREAM_ERROR",
  /** 调用成功但输出无法解析成可用 JSON 契约。 */
  invalidOutput: "CLASSIFY_LLM_INVALID_OUTPUT",
} as const;

/** 失败归类(用于调用方区分「可兜底」与「应走错误/取消通道」)。 */
export type ClassifyFailureKind =
  | "none"
  | "aborted"
  | "timeout"
  | "auth"
  | "stream-error"
  | "invalid-output";

/** classifyViaLlm 的完整结果(总返回一个 result;失败时为 general 兜底并带标记)。 */
export interface ClassifyViaLlmOutcome {
  /** 解析结果或兜底结果(general + 低置信);`usedFallback` 区分二者。 */
  result: ClassifierResult;
  /** 解析元信息(兜底路径为合成的降级元信息)。 */
  meta: ClassifierParseMeta;
  /** 是否发生了降级(解析补默认 / 未知类型 / 证据丢弃 / 任何失败兜底)。 */
  degraded: boolean;
  /** 是否被取消(外部 signal 或包装层超时)。 */
  aborted: boolean;
  /** 是否由包装层 `timeoutMs` 触发超时(与客户端断连区分)。 */
  timedOut: boolean;
  /** result 是否为 `fallbackClassifierResult()` 兜底。 */
  usedFallback: boolean;
  /** 失败归类;成功为 "none"。 */
  failure: ClassifyFailureKind;
  /** 失败原因(success 时可能为截断提示);不含用户隐私内容。 */
  reason?: string;
  /** 本次调用墙钟耗时(毫秒;审计/性能用,不参与判定)。 */
  durationMs: number;
  /** 实际下发的硬参数快照(审计:证明 temp0/512/lowest)。 */
  request: {
    provider: string;
    model: string;
    maxTokens: number;
    temperature: number;
    reasoningEffort?: string;
  };
}

/** 分类调用输入(AUTO 路径:本轮输入 + 可选上下文)。 */
export interface ClassifyViaLlmInput {
  raw_input: string;
  context_turns?: readonly ConversationTurn[];
}

/** classifyViaLlm 选项(全部可选;缺省即最保守行为)。 */
export interface ClassifyViaLlmOptions<Message = ClassifierLlmMessage> {
  language?: ClassifierLanguage;
  /** 外部取消信号(客户端断连 / 宿主统一超时)。 */
  signal?: AbortSignal;
  /** 包装层硬超时(毫秒);>0 时生效,到时中止调用并标记 `timedOut`。 */
  timeoutMs?: number;
  /** 显式推理强度;优先级最高(用于宿主 `reasoningEffort='session'` 场景)。 */
  reasoningEffort?: string;
  /** 宿主注入的最低档解析(复用既有 resolveLowestEffortCached);返回 undefined 表示不指定。 */
  resolveLowestEffort?: (provider: string, model: string) => Promise<string | undefined>;
  /** 构造 user 消息(宿主注入带 id/source 的真实 Message);缺省用最小 user 文本消息。 */
  buildMessage?: (payload: string) => Message;
  /** 逐段回调:思考块已剥离的干净增量(宿主透传 SSE 时可注入)。 */
  onDelta?: (text: string) => void;
}

/** 默认 user 消息:结构化最小形态,真实宿主可注入自己的 Message 工厂。 */
function defaultClassifierMessage(payload: string): ClassifierLlmMessage {
  return { role: "user", content: [{ type: "text", text: payload }] };
}

/** 内部失败载体:保留失败码供 auth 归类。 */
class ClassifierStreamFailure extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ClassifierStreamFailure";
    this.code = code;
  }
}

/** 认证 / 授权类失败关键词(保守;命中即归 auth,调用方可提示检查 API key)。 */
const AUTH_FAILURE_PATTERN =
  /auth|unauthor|permission|forbidden|invalid[_ -]?api[_ -]?key|api[_ -]?key|401|403/i;

function isAuthFailure(message: string): boolean {
  return AUTH_FAILURE_PATTERN.test(message);
}

/** 兜底路径的合成元信息(调用侧失败没有解析元信息,显式标记降级)。 */
function fallbackMeta(issues: string[]): ClassifierParseMeta {
  return {
    jsonCandidates: 0,
    degraded: true,
    issues,
    unknownTypeFallback: false,
    droppedEvidence: 0,
    lowConfidence: true,
    multiIntent: false,
  };
}

/**
 * 内部最低档解析:显式注入优先;否则按 llm.resolveModelInfo 的档位表取最低。
 * 目录查询失败 / 模型不暴露推理时返回 undefined(不冒险乱发)。
 */
async function resolveLowestEffortFromLlm(
  llm: ClassifierLlm<unknown>,
  provider: string,
  model: string,
): Promise<string | undefined> {
  try {
    const efforts = (await llm.resolveModelInfo?.(provider, model))?.reasoning?.efforts;
    if (!efforts?.length) return undefined;
    const keyworded = efforts.find((effort) =>
      /none|minimal|low|低/i.test(`${effort.id} ${effort.name ?? ""}`),
    );
    return String((keyworded ?? efforts[0]).id);
  } catch {
    return undefined;
  }
}

/**
 * 折叠分类流:文本增量过 thinkFilter(跨 chunk 剥 `<think>`),
 * finish 为 error/aborted 时抛出,max-tokens 标记截断;无增量时降级用 block-end 文本。
 */
async function collectClassifierText(
  stream: AsyncIterable<ClassifierLlmChunk>,
  onDelta?: (text: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  const filter = createThinkFilter();
  const blocks = new Map<number, string>();
  let filtered = "";
  let truncated = false;

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text-delta": {
        const clean = filter.push(chunk.text ?? "");
        if (clean) {
          filtered += clean;
          onDelta?.(clean);
        }
        break;
      }
      case "block-end": {
        if (chunk.block?.type === "text") {
          blocks.set(chunk.index ?? blocks.size, chunk.block.text ?? "");
        }
        break;
      }
      case "finish": {
        const reason = chunk.reason;
        if (!reason) break;
        if (reason.kind === "error" || reason.kind === "aborted") {
          const code = reason.failure?.code;
          const detail = reason.failure
            ? `${code ?? "unknown"}: ${reason.failure.message ?? ""}`.trim()
            : reason.kind;
          throw new ClassifierStreamFailure(`模型调用失败(${detail})`, code);
        }
        // 分类调用不带工具,模型请求工具说明路由/适配异常,明确报错而非当成功。
        if (reason.kind === "tool-calls") {
          throw new ClassifierStreamFailure("模型意外请求工具调用(分类调用不提供工具),请检查模型路由配置");
        }
        if (reason.kind === "max-tokens") truncated = true;
        break;
      }
      default:
        break;
    }
  }

  const tail = filter.flush();
  if (tail) {
    filtered += tail;
    onDelta?.(tail);
  }
  // 优先使用增量(协议主通道);某些适配器只发 block-end 时降级,仍剥思考块。
  const text =
    filtered ||
    stripThinkBlocks(
      [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, blockText]) => blockText)
        .join(""),
    );
  return { text, truncated };
}

/**
 * classifyViaLlm —— 一次分类小调用(宿主侧调用入口,P03-T02)。
 *
 * 语义:
 *   - 正常 → parseClassifierOutput;结果可用即返回,失败(无可用 JSON)→ general 兜底;
 *   - error(AUTH / 传输)→ general + 低置信兜底,`failure` 标注 auth / stream-error;
 *   - 超时(`timeoutMs`)→ `timedOut: true`,调用方应走超时错误通道(与现有宿主风格一致);
 *   - 外部 signal 取消 → `aborted: true`;signal 在调用前已取消时立即返回,不发起请求。
 *
 * 本函数不解析路由、不重试、不写 UI、不影响 handler 主路径(P05 才编排)。
 */
export async function classifyViaLlm<Message = ClassifierLlmMessage>(
  llm: ClassifierLlm<Message>,
  route: { provider: string; model: string },
  input: ClassifyViaLlmInput,
  options: ClassifyViaLlmOptions<Message> = {},
): Promise<ClassifyViaLlmOutcome> {
  const startedAt = Date.now();
  const language: ClassifierLanguage = options.language ?? "zh";
  const rawInput = input.raw_input ?? "";
  const contextTurns = input.context_turns ?? [];
  const buildMessage =
    options.buildMessage ??
    ((payload: string): Message => defaultClassifierMessage(payload) as unknown as Message);

  // 请求快照:即使提前取消也给出「本应使用的硬参数」,便于审计与回归。
  const request: ClassifyViaLlmOutcome["request"] = {
    provider: route.provider,
    model: route.model,
    maxTokens: CLASSIFIER_MAX_TOKENS,
    temperature: CLASSIFIER_TEMPERATURE,
  };
  const finish = (
    outcome: Omit<ClassifyViaLlmOutcome, "durationMs" | "request">,
  ): ClassifyViaLlmOutcome => ({
    ...outcome,
    durationMs: Date.now() - startedAt,
    request,
  });

  // 1. 调用前已取消:立即生效,绝不发起请求。
  if (options.signal?.aborted) {
    return finish({
      result: fallbackClassifierResult("分类已取消,回退通用模式;可手动选择任务类型"),
      meta: fallbackMeta([CLASSIFY_LLM_ISSUE.aborted]),
      degraded: true,
      aborted: true,
      timedOut: false,
      usedFallback: true,
      failure: "aborted",
      reason: "aborted before start",
    });
  }

  // 2. 推理强度:显式 > 宿主注入的最低档解析 > 内部目录解析。
  let reasoningEffort = options.reasoningEffort;
  if (!reasoningEffort) {
    const resolver =
      options.resolveLowestEffort ?? ((provider, model) => resolveLowestEffortFromLlm(llm, provider, model));
    reasoningEffort = await resolver(route.provider, route.model);
  }
  if (reasoningEffort) request.reasoningEffort = reasoningEffort;

  // 3. 组合中止信号:外部 signal 或包装层超时,任一触发都中止底层调用。
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
  }

  try {
    const system = buildClassifierSystem(language);
    const user = buildClassifierUser({ raw_input: rawInput, context_turns: contextTurns }, language);
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [buildMessage(user)],
      maxTokens: CLASSIFIER_MAX_TOKENS,
      temperature: CLASSIFIER_TEMPERATURE,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      signal: controller.signal,
    });

    const collected = await collectClassifierText(stream, options.onDelta);
    // 中止可能以「正常 end」收尾:半截输出不可信,统一走取消 / 超时语义。
    if (controller.signal.aborted) {
      throw new ClassifierStreamFailure(timedOut ? "分类调用超时" : "分类调用被中止");
    }

    const outcome = parseClassifierOutput(collected.text, { rawInput, contextTurns });
    if (outcome.result === null) {
      return finish({
        result: fallbackClassifierResult("分类输出无法解析,已回退通用模式;可手动选择任务类型"),
        meta: fallbackMeta([CLASSIFY_LLM_ISSUE.invalidOutput, ...outcome.meta.issues]),
        degraded: true,
        aborted: false,
        timedOut: false,
        usedFallback: true,
        failure: "invalid-output",
        reason: "classifier output is not usable JSON",
      });
    }
    return finish({
      result: outcome.result,
      meta: outcome.meta,
      degraded: outcome.meta.degraded,
      aborted: false,
      timedOut: false,
      usedFallback: false,
      failure: "none",
      reason: collected.truncated ? "classifier output truncated at maxTokens" : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (timedOut || controller.signal.aborted) {
      return finish({
        result: fallbackClassifierResult(
          timedOut
            ? "分类调用超时,回退通用模式;可手动选择任务类型"
            : "分类调用已取消,回退通用模式;可手动选择任务类型",
        ),
        meta: fallbackMeta([timedOut ? CLASSIFY_LLM_ISSUE.timedOut : CLASSIFY_LLM_ISSUE.aborted]),
        degraded: true,
        aborted: true,
        timedOut,
        usedFallback: true,
        failure: timedOut ? "timeout" : "aborted",
        reason: message,
      });
    }
    const auth = isAuthFailure(message);
    return finish({
      result: fallbackClassifierResult("分类调用失败,已回退通用模式;可手动选择任务类型"),
      meta: fallbackMeta([auth ? CLASSIFY_LLM_ISSUE.authFailed : CLASSIFY_LLM_ISSUE.streamError]),
      degraded: true,
      aborted: false,
      timedOut: false,
      usedFallback: true,
      failure: auth ? "auth" : "stream-error",
      reason: message,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
