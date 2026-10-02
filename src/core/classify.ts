/**
 * Intent Classifier v0.1(AUTO 路径最小可用版,纯函数 + 一次宿主侧小调用)。
 *
 * 本模块只负责「分类提示词构建 + JSON 容错解析 + 失败回退」,不直接发请求:
 * 真正的 LLM 调用由 Host handler 编排(见 src/index.ts),便于纯函数单测与
 * override 旁路(手动指定类型时完全不调用分类)。
 *
 * 防误判三规则(PLAN-v1 §6,写进 system prompt + 测试):
 *   1. 以「当前输入」为判断对象;历史讨论仅供参考;
 *   2. 区分「当前请求」与「之前讨论过的内容」;
 *   3. 助手 / Agent 的建议不等于用户决定:evidence_quotes 只能引用用户自己的发言。
 *
 * 解析失败 / 低置信 → general + Low(见 fallbackClassifierResult)。
 *
 * 全部文案为本项目独立撰写;未复制任何 AGPL 项目源码 / 模板 / 测试。
 */
import type { ClassifierResult, ConversationTurn, PromptType } from "./types.js";
import { stripThinkBlocks } from "../prompt.js";

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

/** 类型守卫:任意值是否为合法 PromptType。 */
export function isPromptType(value: unknown): value is PromptType {
  return typeof value === "string" && (PROMPT_TYPES as readonly string[]).includes(value);
}

/** 分类语言(与策略文案一致,zh 优先)。 */
export type ClassifierLanguage = "zh" | "en";

// ─────────────────────────────────────────────────────────────────────────────
// system / user 提示词
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_ZH = `你是「提示词任务类型分类器」。只输出一个 JSON 对象,不要输出任何解释、Markdown 代码块或多余文字。

分类对象是「用户本轮输入」;历史讨论仅供参考。

七种任务类型:
- research:需要检索 / 调研 / 对比信息后回答(如「帮我研究…」「查一下…」「哪个方案更好」)
- planning:要制定计划 / 路线 / 任务拆解(如「帮我规划…」「分几步做…」)
- execution:要直接执行 / 改写 / 生成交付物(如「帮我写一段代码」「把这段翻译成英文」)
- diagnostic:要排查问题原因(如「为什么报错」「哪里出了问题」)
- review:要评审 / 检查已有产物(如「帮我 review 这段代码」「检查这份文档」)
- creative:创意写作 / 风格化产出(如「写一首诗」「起个标题」)
- general:无法判定或不属于以上任何类型

防误判规则:
1. 以当前输入为判断对象;历史讨论只辅助判断意图方向。
2. 区分「当前请求」与「之前讨论过的内容」:当前请求是用户最新一条消息的主谓。
3. 助手 / Agent 的建议不等于用户决定:evidence_quotes 只能引用用户自己的发言。

JSON 字段:
- prompt_type:上述七值之一
- confidence_internal:0..1 之间的小数
- missing_constraints:字符串数组,列出编译时需注入 [待补充: …] 的缺口
- rationale:一句话理由
- evidence_quotes:字符串数组,必须是「用户本轮输入」或历史「用户」消息中的逐字片段;不得引用助手发言`;

const SYSTEM_EN = `You are the "prompt task-type classifier". Output a single JSON object only — no explanation, no Markdown code fences, no extra text.

Classify "the user's current input"; earlier discussion is reference only.

Seven task types:
- research: needs searching / investigation / comparison (e.g. "research ...", "look up ...", "which option is better")
- planning: needs a plan / roadmap / task breakdown (e.g. "plan ...", "what are the steps")
- execution: needs direct execution / rewrite / a deliverable (e.g. "write a snippet", "translate this")
- diagnostic: needs troubleshooting of a cause (e.g. "why does it fail", "what went wrong")
- review: needs review / inspection of an existing artifact (e.g. "review this code", "check this doc")
- creative: creative writing / stylized output (e.g. "write a poem", "brainstorm titles")
- general: undecidable or none of the above

Anti-misclassification rules:
1. Judge the current input; history only helps infer the direction.
2. Separate "the current request" from "what was discussed earlier".
3. Assistant/agent suggestions are not user decisions: evidence_quotes may only quote the user.

JSON fields:
- prompt_type: one of the seven values above
- confidence_internal: a decimal in 0..1
- missing_constraints: array of strings to become [TODO: ...] placeholders
- rationale: one-sentence reason
- evidence_quotes: array of strings, each a verbatim fragment from the user's current input or a historical "user" message; never quote the assistant`;

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

// ─────────────────────────────────────────────────────────────────────────────
// 解析 + 回退
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * 从模型原始输出中解析 ClassifierResult。
 *
 * 容错策略(与 Y1X1n parse 风格一致):先剥离 `<think>` 思考块,再截取第一个
 * `{` 到最后一个 `}` 之间的 JSON;字段缺失/类型不符时补默认值;prompt_type 非法
 * 或 JSON 不可解析时返回 null(调用方回退 general)。
 */
export function parseClassifierResult(raw: string): ClassifierResult | null {
  const text = stripThinkBlocks(String(raw ?? ""));
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (!isPromptType(record.prompt_type)) return null;
  return {
    prompt_type: record.prompt_type,
    confidence_internal: clampConfidence(record.confidence_internal),
    missing_constraints: asStringArray(record.missing_constraints),
    rationale: typeof record.rationale === "string" ? record.rationale.trim() : "",
    evidence_quotes: asStringArray(record.evidence_quotes),
  };
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
