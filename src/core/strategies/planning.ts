/**
 * Planning PromptStrategy v0.1 —— P02-T02。
 *
 * 把用户口语化的「规划诉求」编译成一份可直接交给下游 DSH / Claude Code 执行的
 * 规划型 Prompt:可验收的分阶段计划、每阶段带 Acceptance、失败路径与停止条件齐备。
 *
 * 规划铁律(写进 system prompt + guards + 测试):
 *   1. 只规划、不执行 —— 产出是「待执行的计划」,不得出现执行已发生的证据;
 *   2. 每个阶段必须带 Acceptance —— 没有验收标准的阶段不可验收,不得算完成;
 *   3. 失败路径与停止条件必备 —— Failure Handling / Stop Conditions 不得省略。
 *
 * 该模块是纯数据 + 纯函数:零 ctx.llm / UI / Host 依赖,独立 version,可独立测试与升级。
 * 复用 `_shared.ts` 的跨策略不变式 A(UNKNOWN ≠ BLOCKING)/ B(SUGGESTED ≠ USER REQUIREMENT)。
 *
 * 全部文案为本项目独立撰写;设计思想(分阶段计划 + 每阶段验收 + 停止条件)为通用工程实践,
 * 未复制任何 AGPL 项目的源码 / 模板文本 / 测试。
 */
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
export const PLANNING_STRATEGY_VERSION = "0.1.0";

/** 铁律 1 的固定表述:system 提示词必须包含,测试据此断言。 */
export const PLAN_ONLY_NOT_EXECUTE = "只规划、不执行";

/** 铁律 2 的固定表述:每个阶段必须带验收标准。 */
export const PHASE_REQUIRES_ACCEPTANCE = "每个阶段必须带验收标准";

/** 铁律 3 的固定表述:失败路径与停止条件必备。 */
export const FAILURE_AND_STOP_REQUIRED = "失败处理与停止条件必备";

// ─────────────────────────────────────────────────────────────────────────────
// 16 个必出段落(English 段落名 = required_sections 断言锚点;中英并列渲染)
// ─────────────────────────────────────────────────────────────────────────────

interface PlanningSectionSpec {
  /** 契约段落名(English,required_sections 使用;不得改名)。 */
  id: string;
  /** 中文标题。 */
  zh: string;
  /** 该段要写什么(中文)。 */
  guidanceZh: string;
  /** 该段要写什么(英文)。 */
  guidanceEn: string;
}

