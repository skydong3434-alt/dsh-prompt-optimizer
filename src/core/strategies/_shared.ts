/**
 * 策略共享规则段(完整版 v0.2):保真原则 / 语言匹配 / [待补充:] 纪律 / 建议标注纪律 /
 * 禁入集合处理 + **cross-strategy invariants A·B**(docs/provenance.md §8)。
 *
 * 纯常量 + 纯字符串函数 + 守卫工厂,**零 import**(不触碰 Harness / UI / Node / DOM API),
 * 可独立测试与跨端复用。每个策略通过 `sharedRules(language)` 取回本语言的规则段,再拼进
 * 自己的 system prompt —— 规则只有一份,七种策略升级时不会各写各的。
 *
 * 与 PLAN-v1 §7「共享规则段」/ §5.4「防 suggested→explicit 强制点」/ §9「Validation 三层」
 * 对应;本模块导出的常量名与语义属于策略契约的一部分,不得随意改名。为保持零 import,
 * 守卫工厂的返回类型使用本地结构类型(与 core/types.ts 的 `Guard` 结构兼容)。
 *
 * 全部文案为本项目独立撰写;未复制任何 AGPL 项目(仅借鉴「共享规则段 + 守卫分层」思想)。
 */

/** 共享规则段版本(与各策略独立版本解耦;升级总纲不改策略)。 */
export const SHARED_RULES_VERSION = "0.2.0";

/** 策略文案语言:中文优先(zh),英文同构。 */
export type StrategyLanguage = "zh" | "en";

// ─────────────────────────────────────────────────────────────────────────────
// 占位符 / 标注前缀(常量,供各策略与测试共用,避免各处硬编码)
// ─────────────────────────────────────────────────────────────────────────────

/** 中文「待补充」标记前缀(与 PLAN-v1 §5 的 [待补充: …] 口径一致)。 */
export const TODO_PLACEHOLDER_PREFIX = "[待补充:";
/** 中文「待补充」标记后缀。 */
export const TODO_PLACEHOLDER_SUFFIX = "]";
/** 英文「待补充」标记前缀。 */
export const TODO_PLACEHOLDER_PREFIX_EN = "[TODO:";
/** 完整「待补充」占位符识别正则(与上面的前缀/后缀常量保持同源口径)。 */
export const TODO_PLACEHOLDER_RE = /\[(?:待补充|TODO)\s*:[^\]]*\]/;
/** quote 证据标记前缀:要求段的每条都应附 [quote: 用户原话]。 */
export const QUOTE_MARKER_PREFIX = "[quote:";
/** 建议段的固定前缀(中文):建议永不混入「要求」段。 */
export const SUGGESTION_LABEL_ZH = "建议(可忽略)";
/** 建议段的固定前缀(英文)。 */
export const SUGGESTION_LABEL_EN = "Suggestion (optional)";

/** 生成中文/英文「待补充」占位符,label 为空时退化为通用占位。 */
export function todoPlaceholder(
  label: string,
  language: StrategyLanguage = "zh",
): string {
  const clean = String(label ?? "").trim() || "待明确信息";
  return language === "en"
    ? `${TODO_PLACEHOLDER_PREFIX_EN} ${clean}]`
    : `${TODO_PLACEHOLDER_PREFIX} ${clean}${TODO_PLACEHOLDER_SUFFIX}`;
}

/** 生成 quote 证据标记;空 quote 不生成标记(调用方应先做证据校验)。 */
export function quoteMarker(quote: string): string {
  const clean = String(quote ?? "").trim();
  return clean ? `${QUOTE_MARKER_PREFIX} ${clean}]` : "";
}

/** 去掉文本开头的建议前缀(中英),用于「建议是否被升级」的字面比对。 */
export function stripSuggestionLabel(text: string): string {
  let value = String(text ?? "").trim();
  for (const label of [SUGGESTION_LABEL_ZH, SUGGESTION_LABEL_EN]) {
    if (value.startsWith(label)) {
      return value.slice(label.length).replace(/^[\s:：\-–—]+/, "").trim();
    }
  }
  return value.replace(/^(?:建议|suggestion)\s*[:：]\s*/i, "").trim();
}

