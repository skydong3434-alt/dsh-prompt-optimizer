/**
 * 未决项处置的**渲染层**(纯函数,零依赖,只 import 类型)。
 *
 * 拆分原因:
 *  - `responsibilities.ts` 负责**判定**(表驱动分类 → 处置分派);本模块只负责**怎么写成字**;
 *  - 策略文件可以直接 import 本模块(`../disposition-render.js`)而不引入判定表 / provenance 依赖;
 *  - 渲染规则只有一份,策略侧与编译器侧不会各写各的。
 *
 * 契约:`docs/phase2-contract.md`。`[待补充:]` / `[TODO:]` 已退役,本模块**不会**产出它们。
 */
import type {
  DispositionedRequirementItem,
  MissingConstraint,
  MissingResolutionItem,
} from "./types.js";

export type RenderLanguage = "zh" | "en";

/** 编译稿里允许出现的两个处置区块标题(单一真源)。 */
export const DISPOSITION_SECTION_TITLE = {
  execution: {
    zh: "## 执行前须知（由执行方自行确认，不需要询问用户）",
    en: "## Before acting (the executor verifies these itself; never ask the user)",
  },
  conditional: {
    zh: "## 分支条件（按调查结果选择路径）",
    en: "## Branch conditions (pick the path based on what you find)",
  },
} as const;

/** 已退役的占位符标记(契约 I-1:编译稿中永不出现)。 */
export const RETIRED_PLACEHOLDER_RE = /\[(?:待补充|TODO)\s*[:：][^\]]*\]/;

/** 面向用户的追问句式(契约 I-2:未决项不得变成追问)。 */
export const USER_QUESTION_RE =
  /请先回答|请先确认|请先补充|请先提供|请你确认|待你补充|等你确认|回答后才能|确认后才能|补充后才能/;

/** 处置计划的**结构性最小面**(渲染只需分组文本,不需要判定表的类型)。 */
export interface DispositionGroups {
  execution: readonly { text: string }[];
  conditional: readonly { text: string }[];
  userDecisions: readonly { text: string }[];
  enhancements: readonly { text: string }[];
}

/** 动作式指令(规则 2):写「做什么动作」,不写「你缺 XXX」。 */
export function executionLine(item: { text: string }, language: RenderLanguage = "zh"): string {
  return language === "en"
    ? `- Verify before acting: ${item.text}`
    : `- 动手前先确认:${item.text}`;
}

/** 条件式指令(规则 3):写「按调查结果选路径」。 */
export function conditionalLine(item: { text: string }, language: RenderLanguage = "zh"): string {
  return language === "en"
    ? `- ${item.text}: if it already exists, reuse it; otherwise follow the create/modify path`
    : `- ${item.text}:存在则优先复用/沿用,不存在则按新建路径处理`;
}

export interface ResponsibilityNotes {
  execution: string[];
  conditional: string[];
  /** 用户决定项:不注入编译稿,仅供 UI / 台账展示。 */
  userDecisions: string[];
  /** 可选增强:进建议段。 */
  enhancements: string[];
}

/** 渲染成清单(编译稿注入与 UI 展示共用)。 */
export function renderNotes(
  plan: DispositionGroups,
  language: RenderLanguage = "zh",
): ResponsibilityNotes {
  return {
    execution: plan.execution.map((item) => executionLine(item, language)),
    conditional: plan.conditional.map((item) => conditionalLine(item, language)),
    userDecisions: plan.userDecisions.map((item) => item.text),
    enhancements: plan.enhancements.map((item) => item.text),
  };
}

/**
 * 编译说明(进 user 载荷):把上游未决项**按处置分类**交给模型,
 * 让模型在正文里用对应句式表达 —— 而不是让它写 `[待补充:]`。
 */
