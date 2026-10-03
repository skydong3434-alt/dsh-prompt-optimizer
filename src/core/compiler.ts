/**
 * Prompt Compiler(最小版,Vertical Slice):策略 system/user 组装 + 四段协议解析
 * + provenance 机械校验 + anti-drift 守卫汇总。
 *
 * 协议(PLAN-v1 §8):模型按标记段输出
 *   <<<DIAGNOSIS>>> 需求诊断
 *   <<<EXPLICIT>>>  用户本轮明确要求(每条附 [quote: …])
 *   <<<CONTEXT>>>   上下文里「用户」已确认(每条附 [quote: …])
 *   <<<SUGGESTED>>> 优化器建议(可忽略)
 *   <<<UNKNOWN>>>   证据不足 / [待补充: …]
 *   <<<OPTIMIZED>>> 优化后的完整 Prompt
 *   <<<END>>>
 * 解析层同时兼容 Markdown 四段标题(策略原始 formatNote 的写法),解析失败时
 * 整段文本作为 optimized_prompt 降级(wellFormed=false),绝不伪造 provenance。
 *
 * 纯函数,零 ctx.llm / UI 依赖;唯一外部依赖是 core/provenance 与 prompt.ts 的
 * 纯工具(think 剥离 / legacy 输出解析)。
 */
import type {
  ClassifierResult,
  CompileResult,
  CompileVars,
  ConversationTurn,
  MissingConstraint,
  NormalizedContext,
  PromptStrategy,
  PromptType,
  ProvenanceRecord,
  ProvenanceSource,
  ValidationProblem,
} from "./types.js";
import { toConfidenceLevel } from "./types.js";
import { makeProvenanceRecord, validateProvenance } from "./provenance.js";
import { normalizeInput } from "./context.js";
import {
  fallbackClassifierResult,
  manualClassifierResult,
  parsePromptTypeInput,
} from "./classify.js";
import { defaultStrategyRegistry, type StrategyRegistry } from "./registry.js";
import {
  buildSystemPrompt,
  buildUserPayload,
  parseOptimizerOutput,
  stripThinkBlocks,
  type OptimizerMode,
} from "../prompt.js";
import {
  SUGGESTION_LABEL_EN,
  SUGGESTION_LABEL_ZH,
  stripSuggestionLabel,
  todoPlaceholder,
} from "./strategies/_shared.js";

// ─────────────────────────────────────────────────────────────────────────────
// 机器可解析输出协议(标记段)
// ─────────────────────────────────────────────────────────────────────────────

export const COMPILE_MARKERS = {
  diagnosis: "<<<DIAGNOSIS>>>",
  explicit: "<<<EXPLICIT>>>",
  context: "<<<CONTEXT>>>",
  suggested: "<<<SUGGESTED>>>",
  unknown: "<<<UNKNOWN>>>",
  optimized: "<<<OPTIMIZED>>>",
  end: "<<<END>>>",
} as const;

/**
 * Compiler 10 步编排(PLAN-v1 §8)的审计锚点。
 *
 * `enforcedBy` 标出该步由谁落实,避免把「提示词约束」当成「机械保证」:
 *   - orchestration:compilePrompt 机械完成(可单测);
 *   - protocol:策略 system / 编译协议约束模型完成(由守卫 + 回归断言把关);
 *   - finalize:finalizeCompile 的容错解析 + provenance 机械校验落实。
 */
export const COMPILE_PROMPT_STEPS = [
  { id: "intent-preservation", zh: "意图保真", enforcedBy: "protocol" },
  { id: "context-reconstruction", zh: "保守上下文重建", enforcedBy: "orchestration" },
  { id: "missing-information", zh: "缺失信息检测", enforcedBy: "orchestration" },
  { id: "hidden-constraint", zh: "隐式约束检测(仅当有证据)", enforcedBy: "protocol" },
  { id: "risk-ambiguity", zh: "风险 / 歧义检测(写入诊断)", enforcedBy: "protocol" },
  { id: "strategy-structuring", zh: "策略化结构", enforcedBy: "orchestration" },
  { id: "output-contract", zh: "输出契约构建", enforcedBy: "orchestration" },
  { id: "anti-drift", zh: "反漂移约束", enforcedBy: "protocol" },
  { id: "provenance-preservation", zh: "来源保全(四段协议)", enforcedBy: "orchestration" },
  { id: "final-compilation", zh: "最终编译(解析 + provenance 校验)", enforcedBy: "finalize" },
] as const;

