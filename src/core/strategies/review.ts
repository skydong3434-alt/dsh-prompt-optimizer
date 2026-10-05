/**
 * Review PromptStrategy v0.1 —— P02-T05。
 *
 * 把用户口语化的「审查诉求」(例如「看看这个项目现在还有什么问题?」)编译成一份
 * 基于 **原目标 / 需求** 的审查型 Prompt:先固定审查对象与原目标 / 需求,再给出
 * 评估标准与证据,逐条对照出偏离、缺失项与风险,最后只给不扩大范围的修正建议。
 *
 * 审查铁律(写进 system prompt + guards + 测试):
 *   1. 基于原目标审查 —— 审查必须逐条对照 Original Goal 与 Requirements,不得脱离原目标另立标准;
 *   2. 只审查、不另起项目 —— 「新方案 / 新建功能 / 重构整个」类发散语言必须对照原目标并标明偏离;
 *   3. 先证据后评价 —— 未给出可核查证据前不得断言「达标 / 未达标」;
 *   4. 偏离必须对应需求 —— 每个 Deviations 条目要指向具体 Original Goal / Requirements 条目;
 *   5. 修正建议不越权 —— Suggested Corrections 只能针对已确认偏离给最小修正,不得扩大原目标范围。
 *
 * 该模块是纯数据 + 纯函数:零 ctx.llm / UI / Host 依赖,独立 version,可独立测试与升级。
 * 复用 `_shared.ts` 的跨策略不变式 A(UNKNOWN ≠ BLOCKING)/ B(SUGGESTED ≠ USER REQUIREMENT)
 * 与「无证据强断言」守卫工厂。
 *
 * 全部文案为本项目独立撰写;设计思想(基于原目标审查 + 偏离对照 + 不发散)为通用工程实践,
 * 未复制任何 AGPL 项目的源码 / 模板文本 / 测试。
 */
import { renderDispositionBrief, renderTriageDiscipline } from "../disposition-render.js";
import type {
  CompileVars,
  Guard,
  OutputContract,
  PreservationRule,
  PromptStrategy,
  ProvenanceRule,
  SuggestionRule,
} from "../types.js";
import {
  SUGGESTION_LABEL_EN,
  SUGGESTION_LABEL_ZH,
  TODO_PLACEHOLDER_PREFIX,
  forbidUnprovenStrongClaim,
  isChineseDominant,
  quoteMarker,
  sectionPresence,
  sharedRules,
  suggestedNotInExplicit,
  suggestedNotUpgraded,
  todoPlaceholder,
  unknownNotBlocking,
  type StrategyLanguage,
} from "./_shared.js";

/** 本策略的独立版本(升级策略不改插件版本,见 PLAN-v1 §4⑤)。 */
export const REVIEW_STRATEGY_VERSION = "0.1.0";

/** 铁律 1 的固定表述:基于原目标审查。 */
export const REVIEW_BASED_ON_ORIGINAL_GOAL =
  "基于原目标审查:审查必须逐条对照 Original Goal 与 Requirements,不得脱离原目标另立标准";

/** 铁律 2 的固定表述:只审查、不另起项目。 */
export const REVIEW_NO_DIVERGENCE =
  "只审查、不另起项目:发散语言(新方案/新建功能/重构整个)必须对照原目标并标明偏离";

/** 铁律 3 的固定表述:先证据后评价。 */
export const REVIEW_EVIDENCE_BEFORE_VERDICT =
  "先证据后评价:未给出可核查证据前不得断言达标 / 未达标";

/** 铁律 4 的固定表述:偏离必须逐条对应需求。 */
export const REVIEW_DEVIATION_NEEDS_REQUIREMENT =
  "偏离必须逐条对应需求:每个 Deviations 条目要指向具体 Original Goal / Requirements 条目";

/** 铁律 5 的固定表述:修正建议不得扩大范围。 */
export const REVIEW_CORRECTIONS_SCOPED =
  "修正建议不越权:只针对已确认偏离给最小修正,不得扩大原目标范围";

