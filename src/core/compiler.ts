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
  AnalysisResult,
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
import { defaultStrategyRegistry, isLegacyGeneral, type StrategyRegistry } from "./registry.js";
import { routeStrategy, type RouteDecision } from "./router.js";
import { injectResponsibilityNotes, planResponsibilities } from "./responsibilities.js";
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
${COMPILE_MARKERS.end}

# Compilation discipline (highest priority, applies to every section)
- The explicit/context sections may only hold requirements that have a verbatim [quote: ...] found in the user's current input or in historical "user" messages. Compiler instructions, gap-mapping notes, or system text are NOT user requirements: never copy them into explicit/context, and never invent a [quote: ...].
- Every unconfirmed / unspecified essential goes to [TODO: what is missing]; merge items of one topic into a single, most-complete entry (do not list the same unknown under several phrasings).
- Only write "confirmed / determined / adopted" when a verbatim quote backs it; otherwise use "to confirm" or [TODO: ...]. Do not restate the user's full raw input inside the optimized prompt: verbatim quoting is only for [quote: ...] markers in the source sections.
- Unknowns never block: never write "please answer first / must confirm / cannot continue / unable to break down". Output the framework first and ask for supplements via [TODO: ...].
- Phrase scope / prohibition statements object-first: "X stays as-is / X is out of scope"; never write "modify X / change X / delete X" even when negated ("don't modify X") — mechanical guards read verb+object as scope expansion. The same applies when describing trigger conditions inside Stop Conditions / Failure Handling.
- When restating disputed / opposing claims the user mentioned (e.g. "only CUDA works", "CUDA is the only way"), rephrase them neutrally (e.g. "claims CUDA is required"); never repeat such colloquial phrasings verbatim, and pick [quote: ...] fragments that avoid them.
- Keep the user's own wording for platform / environment / model names (e.g. "Mac M1 Pro"); do not normalize them to names like "macOS" / "OS".
- Never use past / ongoing execution wording ("started / implemented / committed / executed / completed"); do not even write meta-mentions such as "no 'executed' wording" — mechanical guards match the literal word. Write every action as a pending step.
- Every explicit requirement must remain traceable in the optimized prompt via at least one keyword (no need to repeat the full sentence); never drop a requirement silently.
- Item the user explicitly says is undecided ("not decided / haven't thought about it / leave it blank / you give me a hint") is unevidenced: put it in the UNKNOWN section as [TODO: ...], never as a settled requirement or conclusion.
- Facts from historical "assistant" messages are unconfirmed leads at most: mark them "to verify / [TODO:]"; never write them as "confirmed / determined / final". Only the user's own statements count as evidence.
- Keep conditional sentences explicitly conditional: use "if / whether / to verify" (若 / 如果 / 待验证) when a claim is conditional; never state "X is infeasible" flatly.
- Use "confirmed / determined" only as noun-phrase modifiers (e.g. "confirmed info / confirmed scope / determined dates") or inside [quote: ...] citations; never as a standalone predicate or sentence tail (e.g. "status confirmed", "all confirmed").
- For parameters the user did not provide (budget / cost / deadline / time / platform / model): write [TODO: ...] or "not provided by the user"; never write them as unmarked hard-constraint lines (e.g. "budget: ...").
- Never write "cannot break down / unable to split tasks / cannot get X so decomposition stalls" — mechanical invariants match these literally even inside if-clauses; write "decomposition input missing; output the framework first with [TODO: ...]".
- Never produce the literal combination "no case / precedent ... (infeasible / cannot / unable)" — including meta-mentions like "there is no such thing as 'judging infeasible for lack of cases'"; write the positive phrasing "missing cases are not a conclusion".
- In scope / prohibition statements, never place a verb (change / modify / refactor / delete) and a scope-object noun (e.g. "settings storage layer") in the same sentence — even joined by a semicolon / comma / slash (e.g. "change; settings storage layer"): mechanical guards read verb+object as scope expansion regardless of the separator. Use object-first phrasing only ("settings storage layer stays as-is / is out of scope"); verb sentences must not name the object.
- Do not write lead-in summary lines that restate a constraint topic on their own line (e.g. "deadline/time not settled" before the merged entry): each topic appears exactly once, in its own [TODO: ...] entry. Pick the minimal verbatim [quote: ...] fragment for each entry — quoting "deadline not settled" must not drag in "give me a time hint".
- In [TODO: ...] entries, do not use the noun phrase "user confirms / user confirmation" (e.g. "needs user confirmation") — write "needs confirmation / to confirm / awaiting user input" instead; the anti-drift guard reads "user ... confirm" + assistant-derived text as treating an assistant claim as user-confirmed.
- Non-source sections (diagnosis, titles, headings, structural prose) must never quote the user's words verbatim (no 「…」 / "…" wrapping user phrases): mention them by paraphrase only (e.g. "a time hint was requested"); verbatim quoting is allowed only inside [quote: ...] markers of explicit/context entries.
- The optimized title and Goal must keep the core verb of the user's request (e.g. "plan / break down / research"); do not rewrite it beyond recognition.`;
  }
  return `# 机器可解析输出协议(最终协议,优先级高于上文任何格式描述)
 为便于程序解析,请把上文要求的内容放入以下标记段;标记行单独成行,除标记段内容外不要输出任何其他文字:
${COMPILE_MARKERS.diagnosis}
需求诊断(目标清晰度 / 上下文完整性 / 约束边界 / 结构表达 / 输出规格 + 风险与歧义提示,可多行)
${COMPILE_MARKERS.explicit}
用户本轮明确要求,每行一条,格式「- 内容 [quote: 用户原话逐字片段]」;「内容」尽量直接用用户原话本身(与 quote 相同或最接近,不要改写为『禁止+动词+对象』等新句式);没有写「- (无)」
${COMPILE_MARKERS.context}
上下文里「用户」已确认的内容,每行一条,格式「- 内容 [quote: 上下文用户原话逐字片段]」;助手发言不算;没有写「- (无)」
${COMPILE_MARKERS.suggested}
优化器建议,每行一条,格式「- ${SUGGESTION_LABEL_ZH} 内容」;没有写「- (无)」
${COMPILE_MARKERS.unknown}
证据不足 / 待确认项,每行一条,格式「- [待补充: 缺什么、为什么重要]」;没有写「- (无)」
${COMPILE_MARKERS.optimized}
优化后的完整 Prompt(必须包含所选策略要求的全部段落,按顺序)
${COMPILE_MARKERS.end}

# 编译纪律(最高优先级,适用所有段落)
- 明确要求 / 上下文已确认 段只能收录能在用户本轮原始输入或上下文「用户」消息中逐字找到 quote 的内容。编译器指令、缺口落成说明、系统提示都不是用户要求:禁止写入 explicit/context,禁止编造 [quote: …]。
- 所有证据不足 / 用户未说明的关键信息一律写成 [待补充: 缺什么];同一主题(如预算/边界、工期/时间)只列一条、合并为信息最全的一条,不得用不同措辞各列一条。
- 「已确认 / 已确定 / 已采用」只在有逐字 quote 依据时使用;未确认事项用「待确认」或 [待补充: …]。
- 未知信息绝不阻塞:不要写「请先回答 / 必须先确认 / 无法继续 / 不能拆解 / 拒绝产出」等句式;先输出框架并用 [待补充: …] 请求补充。
- 不要在优化稿中整段复述用户原始输入;逐字引用只作为 [quote: …] 出现在来源段。
- 范围 / 禁止性表述一律对象前置:写「X 保持现状 / X 不在本次改动范围内」;不要写「修改 X / 改动 X / 删除 X」(即使带否定词「不要 / 不得 / 禁止」),Stop Conditions / Failure Handling 里描述触发条件时同样适用——机械守卫按 动词+对象 判定范围扩大。
- 转述用户提到的争议 / 对立说法时,不要原样重复其口语短语(如「只能 CUDA」「CUDA 是唯一」等);改写为中性转述(如「称必须依赖 CUDA」);quote 只选用不含此类短语的逐字片段。
- 平台 / 环境 / 模型等技术名词沿用用户原词(如「Mac M1 Pro」),不要改写成「macOS」「OS」等规范化名称。
- 不得使用「已开始 / 已实施 / 已提交 / 已执行 / 已完成」等动作已发生措辞,连「无『已执行』类措辞」这类元说明也不要写(机械守卫按字面命中);所有动作一律写成待执行的步骤。
- 每条明确要求必须在优化稿中可回追到至少一个关键词(不必整句复述);不得静默丢弃任何明确要求。
- 用户明确表示「未定 / 没想好 / 先空着 / 你给提示就行」的事项属于证据不足项:写入 UNKNOWN 段并落成 [待补充: …],不要当作已确定的要求或结论。
- 历史「助手」发言里的路线 / 决定信息顶多算待验证线索:标记「待验证 / [待补充: …]」,禁止写成「已确认 / 已确定 / 最终」等结论;只有用户自己的发言才算证据。
- 条件句必须显式带条件词(若 / 如果 / 待验证等);不得把条件句写成平铺结论(如「X 不可行」必须写成「若 X 不可行,则…」并保留条件词)。
- 「已确认 / 已确定」只用作名词短语修饰(如「已确认信息 / 已确认范围 / 已确定的日期」)或带 [quote:] 的引述;不要单独作谓语或句尾(如「状态已确认」「…均已确认」)。
- 用户未提供的预算 / 成本 / 工期 / 时间 / 平台 / 模型等参数:一律写成 [待补充: …] 或注明「用户未提供」,不要写成无标记的硬约束行(如「预算: …」)。
- 不要写「无法拆解 / 不能拆解 / 无法获取(导致)拆解受阻」等句式,即使出现在「若…」条件句中也会被机械 invariant 命中;改为「拆解输入暂缺,先以 [待补充: …] 占位并输出框架」。
- 不要在优化稿中出现「案例 / 先例…(不可行|无法|不能)」的字面组合,包括「不存在『因检索不到案例而判定不可行』」这类元表述;直接写「案例缺失不等于结论」的正面表述。
- 范围 / 禁止性表述里,动词(改动 / 修改 / 重构 / 删除)与范围对象名词(如 settings 存储层)即使以分号 / 顿号 / 逗号 / 斜杠并置(如「改动;settings 存储层」)也会被机械守卫判定为范围扩大;一律只写对象前置句式「X 保持现状 / X 不在本次改动范围」,动词句不出现对象名。
- 不要写约束主题的总起句(如「工期约束未定」「预算方面均未定」)单独成行:每个主题只在它自己的 [待补充: …] 条目中出现一次。quote 一律选用最小逐字子片段——引「工期约束也没想好」时不得顺带引「时间上」。
- [待补充: …] 条目不要使用「用户确认 / 需用户确认」这类名词短语(如「需用户确认):…」会被机械守卫按『用户…确认』+ 助手引文误判为把助手发言当用户已确认);改写作「需确认 / 待验证 / 需要用户补充」。
- 非来源段(诊断 / 标题 / 小标题 / 结构表达等)禁止逐字引述用户原话(不要用「…」/ "…" 引号包用户词句),提及用户词句一律转述(如『要求给出时间提示』);逐字引用只允许出现在 explicit/context 条目的 [quote: …] 标记内。
- 优化稿标题与 Goal 必须保留用户原话的核心动词(如「规划 / 拆解 / 研究」),不得整段改写后面目全非。`;
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
  // v2 Phase 2:未知项分组标题改为「未知项 / 未决项」;[待补充] 保留容忍(旧产物仍可解析)。
  unknown: /^#{1,6}\s*(?:未知项|未决项|待补充|Unknown items)/,
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
  /**
   * v2:分析结果。提供时由 Target-aware Router 选策略(目标维度生效);
   * 缺省 = 沿用 v1 的按意图取策略(向后兼容)。
   */
  analysis?: AnalysisResult;
  /** 显式指定策略(跳过 router;测试与宿主高级用法)。 */
  strategy?: PromptStrategy;
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
  /** v2:Target-aware 路由裁决(无 analysis 时为 null,走 v1 意图路由)。 */
  route: RouteDecision | null;
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

  // 步骤 3:缺失信息检测(classifier/分析缺口 → 去重的 MissingConstraint)。
  const missing = classifierMissingConstraints(classifier);

  // 步骤 6:v2 Target-aware 路由(有分析时按 目标/引擎/模态/意图 选契约;
  // 无分析时沿用 v1 的按意图取策略 —— 向后兼容)。手动覆盖优先级最高。
  const route = input.analysis
    ? routeStrategy(input.analysis, { manualType: override, registry, rawInput: input.raw_input })
    : null;
  const strategy = input.strategy ?? route?.strategy ?? registry.get(classifier.prompt_type);
  const legacy = input.legacy ?? isLegacyGeneral(strategy);

  // 步骤 3 附:未决项处置分派(Phase 2 契约;见 docs/phase2-contract.md)。
  // 策略侧只负责渲染,判定只发生在这里(单一真源)。
  const dispositionPlan = planResponsibilities({
    resolution: input.analysis?.missing_resolution,
    labels: missing,
  });

  const vars: CompileVars = {
    raw_input: normalized.raw_input,
    context_turns: [...normalized.bounded_turns],
    workspace_metadata: normalized.workspace_metadata,
    missing_constraints: missing,
    ...(input.analysis?.missing_resolution
      ? { missing_resolution: [...input.analysis.missing_resolution] }
      : {}),
    missing_dispositions: dispositionPlan.items,
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
    // v2:prompt_type 表达**工作意图**(由分析给出);contract 表达编译契约(strategy)。
    prompt_type: input.analysis?.prompt_type ?? strategy.type,
    ...(strategy.type !== (input.analysis?.prompt_type ?? strategy.type)
      ? { contract: strategy.type }
      : {}),
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
    route,
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
  /**
   * v2 分析结果(可选)。提供时会把意图 / 目标 / 分诊 / 台账 / 缺失解析
   * 附加到 CompileResult 上,供 UI 与校验器使用(旧调用方不传即行为不变)。
   */
  analysis?: AnalysisResult;
}