/**
 * 去掉「建议」条目的触发理由子句(「触发理由: …」/「理由: …」/「原因: …」)。
 * P07-T03 实测:建议的触发理由常引用用户原话(如「符合『先小步、每步可回退』的要求」),
 * 若带着理由与 explicit 记录做子串比对,会误判「建议被升级为用户要求」。比对前先剥离。
 * 注:触发理由常以「（触发理由: …）」包裹,前导括号一并剥除。
 */
export function stripSuggestionReason(text: string): string {
  return String(text ?? "")
    .replace(/[；;。]?\s*[（(]?\s*(?:触发理由|理由|原因)\s*[:：].*$/s, "")
    .replace(/[（(]\s*$/, "")
    .trim();
}

/**
 * 去掉「建议」正文里以「」/『』包裹的用户原话引用片段。
 * P07-T03 实测:建议常引用用户词句(如「作为『每步可回退』的落地机制」),
 * 引用片段不是建议自己的断言,与 explicit 记录比对前先剥离,避免子串误判。
 */
export function stripSuggestionQuotedRefs(text: string): string {
  return String(text ?? "").replace(/[「『][^」』]*[」』]/g, "").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 保真自检清单(常量组;各策略 system prompt 引用同一份)
// ─────────────────────────────────────────────────────────────────────────────

/** 保真自检清单(中文):输出前逐项检查,任一项失败即为语义漂移。 */
export const FIDELITY_SELF_CHECK_ZH: readonly string[] = [
  "对象 / 主体是否原样保留",
  "动作与方向是否未改写、未颠倒",
  "数量 / 范围 / 时间是否未扩大也未缩小",
  "禁止项与禁入集合是否仍然生效",
  "术语 / 专有名词 / 型号 / 缩写是否未替换、未意译",
  "语气与受众是否与原文一致",
  "每条具体化是否都能回溯到用户输入或上下文已确认信息",
];

/** 保真自检清单(英文),与中文逐项同构。 */
export const FIDELITY_SELF_CHECK_EN: readonly string[] = [
  "subject / entity kept verbatim",
  "action and direction not rewritten or inverted",
  "quantities / scope / timing neither widened nor narrowed",
  "prohibitions and the do-not-enter set still enforced",
  "terms / proper nouns / model names / acronyms not replaced or localized",
  "tone and audience match the original",
  "every concretization traces back to user input or context-confirmed facts",
];

// ─────────────────────────────────────────────────────────────────────────────
// Cross-strategy invariants A·B(docs/provenance.md §8)
//   A. UNKNOWN ≠ BLOCKING
//   B. OPTIMIZER_SUGGESTED ≠ USER REQUIREMENT
// ─────────────────────────────────────────────────────────────────────────────

/** 不变式 A(中文):未知保持未知、非阻塞。 */
export const INVARIANT_UNKNOWN_NOT_BLOCKING_ZH =
  "UNKNOWN ≠ BLOCKING:未知信息保持未知且不阻塞;仅当缺失信息会实质改变当前任务方向或导致任务无法继续时,才允许写成需要用户补充(NEEDS_USER_INPUT);其余未知一律保留为 [待补充: …],不强制用户先回答,下游应在合理边界内继续。";

/** 不变式 A(英文)。 */
export const INVARIANT_UNKNOWN_NOT_BLOCKING_EN =
  "UNKNOWN ≠ BLOCKING: an unknown stays unknown and is not a blocker. Only when the missing information would materially change the task direction or halt progress may it become NEEDS_USER_INPUT; all other unknowns stay as [TODO: ...], never forcing the user to answer first, and downstream work continues within reasonable bounds.";

/** 不变式 B(中文):建议永远保持建议身份。 */
export const INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH =
  "OPTIMIZER_SUGGESTED ≠ USER REQUIREMENT:优化器建议永远保持建议身份,不得无痕升级为用户明确要求 / 必须满足的硬约束 / 已确认路线 / Human Decision;用户未明确采纳前恒为建议。";

/** 不变式 B(英文)。 */
export const INVARIANT_SUGGESTED_NOT_REQUIREMENT_EN =
  "OPTIMIZER_SUGGESTED ≠ USER REQUIREMENT: optimizer suggestions always keep their suggested status and must never be silently upgraded into explicit user requirements, hard constraints, confirmed decisions, or Human Decisions; until the user explicitly adopts them they remain suggestions.";

// ─────────────────────────────────────────────────────────────────────────────
// 语言检测(与 src/prompt.ts 的 estimateTokens 共用同一套 CJK 判定区间)
//   为保持本模块零 import,这里按相同区间独立实现,不复制任何第三方代码。
// ─────────────────────────────────────────────────────────────────────────────

/** CJK 表意文字区间(与 estimateTokens 完全一致:扩展 A / 基本区 / 兼容表意)。 */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/** 统计 CJK 表意文字数(与 estimateTokens 同一区间)。 */
export function countCjkChars(text: string): number {
  let cjk = 0;
  for (const ch of String(text ?? "")) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk += 1;
  }
  return cjk;
}

/** 统计拉丁字母数(仅 A-Za-z,数字/标点不计入语言判定)。 */
export function countLatinChars(text: string): number {
  let latin = 0;
  const source = String(text ?? "");
  for (const ch of source) {
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) latin += 1;
  }
  return latin;
}

/**
 * 与 src/prompt.ts `estimateTokens` 同一口径的粗略 token 估算
 * (CJK 约 1 字 1 token,其余 4 字符 1 token)。零 import 的同源实现。
 */
export function estimateTokenCount(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text ?? "")) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 判断文本是否以中文为主体(CJK 字数 ≥ 拉丁字母数;平局按中文优先)。
 * 用于语言匹配纪律:中文输入 → 中文输出,英文输入 → 英文输出。
 */