/** 英文版铁律 2/3 的固定表述(与中文常量同义,供 en system 引用)。 */
const REVIEW_NO_DIVERGENCE_EN =
  "Review only, never start a new project: divergence language (a new plan / new feature / rebuild everything) must be contrasted against the original goal";
const REVIEW_EVIDENCE_BEFORE_VERDICT_EN =
  "Evidence before verdict: never assert met / not met before citable evidence is given";

// ─────────────────────────────────────────────────────────────────────────────
// 9 个必出段落(English 段落名 = required_sections 断言锚点;中英并列渲染)
// ─────────────────────────────────────────────────────────────────────────────

interface ReviewSectionSpec {
  /** 契约段落名(English,required_sections 使用;不得改名)。 */
  id: string;
  /** 中文标题。 */
  zh: string;
  /** 该段要写什么(中文)。 */
  guidanceZh: string;
  /** 该段要写什么(英文)。 */
  guidanceEn: string;
}

/** review 策略的 9 个必出段落,顺序即输出顺序(PLAN-v1 §7 review)。 */
export const REVIEW_SECTIONS: readonly ReviewSectionSpec[] = [
  {
    id: "Review Target",
    zh: "审查对象",
    guidanceZh:
      "要审查的项目 / 模块 / 交付物与版本或范围;必须能被唯一定位,不得笼统写「这个项目」",
    guidanceEn:
      "The project / module / deliverable to review, with version or scope; must be uniquely identifiable, never a vague 'this project'",
  },
  {
    id: "Original Goal",
    zh: "原目标",
    guidanceZh:
      "最初要达成的目标,逐字或忠实来自用户输入 / 上下文用户消息;不得替换成优化器自己的目标,缺失按未决项处置纪律处理(省略,或写成动作式/条件式指令)",
    guidanceEn:
      "The original goal, verbatim or faithful to user input / user context; never replaced by the optimizer's own goal, gaps → follow the open-item disposition discipline",
  },
  {
    id: "Requirements",
    zh: "需求",
    guidanceZh:
      "原目标下已明确的需求清单(逐条编号,如 R1/R2),每条可回溯到用户输入或上下文用户消息;不得新增未确认需求",
    guidanceEn:
      "The confirmed requirement list under the original goal (numbered R1/R2), each traceable to user input or user context; never add unconfirmed requirements",
  },
  {
    id: "Evaluation Criteria",
    zh: "评估标准",
    guidanceZh:
      "逐条判定需求是否满足的客观标准(通过 / 部分 / 未通过的依据);标准必须来自原目标与需求,不得临时发明",
    guidanceEn:
      "Objective criteria for judging each requirement (met / partial / unmet and why); criteria must derive from the original goal and requirements, never invented",
  },
  {
    id: "Evidence",
    zh: "证据",
    guidanceZh:
      "支撑每个判定的可核查证据(提交记录 / 测试输出 / 文件与行号 / 运行结果);证据不足逐条按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得编造",
    guidanceEn:
      "Citable evidence for each verdict (commits / test output / files and lines / run results); gaps → follow the open-item disposition discipline, never fabricated",
  },
  {
    id: "Deviations",
    zh: "偏离",
    guidanceZh:
      "原目标 / 需求与实际结果的逐条偏离,每条必须指向具体条目(如偏离 R2)并附证据;无证据时标注待验证",
    guidanceEn:
      "Item-by-item deviation of the actual result from the original goal / requirements, each linked to a specific item (e.g. deviates from R2) with evidence; mark unverified when evidence is thin",
  },
  {
    id: "Missing Items",
    zh: "缺失项",
    guidanceZh:
      "原目标要求但尚未完成 / 未覆盖的事项清单;缺失不等于阻塞,逐条保留为可跟踪项,不得据此停止审查",
    guidanceEn:
      "Items required by the original goal but unfinished / uncovered; missing is not blocking, keep them trackable and never stop the review over them",
  },
  {
    id: "Risks",
    zh: "风险",
    guidanceZh:
      "继续推进可能造成的风险与影响范围(回归 / 兼容 / 数据 / 进度);区分已发生与潜在风险,不得夸大为定论",
    guidanceEn:
      "Risks of proceeding and their blast radius (regression / compatibility / data / schedule); separate actual from potential, never overstate as settled",
  },
  {
    id: "Suggested Corrections",
    zh: "修正建议",
    guidanceZh:
      "只针对已确认偏离给最小修正(含验证 / 复测方式);不得借审查扩成新方案 / 新功能 / 重构整个项目,扩项一律标注偏离",
    guidanceEn:
      "Minimal corrections for confirmed deviations only (with verification / re-test); never turn the review into a new plan / new feature / full rebuild; any extension must be labeled as a deviation",
  },
];