export interface CompiledOutcome {
  result: CompileResult;
  wellFormed: boolean;
  /** provenance error + 守卫问题(稳定 rule id,便于回归断言)。 */
  problems: ValidationProblem[];
}

/** 把 v2 分析结果附加到编译结果上(长度恒为加法;analysis 缺省时不做任何事)。 */
export function attachAnalysis(result: CompileResult, analysis: AnalysisResult | undefined): void {
  if (!analysis) return;
  result.intent = analysis.intent;
  result.target = analysis.target;
  result.triage = analysis.triage;
  result.ledger = analysis.ledger;
  result.missing_resolution = analysis.missing_resolution;
}

/**
 * KEEP 分诊的收尾(v2 §C4 的硬承诺):**不调用模型、不重写**,
 * `optimized_prompt` 逐字等于用户输入。
 *
 * 说明:`wellFormed` 恒为 true(输入原样通过);`provenance_ok` 不做三层校验
 * ——那三层校验的对象是「模型产出」,KEEP 路径没有模型产出,校验无对象。
 * 唯一机械不变量由 `assertKeepFidelity` 在宿主侧断言(output === rawInput)。
 */
export function finalizeKeepResult(
  strategy: PromptStrategy,
  opts: {
    rawInput: string;
    classifier: ClassifierResult;
    analysis?: AnalysisResult;
    missing?: MissingConstraint[];
  },
): CompiledOutcome {
  const result: CompileResult = {
    prompt_type: strategy.type,
    confidence_level: toConfidenceLevel(opts.classifier.confidence_internal),
    diagnosis:
      opts.analysis?.intent.rationale?.trim() ||
      "输入已是可用成稿(分诊 KEEP):原样保留,不改写。",
    explicit_requirements: [],
    context_requirements: [],
    suggested_requirements: [],
    unknowns: [],
    missing_constraints: [...(opts.missing ?? [])],
    optimized_prompt: opts.rawInput,
    strategy_version: strategy.version,
    provenance_ok: true,
  };
  attachAnalysis(result, opts.analysis);
  return { result, wellFormed: true, problems: [] };
}

