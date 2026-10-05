/**
 * Execution PromptStrategy v0.1 —— P02-T03。
 *
 * 把用户口语化的「执行诉求」(例如「按规划继续执行 P03-T02」)编译成一份可直接照做的
 * 执行型 Prompt:聚焦「当前这一个 Task」、可见的 Allowed / Forbidden Scope、原子动作、
 * 可复现的测试与验收、失败与停止条件、Git·State 规则,以及完成后的 Handoff。
 *
 * 执行铁律(写进 system prompt + guards + 测试):
 *   1. 聚焦当前任务 —— 只编译当前 Task,不重新规划整个项目、不产出全项目路线图;
 *   2. Allowed / Forbidden Scope 双段必备 —— 允许改什么、禁止碰什么必须逐条写清;
 *   3. Handoff 必备 —— 完成后交给谁、下一个 Task 是什么、交接前置条件不得省略。
 *
 * 该模块是纯数据 + 纯函数:零 ctx.llm / UI / Host 依赖,独立 version,可独立测试与升级。
 * 复用 `_shared.ts` 的跨策略不变式 A(UNKNOWN ≠ BLOCKING)/ B(SUGGESTED ≠ USER REQUIREMENT)。
 *
 * 全部文案为本项目独立撰写;设计思想(聚焦单任务 + 范围双段 + 交接段)为通用工程实践,
 * 未复制任何 AGPL 项目的源码 / 模板文本 / 测试。
 */
import { renderDispositionBrief } from "../disposition-render.js";
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
export const EXECUTION_STRATEGY_VERSION = "0.1.0";

/** 铁律 1 的固定表述:system 提示词必须包含,测试据此断言。 */
export const FOCUS_CURRENT_TASK = "聚焦当前任务,不重新规划整个项目";

/** 铁律 2 的固定表述:允许 / 禁止范围双段必备。 */
export const SCOPE_BOUNDARY_REQUIRED = "Allowed Scope 与 Forbidden Scope 双段必备";

/** 铁律 3 的固定表述:交接段必备。 */
export const HANDOFF_MANDATORY = "Handoff 交接段必备";

// ─────────────────────────────────────────────────────────────────────────────
// 15 个必出段落(English 段落名 = required_sections 断言锚点;中英并列渲染)
// ─────────────────────────────────────────────────────────────────────────────

interface ExecutionSectionSpec {
  /** 契约段落名(English,required_sections 使用;不得改名)。 */
  id: string;
  /** 中文标题。 */
  zh: string;
  /** 该段要写什么(中文)。 */
  guidanceZh: string;
  /** 该段要写什么(英文)。 */
  guidanceEn: string;
}