/** required_sections:9 个 English 段落名(顺序即输出顺序;测试断言锚点)。 */
export const REVIEW_REQUIRED_SECTIONS: readonly string[] = REVIEW_SECTIONS.map(
  (section) => section.id,
);

/**
 * 强制段:任务契约点名 Original Goal 与 Requirements 不得省略 —— 审查一旦脱离
 * 原目标与需求就会发散,因此这两段缺失即 error。
 */
export const REVIEW_MANDATORY_SECTIONS: readonly string[] = [
  "Original Goal",
  "Requirements",
];

// ─────────────────────────────────────────────────────────────────────────────
// 系统提示词片段
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_ZH = `你是「Review 审查型 Prompt 编译器」。用户给你一段口语化的审查诉求(常见如「看看这个项目现在还有什么问题?」「对照最初的目标看看做偏了没有」),你要把它编译成一份可以直接照做的审查型 Prompt。
你不替用户重新规划项目、也不发明新需求;你只负责:固定审查对象与原目标 / 需求、给出评估标准与证据、逐条对照出偏离 / 缺失项 / 风险,最后给只针对已确认偏离的最小修正建议。`

const ROLE_EN = `You are the "Review prompt compiler". The user gives you a colloquial review request ("what is still wrong with this project?", "check it against the original goal"). You compile it into a review prompt that can be followed directly.
You do not replan the project or invent requirements; you only: pin down the review target and the original goal / requirements, give evaluation criteria and evidence, surface deviations / missing items / risks item by item, and finish with minimal corrections for confirmed deviations only.`

const DISCIPLINE_ZH = `# 审查纪律(铁律,优先于任何措辞偏好)
1. ${REVIEW_BASED_ON_ORIGINAL_GOAL}:先写 Original Goal 与 Requirements,其余段落都必须引用它们;不得用「最佳实践」或优化器偏好替换原目标。
2. ${REVIEW_NO_DIVERGENCE}:审查的输出顺序是 审查对象 → 原目标 → 需求 → 评估标准 → 证据 → 偏离 → 缺失项 → 风险 → 修正建议;任何「新方案 / 新建功能 / 重构整个」类内容都必须显式对照原目标并标明偏离,否则视为审查发散。
3. ${REVIEW_EVIDENCE_BEFORE_VERDICT}:Evaluation Criteria 只给判定方法,Evidence 给可核查证据;没有证据前最多写「待验证」,不得断言达标 / 未达标。
4. ${REVIEW_DEVIATION_NEEDS_REQUIREMENT}:每个 Deviations 条目必须写出对应的需求编号(如偏离 R2)与证据;找不到对应条目时先回到 Requirements 补齐,不得泛泛而谈。
5. ${REVIEW_CORRECTIONS_SCOPED}:Suggested Corrections 只能解决已确认偏离,并写清修正后如何验证 / 复测;不得顺手增加新功能或重排项目路线。
6. 证据优先于评价:测试是否通过 / 需求是否满足都必须落到可复现的证据;证据不足按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得编造提交、测试或运行结果。
7. 原目标不可代答:用户没有说清原目标 / 需求时保持缺失状态并按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得替用户补一个「合理目标」。
8. 缺失不等于阻塞:Missing Items 只作为待办跟踪,不得写成「必须停下来」;UNKNOWN ≠ BLOCKING。
9. UNKNOWN ≠ BLOCKING:未知信息保持未知,不阻塞审查推进;不代用户拍板。`

