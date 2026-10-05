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

/**
 * 机械改写已退役占位符(RC:实测模型仍会写 `[待补充: X]`,占比 3/25)。
 *
 * Phase 2 已把 `[待补充:]` 退役;只在校验层报错会让用户看到回流/硬错误。
 * 这里做**确定性**改写:占位符 → 执行前须知(动作式),即五类处置里的
 * EXECUTION_RESPONSIBILITY —— 语义等价(「这项未知 → 执行方动手前确认」),
 * 且不再出现退役形式。I-1 因此由构造保证,而不是靠重试。
 */
export function rewriteRetiredPlaceholders(text: string): string {
  const source = String(text ?? "");
  if (!RETIRED_PLACEHOLDER_RE.test(source)) return source;
  return source
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      const standalone = /^(?:[-*•]|\d+[.、)]\s*)?\s*\[(?:待补充|TODO)\s*[:：]\s*([^\]]*)\]\s*$/i.exec(line);
      if (standalone) {
        const detail = normalizeItemText(standalone[1] ?? "");
        return detail ? `- 动手前先确认:${detail}` : "- 动手前先确认:该项未决信息由执行方在动手前自行确认";
      }
      return raw.replace(
        /\[(?:待补充|TODO)\s*[:：]\s*([^\]]*)\]/gi,
        (_all, detail) => `由执行方动手前确认:${normalizeItemText(String(detail ?? "")) || "该项未决信息"}`,
      );
    })
    .join("\n");
}


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

/**
 * 条目文本归一化:剥掉句末标点与多余空白。
 *
 * 不这么做的话,「…并在两镜头中保持一致。」这类以句号结尾的条目会与
 * 条件式后缀拼成畸形句:`- X。:存在则优先复用/沿用,不存在则…`(RC 实测)。
 */
export function normalizeItemText(text: string): string {
  return String(text ?? "")
    .trim()
    .replace(/[。．.；;,:：,]+$/u, "")
    .trim();
}

/** 动作式指令(规则 2):写「做什么动作」,不写「你缺 XXX」。 */
export function executionLine(item: { text: string }, language: RenderLanguage = "zh"): string {
  const text = normalizeItemText(item.text);
  return language === "en" ? `- Verify before acting: ${text}` : `- 动手前先确认:${text}`;
}

/** 条件式指令(规则 3):写「按调查结果选路径」。 */
export function conditionalLine(item: { text: string }, language: RenderLanguage = "zh"): string {
  const text = normalizeItemText(item.text);
  return language === "en"
    ? `- ${text}: if it already exists, reuse it; otherwise follow the create/modify path`
    : `- ${text}:存在则优先复用/沿用,不存在则按新建路径处理`;
}

/**
 * 编辑分诊纪律(RC 根因修复:实测 PATCH 把 39 字的三行输入重写成 2600 字的
 * 完整诊断模板 —— 「局部修改」的语义被彻底违反)。
 *
 * KEEP 不调用模型;这里只处理 PATCH / RESTRUCTURE / REBUILD 三种「允许改写」的级别。
 */
export function renderTriageDiscipline(
  triage: string,
  language: RenderLanguage = "zh",
): string {
  const zh = language !== "en";
  if (triage === "PATCH") {
    return zh
      ? `# 编辑分诊纪律:PATCH(局部修改 —— 必须严格遵守)
- **保持原稿的结构与措辞**:原有标题、编号、条目顺序、专有名词一律不动
- 只补「原稿缺失且必须交代」的少量信息(通常 1–3 处),并修掉明显的表述缺陷
- **不得**新增章节 / 不得重排顺序 / 不得把口语改写成模板 / 不得扩写成另一个任务的提示词
- 长度应贴近原稿;明显变长就是越界`
      : `# Edit triage: PATCH (local edit — strictly enforced)
- **Keep the original structure and wording**: existing headings, numbering, item order and proper nouns stay as-is
- Only add the few genuinely missing items (usually 1–3) and fix obvious defects
- **Do not** add sections, reorder, templatize, or rewrite it into another task's prompt
- Length should stay close to the original; growing a lot is out of scope`;
  }
  if (triage === "RESTRUCTURE") {
    return zh
      ? `# 编辑分诊纪律:RESTRUCTURE(只重组,不加内容)
- 允许:重新排序、合并重复项、建立更清楚的结构与标题
- **不得**:新增用户没提出的目标 / 约束 / 验收标准;不得把信息量扩大
- 信息量应与原稿一致,只是更好读`
      : `# Edit triage: RESTRUCTURE (reorganize only)
- Allowed: reorder, merge duplicates, add clear structure and headings
- **Not allowed**: adding goals/constraints/acceptance the user never stated; do not expand the information
- Keep the information content identical, just easier to read`;
  }
  if (triage === "REBUILD") {
    return zh
      ? `# 编辑分诊纪律:REBUILD(可重新构建,但必须最小充分)
- 可以按信息责任重新组织,但**只写完成任务真正需要的信息**
- 不得为了套结构而生成空段落;不得把「可自查项」写成待填字段
- 目标是 **Minimum Sufficient Prompt**:删掉任何一句都会影响正确执行;再加就是重复或装饰`
      : `# Edit triage: REBUILD (rebuild, but minimum-sufficient)
- You may reorganize by information responsibility, but **only include what the task truly needs**
- Never emit empty sections just to fill a structure; never turn discoverable facts into blanks for the user
- Target the **Minimum Sufficient Prompt**: removing any line would hurt execution; adding more is repetition or decoration`;
  }
  return "";
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