/** planning 策略的 16 个必出段落,顺序即输出顺序(PLAN-v1 §7 planning)。 */
export const PLANNING_SECTIONS: readonly PlanningSectionSpec[] = [
  {
    id: "Goal",
    zh: "目标",
    guidanceZh: "本次规划要达成的最终目标;必须写到「怎样算达成」可判断,不用空泛动词",
    guidanceEn: "The final objective; written so that 'done' is judgeable, not a vague verb",
  },
  {
    id: "Why",
    zh: "动机",
    guidanceZh: "为什么做这件事、解决什么问题、不做的代价;来自用户的部分附 quote",
    guidanceEn: "Why this work matters, what problem it solves, the cost of not doing it",
  },
  {
    id: "Preconditions",
    zh: "前置条件",
    guidanceZh: "开始前必须已成立的条件(环境 / 权限 / 依赖 / 输入);未知写 [待补充: …]",
    guidanceEn: "Conditions that must already hold before starting; unknown → [TODO: ...]",
  },
  {
    id: "Inputs",
    zh: "输入",
    guidanceZh: "执行所需的具体输入及其来源;用户未提供的写 [待补充: …],不得自行补全",
    guidanceEn: "Concrete inputs and their sources; anything unstated → [TODO: ...]",
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
    id: "Phases",
    zh: "阶段",
    guidanceZh:
      "按里程碑分段,每段一个可独立验收的阶段;每个阶段必须带 Acceptance(验收标准)",
    guidanceEn:
      "Milestone phases, each independently acceptable; every phase must carry its Acceptance",
  },
  {
    id: "Tasks",
    zh: "任务",
    guidanceZh: "每个阶段下的可执行任务清单,一项一件、动作明确",
    guidanceEn: "Executable task list per phase, one action per item",
  },
  {
    id: "Dependencies",
    zh: "依赖",
    guidanceZh: "任务 / 阶段之间的先后顺序与外部依赖;不得留下隐含顺序",
    guidanceEn: "Ordering between tasks/phases and external dependencies; no implicit order",
  },
  {
    id: "Exact Steps",
    zh: "具体步骤",
    guidanceZh: "可直接照做的原子步骤(命令 / 操作),不写空泛动词",
    guidanceEn: "Atomic steps that can be followed directly; no vague verbs",
  },
  {
    id: "Outputs",
    zh: "产出物",
    guidanceZh: "每个阶段产出什么、放在哪里、如何获取或验证",
    guidanceEn: "What each phase produces, where it lives, how to obtain or inspect it",
  },
  {
    id: "Tests",
    zh: "测试",
    guidanceZh: "如何验证每步 / 每阶段:可复现的命令或检查项;不得只写「测试通过」",
    guidanceEn: "How to verify each step/phase: reproducible commands or checks; not just 'tests pass'",
  },
  {
    id: "Acceptance Criteria",
    zh: "验收标准",
    guidanceZh:
      "每个阶段的通过标准(可判定);未达到验收标准不得进入下一阶段;不得用主观形容词",
    guidanceEn:
      "Judgeable pass criteria per phase; no next phase until they hold; no subjective wording",
  },
  {
    id: "Failure Handling",
    zh: "失败处理",
    guidanceZh: "失败如何回修、重试上限、何时上报;不得省略",
    guidanceEn: "How failures are repaired, retry limits, when to escalate; never omitted",
  },
  {
    id: "Stop Conditions",
    zh: "停止条件",
    guidanceZh: "触发即停止并等待人工裁决的条件(越权 / 不可逆 / 契约冲突等)",
    guidanceEn: "Conditions that halt the work and wait for a human decision",
  },
  {
    id: "Next Step Condition",
    zh: "下一步条件",
    guidanceZh: "满足什么条件才允许进入下一步 / 下一阶段;未满足不得推进",
    guidanceEn: "What must hold before proceeding to the next step/phase",
  },
];

/** required_sections:16 个 English 段落名(顺序即输出顺序;测试断言锚点)。 */
export const PLANNING_REQUIRED_SECTIONS: readonly string[] = PLANNING_SECTIONS.map(
  (section) => section.id,
);

// ─────────────────────────────────────────────────────────────────────────────
// 系统提示词片段
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_ZH = `你是「Planning 规划型 Prompt 编译器」。用户给你一段口语化、可能不完整的规划诉求,你要把它编译成一份可直接交给下游 DSH / Claude Code 执行的规划型 Prompt。
你不执行、不开始开发;你只负责:把目标写清、把工作拆成可独立验收的阶段、暴露前置条件与缺口、规定失败路径与停止条件。`

const ROLE_EN = `You are the "Planning prompt compiler". The user gives you a colloquial, possibly incomplete planning request. You compile it into a planning prompt that downstream DSH / Claude Code can execute directly.
You do not execute and you do not start development. You only: state the goal, split the work into independently acceptable phases, expose preconditions and gaps, and define failure paths and stop conditions.`

const DISCIPLINE_ZH = `# 规划纪律(铁律,优先于任何措辞偏好)
1. ${PLAN_ONLY_NOT_EXECUTE}:整份产出是「待执行的计划」;不得出现「已开始实施 / 已开始开发 / 已修改文件 / 已完成实现 / 已提交 / 已部署」等「动作已发生」的证据,所有动作一律写成待执行的步骤。
2. ${PHASE_REQUIRES_ACCEPTANCE}:Phases 下每个阶段都要有可判定的 Acceptance(验收标准);没有验收标准的阶段视为不可验收,不得算完成,也不得进入下一阶段。
3. ${FAILURE_AND_STOP_REQUIRED}:必须写清失败如何回修、重试上限,以及触发即停止等待裁决的停止条件。
4. 目标可验收:Goal 必须写到「怎样算达成」能判断;Why 说明动机与不做的代价。
5. 顺序与依赖显式:Dependencies 写清任务 / 阶段先后;Exact Steps 必须原子、可复现,不写空泛动词。
6. 不替用户发明约束:预算、工期、人员、技术栈、平台等硬约束,用户没说的一律写 [待补充: …]。
7. UNKNOWN ≠ BLOCKING:未知信息保持未知,不阻塞后续合理推进;仅当缺失会实质改变方向时才需要用户补充。
8. 不代用户做决定:需要用户拍板的选择写成 [待补充: …] 或 Stop Conditions,优化器不得代选。`