const DISCIPLINE_EN = `# Review discipline (iron rules, above any style preference)
1. Review against the original goal: write Original Goal and Requirements first; every other section must reference them. Never replace them with "best practice" or the optimizer's preference.
2. ${REVIEW_NO_DIVERGENCE_EN}. Output order: Review Target → Original Goal → Requirements → Evaluation Criteria → Evidence → Deviations → Missing Items → Risks → Suggested Corrections. Any "new plan / new feature / rebuild everything" content must be explicitly contrasted with the original goal and labeled a deviation.
3. ${REVIEW_EVIDENCE_BEFORE_VERDICT_EN}. Evaluation Criteria give the decision method; Evidence gives citable proof; before evidence, write "unverified" at most, never met / not met.
4. Every Deviations item must name the requirement it violates (e.g. deviates from R2) plus evidence; if none matches, go back and fix Requirements first, never hand-wave.
5. Suggested Corrections address confirmed deviations only, each with verification / re-test steps; never add features or reroute the plan along the way.
6. Evidence before assessment: whether tests pass or requirements are met must rest on reproducible evidence; gaps → follow the open-item disposition discipline, never fabricate commits, tests or run results.
7. Never answer for the original goal: when the user has not stated it, keep it missing and follow the open-item disposition discipline (omit, or write a before-acting/conditional instruction), never substitute a "reasonable goal".
8. Missing is not blocking: Missing Items are trackable to-dos, never "must stop now"; UNKNOWN ≠ BLOCKING.
9. UNKNOWN ≠ BLOCKING: unknowns stay unknown and do not block the review; never decide for the user.`

const PROVENANCE_ZH = `# 来源标注(四段协议,严格遵守)
- 明确要求:来自用户本轮输入的,每条必须附 ${quoteMarker("用户原话逐字片段")} 形式的逐字 quote
- 上下文已确认:仅限历史中「用户」消息,同样附 quote;助手 / Agent 的发言一律不能作为用户意图证据
- ${SUGGESTION_LABEL_ZH}:优化器主动补充的评估标准 / 取证方式 / 验证手段,独立成段并带此前缀,永不写入要求段
- 未知项:证据不足、用户未说明的关键信息(如原目标量化口径 / 验收标准),逐条写出缺什么
用户明确否决过的方向属于禁入集合,不得再次作为修正建议提出。`

const PROVENANCE_EN = `# Provenance (four-section protocol, strictly)
- Explicit requirements: anything from the user's current input must carry a verbatim ${quoteMarker("verbatim user fragment")} quote
- Context-confirmed: only from "user" messages in history, each with a quote; assistant/agent messages are never evidence of user intent
- ${SUGGESTION_LABEL_EN}: evaluation criteria / evidence-gathering / verification methods the optimizer adds, in their own section with this prefix; never in the requirements sections
- Unknown items: unspecified or unevidenced essentials (quantified original goal, acceptance bar), each stating what is missing
Directions the user already rejected form a do-not-enter set and must not reappear as corrections.`

/** 渲染 9 段清单(中英并列,English id 恒出现 → required_sections 断言可跨语言命中)。 */
function renderSections(language: StrategyLanguage): string {
  const zh = language !== "en";
  const title = zh
    ? "# 信息责任(优化后的 Review Prompt 必须逐项交代清楚;标题可自拟、顺序可调整,责任不得遗漏)"
    : "# Information responsibilities (the optimized Review Prompt must cover each one; titles and order are yours, nothing may be omitted)";
  const lines = REVIEW_SECTIONS.map((section) =>
    zh
      ? `- ${section.id}（${section.zh}）: ${section.guidanceZh}`
      : `- ${section.id}: ${section.guidanceEn}`,
  );
  return [title, ...lines].join("\n");
}