/** execution 策略的 15 个必出段落,顺序即输出顺序(PLAN-v1 §7 execution)。 */
export const EXECUTION_SECTIONS: readonly ExecutionSectionSpec[] = [
  {
    id: "Current Task",
    zh: "当前任务",
    guidanceZh:
      "本次执行针对的那一个具名 Task(如 P02-T03);只写当前任务,不铺开后续任务或整项目计划",
    guidanceEn:
      "The single named task this execution targets (e.g. P02-T03); only the current one, no roadmap",
  },
  {
    id: "Goal",
    zh: "目标",
    guidanceZh: "这个 Task 要达成的可判定结果;不用空泛动词,写清「怎样算完成」",
    guidanceEn: "The judgeable result of this task; state what 'done' means, not a vague verb",
  },
  {
    id: "Preconditions",
    zh: "前置条件",
    guidanceZh: "开始前必须已成立的条件(环境 / 依赖 / 上一步产出);未知按未决项处置纪律处理(省略,或写成动作式/条件式指令)",
    guidanceEn: "Conditions that must already hold; unknown → follow the open-item disposition discipline",
  },
  {
    id: "Allowed Scope",
    zh: "允许范围",
    guidanceZh: "本次只允许修改 / 新增的文件或模块,逐条列出;不得含糊扩大",
    guidanceEn: "Files or modules this task may change, listed one by one; never widened loosely",
  },
  {
    id: "Forbidden Scope",
    zh: "禁止范围",
    guidanceZh:
      "明确禁止触碰的模块 / 路径 / 动作(如正式 profile、其他策略、UI、force push),逐条列出且不得省略",
    guidanceEn:
      "Modules/paths/actions explicitly off-limits (production profile, other strategies, UI, force push); never omitted",
  },
  {
    id: "Inputs",
    zh: "输入",
    guidanceZh: "执行所需的具体输入及其来源;用户未提供的按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得自行补全",
    guidanceEn: "Concrete inputs and their sources; anything unstated → follow the open-item disposition discipline",
  },
  {
    id: "Executor",
    zh: "执行者",
    guidanceZh: "谁执行(人 / Agent / 工具)与所需能力;不得指定用户未确认的角色",
    guidanceEn: "Who executes (human / agent / tool) and required capability; do not invent roles",
  },
  {
    id: "Tools",
    zh: "工具",
    guidanceZh: "需要使用的工具 / 命令 / 环境;不得凭空发明用户未确认的技术栈",
    guidanceEn: "Tools / commands / environment needed; never invent an unconfirmed stack",
  },
  {
    id: "Exact Actions",
    zh: "具体动作",
    guidanceZh:
      "可直接照做的原子动作序列,一条一个动作,对应具体文件 / 命令 / 判定;不写「分析一下」「规划一下」",
    guidanceEn:
      "Atomic, directly followable action sequence; one action each, tied to a file/command/check; no vague verbs",
  },
  {
    id: "Tests",
    zh: "测试",
    guidanceZh: "验证每个动作的可复现命令或检查项及预期结果;不得只写「测试通过」",
    guidanceEn: "Reproducible commands or checks per action with expected results; not just 'tests pass'",
  },
  {
    id: "Acceptance",
    zh: "验收",
    guidanceZh: "本次执行可判定的通过标准;未满足不得声称完成",
    guidanceEn: "Judgeable pass criteria for this execution; not met means not done",
  },
  {
    id: "Failure Handling",
    zh: "失败处理",
    guidanceZh: "失败如何回修、重试上限、何时上报;不得省略",
    guidanceEn: "How failures are repaired, retry limits, when to escalate; never omitted",
  },
  {
    id: "Git·State Rules",
    zh: "Git 与状态规则",
    guidanceZh:
      "分支、commit 前缀、一个内容提交 + 一个仅状态同步提交;不 force / 不 reset --hard / 不改写历史",
    guidanceEn:
      "Branch, commit prefix, one content commit + one state-sync commit; no force / no reset --hard / no history rewrite",
  },
  {
    id: "Stop Conditions",
    zh: "停止条件",
    guidanceZh: "触发即停止并等待人工裁决的条件(越权 / 不可逆 / 命中门禁等)",
    guidanceEn: "Conditions that halt the work and wait for a human decision (Human Gate, irreversible, out of scope)",
  },
  {
    id: "Handoff",
    zh: "交接",
    guidanceZh:
      "完成后交接什么、交给谁、下一个 Task 是什么、交接前置条件;不得省略",
    guidanceEn:
      "What is handed off, to whom, which task comes next, and the conditions; never omitted",
  },
];

/** required_sections:15 个 English 段落名(顺序即输出顺序;测试断言锚点)。 */
export const EXECUTION_REQUIRED_SECTIONS: readonly string[] =
  EXECUTION_SECTIONS.map((section) => section.id);

/** 强制段(任务契约点名:Allowed / Forbidden Scope 与 Handoff 不得省略)。 */
export const EXECUTION_MANDATORY_SECTIONS: readonly string[] = [
  "Current Task",
  "Allowed Scope",
  "Forbidden Scope",
  "Handoff",
];

// ─────────────────────────────────────────────────────────────────────────────
// 系统提示词片段
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_ZH = `你是「Execution 执行型 Prompt 编译器」。用户给你一段口语化、可能不完整的执行诉求(常见如「按规划继续执行 P03-T02」),你要把它编译成一份可以直接照做的执行型 Prompt。
你不代替用户做决定、也不重新规划项目;你只负责:锁定当前任务、写清允许与禁止范围、把动作原子化、规定测试与验收、失败与停止条件,以及完成后的交接。`