/** 10 步编排的稳定步骤 id。 */
export type CompileStepId = (typeof COMPILE_PROMPT_STEPS)[number]["id"];

/** compilePrompt 实际机械落实的步骤(其余由协议 / finalize 落实)。 */
const ORCHESTRATION_STEP_IDS: CompileStepId[] = COMPILE_PROMPT_STEPS.filter(
  (step) => step.enforcedBy === "orchestration",
).map((step) => step.id);

const MARKER_NAMES = [
  "DIAGNOSIS",
  "EXPLICIT",
  "CONTEXT",
  "SUGGESTED",
  "UNKNOWN",
  "OPTIMIZED",
  "END",
] as const;
type MarkerName = (typeof MARKER_NAMES)[number];

/** 编译输出协议说明(拼在策略 system 之后,作为最终、最高优先级的格式约束)。 */
export function buildCompilerProtocol(language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    return `# Machine-parseable output protocol (final; overrides any format note above)
To make the result parsable, put the content described above inside the following marker sections. Each marker must be on its own line; output nothing outside the sections:
${COMPILE_MARKERS.diagnosis}
Requirement diagnosis (goal clarity / context completeness / constraints / structure / output spec + risks and ambiguities; multiple lines allowed)
${COMPILE_MARKERS.explicit}
The user's explicit requirements from this input, one per line as "- content [quote: verbatim user fragment]"; write "- (none)" if none
${COMPILE_MARKERS.context}
Facts the "user" confirmed earlier, one per line as "- content [quote: verbatim user fragment]"; assistant messages never count; write "- (none)" if none
${COMPILE_MARKERS.suggested}
Optimizer suggestions, one per line as "- ${SUGGESTION_LABEL_EN} content"; write "- (none)" if none
${COMPILE_MARKERS.unknown}
Unevidenced / unconfirmed items, one per line as "- [TODO: what is missing and why it matters]"; write "- (none)" if none
${COMPILE_MARKERS.optimized}
The full optimized prompt (must contain every section the chosen strategy requires, in order)
${COMPILE_MARKERS.end}`;
  }
  return `# 机器可解析输出协议(最终协议,优先级高于上文任何格式描述)
为便于程序解析,请把上文要求的内容放入以下标记段;标记行单独成行,除标记段内容外不要输出任何其他文字:
${COMPILE_MARKERS.diagnosis}
需求诊断(目标清晰度 / 上下文完整性 / 约束边界 / 结构表达 / 输出规格 + 风险与歧义提示,可多行)
${COMPILE_MARKERS.explicit}
用户本轮明确要求,每行一条,格式「- 内容 [quote: 用户原话逐字片段]」;没有写「- (无)」
${COMPILE_MARKERS.context}
上下文里「用户」已确认的内容,每行一条,格式「- 内容 [quote: 上下文用户原话逐字片段]」;助手发言不算;没有写「- (无)」
${COMPILE_MARKERS.suggested}
优化器建议,每行一条,格式「- ${SUGGESTION_LABEL_ZH} 内容」;没有写「- (无)」
${COMPILE_MARKERS.unknown}
证据不足 / 待确认项,每行一条,格式「- [待补充: 缺什么、为什么重要]」;没有写「- (无)」
${COMPILE_MARKERS.optimized}
优化后的完整 Prompt(必须包含所选策略要求的全部段落,按顺序)
${COMPILE_MARKERS.end}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 标记定位(取最后一次出现:推理模型可能在思考里复述标记)
// ─────────────────────────────────────────────────────────────────────────────

interface MarkerPos {
  index: number;
  length: number;
}

function findLastMarker(text: string, name: MarkerName): MarkerPos | null {
  const re = new RegExp(`<<<\\s*${name}\\s*>>>`, "g");
  let last: MarkerPos | null = null;
  for (const match of text.matchAll(re)) {
    last = { index: match.index, length: match[0].length };
  }
  return last;
}

function collectMarkerPositions(text: string): Partial<Record<MarkerName, MarkerPos>> {
  const positions: Partial<Record<MarkerName, MarkerPos>> = {};
  for (const name of MARKER_NAMES) {
    const pos = findLastMarker(text, name);
    if (pos) positions[name] = pos;
  }
  return positions;
}

function contentOf(
  text: string,
  positions: Partial<Record<MarkerName, MarkerPos>>,
  name: MarkerName,
): string {
  const pos = positions[name];
  if (!pos) return "";
  // 该标记之后最近的一个标记即本段结束;没有则到文末。
  let end = text.length;
  for (const other of MARKER_NAMES) {
    if (other === name) continue;
    const otherPos = positions[other];
    if (otherPos && otherPos.index > pos.index && otherPos.index < end) end = otherPos.index;
  }
  return text.slice(pos.index + pos.length, end).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 行解析:quote 提取 / 四段记录构造
// ─────────────────────────────────────────────────────────────────────────────

const QUOTE_RE = /\[quote:\s*([^\]]*?)\s*\]/g;
/** 中英两种占位符(`[待补充: …]` / `[TODO: …]`),与 _shared 的 TODO_PLACEHOLDER_RE 同源口径。 */
const TODO_RE = /\[(?:待补充|TODO)\s*:\s*([^\]]*?)\s*\]/g;

function extractQuotes(line: string): string[] {
  const quotes: string[] = [];
  for (const match of line.matchAll(QUOTE_RE)) {
    const quote = match[1].trim();
    if (quote) quotes.push(quote);
  }
  return quotes;
}

function stripQuotes(line: string): string {
  return line.replace(QUOTE_RE, "").trim();
}

function isNoneLine(line: string): boolean {
  const clean = line.replace(/^[-*]\s*/, "").trim();
  return clean === "" || /^(\(无\)|（无）|无|\(none\)|none|N\/A|n\/a)$/i.test(clean);
}

interface ParsedRecords {
  records: ProvenanceRecord[];
  missing: MissingConstraint[];
}

function parseRecordLines(block: string, source: ProvenanceSource, idPrefix: string): ParsedRecords {
  const records: ProvenanceRecord[] = [];
  const missing: MissingConstraint[] = [];
  let seq = 0;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isNoneLine(line)) continue;
    const body = line.replace(/^[-*]\s*/, "").trim();
    if (!body || isNoneLine(body)) continue;

    const quotes = extractQuotes(body);
    let text: string;
    if (source === "UNKNOWN") {
      const labels: string[] = [];
      for (const match of body.matchAll(TODO_RE)) {
        const label = match[1].trim();
        if (label) labels.push(label);
      }
      text = stripQuotes(body).replace(TODO_RE, "").trim() || labels.join(";");
      for (const label of labels.length ? labels : [text]) {
        if (!label) continue;
        seq += 1;
        missing.push({ id: `${idPrefix}-${seq}`, label });
      }
    } else if (source === "OPTIMIZER_SUGGESTED") {
      text = stripQuotes(stripSuggestionLabel(body));
    } else {
      text = stripQuotes(body);
    }
    if (!text) continue;
    records.push(
      makeProvenanceRecord({
        text,
        source,
        evidence: source === "OPTIMIZER_SUGGESTED" || source === "UNKNOWN" ? [] : quotes,
        confidence: source === "USER_EXPLICIT" || source === "CONTEXT_EXPLICIT" ? "high" : "medium",
      }),
    );
  }
  return { records, missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown 四段标题回退(策略原始 formatNote 的写法)
// ─────────────────────────────────────────────────────────────────────────────

const MD_HEADS = {
  explicit: /^#{1,6}\s*明确要求/,
  context: /^#{1,6}\s*上下文已确认/,
  suggested: /^#{1,6}\s*优化器建议/,
  unknown: /^#{1,6}\s*待补充/,
  optimized: /^#{1,6}\s*优化后的/,
} as const;

type MdKey = keyof typeof MD_HEADS;

function parseMarkdownSections(text: string): Record<MdKey, string> & { found: boolean } {
  const buffers: Record<MdKey, string[]> = { explicit: [], context: [], suggested: [], unknown: [], optimized: [] };
  let current: MdKey | null = null;
  let found = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    let matched: MdKey | null = null;
    for (const key of Object.keys(MD_HEADS) as MdKey[]) {
      if (MD_HEADS[key].test(line)) {
        matched = key;
        break;
      }
    }
    if (matched) {
      current = matched;
      found = true;
      continue;
    }
    if (current === null) continue;
    // 优化稿内部可能包含 ### 子标题(策略要求的 15 段),一律保留为内容;
    // 其余来源段遇到下一个标题即结束。
    if (current !== "optimized" && /^#{1,6}\s/.test(line)) {
      current = null;
      continue;
    }
    buffers[current].push(rawLine);
  }
  return {
    explicit: buffers.explicit.join("\n"),
    context: buffers.context.join("\n"),
    suggested: buffers.suggested.join("\n"),
    unknown: buffers.unknown.join("\n"),
    optimized: buffers.optimized.join("\n"),
    found,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseCompileOutput
// ─────────────────────────────────────────────────────────────────────────────

/** 编译输出解析结果(段落 → ProvenanceRecord / optimized_prompt)。 */
export interface CompiledSections {
  diagnosis: string;
  explicit_requirements: ProvenanceRecord[];
  context_requirements: ProvenanceRecord[];
  suggested_requirements: ProvenanceRecord[];
  unknowns: ProvenanceRecord[];
  missing_constraints: MissingConstraint[];
  optimized_prompt: string;
  /** 是否解析到优化稿锚点(标记或 Markdown 标题);false = 整段降级。 */
  wellFormed: boolean;
}

/**
 * 解析编译器输出:优先标记协议,缺失时回退 Markdown 四段标题;
 * 两者都没有时整段文本作为 optimized_prompt(wellFormed=false)。
 */
export function parseCompileOutput(raw: string): CompiledSections {
  const text = stripThinkBlocks(String(raw ?? "")).trim();
  const positions = collectMarkerPositions(text);
  const hasMarkers = positions.OPTIMIZED !== undefined;

  if (hasMarkers) {
    const parsedExplicit = parseRecordLines(contentOf(text, positions, "EXPLICIT"), "USER_EXPLICIT", "mc-explicit");
    const parsedContext = parseRecordLines(contentOf(text, positions, "CONTEXT"), "CONTEXT_EXPLICIT", "mc-context");
    const parsedSuggested = parseRecordLines(contentOf(text, positions, "SUGGESTED"), "OPTIMIZER_SUGGESTED", "mc-suggested");
    const parsedUnknown = parseRecordLines(contentOf(text, positions, "UNKNOWN"), "UNKNOWN", "mc-unknown");
    return {
      diagnosis: contentOf(text, positions, "DIAGNOSIS"),
      explicit_requirements: parsedExplicit.records,
      context_requirements: parsedContext.records,
      suggested_requirements: parsedSuggested.records,
      unknowns: parsedUnknown.records,
      missing_constraints: [...parsedUnknown.missing],
      optimized_prompt: contentOf(text, positions, "OPTIMIZED"),
      wellFormed: true,
    };
  }

  const md = parseMarkdownSections(text);
  if (md.found && md.optimized.trim()) {
    const parsedExplicit = parseRecordLines(md.explicit, "USER_EXPLICIT", "mc-explicit");
    const parsedContext = parseRecordLines(md.context, "CONTEXT_EXPLICIT", "mc-context");
    const parsedSuggested = parseRecordLines(md.suggested, "OPTIMIZER_SUGGESTED", "mc-suggested");
    const parsedUnknown = parseRecordLines(md.unknown, "UNKNOWN", "mc-unknown");
    return {
      diagnosis: "",
      explicit_requirements: parsedExplicit.records,
      context_requirements: parsedContext.records,
      suggested_requirements: parsedSuggested.records,
      unknowns: parsedUnknown.records,
      missing_constraints: [...parsedUnknown.missing],
      optimized_prompt: md.optimized.trim(),
      wellFormed: true,
    };
  }

  return {
    diagnosis: "",
    explicit_requirements: [],
    context_requirements: [],
    suggested_requirements: [],
    unknowns: [],
    missing_constraints: [],
    optimized_prompt: text,
    wellFormed: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// system / user 组装
// ─────────────────────────────────────────────────────────────────────────────

export interface CompilePayloadOptions {
  language: "zh" | "en";
  mode: OptimizerMode;
  /** 上一轮优化结果(轻量记忆链;可选)。 */
  previous?: string;
  /**
   * 是否为 legacy general 兜底策略(由调用方按 registry 判定后传入)。
   * legacy 走 Y1X1n prompt.ts 的 template/intent 双模式,保证零回归;
   * 不用对象身份判定,避免独立 bundle 间模块副本导致的误判。
   */
  legacy?: boolean;
}

function renderPrevious(previous: string, language: "zh" | "en"): string {
  const clean = previous.trim();
  if (!clean) return "";
  return language === "en"
    ? `Here is the result of my previous optimization round (continuity reference: keep the decisions and phrasing I accepted; adjust only around what my new draft changes — unless my new draft explicitly overrules them):\n\n<previous-optimized>\n${clean}\n</previous-optimized>`
    : `以下是我上一轮优化得到的结果(延续参考:沿用其中我已接受的决策与表达,只围绕本轮草稿的变化点调整;本轮草稿明确推翻的除外):\n\n<previous-optimized>\n${clean}\n</previous-optimized>`;
}

/**
 * 组装 compile 阶段的 system + user。
 *
 * - legacy general 兜底:完全走 Y1X1n prompt.ts(mode / previous 语义与改造前一致);
 * - 其余策略:strategy.buildSystem + 机器可解析协议;strategy.buildUser + 记忆链。
 */
export function buildCompilePayload(
  strategy: PromptStrategy,
  vars: CompileVars,
  opts: CompilePayloadOptions,
): { system: string; user: string } {
  const turns = [...vars.context_turns];
  if (opts.legacy) {
    const strategyKind = turns.length ? "intent" : "template";
    return {
      system: buildSystemPrompt(opts.language, opts.mode, strategyKind),
      user: buildUserPayload(vars.raw_input, opts.language, turns, opts.previous),
    };
  }
  const system = `${strategy.buildSystem(opts.language)}\n\n${buildCompilerProtocol(opts.language)}`;
  const previous = opts.previous ? renderPrevious(opts.previous, opts.language) : "";
  const user = previous ? `${previous}\n\n${strategy.buildUser(vars)}` : strategy.buildUser(vars);
  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────────
// compilePrompt:10 步编排(步骤 1-9;步骤 10 由 finalizeCompile 完成)
//
// 纯函数:不调用 LLM、不感知 Host / UI。宿主拿到 { system, user } 后自行
// llm.stream,再把模型原文交给 finalizeCompile 得到最终 CompileResult。
// result 骨架刻意 `provenance_ok=false`(尚未 validate),绝不提前乐观置真。
// ─────────────────────────────────────────────────────────────────────────────

/** compilePrompt 入参(全部可确定性提供;零 Harness 依赖)。 */
export interface CompilePromptInput {
  /** 用户本轮原始输入(原样保留)。 */
  raw_input: string;
  /** 会话近期对话(时间升序);按共享预算确定性收敛。 */
  turns?: readonly ConversationTurn[];
  /** 确定性 workspace metadata;非法字段静默丢弃。 */
  workspace_metadata?: { cwd?: unknown; workspace_name?: unknown };
  /**
   * 手动类型覆盖:合法时直达 registry(函数级完全跳过分类);
   * 非法 / 缺省按 AUTO 处理(绝不因未知值绕过分类语义)。
   */
  promptType?: PromptType | string;
  /** AUTO 分类结果;缺省且无 override 时按 general 低置信兜底(不抛错)。 */
  classifier?: ClassifierResult | null;
  /** 策略注册表;缺省 = 七策略全量(未知类型 registry 内部回退 general)。 */
  registry?: StrategyRegistry;
  language?: "zh" | "en";
  mode?: OptimizerMode;
  /** 上一轮优化结果(轻量记忆链;可选)。 */
  previous?: string;
  /**
   * 是否 legacy general 编译路径:由调用方按 registry 判定后传入。
   * 不在本模块用对象身份判定,避免独立 bundle 间策略副本导致的误判。
   */
  legacy?: boolean;
}

/** compilePrompt 产出:宿主直接可用的编译载荷 + 待 validate 的结果骨架。 */
export interface CompilePlan {
  /** 实际采用的分类结果(override 时为确定性 manual 结果)。 */
  classifier: ClassifierResult;
  /** 由 registry 解析出的策略(类型/版本可审计)。 */
  strategy: PromptStrategy;
  /** 确定性归一化上下文。 */
  normalized: NormalizedContext;
  /** 注入策略的编译变量(missing_constraints 已去重)。 */
  vars: CompileVars;
  /** compile 阶段 system(策略 + 机器可解析四段协议)。 */
  system: string;
  /** compile 阶段 user(原始输入 + 上下文 + 缺口清单 + 记忆链)。 */
  user: string;
  /** 待 validate 的 CompileResult 骨架:`provenance_ok=false`、`optimized_prompt=""`。 */
  result: CompileResult;
  /** 是否走手动 override(为 true 时不存在任何分类调用)。 */
  overridden: boolean;
  legacy: boolean;
  /** 本次编排机械落实的步骤 id(见 COMPILE_PROMPT_STEPS)。 */
  steps: CompileStepId[];
}

/** classifier 的缺口字符串 → 稳定 id 的 MissingConstraint。 */
function classifierMissingConstraints(classifier: ClassifierResult): MissingConstraint[] {
  const raw = Array.isArray(classifier.missing_constraints) ? classifier.missing_constraints : [];
  return dedupeConstraints(
    raw.map((label, index) => ({ id: `mc-classifier-${index + 1}`, label: String(label ?? "") })),
  );
}

/**
 * 执行 Compiler 的确定性编排(PLAN-v1 §8 步骤 1-9):
 *
 *   1. Intent Preservation      —— raw_input 原样进入 vars(协议约束模型保真);
 *   2. Context Reconstruction   —— normalizeInput 保守截断(仅 user/assistant 合法轮次);
 *   3. Missing Information      —— classifier 缺口 → MissingConstraint(去重);
 *   4. Hidden Constraint        —— 仅当有证据,交由策略协议 + 守卫;
 *   5. Risk / Ambiguity         —— 写入 DIAGNOSIS 段(协议);
 *   6. Strategy Structuring     —— registry.get(type),未知类型回退 general;
 *   7. Output Contract          —— 策略 required_sections 进入 user 载荷;
 *   8. Anti-drift Constraints   —— 策略 system + 共享规则段(禁入集合 / 强断言纪律);
 *   9. Provenance Preservation  —— 四段协议(EXPLICIT/CONTEXT/SUGGESTED/UNKNOWN + OPTIMIZED/END)。
 *
 * 第 10 步(Final Compilation = 解析 + provenance 校验 + 守卫汇总)由
 * {@link finalizeCompile} 在模型输出到达后完成。
 */
export function compilePrompt(input: CompilePromptInput): CompilePlan {
  const language = input.language ?? "zh";
  const mode = input.mode ?? "full";
  const registry = input.registry ?? defaultStrategyRegistry;

  // 步骤 2:归一化(deterministic;raw_input 不截断,上下文按共享预算收敛)。
  const normalized = normalizeInput({
    raw_input: input.raw_input,
    turns: input.turns,
    workspace_metadata: input.workspace_metadata,
  });

  // 步骤 2 附:类型解析 —— override 直达 registry(函数级旁路分类);否则用 AUTO 结果。
  const override = parsePromptTypeInput(input.promptType);
  const overridden = override !== undefined;
  const classifier: ClassifierResult =
    override !== undefined
      ? manualClassifierResult(override)
      : input.classifier ?? fallbackClassifierResult("未提供分类结果,已回退通用模式;可手动选择任务类型");

  // 步骤 6:策略选择(未知类型由 registry 兜底 general)。
  const strategy = registry.get(classifier.prompt_type);
  const legacy = input.legacy ?? false;

  // 步骤 3:缺失信息检测(classifier 缺口 → [待补充:] 注入清单)。
  const missing = classifierMissingConstraints(classifier);

  const vars: CompileVars = {
    raw_input: normalized.raw_input,
    context_turns: [...normalized.bounded_turns],
    workspace_metadata: normalized.workspace_metadata,
    missing_constraints: missing,
  };

  // 步骤 7/8/9:输出契约 + 反漂移 + 四段来源协议(组装 system / user)。
  const payload = buildCompilePayload(strategy, vars, {
    language,
    mode,
    previous: input.previous,
    legacy,
  });

  // 待 validate 的骨架:provenance_ok 保持 false,optimized_prompt 留空。
  const result: CompileResult = {
    prompt_type: strategy.type,
    confidence_level: toConfidenceLevel(classifier.confidence_internal),
    diagnosis: "",
    explicit_requirements: [],
    context_requirements: [],
    suggested_requirements: [],
    unknowns: [],
    missing_constraints: missing,
    optimized_prompt: "",
    strategy_version: strategy.version,
    provenance_ok: false,
  };

  return {
    classifier,
    strategy,
    normalized,
    vars,
    system: payload.system,
    user: payload.user,
    result,
    overridden,
    legacy,
    steps: [...ORCHESTRATION_STEP_IDS],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// finalizeCompile:解析 + provenance 校验 + guards 汇总
// ─────────────────────────────────────────────────────────────────────────────

export interface FinalizeCompileOptions {
  rawInput: string;
  contextTurns: readonly ConversationTurn[];
  classifier: ClassifierResult;
  /** classifier 给出的缺口(编译期强制注入 [待补充: …])。 */
  missing: MissingConstraint[];
  mode: OptimizerMode;
  /** 是否为 legacy general 兜底策略(由调用方按 registry 判定后传入)。 */
  legacy?: boolean;
  /** 缺口占位符语言(缺省 zh);legacy 路径不注入。 */
  language?: "zh" | "en";
}

export interface CompiledOutcome {
  result: CompileResult;
  wellFormed: boolean;
  /** provenance error + 守卫问题(稳定 rule id,便于回归断言)。 */
  problems: ValidationProblem[];
}

function dedupeConstraints(items: MissingConstraint[]): MissingConstraint[] {
  const seen = new Set<string>();
  const out: MissingConstraint[] = [];
  for (const item of items) {
    const label = item.label.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ ...item, label });
  }
  return out;
}

/**
 * 机械注入缺口占位符:确保每条 missing constraint 在优化稿中以
 * `[待补充: …]`(zh)/ `[TODO: …]`(en)出现。
 *
 * - 优化稿已逐字包含该 label(例如策略自己的 Evidence Gaps 段)→ 不重复注入;
 * - 其余追加到文末「## 待补充（编译期自动补录）」清单,绝不改写既有内容;
 * - 纯函数:不发明 label 之外的任何信息,也不替用户做决定。
 */
export function injectMissingPlaceholders(
  prompt: string,
  missing: readonly MissingConstraint[],
  language: "zh" | "en" = "zh",
): { prompt: string; injected: MissingConstraint[] } {
  const base = String(prompt ?? "");
  const injected: MissingConstraint[] = [];
  const lines: string[] = [];
  for (const item of missing) {
    const label = String(item.label ?? "").trim();
    if (!label || base.includes(label)) continue;
    injected.push({ ...item, label });
    lines.push(`- ${todoPlaceholder(label, language)}`);
  }
  if (!lines.length) return { prompt: base, injected };
  const header =
    language === "en" ? "## TODOs (auto-appended by compiler)" : "## 待补充（编译期自动补录）";
  const separator = base.trim() ? "\n\n" : "";
  return { prompt: `${base.trimEnd()}${separator}${header}\n${lines.join("\n")}`, injected };
}

/**
 * 把模型原始输出编译为 `CompileResult`。
 *
 * - legacy general:沿用 parseOptimizerOutput(零回归),provenance 段为空、ok=true;
 * - 其余策略:parseCompileOutput → validateProvenance(机械比对)→ strategy.guards;
 *   provenance error 或任一守卫触发 → provenance_ok=false(UI 顶部警示);
 * - 非 legacy 路径还会把未在优化稿中出现的缺口机械注入为 `[待补充: …]`。
 */
export function finalizeCompile(
  strategy: PromptStrategy,
  rawText: string,
  opts: FinalizeCompileOptions,
): CompiledOutcome {
  const confidenceLevel = toConfidenceLevel(opts.classifier.confidence_internal);
  const language = opts.language ?? "zh";

  if (opts.legacy) {
    const parsed = parseOptimizerOutput(rawText, opts.mode);
    const result: CompileResult = {
      prompt_type: strategy.type,
      confidence_level: confidenceLevel,
      diagnosis: parsed.analysis,
      explicit_requirements: [],
      context_requirements: [],
      suggested_requirements: [],
      unknowns: [],
      missing_constraints: dedupeConstraints(opts.missing),
      optimized_prompt: parsed.optimized,
      strategy_version: strategy.version,
      provenance_ok: true,
    };
    return { result, wellFormed: parsed.wellFormed, problems: [] };
  }

  const sections = parseCompileOutput(rawText);
  const missing = dedupeConstraints([...opts.missing, ...sections.missing_constraints]);
  const result: CompileResult = {
    prompt_type: strategy.type,
    confidence_level: confidenceLevel,
    diagnosis: sections.diagnosis,
    explicit_requirements: sections.explicit_requirements,
    context_requirements: sections.context_requirements,
    suggested_requirements: sections.suggested_requirements,
    unknowns: sections.unknowns,
    missing_constraints: missing,
    optimized_prompt: sections.optimized_prompt,
    strategy_version: strategy.version,
    provenance_ok: true,
  };

  // 缺口机械注入:保证 missing_constraints 在交付稿中显式可见(不发明、不改写)。
  result.optimized_prompt = injectMissingPlaceholders(
    result.optimized_prompt,
    result.missing_constraints,
    language,
  ).prompt;

  const records = [...result.explicit_requirements, ...result.context_requirements];
  const provenance = validateProvenance(records, opts.rawInput, [...opts.contextTurns]);
  const problems: ValidationProblem[] = [...provenance.problems];

  const cleanOutput = stripThinkBlocks(String(rawText ?? ""));
  for (const guard of strategy.guards) {
    const detail = guard.check(cleanOutput, result, opts.rawInput);
    if (detail) problems.push({ severity: "error", rule: guard.id, detail });
  }

  result.provenance_ok = provenance.ok && !problems.some((problem) => problem.severity === "error");
  return { result, wellFormed: sections.wellFormed, problems };
}