export function isChineseDominant(text: string): boolean {
  return countCjkChars(text) >= countLatinChars(text);
}

/** 语言判定(与 isChineseDominant 同源;语言匹配纪律的统一入口)。 */
export function detectLanguage(text: string): StrategyLanguage {
  return isChineseDominant(text) ? "zh" : "en";
}

// ─────────────────────────────────────────────────────────────────────────────
// 规则段文案(中文)
// ─────────────────────────────────────────────────────────────────────────────

const SHARED_FIDELITY_ZH = `# 保真原则(全程遵守)
- 先逐条列出输入已明确的信息(对象、动作、约束、范围、术语、数字、语气),与「你的推断」分开;推断只能影响措辞,绝不写成用户要求
- 已明确的对象、方向、数量、范围、禁止项、术语必须原样保留:不替换、不扩大、不缩小、不颠倒
- 任何具体化都必须能回溯到用户输入或上下文已确认信息;无依据的宁可不写,写成 [待补充: …]
- 输出前按以下清单逐项自检,任一项失败即为语义漂移,必须修正:
${FIDELITY_SELF_CHECK_ZH.map((item) => `  - ${item}`).join("\n")}`;

const SHARED_LANGUAGE_ZH = `# 语言匹配
- 输入以中文为主体 → 输出中文;以英文为主体 → 输出英文
- 保留原文的术语与专有名词(产品名 / 模型名 / 缩写):不改写、不意译、不臆造中译名`;

/**
 * 未决项处置纪律(Phase 2 正式契约,见 docs/phase2-contract.md)。
 *
 * 关键变化:`[待补充:]` 占位符**退役**。未决项按「谁有能力解决」分派:
 *   - 执行 Agent 正常工作就会拿到的信息 → 直接省略(不提示、不占位);
 *   - 必须在行动前调查、且影响正确执行 → 写成**动作式**指令("动手前先确认:…");
 *   - 调查结果决定后续分支 → 写成**条件式**指令("…:存在则…,否则…");
 *   - 只有用户能决定且不阻塞 → **不写进优化稿**(留给面板/后续澄清)。
 * 反膨胀:不得把缺口机械改写成「由执行方自行确认 XXX」堆成另一种模板。
 */
const SHARED_TODO_ZH = `# 未决项处置纪律(严格执行)
- **禁止输出 [待补充:] / [TODO:] 占位符**(本契约已退役该形式);也禁止写面向用户的追问(「请先回答/请你确认」)
- 执行 Agent 在正常工作中自然会拿到的信息(路径 / 目录 / 文件名 / 位置等) → **直接省略**,不要提示
- 必须在动手前调查、且会影响正确执行的事实(版本 / 接口 / 签名 / 配置 / 字段 / 表结构 / 依赖 / 环境 / 默认值 / 规范) → 写成**动作式**指令,如「动手前先确认:当前依赖版本与可用接口」
- 调查结果会决定走哪条路 → 写成**条件式**指令,如「是否已有 workflow:存在则优先复用/沿用,不存在则按新建路径处理」
- 只有用户本人能决定、且不影响本次执行的偏好 → **不要写进优化稿**,也不要问;执行方按通用做法推进即可
- 绝不把「缺什么」当成已确认信息继续推导,也不得用默认值悄悄替代`;