const ROLE_EN = `You are the "Execution prompt compiler". The user gives you a colloquial, possibly incomplete execution request (often "continue with P03-T02 per the plan"). You compile it into an execution prompt that can be followed directly.
You do not decide for the user and you do not re-plan the project. You only: pin down the current task, state allowed and forbidden scope, make actions atomic, define tests and acceptance, failure and stop conditions, and the handoff.`

const DISCIPLINE_ZH = `# 执行纪律(铁律,优先于任何措辞偏好)
1. ${FOCUS_CURRENT_TASK}:只编译「当前这一个 Task」;不得产出全项目路线图、分阶段总规划或「重新规划整个项目」的内容。输入里提到后续 Task 时,只作为 Handoff 的交接口,不得展开成新的规划。
2. ${SCOPE_BOUNDARY_REQUIRED}:必须逐条写清本次允许修改什么、禁止触碰什么;Forbidden Scope 不得省略、不得写成空泛声明。
3. ${HANDOFF_MANDATORY}:必须写清完成后交接什么、交给谁、下一个 Task 是什么、交接前置条件。
4. Exact Actions 原子可执行:每条动作对应一个具体文件 / 命令 / 判定,不写「分析一下」「规划一下」这类空泛动词;不得把执行诉求膨胀成重规划。
5. 每个动作带验证:Tests 给出可复现命令或检查项,Acceptance 给出可判定的通过标准,不得只写「测试通过」。
6. 失败与停止:Failure Handling 写回修方式与重试上限;Stop Conditions 写触发即停等待裁决的条件。
7. Git·State Rules 必备:分支、commit 前缀、一个内容提交 + 一个仅状态同步提交、不 force / 不 reset --hard / 不改写历史。
8. UNKNOWN ≠ BLOCKING:未知信息保持未知,不阻塞后续合理推进;不代用户拍板,未知按未决项处置纪律处理(省略,或写成动作式/条件式指令)。`

const DISCIPLINE_EN = `# Execution discipline (iron rules, above any style preference)
1. Focus on the current task only — never re-plan the entire project: compile only the single current task. Never produce a whole-project roadmap, a phase-by-phase master plan, or "re-plan the entire project" content. When the input mentions later tasks, treat them only as handoff pointers, never as new planning.
2. Allowed Scope and Forbidden Scope are both mandatory: state, item by item, what may change and what is off-limits; Forbidden Scope must never be omitted or left vague.
3. Handoff is mandatory: state what is handed off, to whom, which task comes next, and the handoff preconditions.
4. Exact Actions are atomic and followable: each action maps to a concrete file / command / check; no vague verbs like "analyze" or "plan around". Never inflate an execution request into a re-plan.
5. Every action carries verification: Tests give reproducible commands or checks; Acceptance gives judgeable pass criteria, never just "tests pass".
6. Failure and stop: Failure Handling states repair and retry limits; Stop Conditions state when to halt for a human decision.
7. Git·State Rules are mandatory: branch, commit prefix, one content commit + one state-sync commit, no force / no reset --hard / no history rewrite.
8. UNKNOWN ≠ BLOCKING: unknowns stay unknown and do not block reasonable progress; never decide for the user, follow the open-item disposition discipline (omit, or write a before-acting/conditional instruction).`

const PROVENANCE_ZH = `# 来源标注(四段协议,严格遵守)
- 明确要求:来自用户本轮输入的,每条必须附 ${quoteMarker("用户原话逐字片段")} 形式的逐字 quote
- 上下文已确认:仅限历史中「用户」消息,同样附 quote;助手 / Agent 的发言一律不能作为用户意图证据
- ${SUGGESTION_LABEL_ZH}:优化器主动补充的动作细则 / 校验命令 / 回滚建议,独立成段并带此前缀,永不写入要求段
- 未知项:证据不足、用户未说明的关键信息,逐条写出缺什么
用户明确否决过的方向属于禁入集合,不得再次作为动作 / 建议提出。`

const PROVENANCE_EN = `# Provenance (four-section protocol, strictly)
- Explicit requirements: anything from the user's current input must carry a verbatim ${quoteMarker("verbatim user fragment")} quote
- Context-confirmed: only from "user" messages in history, each with a quote; assistant/agent messages are never evidence of user intent
- ${SUGGESTION_LABEL_EN}: action details / verification commands / rollback advice the optimizer adds, in their own section with this prefix; never in the requirements sections
- Unknown items: unspecified or unevidenced essentials, each stating what is missing
Directions the user already rejected form a do-not-enter set and must not reappear as actions or suggestions.`