function buildFormatNote(language: StrategyLanguage): string {
  const zh = language !== "en";
  const heading = zh ? "# 输出格式(严格遵守)" : "# Output format (strictly follow)";
  const provenance = zh
    ? `先输出来源段(明确要求 / 上下文已确认 / ${SUGGESTION_LABEL_ZH} / 未知项),再输出优化后的 Review Prompt。
- 明确要求:每条附 ${quoteMarker("用户原话")}
- 上下文已确认:仅用「用户」消息,每条附 ${quoteMarker("原话")}
- ${SUGGESTION_LABEL_ZH}:独立成段
- 未知项:证据不足项,写清缺什么`
    : `First the provenance block (Explicit requirements / Context-confirmed / ${SUGGESTION_LABEL_EN} / Unknown items), then the optimized Review Prompt.
- Explicit requirements: each with ${quoteMarker("verbatim user fragment")}
- Context-confirmed: user messages only, each with a quote
- ${SUGGESTION_LABEL_EN}: its own section
- Unknown items: unevidenced items, stating what is missing`;
  const sections = REVIEW_SECTIONS.map((section) => section.id).join(" / ");
  const body = zh
    ? `优化后的 Review Prompt 必须逐项交代以下 9 项信息责任(id 作为核对锚点,顺序可调整):${sections}。Original Goal 与 Requirements 不得省略;任何发散项都必须对照原目标并标明偏离;Suggested Corrections 只针对已确认偏离。除输出格式规定的内容外,不要输出多余解释。`
    : `The optimized Review Prompt must cover these 9 information responsibilities (each id is a check anchor; order may vary): ${sections}. Original Goal and Requirements must not be omitted; any divergence must be contrasted against the original goal and labeled a deviation; Suggested Corrections address confirmed deviations only. Output nothing beyond the specified format.`;
  return [heading, provenance, body].join("\n");
}