/** KEEP 保真断言:输出必须与用户输入逐字一致(机械可验证,回归锚点)。 */
export function assertKeepFidelity(result: CompileResult, rawInput: string): boolean {
  return result.optimized_prompt === rawInput;
}

/** 缺口标签的「核心内容」：剥掉 [待补充: …] / [TODO: …] 包装与标点，用于语义去重比较。 */
function constraintCore(label: string): string {
  const withoutInner = String(label ?? "")
    .trim()
    .replace(/\[(?:待补充|TODO)\s*[:：]?\s*[^\]]*\]/gi, "")
    .replace(/^\[\s*(?:待补充|TODO)\s*[:：]\s*/, "")
    .replace(/\]\s*$/, "");
  return withoutInner.replace(/[\s，。；、,.;:：()（）「」【】《》[\]"'“”]/g, "").toLowerCase();
}

/** 语义同话题别名组（G-4 #2：预算/边界、工期/时间/排期各为同一话题，须合并为一条）。 */
const CONSTRAINT_TOPIC_GROUPS: ReadonlyArray<readonly string[]> = [
  ["预算", "预算边界", "预算方面", "经费", "成本", "费用", "budget"],
  ["工期", "工期约束", "排期", "时间", "时间上", "时间安排", "时间提示", "时间范围", "进度", "节奏", "deadline", "schedule"],
];

/** 核心内容命中的话题组下标（-1 = 不属于任何已知话题）。 */
function topicGroupOf(core: string): number {
  return CONSTRAINT_TOPIC_GROUPS.findIndex((group) =>
    group.some((alias) => core.includes(alias)),
  );
}

/**
 * 缺口去重（G-4 #2：语义重复的 UNKNOWN 合并）：
 *   1. 完全同 label（去包装后同核心）→ 去重；
 *   2. 语义等价：一方核心内容整体包含另一方，且较短方 ≥ 3 字 → 合并为信息更全的一条；
 *   3. 同话题组（预算 / 工期·时间）且双方核心均 ≥ 3 字 → 合并为信息更全的一条。
 * 只合并「包含 / 同话题」关系，不做同义改写；合并后保留长标签的全部信息，绝不发明新内容。
 * 注：模型可能把待补充文本写成「需注入[待补充:预算边界]」这类带内嵌占位符的标签，
 * 比较前先剥掉内嵌标记（否则「预算边界未定，需注入[待补充:预算边界]」与
 * 「预算边界未定，需注入预算边界」无法互相包含）。
 */
function dedupeConstraints(items: MissingConstraint[]): MissingConstraint[] {
  const out: MissingConstraint[] = [];
  const preferLabel = (existing: string, candidate: string): string =>
    constraintCore(candidate).length > constraintCore(existing).length ? candidate : existing;
  for (const item of items) {
    const label = String(item.label ?? "").trim();
    if (!label) continue;
    const core = constraintCore(label);
    let merged = false;
    for (let i = 0; i < out.length; i += 1) {
      const otherCore = constraintCore(out[i].label);
      const sameExact = core.length > 0 && core === otherCore;
      if (sameExact) {
        out[i] = { ...out[i], label: preferLabel(out[i].label, label) };
        merged = true;
        break;
      }
      if (core.length >= 3 && otherCore.length >= 3) {
        const [short, long] = core.length <= otherCore.length ? [core, otherCore] : [otherCore, core];
        if (long.includes(short)) {
          // 保留信息更全（更长）的一条；新条目更长时替换旧条目。
          out[i] = { ...out[i], label: preferLabel(out[i].label, label) };
          merged = true;
          break;
        }
        const group = topicGroupOf(core);
        if (group !== -1 && group === topicGroupOf(otherCore)) {
          out[i] = { ...out[i], label: preferLabel(out[i].label, label) };
          merged = true;
          break;
        }
      }
    }
    if (!merged) out.push({ ...item, label });
  }
  return out;
}

/** 渲染用的干净标签：剥掉内嵌的 [待补充: …] / [TODO: …] 标记（模型偶发写「需注入[待补充:预算]」类嵌套占位符）。 */
function cleanConstraintLabel(label: string): string {
  return String(label ?? "")
    .trim()
    .replace(/\[(?:待补充|TODO)\s*[:：]?\s*[^\]]*\]/gi, "")
    .replace(/^\[\s*(?:待补充|TODO)\s*[:：]\s*/, "")
    .replace(/\]\s*$/, "")
    .trim();
}