const DISCIPLINE_EN = `# Planning discipline (iron rules, above any style preference)
1. Plan only, never execute: the whole output is a plan-to-be-executed. Never include evidence that work already happened ("implementation started", "files modified", "committed", "deployed"). Every action is written as a step still to be taken.
2. Every phase must carry Acceptance: under Phases, each phase needs judgeable Acceptance criteria. A phase without them is not acceptable, does not count as done, and may not be followed by the next phase.
3. Failure handling and stop conditions are mandatory: state how failures are repaired, retry limits, and the conditions that halt the work for a human decision.
4. Judgeable goal: the Goal must make "done" judgeable; Why explains the motivation and the cost of not doing it.
5. Explicit order and dependencies: Dependencies state task/phase order; Exact Steps are atomic and reproducible, not vague verbs.
6. Never invent constraints (budget, schedule, staffing, stack, platform). If the user did not state it, write [TODO: ...].
7. UNKNOWN ≠ BLOCKING: unknowns stay unknown and do not block reasonable progress; only a materially direction-changing gap needs the user.
8. Never decide for the user: choices only the user can make become [TODO: ...] or Stop Conditions.`

const PROVENANCE_ZH = `# 来源标注(四段协议,严格遵守)
- 明确要求:来自用户本轮输入的,每条必须附 ${quoteMarker("用户原话逐字片段")} 形式的逐字 quote
- 上下文已确认:仅限历史中「用户」消息,同样附 quote;助手 / Agent 的发言一律不能作为用户意图证据
- ${SUGGESTION_LABEL_ZH}:优化器主动补充的阶段划分 / 验收指标 / 风险提示,独立成段并带此前缀,永不写入要求段
- [待补充]:证据不足、用户未说明的关键信息,逐条写出缺什么
用户明确否决过的方向属于禁入集合,不得再次作为阶段 / 任务 / 建议提出。`

const PROVENANCE_EN = `# Provenance (four-section protocol, strictly)
- Explicit requirements: anything from the user's current input must carry a verbatim ${quoteMarker("verbatim user fragment")} quote
- Context-confirmed: only from "user" messages in history, each with a quote; assistant/agent messages are never evidence of user intent
- ${SUGGESTION_LABEL_EN}: phasing / acceptance metrics / risk notes the optimizer adds, in their own section with this prefix; never in the requirements sections
- [TODO:]: unspecified or unevidenced essentials, each stating what is missing
Directions the user already rejected form a do-not-enter set and must not reappear as phases, tasks, or suggestions.`