/** 渲染 15 段清单(中英并列,English id 恒出现 → required_sections 断言可跨语言命中)。 */
function renderSections(language: StrategyLanguage): string {
  const zh = language !== "en";
  const title = zh
    ? "# 信息责任(优化后的 Execution Prompt 必须逐项交代清楚;标题可自拟、顺序可调整,责任不得遗漏)"
    : "# Information responsibilities (the optimized Execution Prompt must cover each one; titles and order are yours, nothing may be omitted)";
  const lines = EXECUTION_SECTIONS.map((section) =>
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
    ? `先输出来源段(明确要求 / 上下文已确认 / ${SUGGESTION_LABEL_ZH} / 未知项),再输出优化后的 Execution Prompt。
- 明确要求:每条附 ${quoteMarker("用户原话")}
- 上下文已确认:仅用「用户」消息,每条附 ${quoteMarker("原话")}
- ${SUGGESTION_LABEL_ZH}:独立成段
- 未知项:证据不足项,写清缺什么`
    : `First the provenance block (Explicit requirements / Context-confirmed / ${SUGGESTION_LABEL_EN} / Unknown items), then the optimized Execution Prompt.
- Explicit requirements: each with ${quoteMarker("verbatim user fragment")}
- Context-confirmed: user messages only, each with a quote
- ${SUGGESTION_LABEL_EN}: its own section
- Unknown items: unevidenced items, stating what is missing`;
  const sections = EXECUTION_SECTIONS.map((section) => section.id).join(" / ");
  const body = zh
    ? `优化后的 Execution Prompt 必须逐项交代以下 15 项信息责任(id 作为核对锚点,顺序可调整):${sections}。Allowed Scope / Forbidden Scope / Handoff 不得省略;不得把它写成整项目规划。其余写法细则:
- Forbidden Scope 条目用「X 保持现状 / X 不在本次改动范围内」的对象前置句式,不要写「禁止修改 X / 不得改动 X」的动词前置句式(机械守卫会按动词+对象把禁止句误判为范围扩大)。
- 动词(改动 / 修改 / 重构 / 删除)与范围对象名词(如 settings 存储层)必须分处不同句子、相距 12 字符以上:动词句不提对象名(如「允许改动:src/client 与 i18n 文案」),对象句只配「保持现状 / 不在本次范围」(如「settings 存储层保持现状」)。
- 即使以分号 / 顿号 / 逗号把动词与对象并置(如「改动;settings 存储层」)同样会被机械守卫判为范围扩大;范围句只写「X 保持现状 / X 不在本次范围」,动词句不得出现对象名。
- 明确要求 条目文本尽量直接沿用用户原话(与 quote 相同或最接近),不要改写为「禁止+动词+对象」等新句式。
- Stop Conditions / Failure Handling 描述触发条件时同样用对象前置句式,不要写「发现需要改动 X」(机械守卫按 动词+对象 判定范围扩大)。
- 各段小标题不要加编号(写 "### Current Task",不要 "### 1. Current Task"),机械守卫按标题前缀匹配。
- 除输出格式规定的内容外,不要输出多余解释。`
    : `The optimized Execution Prompt must cover these 15 information responsibilities (each id is a check anchor; order may vary): ${sections}. Allowed Scope / Forbidden Scope / Handoff must not be omitted, and this must not become a whole-project plan. Wording rules:
- Phrase Forbidden Scope items object-first ("X stays as-is / X is out of scope"): mechanical guards treat a verb+object pair as scope expansion even when negated (e.g. "don't modify X").
- Keep verbs (change / modify / refactor / delete) and scope-object nouns (e.g. settings storage layer) in separate sentences more than 12 characters apart: verb sentences do not name the object (e.g. "changes allowed: src/client and i18n files"), object sentences only pair with "stays as-is / out of scope".
- Even joining verb and object with a semicolon / comma / slash (e.g. "change; settings storage layer") is treated as scope expansion by mechanical guards; write object-first sentences only, and never name the object in a verb sentence.
- Keep Explicit-requirement item text as close to the user's own words as possible (same as the quote); do not rewrite it into "forbid + verb + object" forms.
- In Stop Conditions / Failure Handling also phrase trigger conditions object-first; never write "a need to modify X is found" (mechanical guards read verb+object as scope expansion).
- Do not number section headings (write "### Current Task", not "### 1. Current Task"); mechanical guards match heading prefixes.
- Output nothing beyond the specified format.`;
  return [heading, provenance, body].join("\n");
}

/** execution 策略的 system prompt(双语同构,zh 优先)。 */
export function buildExecutionSystem(language: StrategyLanguage): string {
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
  // v2 Phase 2 契约(docs/phase2-contract.md):未决项按处置分类交付,
  // 不再落成 [待补充:] 占位符 —— 见 disposition-render.ts。
  return renderDispositionBrief(
    {
      missing_constraints: vars.missing_constraints,
      dispositions: vars.missing_dispositions,
      missing_resolution: vars.missing_resolution,
    },
    language,
    "请在编译中自行识别缺口。",
    "identify gaps during compilation.",
  );
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
  push("用户目标", "User goals", derived.user_goals);
  push("用户已否决的方向(禁入集合)", "Rejected directions (do-not-enter)", derived.rejected_directions);
  push("用户已知约束", "Known constraints", derived.known_constraints);
  if (!groups.length) return "";
  const header = zh
    ? "上游 LLM 已提炼的字段(仅作参考;没有逐字证据的一律当假设处理):"
    : "Fields distilled upstream (reference only; anything without a verbatim quote is an assumption):";
  return `${header}\n${groups.join("\n")}`;
}

/** execution 策略的 user 载荷;语言由 raw_input 主体语言决定(zh 优先)。 */
export function buildExecutionUser(vars: CompileVars): string {
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
      ? `以下是我的执行诉求(你唯一需要编译的对象;聚焦当前这一个 Task):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`
      : `Here is my execution request (the only thing to compile; focus on this single task):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`,
  );
  return sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 守卫(anti-drift):禁整项目重规划 / 不得以规划·分析段为主 / 强制段 + 不变式 A·B
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Markdown 标题行(只把标题作为「段落主导性」的判定对象,正文提及不算)。
 * 兼容 `# 标题` / `**加粗标题**` / 带编号前缀的两种变体
 * (首轮回归实测:模型输出常用 _加粗小标题_ 或 `### 1. Current Task` 编号标题)。
 * 注:返回捕获组 1 为标题文本(各写法统一)。
 */
const HEADING_RE =
  /^(?:#{1,6}\s*(?:[0-9]+[.、)．）]?\s*)?(.+)$|\*\*(?:[0-9]+[.、)．）]?\s*)?([^*]+)\*\*\s*$)/;

/** 规划型段落标题前缀(execution 产出里不应成为主体)。 */
const PLANNING_HEADING_PREFIXES: readonly string[] = [
  "phases",
  "phase",
  "阶段",
  "tasks",
  "task list",
  "任务清单",
  "任务列表",
  "dependencies",
  "dependency",
  "依赖",
  "next step condition",
  "下一步条件",
  "milestones",
  "milestone",
  "里程碑",
  "roadmap",
  "路线图",
  "整体规划",
  "总体规划",
  "全项目规划",
  "项目计划",
  "实施计划",
  "规划方案",
];

/** 分析型段落标题前缀(execution 产出里不应成为主体)。 */
const ANALYSIS_HEADING_PREFIXES: readonly string[] = [
  "analysis",
  "分析",
  "background",
  "背景",
  "调研",
  "research",
  "研究",
  "diagnosis",
  "诊断",
];

/** 执行型段落标题前缀(execution 产出的骨架)。 */
const EXECUTION_HEADING_PREFIXES: readonly string[] = [
  "current task",
  "当前任务",
  "exact actions",
  "具体动作",
  "allowed scope",
  "允许范围",
  "forbidden scope",
  "禁止范围",
  "handoff",
  "交接",
];

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  const value = text.trim().toLowerCase();
  return prefixes.some((prefix) => value.startsWith(prefix));
}

/** 整项目重规划语言(execution 必须聚焦单任务,不得重规划项目)。 */
const PROJECT_REPLANNING_RE =
  /(?:重新规划(?:整个|全)?项目|重做(?:整体|全项目|整个项目)规划|(?:整个|全)项目(?:的)?(?:整体)?(?:路线图|计划|规划)|整体规划(?:整个|全)?项目|全项目规划|项目整体规划|从头规划(?:整个|全)?项目|分阶段(?:地)?规划(?:整个|全)?项目|re-?plan(?:ning)?\s+(?:the\s+)?(?:entire|whole)\s+project|(?:entire|whole)[- ]project\s+(?:plan|roadmap)|project[- ]wide\s+(?:plan|roadmap))/i;

/** 禁令 / 约束措辞:整行是在「禁止重规划」而非制造重规划,不得触发。 */
const NEGATION_RE = /不得|禁止|严禁|不要|切勿|不允许|无需|避免|不重|不(?:得|应)(?:再)?规划/;

/** [待补充:] 占位符(未知项本身不是重规划主张)。 */
const PLACEHOLDER_RE = /\[待补充:|\[TODO:/;

/** 守卫 1:execution 产出不得把诉求膨胀成「整项目重规划」。 */
const guardNoProjectReplanning: Guard = {
  id: "execution-no-project-replanning",
  description: `${FOCUS_CURRENT_TASK};出现「重新规划整个项目 / 全项目路线图 / 分阶段总规划」类语言即触发`,
  check(output) {
    for (const rawLine of String(output ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || NEGATION_RE.test(line) || PLACEHOLDER_RE.test(line)) continue;
      const hit = line.match(PROJECT_REPLANNING_RE)?.[0];
      if (hit) {
        return `发现整项目重规划语言「${hit}」:execution 只聚焦当前任务,后续 Task 只能作为 Handoff 的交接口`;
      }
    }
    return null;
  },
};

/**
 * 守卫 2:输出不得以「规划 / 分析」段落为主。
 * 只统计标题行;没有执行骨架(Current Task / Allowed·Forbidden Scope / Exact Actions / Handoff)
 * 或规划·分析标题数不少于执行标题数时触发。
 */
const guardNotPlanningDominated: Guard = {
  id: "execution-not-planning-dominated",
  description:
    "optimized prompt 必须以执行段为骨架;规划/分析型标题不得不少于执行型标题,否则触发",
  check(output) {
    let planning = 0;
    let analysis = 0;
    let execution = 0;
    for (const rawLine of String(output ?? "").split(/\r?\n/)) {
      const match = HEADING_RE.exec(rawLine.trim());
      if (!match) continue;
      const heading = String(match[1] ?? match[2] ?? "");
      if (startsWithAny(heading, EXECUTION_HEADING_PREFIXES)) {
        execution += 1;
      } else if (startsWithAny(heading, PLANNING_HEADING_PREFIXES)) {
        planning += 1;
      } else if (startsWithAny(heading, ANALYSIS_HEADING_PREFIXES)) {
        analysis += 1;
      }
    }
    if (execution === 0) {
      return "产出中没有任何执行段(Current Task / Allowed Scope / Forbidden Scope / Exact Actions / Handoff):execution 策略必须以执行段为骨架";
    }
    const nonExecution = planning + analysis;
    if (nonExecution >= execution) {
      return `产出以规划/分析段落为主(规划·分析标题 ${nonExecution} ≥ 执行标题 ${execution}):execution 策略不得膨胀成重规划或需求分析`;
    }
    return null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 保真 / 建议 / 来源规则
// ─────────────────────────────────────────────────────────────────────────────

const preservationRules: PreservationRule[] = [
  {
    id: "execution-preserve-subject-terms",
    description:
      "用户输入中的 Task 编号 / 专有名词 / 型号 / 产品名 / 缩写(大写开头、含数字或全大写)必须原样出现在优化稿中",
    check(output, rawInput) {
      const tokens = (rawInput.match(/[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? []).filter(
        (token) => /^[A-Z]/.test(token) || /\d/.test(token),
      );
      if (tokens.length === 0) return true;
      return tokens.every((token) => output.includes(token));
    },
  },
  {
    id: "execution-preserve-language",
    description: "优化稿语言必须与用户输入主体语言一致(中文输入 → 中文输出)",
    check(output, rawInput) {
      if (output.trim() === "") return false;
      return isChineseDominant(output) === isChineseDominant(rawInput);
    },
  },
  {
    id: "execution-preserve-scope-boundaries",
    description:
      "用户已明确的允许 / 禁止范围不得扩大或缩小;不得把「只改某文件」扩成「重构整个模块」",
  },
];

const suggestionRules: SuggestionRule[] = [
  {
    id: "execution-suggest-verification-commands",
    description: `可建议补充可复现的校验命令 / 检查项,但必须标注「${SUGGESTION_LABEL_ZH}」`,
  },
  {
    id: "execution-suggest-rollback-plan",
    description: "可建议失败时的回滚 / 备份措施,不得代替用户决定",
  },
  {
    id: "execution-suggest-commit-splitting",
    description: "可建议拆分内容提交与状态同步提交,但不得改写用户给定的 Git 规则",
  },
  {
    id: "execution-suggest-tooling",
    description: "可建议所需工具 / 命令,但不得凭空发明用户未确认的技术栈或平台",
  },
];

const provenanceRules: ProvenanceRule[] = [
  {
    id: "execution-quote-scope",
    description:
      "当前任务编号 / 允许范围 / 禁止项必须逐字来自用户输入或上下文用户消息,不得替换成相似说法",
  },
  {
    id: "execution-no-confirmed-without-evidence",
    description:
      "「已确认 / 已定 / 已完成」类表述必须有逐字 quote;否则降级为待执行 / 假设 / 待确认",
  },
  {
    id: "execution-unknown-placeholder",
    description: "证据不足的前置条件 / 输入 / 范围写入 未决项(省略或写成动作式/条件式指令),不得自行假定",
  },
  {
    id: "execution-suggested-separated",
    description: `优化器建议必须独立成段并标注「${SUGGESTION_LABEL_ZH}」,永不混入要求段`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 策略对象
// ─────────────────────────────────────────────────────────────────────────────

const outputContract: OutputContract = {
  /** v2:信息责任清单(不再强制模板段落;id 作为核对锚点)。 */
  responsibilities: [...EXECUTION_REQUIRED_SECTIONS],
  /** @deprecated 与 responsibilities 内容一致;保留给旧消费方。 */
  sections: [...EXECUTION_REQUIRED_SECTIONS],
  formatNote: buildFormatNote("zh"),
};

/** Execution PromptStrategy v0.1(纯数据 + 纯函数,零 ctx/UI/Host 依赖)。 */
export const executionStrategy: PromptStrategy = {
  type: "execution",
  name: "Execution（执行）",
  version: EXECUTION_STRATEGY_VERSION,
  purpose:
    "把用户口语化的执行诉求编译成可直接照做的执行型 Prompt:聚焦当前 Task、Allowed/Forbidden Scope 双段齐备、动作原子可执行、测试与验收可判定、失败与停止条件显式、Git·State 规则与 Handoff 必备。",
  informationResponsibilities: [...EXECUTION_REQUIRED_SECTIONS],
  /** @deprecated 保留给旧消费方;内容与 informationResponsibilities 一致。 */
  required_sections: [...EXECUTION_REQUIRED_SECTIONS],
  optional_sections: ["Verification Log", "Rollback Plan", "Risk Notes", "Open Questions"],
  preservationRules,
  suggestionRules,
  guards: [
    guardNoProjectReplanning,
    guardNotPlanningDominated,
    sectionPresence(EXECUTION_REQUIRED_SECTIONS, {
      id: "execution-required-sections",
      description: `优化稿必须包含全部 15 个必出段落:${EXECUTION_REQUIRED_SECTIONS.join(" / ")}`,
    }),
    sectionPresence(EXECUTION_MANDATORY_SECTIONS, {
      id: "execution-mandatory-scope-and-handoff",
      description: `强制段不得省略:${EXECUTION_MANDATORY_SECTIONS.join(" / ")}(Allowed / Forbidden Scope 与 Handoff 必备)`,
    }),
    unknownNotBlocking(),
    suggestedNotInExplicit(),
    suggestedNotUpgraded(),
  ],
  provenanceRules,
  buildSystem(language: "zh" | "en"): string {
    return buildExecutionSystem(language);
  },
  buildUser(vars: CompileVars): string {
    return buildExecutionUser(vars);
  },
  outputContract,
};

export default executionStrategy;