const SHARED_SUGGESTION_ZH = `# 建议标注纪律
- 优化器主动补充的内容必须独立成段,并以「${SUGGESTION_LABEL_ZH}」前缀标注
- 建议永不写入「明确要求 / 上下文已确认」段;不得用肯定语气把建议写成用户已决定
- 建议要说明触发理由;用户已明确表态时不得再提相反建议`;

const SHARED_DO_NOT_ENTER_ZH = `# 禁入集合处理
- 用户在历史中已否决、推翻或明确表示不考虑的方向,不得再次作为候选或建议提出
- 禁入集合只从「用户自己」的发言提取;助手 / Agent 的建议不算用户否决
- 无法确认某方向是否被否决时,处理为「动手前先确认:该方向是否仍被排除」,不得自行假定,也不得写成 [待补充:]`;

const SHARED_INVARIANTS_ZH = `# 跨策略不变式(所有策略共享,优先于任何策略措辞)
- ${INVARIANT_UNKNOWN_NOT_BLOCKING_ZH}
- ${INVARIANT_SUGGESTED_NOT_REQUIREMENT_ZH}`;

// ─────────────────────────────────────────────────────────────────────────────
// 规则段文案(英文)
// ─────────────────────────────────────────────────────────────────────────────

const SHARED_FIDELITY_EN = `# Fidelity rules (always apply)
- First list what the input explicitly states (subject, action, constraints, scope, terms, numbers, tone) and separate it from your guesses; guesses may shape wording only, never become a user requirement
- What is explicit (subject, direction, quantities, scope, prohibitions, terms) must survive intact: never replace, widen, narrow, or invert it
- Every concretization must trace back to the user input or to context-confirmed facts; when in doubt, leave it out and write [TODO: ...]
- Before output, self-check item by item; any failure is semantic drift and must be fixed:
${FIDELITY_SELF_CHECK_EN.map((item) => `  - ${item}`).join("\n")}`;

const SHARED_LANGUAGE_EN = `# Language matching
- Chinese-dominant input → Chinese output; English-dominant input → English output
- Keep the input's terms and proper nouns (products / models / acronyms): do not rename, translate, or invent localized names`;

/**
 * Open-item disposition discipline (Phase 2 contract; see docs/phase2-contract.md).
 * `[TODO:]` placeholders are RETIRED.
 */
const SHARED_TODO_EN = `# Open-item disposition discipline (strict)
- **Never emit [TODO:] / [待补充:] placeholders** (the form is retired), and never ask the user ("please answer / please confirm")
- Information the executor naturally obtains (paths / directories / filenames / locations) → **omit entirely**, do not mention it
- Facts that must be checked before acting and that change correct execution (versions / interfaces / signatures / config / fields / schema / dependencies / environment / defaults / specs) → write a **before-acting** instruction, e.g. "Verify before acting: current dependency versions and available interfaces"
- Facts whose outcome selects the path to take → write a **conditional** instruction, e.g. "whether a workflow already exists: if so reuse it, otherwise follow the create path"
- Preferences only the user can decide and that do not block this run → **do not put them in the compiled prompt** and do not ask
- Never treat "what is missing" as confirmed input, and never silently substitute a default`;

const SHARED_SUGGESTION_EN = `# Suggestion labeling discipline
- Anything the optimizer adds on its own must live in its own section, prefixed "${SUGGESTION_LABEL_EN}"
- Suggestions must never enter the "Explicit requirements / Context-confirmed" sections, and must not be phrased as a decision the user already made
- State why each suggestion is offered; never suggest the opposite of a position the user has already taken`;

const SHARED_DO_NOT_ENTER_EN = `# Do-not-enter set
- Directions the user already rejected, overruled, or excluded in history must not reappear as candidates or suggestions
- Only the user's own statements populate this set; assistant/agent messages are never user rejections
- When unsure whether a direction was excluded, write [TODO: is this direction still excluded?]; never assume`;

