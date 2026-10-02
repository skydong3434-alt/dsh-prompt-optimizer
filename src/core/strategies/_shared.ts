/**
 * 策略共享规则段(初版):保真原则 / 语言匹配 / [待补充:] 纪律 / 建议标注纪律 / 禁入集合处理。
 *
 * 纯常量 + 纯字符串函数,零依赖(不触碰 Harness / UI / Node / DOM API),可独立测试与
 * 跨端复用。每个策略通过 `sharedRules(language)` 取回本语言的规则段,再拼进自己的
 * system prompt —— 规则只有一份,七种策略升级时不会各写各的。
 *
 * 与 PLAN-v1 §7「共享规则段」对应;后续 P02-T01(shared-rules)可在此之上扩展,
 * 但已导出的常量名与语义属于策略契约的一部分,不得随意改名。
 *
 * 全部文案为本项目独立撰写;未复制任何 AGPL 项目(仅借鉴分层思想)。
 */

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

/**
 * 判断文本是否以中文为主体(CJK 字数 ≥ 拉丁字母数;平局按中文优先)。
 * 用于语言匹配纪律:中文输入 → 中文输出,英文输入 → 英文输出。
 */
export function isChineseDominant(text: string): boolean {
  const source = String(text ?? "");
  const cjk = (source.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (source.match(/[A-Za-z]/g) ?? []).length;
  return cjk >= latin;
}

// ─────────────────────────────────────────────────────────────────────────────
// 规则段文案(中文)
// ─────────────────────────────────────────────────────────────────────────────

const SHARED_FIDELITY_ZH = `# 保真原则(全程遵守)
- 先逐条列出输入已明确的信息(对象、动作、约束、范围、术语、数字、语气),与「你的推断」分开;推断只能影响措辞,绝不写成用户要求
- 已明确的对象、方向、数量、范围、禁止项、术语必须原样保留:不替换、不扩大、不缩小、不颠倒
- 任何具体化都必须能回溯到用户输入或上下文已确认信息;无依据的宁可不写,写成 [待补充: …]
- 输出前做一次保真自检:输入的每个原子信息都要在结果里有对应;找不到对应即为语义漂移,必须修正`

const SHARED_LANGUAGE_ZH = `# 语言匹配
- 输入以中文为主体 → 输出中文;以英文为主体 → 输出英文
- 保留原文的术语与专有名词(产品名 / 模型名 / 缩写):不改写、不意译、不臆造中译名`

const SHARED_TODO_ZH = `# [待补充:] 纪律
- 证据不足、用户未说明、无法从输入或上下文确认的关键信息,一律写成 [待补充: 具体缺什么],不得猜测填充
- [待补充:] 要写清「缺什么、为什么重要」,不写空泛占位
- 不得把 [待补充:] 当作已确认信息继续推导;不得用默认值悄悄替代缺口`

const SHARED_SUGGESTION_ZH = `# 建议标注纪律
- 优化器主动补充的内容必须独立成段,并以「建议(可忽略)」前缀标注
- 建议永不写入「明确要求 / 上下文已确认」段;不得用肯定语气把建议写成用户已决定
- 建议要说明触发理由;用户已明确表态时不得再提相反建议`

const SHARED_DO_NOT_ENTER_ZH = `# 禁入集合处理
- 用户在历史中已否决、推翻或明确表示不考虑的方向,不得再次作为候选或建议提出
- 禁入集合只从「用户自己」的发言提取;助手 / Agent 的建议不算用户否决
- 无法确认某方向是否被否决时,写入 [待补充: 该方向是否仍排除],不得自行假定`

// ─────────────────────────────────────────────────────────────────────────────
// 规则段文案(英文)
// ─────────────────────────────────────────────────────────────────────────────

const SHARED_FIDELITY_EN = `# Fidelity rules (always apply)
- First list what the input explicitly states (subject, action, constraints, scope, terms, numbers, tone) and separate it from your guesses; guesses may shape wording only, never become a user requirement
- What is explicit (subject, direction, quantities, scope, prohibitions, terms) must survive intact: never replace, widen, narrow, or invert it
- Every concretization must trace back to the user input or to context-confirmed facts; when in doubt, leave it out and write [TODO: ...]
- Do a fidelity self-check before output: every atomic element of the input must have a counterpart; a missing one is semantic drift and must be fixed`

const SHARED_LANGUAGE_EN = `# Language matching
- Chinese-dominant input → Chinese output; English-dominant input → English output
- Keep the input's terms and proper nouns (products / models / acronyms): do not rename, translate, or invent localized names`

const SHARED_TODO_EN = `# [TODO:] discipline
- Insufficient evidence, unspecified details, or anything unconfirmable from input/context must be written as [TODO: what exactly is missing]; never fill it by guessing
- A [TODO:] must say what is missing and why it matters, not be a vague placeholder
- Never treat a [TODO:] as confirmed input for further reasoning; never silently substitute a default`

const SHARED_SUGGESTION_EN = `# Suggestion labeling discipline
- Anything the optimizer adds on its own must live in its own section, prefixed "${SUGGESTION_LABEL_EN}"
- Suggestions must never enter the "Explicit requirements / Context-confirmed" sections, and must not be phrased as a decision the user already made
- State why each suggestion is offered; never suggest the opposite of a position the user has already taken`

const SHARED_DO_NOT_ENTER_EN = `# Do-not-enter set
- Directions the user already rejected, overruled, or excluded in history must not reappear as candidates or suggestions
- Only the user's own statements populate this set; assistant/agent messages are never user rejections
- When unsure whether a direction was excluded, write [TODO: is this direction still excluded?]; never assume`

// ─────────────────────────────────────────────────────────────────────────────
// 对外取用
// ─────────────────────────────────────────────────────────────────────────────

/** 共享规则段(中文),顺序:保真 → 语言 → 待补充 → 建议标注 → 禁入集合。 */
export const SHARED_RULES_ZH: readonly string[] = [
  SHARED_FIDELITY_ZH,
  SHARED_LANGUAGE_ZH,
  SHARED_TODO_ZH,
  SHARED_SUGGESTION_ZH,
  SHARED_DO_NOT_ENTER_ZH,
];

/** 共享规则段(英文),顺序与中文版一致。 */
export const SHARED_RULES_EN: readonly string[] = [
  SHARED_FIDELITY_EN,
  SHARED_LANGUAGE_EN,
  SHARED_TODO_EN,
  SHARED_SUGGESTION_EN,
  SHARED_DO_NOT_ENTER_EN,
];

/** 按语言取回共享规则段(返回新数组,调用方可安全拼接)。 */
export function sharedRules(language: StrategyLanguage): string[] {
  return [...(language === "en" ? SHARED_RULES_EN : SHARED_RULES_ZH)];
}