/** 渲染 16 段清单(中英并列,English id 恒出现 → required_sections 断言可跨语言命中)。 */
function renderSections(language: StrategyLanguage): string {
  const zh = language !== "en";
  const title = zh
    ? "# 输出段落(优化后的 Planning Prompt 必须按顺序逐段出现,标题中英并列)"
    : "# Output sections (the optimized Planning Prompt must contain each, in order)";
  const lines = PLANNING_SECTIONS.map((section) =>
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
    ? `先输出来源段(明确要求 / 上下文已确认 / ${SUGGESTION_LABEL_ZH} / [待补充]),再输出优化后的 Planning Prompt。
- 明确要求:每条附 ${quoteMarker("用户原话")}
- 上下文已确认:仅用「用户」消息,每条附 ${quoteMarker("原话")}
- ${SUGGESTION_LABEL_ZH}:独立成段
- [待补充]:证据不足项,写清缺什么`
    : `First the provenance block (Explicit requirements / Context-confirmed / ${SUGGESTION_LABEL_EN} / [TODO:]), then the optimized Planning Prompt.
- Explicit requirements: each with ${quoteMarker("verbatim user fragment")}
- Context-confirmed: user messages only, each with a quote
- ${SUGGESTION_LABEL_EN}: its own section
- [TODO:]: unevidenced items, stating what is missing`;
  const sections = PLANNING_SECTIONS.map((section) => section.id).join(" / ");
  const body = zh
    ? `优化后的 Planning Prompt 必须按顺序包含这 16 段:${sections}。Phases 下每个阶段必须带 Acceptance(验收标准)。除输出格式规定的内容外,不要输出多余解释。`
    : `The optimized Planning Prompt must contain these 16 sections in order: ${sections}. Every phase under Phases must carry Acceptance criteria. Output nothing beyond the specified format.`;
  return [heading, provenance, body].join("\n");
}

/** planning 策略的 system prompt(双语同构,zh 优先)。 */
export function buildPlanningSystem(language: StrategyLanguage): string {
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
    : "Recent conversation of the session (reference only; only 'user' messages count as user intent):";
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
  constraints: CompileVars["missing_constraints"],
  language: StrategyLanguage,
): string {
  const zh = language !== "en";
  const items = constraints ?? [];
  if (!items.length) {
    return zh
      ? `尚未提供缺口清单;请在编译中自行识别并以 ${TODO_PLACEHOLDER_PREFIX} …] 形式标出。`
      : "No gap list was provided; identify gaps during compilation and mark them as [TODO: ...].";
  }
  const header = zh
    ? "已识别的缺口(classifier / 上游给出,必须落成 [待补充: …]):"
    : "Known gaps (from classifier/upstream; must become [TODO: ...]):";
  const lines = items.map((item) => {
    const reason = item.reason ? `(${item.reason})` : "";
    return `- ${todoPlaceholder(item.label, language)}${reason}`;
  });
  return `${header}\n${lines.join("\n")}`;
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

/** planning 策略的 user 载荷;语言由 raw_input 主体语言决定(zh 优先)。 */
export function buildPlanningUser(vars: CompileVars): string {
  const language: StrategyLanguage = isChineseDominant(vars.raw_input) ? "zh" : "en";
  const zh = language !== "en";
  const sections: string[] = [];

  const context = renderContext(vars.context_turns, language);
  if (context) sections.push(context);
  const workspace = renderWorkspace(vars.workspace_metadata, language);
  if (workspace) sections.push(workspace);
  const derived = renderLlmDerived(vars.llm_derived, language);
  if (derived) sections.push(derived);
  sections.push(renderMissing(vars.missing_constraints, language));
  sections.push(renderSections(language));

  sections.push(
    zh
      ? `以下是我的规划诉求(你唯一需要编译的对象):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`
      : `Here is my planning request (the only thing to compile):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`,
  );
  return sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 守卫(anti-drift):执行证据 / 每阶段验收 / 必出段落 + 跨策略不变式 A·B
// ─────────────────────────────────────────────────────────────────────────────

/** 结构性行:Markdown 标题 / 加粗小标题 / 四段协议标签(标签本身不是证据)。 */
const STRUCTURAL_LINE =
  /^(?:#{1,6}\s|\*\*[^*]+\*\*\s*$|(?:明确要求|上下文已确认|优化器建议(?:\(可忽略\))?|待补充)\s*[:：]?\s*$)/;

/** 禁令 / 未发生措辞:整行是在「禁止执行证据」而非制造执行证据,不得触发。 */
const EXEC_NEGATION_RE =
  /不得|禁止|严禁|不要|切勿|不允许|无需|避免|尚未|未曾|未开始|未执行|没有(?:开始|执行)|不包含执行证据/;

/**
 * 「动作已发生」的执行证据(过去式 / 进行中):规划不得越权为执行。
 * 只针对计划自身的进度证据,不匹配「已安装 / 已配置」等环境事实。
 */
const EXECUTION_EVIDENCE_RE =
  /已(?:开始|着手)(?:实施|开发|执行|编码|修改|编写|落地)|已(?:完成)(?:实现|开发|修改|编码|重构|迁移|实施)|已(?:修改|创建|删除|新增|重命名)(?:了)?(?:文件|代码|目录|配置)|已(?:提交|推送|合并|部署|发布|上线)|正在(?:实施|执行|编码|开发)|实施中|代码已(?:改|写|更新)|已跑通/;

/** 单个阶段声明:标题型 `### Phase 1` / `### 阶段 1`(必须有编号,排除 `## Phases` 容器标题)。 */
const PHASE_HEADING_RE = /^(#{1,6})\s*(?:Phase|阶段)\s*(?:[0-9]+|[一二三四五六七八九十]+)/i;

/** 阶段提及(非标题型回退):`Phase 1` / `阶段 1`。 */
const PHASE_MENTION_RE = /(?:Phase|阶段)\s*(?:[0-9]+|[一二三四五六七八九十]+)/gi;

/** 验收标准标记(中英同构)。 */
const ACCEPTANCE_RE = /Acceptance|验收标准|验收|通过标准|完成标准|Exit Criteria|Definition of Done/i;
const ACCEPTANCE_RE_GLOBAL =
  /Acceptance|验收标准|验收|通过标准|完成标准|Exit Criteria|Definition of Done/gi;

/** 守卫 1:规划产出不得包含「动作已发生」的执行证据(只规划、不执行)。 */
const guardNoExecutionEvidence: Guard = {
  id: "planning-no-execution-evidence",
  description:
    "规划产出不得出现「已开始实施 / 已修改文件 / 已完成实现 / 已提交」等执行已发生证据;否则触发",
  check(output) {
    for (const rawLine of String(output ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || STRUCTURAL_LINE.test(line)) continue;
      if (EXEC_NEGATION_RE.test(line)) continue;
      const hit = line.match(EXECUTION_EVIDENCE_RE)?.[0];
      if (hit) {
        return `发现执行证据「${hit}」:${PLAN_ONLY_NOT_EXECUTE},动作必须写成待执行的步骤`;
      }
    }
    return null;
  },
};

/** 找出标题型阶段声明(及其标题层级)。 */
function findHeadingPhases(lines: string[]): { index: number; level: number; label: string }[] {
  const found: { index: number; level: number; label: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const match = PHASE_HEADING_RE.exec(trimmed);
    if (match) found.push({ index: i, level: match[1].length, label: trimmed });
  }
  return found;
}

/** 守卫 2:每个阶段必须在其段落内给出 Acceptance(验收标准),否则触发。 */
const guardPhaseRequiresAcceptance: Guard = {
  id: "planning-phase-requires-acceptance",
  description: `每个阶段(Phase / 阶段)必须带 Acceptance(验收标准);否则触发(${PHASE_REQUIRES_ACCEPTANCE})`,
  check(output) {
    const text = String(output ?? "");
    const lines = text.split(/\r?\n/);
    const phases = findHeadingPhases(lines);

    if (phases.length) {
      const missing: string[] = [];
      phases.forEach((phase, index) => {
        let end = index + 1 < phases.length ? phases[index + 1].index : lines.length;
        // 标题型阶段:遇到下一个同层或更高层标题即结束,避免吞掉后续顶层章节。
        for (let i = phase.index + 1; i < end; i++) {
          const heading = /^(#{1,6})\s*/.exec(lines[i].trim());
          if (heading && heading[1].length <= phase.level) {
            end = i;
            break;
          }
        }
        const block = lines.slice(phase.index, end).join("\n");
        if (!ACCEPTANCE_RE.test(block)) missing.push(phase.label);
      });
      if (missing.length) {
        return `阶段缺少 Acceptance(验收标准):${missing.join(" | ")};每个阶段必须有验收标准且可独立验收`;
      }
      return null;
    }

    // 非标题型阶段(表格 / 列表):退化为「阶段数 ≤ 验收标准出现次数」的计数检查。
    const phaseCount = (text.match(PHASE_MENTION_RE) ?? []).length;
    if (phaseCount === 0) {
      return "未声明任何阶段(缺少 Phase / 阶段 段):规划必须给出可独立验收的分阶段计划";
    }
    const acceptanceCount = (text.match(ACCEPTANCE_RE_GLOBAL) ?? []).length;
    if (acceptanceCount < phaseCount) {
      return `检测到 ${phaseCount} 个阶段但只有 ${acceptanceCount} 处验收标准:每个阶段必须有 Acceptance`;
    }
    return null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 保真 / 建议 / 来源规则
// ─────────────────────────────────────────────────────────────────────────────

const preservationRules: PreservationRule[] = [
  {
    id: "planning-preserve-subject-terms",
    description:
      "用户输入中的专有名词 / 型号 / 产品名 / 缩写(大写开头、含数字或全大写)必须原样出现在优化稿中",
    check(output, rawInput) {
      const tokens = (rawInput.match(/[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? []).filter(
        (token) => /^[A-Z]/.test(token) || /\d/.test(token),
      );
      if (tokens.length === 0) return true;
      return tokens.every((token) => output.includes(token));
    },
  },
  {
    id: "planning-preserve-language",
    description: "优化稿语言必须与用户输入主体语言一致(中文输入 → 中文输出)",
    check(output, rawInput) {
      if (output.trim() === "") return false;
      return isChineseDominant(output) === isChineseDominant(rawInput);
    },
  },
  {
    id: "planning-preserve-scope-boundaries",
    description:
      "用户已明确的边界 / 禁止项 / 范围不得扩大或缩小;不得把「计划中」写成「已完成」",
  },
];

const suggestionRules: SuggestionRule[] = [
  {
    id: "planning-suggest-acceptance-metrics",
    description: `可建议为每个阶段补充可判定的验收指标 / 检查命令,但必须标注「${SUGGESTION_LABEL_ZH}」`,
  },
  {
    id: "planning-suggest-risk-and-rollback",
    description: "可建议补充风险提示与回滚 / 备份方案,不得代替用户决定",
  },
  {
    id: "planning-suggest-tooling",
    description: "可建议所需工具 / 命令,但不得凭空发明用户未确认的技术栈或平台",
  },
  {
    id: "planning-suggest-checkpoints",
    description: "可建议设置阶段性检查点(评审 / 演示),但不得凭空给出具体工期数字",
  },
];

const provenanceRules: ProvenanceRule[] = [
  {
    id: "planning-quote-goals",
    description:
      "目标 / 约束 / 已确认方向必须逐字来自用户输入或上下文用户消息,不得替换成相似说法",
  },
  {
    id: "planning-no-confirmed-without-evidence",
    description:
      "「已确认 / 已定 / 已完成」类表述必须有逐字 quote;否则降级为计划 / 假设 / 待确认",
  },
  {
    id: "planning-unknown-placeholder",
    description: "证据不足的前置条件 / 输入 / 边界写入 [待补充: …],不得自行假定",
  },
  {
    id: "planning-suggested-separated",
    description: `优化器建议必须独立成段并标注「${SUGGESTION_LABEL_ZH}」,永不混入要求段`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 策略对象
// ─────────────────────────────────────────────────────────────────────────────

const outputContract: OutputContract = {
  sections: [...PLANNING_REQUIRED_SECTIONS],
  formatNote: buildFormatNote("zh"),
};

/** Planning PromptStrategy v0.1(纯数据 + 纯函数,零 ctx/UI/Host 依赖)。 */
export const planningStrategy: PromptStrategy = {
  type: "planning",
  name: "Planning（规划）",
  version: PLANNING_STRATEGY_VERSION,
  purpose:
    "把用户口语化的规划诉求编译成可直接交给 DSH / Claude Code 执行的分阶段计划:目标可验收、每阶段带 Acceptance、依赖与步骤显式、失败处理与停止条件齐备;只规划、不执行。",
  required_sections: [...PLANNING_REQUIRED_SECTIONS],
  optional_sections: ["Milestones", "Risk Notes", "Rollback Plan", "Open Questions"],
  preservationRules,
  suggestionRules,
  guards: [
    guardNoExecutionEvidence,
    guardPhaseRequiresAcceptance,
    sectionPresence(PLANNING_REQUIRED_SECTIONS, {
      id: "planning-required-sections",
      description: `优化稿必须包含全部 16 个必出段落:${PLANNING_REQUIRED_SECTIONS.join(" / ")}`,
    }),
    unknownNotBlocking(),
    suggestedNotInExplicit(),
    suggestedNotUpgraded(),
  ],
  provenanceRules,
  buildSystem(language: "zh" | "en"): string {
    return buildPlanningSystem(language);
  },
  buildUser(vars: CompileVars): string {
    return buildPlanningUser(vars);
  },
  outputContract,
};

export default planningStrategy;