const SHARED_INVARIANTS_EN = `# Cross-strategy invariants (shared by all strategies; above any strategy wording)
- ${INVARIANT_UNKNOWN_NOT_BLOCKING_EN}
- ${INVARIANT_SUGGESTED_NOT_REQUIREMENT_EN}`;

// ─────────────────────────────────────────────────────────────────────────────
// 对外取用
// ─────────────────────────────────────────────────────────────────────────────

/** 共享规则段(中文),顺序:保真 → 语言 → 待补充 → 建议标注 → 禁入集合 → 跨策略不变式。 */
export const SHARED_RULES_ZH: readonly string[] = [
  SHARED_FIDELITY_ZH,
  SHARED_LANGUAGE_ZH,
  SHARED_TODO_ZH,
  SHARED_SUGGESTION_ZH,
  SHARED_DO_NOT_ENTER_ZH,
  SHARED_INVARIANTS_ZH,
];

/** 共享规则段(英文),顺序与中文版一致。 */
export const SHARED_RULES_EN: readonly string[] = [
  SHARED_FIDELITY_EN,
  SHARED_LANGUAGE_EN,
  SHARED_TODO_EN,
  SHARED_SUGGESTION_EN,
  SHARED_DO_NOT_ENTER_EN,
  SHARED_INVARIANTS_EN,
];

/** 按语言取回共享规则段(返回新数组,调用方可安全拼接)。 */
export function sharedRules(language: StrategyLanguage): string[] {
  return [...(language === "en" ? SHARED_RULES_EN : SHARED_RULES_ZH)];
}

// ─────────────────────────────────────────────────────────────────────────────
// 输出协议分段读取(标记段 + Markdown 四段标题;供守卫工厂共用)
// ─────────────────────────────────────────────────────────────────────────────

export type ProtocolSectionKey =
  | "none"
  | "diagnosis"
  | "explicit"
  | "context"
  | "suggested"
  | "unknown"
  | "optimized";

/** 协议标签 → 段落 key(与 core/compiler.ts 的 COMPILE_MARKERS 对齐)。 */
const MARKER_TO_SECTION: Record<string, ProtocolSectionKey> = {
  DIAGNOSIS: "diagnosis",
  EXPLICIT: "explicit",
  CONTEXT: "context",
  SUGGESTED: "suggested",
  UNKNOWN: "unknown",
  OPTIMIZED: "optimized",
  END: "none",
};