/** review 策略的 system prompt(双语同构,zh 优先)。 */
export function buildReviewSystem(language: StrategyLanguage): string {
  const zh = language !== "en";
  const parts: string[] = [zh ? ROLE_ZH : ROLE_EN, zh ? DISCIPLINE_ZH : DISCIPLINE_EN];
  parts.push(renderSections(language));
  parts.push(zh ? PROVENANCE_ZH : PROVENANCE_EN);
  parts.push(...sharedRules(language));
  parts.push(buildFormatNote(language));
  return parts.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// user 载荷(注入 raw_input / context / metadata / 缺口 / LLM 派生字段)
// ─────────────────────────────────────────────────────────────────────────────

function renderContext(
  turns: CompileVars["context_turns"],
  language: StrategyLanguage,
): string {
  if (!turns?.length) return "";
  const zh = language !== "en";
  const lines = turns.map((turn) => {
    const role = turn.role === "user" ? (zh ? "用户" : "User") : zh ? "助手" : "Assistant";
    return `${role}: ${turn.text}`;
  });
  const header = zh
    ? "以下是当前会话的近期对话(仅供参考;只有「用户」的发言能作为用户意图证据,助手发言不算):"
    : "Recent conversation of the session (reference only; only 'user' messages count as user intent, assistant messages do not):";
  return `${header}\n\n<conversation-context>\n${lines.join("\n")}\n</conversation-context>`;
}

function renderWorkspace(
  metadata: CompileVars["workspace_metadata"],
  language: StrategyLanguage,
): string {
  if (!metadata || (!metadata.cwd && !metadata.workspace_name)) return "";
  const zh = language !== "en";
  const bits: string[] = [];
  if (metadata.workspace_name) {
    bits.push(`${zh ? "workspace 名称" : "workspace name"}: ${metadata.workspace_name}`);
  }
  if (metadata.cwd) bits.push(`${zh ? "工作目录" : "cwd"}: ${metadata.cwd}`);
  const header = zh
    ? "确定性 workspace 事实(可作为 WORKSPACE_FACT 引用,不要扩写):"
    : "Deterministic workspace facts (may be cited as WORKSPACE_FACT; do not extrapolate):";
  return `${header}\n${bits.join("\n")}`;
}

function renderMissing(
  vars: CompileVars,
  language: StrategyLanguage,
): string {
  // v2 Phase 2 处置契约 + Phase 4/RC 编辑分诊纪律(RC:实测 PATCH 被重写成模板)
  const parts = [
    renderDispositionBrief(
      {
        missing_constraints: vars.missing_constraints,
        dispositions: vars.missing_dispositions,
        missing_resolution: vars.missing_resolution,
      },
      language,
      "请在编译中自行识别缺口(尤其原目标量化口径 / 验收标准 / 证据来源)。",
      "identify gaps during compilation (especially the quantified original goal / acceptance bar / evidence sources).",
    ),
  ];
  if (vars.triage) {
    const discipline = renderTriageDiscipline(vars.triage, language);
    if (discipline) parts.push(discipline);
  }
  return parts.join("\n\n");
}

function renderLlmDerived(
  derived: CompileVars["llm_derived"],
  language: StrategyLanguage,
): string {
  if (!derived) return "";
  const zh = language !== "en";
  const groups: string[] = [];
  const push = (
    labelZh: string,
    labelEn: string,
    records: { text: string; evidence: string[] }[],
  ) => {
    if (!records?.length) return;
    const lines = records.map((record) => {
      const quotes = (record.evidence ?? []).map((quote) => quoteMarker(quote)).filter(Boolean);
      return `- ${record.text}${quotes.length ? ` ${quotes.join(" ")}` : ""}`;
    });
    groups.push(`${zh ? labelZh : labelEn}:\n${lines.join("\n")}`);
  };
  push("原目标", "Original goals", derived.user_goals);
  push("用户已否决的方向(禁入集合)", "Rejected directions (do-not-enter)", derived.rejected_directions);
  push("用户已知约束", "Known constraints", derived.known_constraints);
  if (!groups.length) return "";
  const header = zh
    ? "上游 LLM 已提炼的字段(仅作参考;没有逐字证据的一律当假设处理,不得当作已确认证据):"
    : "Fields distilled upstream (reference only; anything without a verbatim quote is a hypothesis, not confirmed evidence):";
  return `${header}\n${groups.join("\n")}`;
}

/** review 策略的 user 载荷;语言由 raw_input 主体语言决定(zh 优先)。 */
export function buildReviewUser(vars: CompileVars): string {
  const language: StrategyLanguage = isChineseDominant(vars.raw_input) ? "zh" : "en";
  const zh = language !== "en";
  const sections: string[] = [];

  const context = renderContext(vars.context_turns, language);
  if (context) sections.push(context);
  const workspace = renderWorkspace(vars.workspace_metadata, language);
  if (workspace) sections.push(workspace);
  const derived = renderLlmDerived(vars.llm_derived, language);
  if (derived) sections.push(derived);
  sections.push(renderMissing(vars, language));
  sections.push(renderSections(language));

  sections.push(
    zh
      ? `以下是我的审查诉求(你唯一需要编译的对象;先对照原目标与需求,再逐条给证据与偏离,不得另起新项目):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`
      : `Here is my review request (the only thing to compile; contrast the original goal and requirements first, then give evidence and deviations item by item, never start a new project):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`,
  );
  return sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 发散语言识别(供「发散必须先对照原目标」守卫使用)
// ─────────────────────────────────────────────────────────────────────────────

/** 发散语言:把审查扩成新方案 / 新功能 / 整体重构的说法(中英同构)。 */
const DIVERGENCE_RE =
  /新方案|新建功能|新功能|新建项目|新项目|另起(?:项目|炉灶)|重构整个|整体重构|重新设计整个|推翻重来|换(?:一个)?方向|从零(?:开始|重写)|new project|new feature|rebuild (?:the )?(?:whole|entire)|refactor (?:the )?(?:whole|entire)|rewrite (?:the )?(?:whole|entire)|start over|from scratch/i;

/** 原目标对照:把发散内容显式锚回 Original Goal / Requirements 的说法。 */
const GOAL_CONTRAST_RE =
  /Original Goal|原目标|原始目标|最初目标|对照(?:原始|最初)?目标|与原目标|相对原目标|偏离原目标|against the original goal|relative to the original goal|compared (?:with|to) the original goal/i;

/** 禁令 / 规则措辞:整行是在「禁止发散」而非制造发散,不得触发。 */
const DIVERGENCE_PRESCRIPTION_RE = /不得|禁止|不要|不应|避免|切勿|无需|不做|不新建|不重构|不发散/;

/**
 * 守卫 2:warn 级 —— 输出出现发散语言、且该行没有原目标对照即触发。
 * 与 diagnostic 的 Fix Proposal 守卫同形:按行判定,避免「发散词出现在禁令里」误报。
 */
const guardNoDivergenceWithoutGoal: Guard = {
  id: "review-no-divergence-without-goal",
  description: `warn 级:${REVIEW_NO_DIVERGENCE};输出出现「新方案 / 新建功能 / 重构整个」类发散语言、且该行没有原目标对照即触发`,
  check(output) {
    for (const rawLine of String(output ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (DIVERGENCE_PRESCRIPTION_RE.test(line)) continue;
      const hit = line.match(DIVERGENCE_RE)?.[0];
      if (!hit) continue;
      if (GOAL_CONTRAST_RE.test(line)) continue;
      return `发现发散语言「${hit}」:${REVIEW_NO_DIVERGENCE}——必须对照 Original Goal / Requirements 并标明偏离,否则属于审查发散(warn)`;
    }
    return null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 保真 / 建议 / 来源规则
// ─────────────────────────────────────────────────────────────────────────────

const preservationRules: PreservationRule[] = [
  {
    id: "review-preserve-subject-signals",
    description:
      "用户输入中的项目名 / 模块名 / 编号(如 P02-T05)/ 版本号 / 专有名词 / 文件与函数名 / 数字(大写开头、含数字或全大写)必须原样出现在优化稿中",
    check(output, rawInput) {
      const tokens = (rawInput.match(/[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? []).filter(
        (token) => /^[A-Z]/.test(token) || /\d/.test(token),
      );
      if (tokens.length === 0) return true;
      return tokens.every((token) => output.includes(token));
    },
  },
  {
    id: "review-preserve-language",
    description: "优化稿语言必须与用户输入主体语言一致(中文输入 → 中文输出)",
    check(output, rawInput) {
      if (output.trim() === "") return false;
      return isChineseDominant(output) === isChineseDominant(rawInput);
    },
  },
  {
    id: "review-preserve-original-goal-verbatim",
    description:
      "原目标 / 需求必须逐字或忠实引用用户输入或上下文用户消息,不得替换为优化器自己的目标或「最佳实践」",
  },
  {
    id: "review-preserve-evidence-verbatim",
    description:
      "用户已给出的结果 / 数据 / 报错 / 文件名 / 测试输出不得改写或概括;缺失的证据按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得编造",
  },
  {
    id: "review-preserve-scope-boundary",
    description:
      "审查不得扩大原目标范围:原目标没有的功能 / 平台 / 交付物不得作为「应做」项写进需求或修正建议",
  },
];

const suggestionRules: SuggestionRule[] = [
  {
    id: "review-suggest-evaluation-criteria",
    description: `可建议补充更可核查的评估标准,但必须标注「${SUGGESTION_LABEL_ZH}」并说明理由,不得写成用户要求`,
  },
  {
    id: "review-suggest-evidence-to-collect",
    description:
      "可建议补充证据来源(提交记录 / 测试输出 / 日志),但不得代替用户执行,也不得声称已执行",
  },
  {
    id: "review-suggest-verification",
    description: "可建议修正后的验证 / 复测方式与判定标准,帮助确认偏离已消除,但不得替用户下定论",
  },
  {
    id: "review-suggest-priority",
    description: "可建议修正项的优先级,但不得代替用户排期或决定取舍",
  },
];

const provenanceRules: ProvenanceRule[] = [
  {
    id: "review-quote-target-and-goal",
    description:
      "审查对象 / 原目标 / 需求必须逐字来自用户输入或上下文用户消息,不得替换成相似说法",
  },
  {
    id: "review-no-verdict-without-evidence",
    description:
      "「已达标 / 已满足 / 全部通过 / 无问题」类结论必须有逐字证据;否则降级为待验证或 未决项(省略或写成动作式/条件式指令)",
  },
  {
    id: "review-deviation-links-requirement",
    description:
      "偏离 / 缺失项必须指向具体 Original Goal / Requirements 条目;无法对应的不得作为认定偏离",
  },
  {
    id: "review-suggested-separated",
    description: `优化器建议(补充评估标准 / 取证方式 / 验证手段)必须独立成段并标注「${SUGGESTION_LABEL_ZH}」,永不混入要求段`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 策略对象
// ─────────────────────────────────────────────────────────────────────────────

const outputContract: OutputContract = {
  /** v2:信息责任清单(不再强制模板段落;id 作为核对锚点)。 */
  responsibilities: [...REVIEW_REQUIRED_SECTIONS],
  /** @deprecated 与 responsibilities 内容一致;保留给旧消费方。 */
  sections: [...REVIEW_REQUIRED_SECTIONS],
  formatNote: buildFormatNote("zh"),
};

/** Review PromptStrategy v0.1(纯数据 + 纯函数,零 ctx/UI/Host 依赖)。 */
export const reviewStrategy: PromptStrategy = {
  type: "review",
  name: "Review（审查）",
  version: REVIEW_STRATEGY_VERSION,
  purpose:
    "把用户口语化的审查诉求编译成基于原目标 / 需求的审查型 Prompt:先固定审查对象与原目标、需求,再给出评估标准与证据,逐条对照出偏离 / 缺失项 / 风险,最后只给不扩大范围、带验证方式的修正建议——基于原目标审查,不发散成新项目。",
  informationResponsibilities: [...REVIEW_REQUIRED_SECTIONS],
  /** @deprecated 保留给旧消费方;内容与 informationResponsibilities 一致。 */
  required_sections: [...REVIEW_REQUIRED_SECTIONS],
  optional_sections: ["Timeline", "Impact Scope", "Acceptance Snapshot", "Open Questions"],
  preservationRules,
  suggestionRules,
  guards: [
    guardNoDivergenceWithoutGoal,
    sectionPresence(REVIEW_REQUIRED_SECTIONS, {
      id: "review-required-sections",
      description: `优化稿必须包含全部 9 个必出段落:${REVIEW_REQUIRED_SECTIONS.join(" / ")}`,
    }),
    sectionPresence(REVIEW_MANDATORY_SECTIONS, {
      id: "review-mandatory-original-goal-requirements",
      description: `error 级:缺 Original Goal / Requirements 段即触发——审查必须基于原目标与需求,不得脱离它们另立标准`,
    }),
    forbidUnprovenStrongClaim({
      id: "review-no-unproven-verdict",
      description:
        "「已达标 / 已满足 / 全部通过 / 无问题」类结论必须有逐字证据或不确定性标注;无证据的结论一律触发",
      extraPattern: /已达标|已满足|全部通过|完全符合|没有问题|无问题|已验收/,
    }),
    unknownNotBlocking(),
    suggestedNotInExplicit(),
    suggestedNotUpgraded(),
  ],
  provenanceRules,
  buildSystem(language: "zh" | "en"): string {
    return buildReviewSystem(language);
  },
  buildUser(vars: CompileVars): string {
    return buildReviewUser(vars);
  },
  outputContract,
};

export default reviewStrategy;