/**
 * @deprecated v2 Phase 2 起 **[待补充:] 已退役**(见 docs/phase2-contract.md):
 * 编译路径改用 `responsibilities.ts` 的 `injectResponsibilityNotes`(只注入
 * 「执行前须知」动作式与「分支条件」条件式两类,永不产出占位符)。
 * 本函数仅为旧单测与外部复用保留,**不得**再接回编译管线。
 *
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
    const label = cleanConstraintLabel(String(item.label ?? ""));
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
      prompt_type: opts.analysis?.prompt_type ?? strategy.type,
      ...(strategy.type !== (opts.analysis?.prompt_type ?? strategy.type)
        ? { contract: strategy.type }
        : {}),
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
    attachAnalysis(result, opts.analysis);
    return { result, wellFormed: parsed.wellFormed, problems: [] };
  }

  const sections = parseCompileOutput(rawText);
  const missing = dedupeConstraints([...opts.missing, ...sections.missing_constraints]);
  const result: CompileResult = {
    prompt_type: opts.analysis?.prompt_type ?? strategy.type,
    ...(strategy.type !== (opts.analysis?.prompt_type ?? strategy.type)
      ? { contract: strategy.type }
      : {}),
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
  attachAnalysis(result, opts.analysis);

  // 未决项机械注入(v2 Phase 2):只注入「执行前须知」(动作式)与「分支条件」
  // (条件式)两类;**绝不**产出 [待补充:] / [TODO:](见 docs/phase2-contract.md)。
  const dispositionPlan = planResponsibilities({
    resolution: opts.analysis?.missing_resolution,
    labels: result.missing_constraints,
  });
  result.optimized_prompt = injectResponsibilityNotes(
    result.optimized_prompt,
    dispositionPlan,
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
  // fast 模式的无标记容错(保留 v0.3.11 的产品行为):fast 是单段落模式,模型常直接
  // 输出整段结果而无标记 —— 此时整段即优化稿,不算「格式退化」。
  // general 迁入 v2 契约后这条容错必须由 v2 解析层承接(legacy 解析器已不可达)。
  const wellFormed = sections.wellFormed || (opts.mode === "fast" && !String(rawText ?? "").includes("<<<"));
  return { result, wellFormed, problems };
}