/** Markdown 四段标题 → 段落 key(与 compiler 的 Markdown 回退口径一致)。 */
const MD_SECTION_PATTERNS: readonly [RegExp, ProtocolSectionKey][] = [
  [/^#{1,6}\s*明确要求/, "explicit"],
  [/^#{1,6}\s*上下文已确认/, "context"],
  [/^#{1,6}\s*优化器建议/, "suggested"],
  [/^#{1,6}\s*待补充/, "unknown"],
];

const MARKER_LINE_RE = /^<<<\s*([A-Z_]+)\s*>>>$/;

/** 一行协议内容(已 trim)及其所属段落。 */
export interface ProtocolLine {
  line: string;
  section: ProtocolSectionKey;
}

/** 把编译输出按标记段 / Markdown 标题拆行,并标注每行所属段落(标题行本身不返回)。 */
export function readProtocolLines(output: string): ProtocolLine[] {
  const lines: ProtocolLine[] = [];
  let section: ProtocolSectionKey = "none";
  for (const rawLine of String(output ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const marker = MARKER_LINE_RE.exec(line);
    if (marker) {
      section = MARKER_TO_SECTION[marker[1]] ?? "none";
      continue;
    }
    const md = MD_SECTION_PATTERNS.find(([pattern]) => pattern.test(line));
    if (md) {
      section = md[1];
      continue;
    }
    lines.push({ line, section });
  }
  return lines;
}

/** 抽取「要求语境」文本(explicit + context 两段;建议 / 未知段不计入)。 */
export function extractRequirementText(output: string): string {
  return readProtocolLines(output)
    .filter(({ section }) => section === "explicit" || section === "context")
    .map(({ line }) => line)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 守卫工厂(纯函数;返回结构与本仓库 core/types.ts 的 `Guard` 兼容)
// ─────────────────────────────────────────────────────────────────────────────

/** 与 core/types.ts 的 ProvenanceRecord 结构兼容的最小子集(保持零 import)。 */
export interface SharedProvenanceRecordLike {
  text: string;
  source?: string;
  evidence?: string[];
}

/** 与 core/types.ts 的 CompileResult 结构兼容的最小子集(保持零 import)。 */
export interface SharedCompileResultLike {
  explicit_requirements?: SharedProvenanceRecordLike[];
  context_requirements?: SharedProvenanceRecordLike[];
  suggested_requirements?: SharedProvenanceRecordLike[];
  unknowns?: SharedProvenanceRecordLike[];
  optimized_prompt?: string;
}

/** 守卫结构(与 core/types.ts 的 Guard 同形)。 */
export interface SharedGuard {
  id: string;
  description: string;
  check: (
    output: string,
    result: SharedCompileResultLike,
    rawInput: string,
  ) => string | null;
}

/** 守卫工厂通用选项(id / description 可覆盖,默认值即共享契约)。 */
export interface SharedGuardOptions {
  id?: string;
  description?: string;
}

/** 强断言词:出现即须有逐字证据或不确定性标注,否则触发。 */
const STRONG_CLAIM_SOURCE =
  "已确认|已确定|已定论|已拍板|确认采用|确定采用|最终采用|最终方案|定为最终|选定为|不可行|无法实现|行不通|淘汰|放弃|排除";

/** 候选名(拉丁词)紧跟确认动词,如「MiniMax 已确认 / H3 采用」;捕获组 2 为确认动词。 */
const CANDIDATE_CONFIRMED_RE =
  /([A-Za-z][A-Za-z0-9.+-]{1,})\s*(已确认|确定|采用|选用|定为)/;

/** 已被降级 / 建议 / 候选 / 假设等标注:命中则视为该行不是「无证据结论」。 */
const DOWNGRADE_MARKER_RE =
  /待补充|待确认|待验证|待定|待复核|假设|候选|可能|建议|需研究|需验证|需核实|存疑|未经证实|无法确认|不排除|研究问题|不得|禁止|切勿|不要|勿|无需|不允许|不能(?:判定|认定|视为|看作|当作)|缺失|缺少|未说明|未提供|未给出|未提及|未明确|上下文已确认|已确认(?:约束|值|信息|事项|清单|口径|范围|条件|标准|前提|的|项|内容|事实|要求|需求|方案|路线|状态|配置|硬件|环境|参数|目标|假定|基础|材料|资料|细节|结论|结果)|若|如果|假如|倘若/;

/** 逐字证据标记(quote / 证据)。 */
const EVIDENCE_MARKER_RE = /\[quote:|\[证据:|【证据:/;

/** 结构性行:Markdown 标题 / 加粗小标题 / 四段协议标签(标签本身不是结论)。 */
const STRUCTURAL_LINE_RE =
  /^(?:#{1,6}\s|\*\*[^*]+\*\*\s*$|(?:明确要求|上下文已确认|优化器建议(?:\(可忽略\))?|待补充)\s*[:：]?\s*$)/;

/** 非断言段:诊断 / 建议 / 未知段本身是「元信息」,不参与强断言扫描。 */
const NON_CLAIM_SECTIONS: readonly ProtocolSectionKey[] = [
  "diagnosis",
  "suggested",
  "unknown",
];

/** 该行是否已被证据 / 不确定性 / 占位符 / 禁令措辞「保护」,从而不算无证据结论。 */
function isExemptLine(line: string): boolean {
  return (
    STRUCTURAL_LINE_RE.test(line) ||
    EVIDENCE_MARKER_RE.test(line) ||
    line.includes(TODO_PLACEHOLDER_PREFIX) ||
    line.includes(TODO_PLACEHOLDER_PREFIX_EN) ||
    DOWNGRADE_MARKER_RE.test(line)
  );
}

/** 该断言是否被用户原话或 explicit/context 记录的逐字证据支撑。 */
function evidenceBacks(
  claim: string,
  result: SharedCompileResultLike | undefined,
  rawInput: string,
): boolean {
  const clean = String(claim ?? "").trim();
  if (!clean) return false;
  if (String(rawInput ?? "").includes(clean)) return true;
  const records = [
    ...(result?.explicit_requirements ?? []),
    ...(result?.context_requirements ?? []),
  ];
  return records.some((record) =>
    (record?.evidence ?? []).some((quote) => {
      const value = String(quote ?? "").trim();
      return value.length > 0 && (value.includes(clean) || clean.includes(value));
    }),
  );
}

/** 两条记录文本是否指向同一条语义单元(去建议前缀、触发理由与原话引用后逐字比较;短串要求全等)。 */
function matchesRecordText(left: string, right: string): boolean {
  const a = stripSuggestionLabel(stripSuggestionReason(stripSuggestionQuotedRefs(left)));
  const b = stripSuggestionLabel(stripSuggestionReason(stripSuggestionQuotedRefs(right)));
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.includes(short);
}

/**
 * 守卫工厂 1:无证据强断言(已确认 / 确定 / 最终 / 采用 / 不可行 / 淘汰 …)。
 * 跳过诊断 / 建议 / 未知段;有逐字证据、占位符、候选或假设标注的行放行。
 */
export function forbidUnprovenStrongClaim(
  options: SharedGuardOptions & { extraPattern?: RegExp } = {},
): SharedGuard {
  const source = options.extraPattern
    ? `(?:${STRONG_CLAIM_SOURCE})|(?:${options.extraPattern.source})`
    : STRONG_CLAIM_SOURCE;
  const pattern = new RegExp(source);
  return {
    id: options.id ?? "shared-no-unproven-strong-claim",
    description:
      options.description ??
      "「已确认/确定/最终/采用/不可行/淘汰」类强断言必须有逐字证据或不确定性标注;否则触发",
    check(output, result, rawInput) {
      for (const { line, section } of readProtocolLines(output)) {
        if (NON_CLAIM_SECTIONS.includes(section)) continue;
        if (isExemptLine(line)) continue;
        const claim =
          line.match(pattern)?.[0] ??
          line.match(CANDIDATE_CONFIRMED_RE)?.[2] ??
          null;
        if (claim && !evidenceBacks(claim, result, rawInput)) {
          return `发现无证据强断言「${claim}」:只能写成假设 / 研究问题 / [待补充: …],不得作为结论`;
        }
      }
      return null;
    },
  };
}

/**
 * 守卫工厂 2:建议不得出现在 explicit/context 来源组或优化稿的「要求」段
 * (invariant B:OPTIMIZER_SUGGESTED ≠ USER REQUIREMENT)。
 */
export function suggestedNotInExplicit(
  options: SharedGuardOptions = {},
): SharedGuard {
  return {
    id: options.id ?? "shared-suggested-not-in-explicit",
    description:
      options.description ??
      `OPTIMIZER_SUGGESTED 条目不得出现在 explicit/context 来源组或优化稿要求段(必须带「${SUGGESTION_LABEL_ZH}」前缀独立成段)`,
    check(output, result) {
      const suggested = result?.suggested_requirements ?? [];
      if (!suggested.length) return null;

      const explicit = [
        ...(result?.explicit_requirements ?? []),
        ...(result?.context_requirements ?? []),
      ];
      for (const record of suggested) {
        const text = stripSuggestionLabel(stripSuggestionReason(stripSuggestionQuotedRefs(record?.text ?? "")));
        if (!text) continue;
        const hit = explicit.find((item) =>
          matchesRecordText(text, item?.text ?? ""),
        );
        if (hit) {
          const source = String(hit.source ?? "explicit");
          return `优化器建议「${text}」出现在「${source}」来源组:建议必须保持建议身份,不得升级为用户要求`;
        }
      }

      const requirementText = extractRequirementText(output);
      if (requirementText) {
        for (const record of suggested) {
          const text = stripSuggestionLabel(stripSuggestionReason(stripSuggestionQuotedRefs(record?.text ?? "")));
          if (text && requirementText.includes(text)) {
            return `优化器建议「${text}」出现在优化稿的要求段:建议必须独立成段并带「${SUGGESTION_LABEL_ZH}」前缀`;
          }
        }
      }
      return null;
    },
  };
}

/**
 * 守卫工厂 3:必出段落齐全性断言工厂(策略可传入自己的 required_sections 复用)。
 */
export function sectionPresence(
  sections: readonly string[],
  options: SharedGuardOptions = {},
): SharedGuard {
  const list = [...(sections ?? [])]
    .map((section) => String(section ?? "").trim())
    .filter(Boolean);
  return {
    id: options.id ?? "shared-required-sections",
    description:
      options.description ??
      `优化稿必须包含全部必出段落:${list.join(" / ")}`,
    check(output) {
      const text = String(output ?? "");
      const missing = list.filter((section) => !text.includes(section));
      if (!missing.length) return null;
      return `优化稿缺少必出段落:${missing.join(" / ")}`;
    },
  };
}

/** 阻塞式未知项的固定句式(出现即违反 invariant A)。 */
const BLOCKING_UNKNOWN_RE =
  /请先回答|请先确认|请先补充|请先提供|必须先回答|必须先确认|必须先补充|必须先提供|必须回答|必须确认|回答后才能|确认后才能|补充后才能|否则无法继续|无法继续|不回答就|不确认就|等你回答|等你确认|待你回答|待你确认/;

/** 真正会改变方向 / 导致无法继续的最小理由标注:命中则允许 NEEDS_USER_INPUT。 */
const DIRECTION_CHANGING_RE =
  /改变(?:任务)?方向|影响(?:任务)?方向|方向无法确定|否则任务方向|实质改变|无法确定(?:任务)?方向/;

/** 禁令 / 规则措辞:整行是在「禁止阻塞」而非制造阻塞,不得触发。 */
const PRESCRIPTION_RE = /不得|禁止|切勿|不允许|不要|无需/;

/**
 * 守卫工厂 4:未知项不得被写成阻塞问题(invariant A:UNKNOWN ≠ BLOCKING)。
 * 允许带方向改变理由的 NEEDS_USER_INPUT;占位符 [待补充:] 与禁令措辞放行。
 */
export function unknownNotBlocking(
  options: SharedGuardOptions = {},
): SharedGuard {
  return {
    id: options.id ?? "shared-unknown-not-blocking",
    description:
      options.description ??
      "未知项不得被写成阻塞性问题(请先回答/必须回答/无法继续);UNKNOWN ≠ BLOCKING",
    check(output) {
      for (const { line } of readProtocolLines(output)) {
        if (
          line.includes(TODO_PLACEHOLDER_PREFIX) ||
          line.includes(TODO_PLACEHOLDER_PREFIX_EN)
        ) {
          continue;
        }
        if (PRESCRIPTION_RE.test(line)) continue;
        if (DIRECTION_CHANGING_RE.test(line)) continue;
        const hit = line.match(BLOCKING_UNKNOWN_RE)?.[0];
        if (hit) {
          return `发现阻塞式未知项「${hit}」:UNKNOWN ≠ BLOCKING,未知项应保留为 [待补充: …] 并允许在合理边界内继续`;
        }
      }
      return null;
    },
  };
}

/** 建议升级为强约束 / 已确认路线的句式(invariant B)。 */
const UPGRADE_REQUIREMENT_RE =
  /必须|需保证|需要保证|务必|强制要求|硬约束|用户要求|用户希望|已经确认|已确认|已采用|最终方案/;

/**
 * 守卫工厂 5:建议文本不得以强约束句式出现在要求语境
 * (invariant B:OPTIMIZER_SUGGESTED ≠ USER REQUIREMENT)。
 */
export function suggestedNotUpgraded(
  options: SharedGuardOptions = {},
): SharedGuard {
  return {
    id: options.id ?? "shared-suggested-not-upgraded",
    description:
      options.description ??
      `建议条目不得以「必须/需保证/要求」等强约束句式出现在要求语境(建议身份声明:${SUGGESTION_LABEL_ZH})`,
    check(output, result) {
      const suggested = result?.suggested_requirements ?? [];
      if (!suggested.length) return null;
      for (const { line, section } of readProtocolLines(output)) {
        if (isExemptLine(line)) continue;
        if (
          section !== "explicit" &&
          section !== "context" &&
          section !== "optimized" &&
          section !== "none"
        ) {
          continue;
        }
        if (!UPGRADE_REQUIREMENT_RE.test(line)) continue;
        for (const record of suggested) {
          const text = stripSuggestionLabel(stripSuggestionReason(stripSuggestionQuotedRefs(record?.text ?? "")));
          if (text && line.includes(text)) {
            const marker = line.match(UPGRADE_REQUIREMENT_RE)?.[0] ?? "必须";
            return `建议「${text}」以强约束句式「${marker}」出现在要求语境:建议不得无痕升级为用户要求 / 硬约束 / 已确认路线`;
          }
        }
      }
      return null;
    },
  };
}