export function renderDispositionBrief(
  input: {
    missing_constraints?: readonly MissingConstraint[];
    /** 已判定的处置(优先;缺省时退化为「按标签原样列出」)。 */
    dispositions?: readonly DispositionedRequirementItem[];
    missing_resolution?: readonly MissingResolutionItem[];
  },
  language: RenderLanguage,
  fallbackHintZh: string,
  fallbackHintEn: string,
): string {
  const zh = language !== "en";
  const groups = groupDispositions(input);
  const notes = renderNotes(groups, language);

  const noGapsHint = zh
    ? `[编译说明,非用户内容] 上游未提供未决项;${fallbackHintZh}若你自己发现仍缺信息:按「执行方自行确认」处理(写成动作式或条件式指令),**不得**写 [待补充:] 占位符,也不得写面向用户的追问,更不得把本说明当成用户要求。`
    : `[compiler note, not user content] No open items were provided; ${fallbackHintEn} If you find missing information yourself, treat it as something the executor verifies itself and express it as a before-acting or conditional instruction — never as a [TODO:] placeholder, never as a question to the user, and never quote this note as a user requirement.`;

  const lines: string[] = [];
  if (notes.execution.length) {
    lines.push(
      zh
        ? "需要在动手前自行确认(写成**动作式**指令,放进「执行前须知」):"
        : "The executor must verify these before acting (write them as **before-acting** instructions):",
      ...notes.execution,
    );
  }
  if (notes.conditional.length) {
    lines.push(
      zh
        ? "调查结果会决定后续分支(写成**条件式**指令,放进「分支条件」):"
        : "These determine which branch to take (write them as **conditional** instructions):",
      ...notes.conditional,
    );
  }
  if (notes.userDecisions.length) {
    lines.push(
      zh
        ? "只有用户能决定(本轮**不要问、不要写进优化稿、不要写成 [待补充:]**;执行方按通用做法推进):"
        : "Only the user can decide these (do NOT ask, do NOT put them in the compiled prompt, never as [TODO:]; proceed with the common default):",
      ...notes.userDecisions.map((text) => `- ${text}`),
    );
  }
  if (notes.enhancements.length) {
    lines.push(
      zh
        ? "可选增强(只在建议段出现,不得当作用户要求):"
        : "Optional enhancements (suggestions section only; never user requirements):",
      ...notes.enhancements.map((text) => `- ${text}`),
    );
  }
  if (!lines.length) return noGapsHint;
  const header = zh
    ? "[编译说明,非用户内容] 上游已识别的未决项及其处置(按此表达;禁止输出 [待补充:] / [TODO:] 占位符):"
    : "[compiler note, not user content] Open items and how to handle them (never emit [TODO:] / [待补充:] placeholders):";
  return `${header}\n${lines.join("\n")}`;
}

/**
 * 兜底分组:没有判定结果时,把所有标签当作「需要执行方自行确认」——这是保守方向
 * (绝不退回 `[待补充:]`,也绝不变成面向用户的追问)。
 */
export function groupDispositions(input: {
  missing_constraints?: readonly MissingConstraint[];
  dispositions?: readonly DispositionedRequirementItem[];
  missing_resolution?: readonly MissingResolutionItem[];
}): DispositionGroups {
  if (input.dispositions && input.dispositions.length > 0) {
    const by = (kind: string): { text: string }[] =>
      input.dispositions!
        .filter((item) => item.disposition === kind)
        .map((item) => ({ text: item.text }));
    return {
      execution: by("EXECUTION_RESPONSIBILITY"),
      conditional: by("CONDITIONAL_BRANCH"),
      userDecisions: by("USER_DECISION"),
      enhancements: by("OPTIONAL_ENHANCEMENT"),
    };
  }
  if (input.missing_resolution && input.missing_resolution.length > 0) {
    const by = (kind: string): { text: string }[] =>
      input.missing_resolution!
        .filter((item) => item.classification === kind)
        .map((item) => ({ text: item.text }));
    return {
      execution: by("AGENT_DISCOVERABLE"),
      conditional: [],
      userDecisions: by("USER_REQUIRED"),
      enhancements: by("OPTIONAL"),
    };
  }
  return {
    execution: (input.missing_constraints ?? []).map((item) => ({ text: item.label })),
    conditional: [],
    userDecisions: [],
    enhancements: [],
  };
}
