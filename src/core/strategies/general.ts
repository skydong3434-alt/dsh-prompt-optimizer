/**
 * General PromptStrategy v0.1 —— P02-T07 通用兜底策略。
 *
 * AUTO 分类失败 / 低置信时,真实类型未知,不能硬套某一类专属骨架;general 的职责是
 * **忠实重组草稿**:把用户口语化、结构松散的一段文字,编译成一份八板块齐全、可直接
 * 交给下游 Agent 的通用 Prompt,并明确区分「用户说的 / 上下文确认的 / 优化器建议的 /
 * 仍待补充的」。
 *
 * 双模式整合(吸收 Y1X1n 既有 template / intent 两种改写语义,**独立重写文案**):
 *   · template(结构模板):无会话上下文时,按八板块结构模板重排草稿,缺失写 [待补充: …];
 *   · intent(提炼目的):有会话上下文时,先提炼用户真实目的,再围绕目的润色草稿,
 *     不强行套模板,保留草稿原始表达框架,上下文只用于理解意图。
 *   模式由 `resolveGeneralMode(context_turns)` 机械判定;system 同时给出两种模式纪律,
 *   user 载荷再点明本次采用哪种模式。
 *
 * 八板块结构(角色 / 任务目标 / 输入材料 / 输出格式 / 内容要求 / 风格 / 约束 / 成功标准)
 * 借鉴通用 Prompt 工程实践(含 Co1ombiagly spec 的板块划分思想),**文案全部本仓库独立撰写**。
 *
 * 通用铁律(写进 system prompt + guards + 测试):
 *   1. 保真改写 —— 只重组与澄清单个草稿的原意,不替换任务、不改变目标、不扩大范围;
 *   2. 无证据不新增硬约束 —— 用户未给出的预算 / 工期 / 平台 / 技术栈 / 数量一律写
 *      [待补充: …],不得凭空写成硬约束;
 *   3. 建议保持建议身份 —— 优化器补充内容必须独立成段并带「建议(可忽略)」前缀;
 *   4. 未知不阻塞 —— UNKNOWN ≠ BLOCKING,未知保持未知,不强迫用户先回答。
 *
 * 纯数据 + 纯函数:零 ctx.llm / UI / Host 依赖,独立 version,可独立测试与升级。
 * 复用 `_shared.ts` 的共享规则段、守卫工厂与跨策略不变式 A·B。
 *
 * 未复制任何 AGPL 项目的源码 / 模板文本 / 测试(八板块只借鉴思想)。
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
export const GENERAL_STRATEGY_VERSION = "0.1.0";

// ─────────────────────────────────────────────────────────────────────────────
// 双模式(template / intent)与铁律表述
// ─────────────────────────────────────────────────────────────────────────────

/** general 的两种改写模式:无上下文用 template,有上下文用 intent。 */
export type GeneralMode = "template" | "intent";

/** template 模式常量(无会话上下文:按八板块结构模板重排草稿)。 */
export const GENERAL_MODE_TEMPLATE: GeneralMode = "template";
/** intent 模式常量(有会话上下文:先提炼目的,再顺势润色)。 */
export const GENERAL_MODE_INTENT: GeneralMode = "intent";

/** 铁律 1 的固定表述:保真改写。 */
export const GENERAL_FIDELITY_RULE =
  "保真改写:只重组与澄清单个草稿的原意,不得替换任务、改变目标、扩大范围或改变语气受众";

/** 铁律 2 的固定表述:无证据不新增硬约束。 */
export const GENERAL_NO_INVENTED_CONSTRAINTS =
  "无证据不新增硬约束:用户未明确给出的预算 / 工期 / 时限 / 平台 / 技术栈 / 数量一律写 [待补充: …],不得凭空写成硬约束";

/**
 * 机械判定本次 general 改写模式:会话上下文里有非空 turn → intent,否则 template。
 * 与 Y1X1n 既有语义一致(有上下文时先提炼目的,不套模板)。
 */
export function resolveGeneralMode(
  contextTurns: CompileVars["context_turns"],
): GeneralMode {
  const hasContext = (contextTurns ?? []).some(
    (turn) => String(turn?.text ?? "").trim().length > 0,
  );
  return hasContext ? GENERAL_MODE_INTENT : GENERAL_MODE_TEMPLATE;
}

// ─────────────────────────────────────────────────────────────────────────────
// 八个必出板块(English 板块名 = required_sections 断言锚点;中英并列渲染)
// ─────────────────────────────────────────────────────────────────────────────

interface GeneralSectionSpec {
  /** 契约板块名(English,required_sections 使用;不得改名)。 */
  id: string;
  /** 中文标题。 */
  zh: string;
  /** 该板块要写什么(中文)。 */
  guidanceZh: string;
  /** 该板块要写什么(英文)。 */
  guidanceEn: string;
}

/** general 策略的 8 个必出板块,顺序即输出顺序。 */
export const GENERAL_SECTIONS: readonly GeneralSectionSpec[] = [
  {
    id: "Role",
    zh: "角色",
    guidanceZh:
      "草稿要求模型扮演的角色 / 身份;草稿未给出时写 [待补充: 角色定位],不得替用户设定专家身份",
    guidanceEn:
      "The role the draft asks the model to play; if the draft gives none, write [TODO: role], never assign an expert persona for the user",
  },
  {
    id: "Task Goal",
    zh: "任务目标",
    guidanceZh:
      "草稿要完成的核心任务与目标;必须忠实原文,不得替换成优化器自己的目标,缺失写 [待补充: …]",
    guidanceEn:
      "The core task and goal of the draft, faithful to the original; never replaced by the optimizer's own goal, gaps → [TODO: ...]",
  },
  {
    id: "Input Materials",
    zh: "输入材料",
    guidanceZh:
      "任务可用的输入材料 / 背景 / 数据;逐条标注来自草稿还是上下文,缺失写 [待补充: …]",
    guidanceEn:
      "Available input materials / background / data, each labeled as coming from the draft or the context; gaps → [TODO: ...]",
  },
  {
    id: "Output Format",
    zh: "输出格式",
    guidanceZh:
      "期望的输出形态(文本 / 表格 / 代码 / JSON 等)与篇幅;草稿未明确时保留原样或写 [待补充: …],不得强行套模板",
    guidanceEn:
      "Expected output shape (text / table / code / JSON) and length; when unstated keep it open or write [TODO: ...], never force a template",
  },
  {
    id: "Content Requirements",
    zh: "内容要求",
    guidanceZh:
      "必须覆盖的内容点 / 步骤 / 判断依据;只重组草稿已表达的内容,不得新增未确认的需求",
    guidanceEn:
      "Content points / steps / decision bases that must be covered; only reorganize what the draft states, never add unconfirmed requirements",
  },
  {
    id: "Style",
    zh: "风格",
    guidanceZh:
      "语气 / 受众 / 表达风格;必须与草稿一致,未给出写 [待补充: …],不得自行拔高或转向",
    guidanceEn:
      "Tone / audience / expression style, consistent with the draft; gaps → [TODO: ...], never inflate or redirect it",
  },
  {
    id: "Constraints",
    zh: "约束",
    guidanceZh:
      "用户明确给出的限制 / 禁止项 / 技术栈 / 边界;不得新增无证据硬约束,新增必须带证据或标注建议",
    guidanceEn:
      "Limits / prohibitions / stack / boundaries the user stated; never add unevidenced hard constraints — additions need evidence or a suggestion label",
  },
  {
    id: "Success Criteria",
    zh: "成功标准",
    guidanceZh:
      "判定产出达标的可核查标准(信息是否齐全 / 格式是否匹配 / 约束是否满足);必须可验证,不得写「好看 / 满意」类空泛表述",
    guidanceEn:
      "Verifiable criteria for a successful deliverable (information complete / format matched / constraints met); never vague like 'looks good'",
  },
];

/** required_sections:8 个 English 板块名(顺序即输出顺序;测试断言锚点)。 */
export const GENERAL_REQUIRED_SECTIONS: readonly string[] = GENERAL_SECTIONS.map(
  (section) => section.id,
);

/** 强制板块:任务目标与成功标准不得省略 —— 缺任一即视为通用 Prompt 不完整。 */
export const GENERAL_MANDATORY_SECTIONS: readonly string[] = [
  "Task Goal",
  "Success Criteria",
];

// ─────────────────────────────────────────────────────────────────────────────
// 系统提示词片段
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_ZH = `你是「General 通用 Prompt 编译器」,负责 AUTO 无法判定类型时的兜底改写。用户给你一段口语化、结构松散的提示词草稿,你要把它编译成一份八板块齐全、可直接交给下游 Agent 执行的通用 Prompt。
你不替用户重新定义任务,也不回答草稿里的问题;你只负责:忠实重组草稿原意、暴露缺失信息、把优化器建议与用户要求分开,并按固定板块输出。`

const ROLE_EN = `You are the "General prompt compiler", the fallback used when AUTO cannot decide the type. The user gives you a colloquial, loosely structured draft. You compile it into a general prompt with all eight sections, ready for a downstream agent.
You do not redefine the task and you do not answer the draft's questions. You only reorganize the draft faithfully, expose what is missing, separate optimizer suggestions from user requirements, and output the fixed sections.`

const FIDELITY_ZH = `# 通用纪律(铁律,优先于任何措辞偏好)
1. ${GENERAL_FIDELITY_RULE}:先把草稿已明确的信息逐条列出(对象 / 任务 / 约束 / 范围 / 术语 / 数字 / 语气),再动笔;推断只能影响措辞,绝不写成用户要求。
2. ${GENERAL_NO_INVENTED_CONSTRAINTS}:草稿没说的预算 / 工期 / 平台 / 技术栈 / 数量就是缺口,写成 [待补充: …],不得替用户拍板。
3. 建议保持建议身份:优化器补充的结构 / 格式 / 成功标准必须独立成段并带「${SUGGESTION_LABEL_ZH}」前缀,永不写入「明确要求」段。
4. UNKNOWN ≠ BLOCKING:未知信息保持未知且不阻塞;只有会实质改变任务方向的缺失才允许写成需要用户补充,其余一律保留 [待补充: …]。
5. 专有名词 / 型号 / 产品名 / 缩写 / 数字原样保留:不改写、不意译、不臆造中译名。
6. 语言匹配:草稿以中文为主体 → 输出中文;以英文为主体 → 输出英文。`

const FIDELITY_EN = `# General discipline (iron rules, above any style preference)
1. ${GENERAL_FIDELITY_RULE} — list what the draft explicitly states first (subject / task / constraints / scope / terms / numbers / tone), then write; guesses may shape wording only and never become user requirements.
2. ${GENERAL_NO_INVENTED_CONSTRAINTS} — unstated budget / schedule / platform / stack / quantities are gaps: write [TODO: ...], never decide them for the user.
3. Suggestions stay suggestions: structure / format / success-criteria additions must live in their own section prefixed "${SUGGESTION_LABEL_EN}", never in the "Explicit requirements" section.
4. UNKNOWN ≠ BLOCKING: an unknown stays unknown and does not block; only a gap that would materially change the task direction may become NEEDS_USER_INPUT, everything else stays [TODO: ...].
5. Keep terms: proper nouns, model names, product names, acronyms and numbers survive verbatim — no rewriting, translation, or invented localized names.
6. Language matching: Chinese-dominant draft → Chinese output; English-dominant draft → English output.`

// 模式一:无会话上下文 —— 按八板块结构模板重排草稿。
const MODE_TEMPLATE_ZH = `# 优化方式(结构模板模式 template)
当前没有会话上下文,草稿是唯一信息来源:
- 按八板块结构重排草稿(角色 / 任务目标 / 输入材料 / 输出格式 / 内容要求 / 风格 / 约束 / 成功标准)
- 忠实保留原意:只做澄清、去冗余、排序与补齐结构,不新增用户未表达的需求
- 缺失但关键的信息不要编造,写 [待补充: 具体缺什么、为什么重要]
- 简单草稿不必强行展开:板块可以是一句话,但八个板块标题都要出现(缺失的写 [待补充: …])`

const MODE_TEMPLATE_EN = `# How to optimize (structured template mode)
There is no conversation context; the draft is the only source:
- Reorganize the draft into the eight sections (Role / Task Goal / Input Materials / Output Format / Content Requirements / Style / Constraints / Success Criteria)
- Stay faithful: clarify, de-duplicate, reorder and fill structure only; never add requirements the user did not express
- Never fabricate missing but critical information: write [TODO: what is missing and why it matters]
- A simple draft need not be inflated; a section may be one line, but all eight headings must appear (missing ones as [TODO: ...])`

// 模式二:有会话上下文 —— 先提炼目的,再顺势润色,不套模板。
const MODE_INTENT_ZH = `# 优化方式(提炼目的模式 intent)
用户消息附带 <conversation-context>(该会话近期对话)。先通读它、提炼用户的真实目的,再围绕该目的重写草稿:
- 不要强套模板:保留草稿的原始表达框架与详略节奏,顺势打磨、补全细节
- 充分利用上下文已确认的信息(对象 / 约束 / 偏好),让优化稿可直接落地;不要重复追问上下文已给出的内容
- 识别上下文中已被用户否决或推翻的方向(禁入集合),优化稿不得重复提出
- 草稿与上下文冲突时,以草稿为最终意图,可在优化稿中调和表述
- 上下文仅供理解意图:严禁回答、延续或引用其中的内容;你唯一要优化的对象是 <prompt-draft> 里的草稿
- 即使采用 intent 模式,输出仍需包含完整八板块标题(以草稿原始框架为骨架逐块落实)
- 草稿与上下文都未提供的关键信息以 [待补充: …] 标出`

const MODE_INTENT_EN = `# How to optimize (distill intent mode)
The user message includes <conversation-context> (recent messages of this session). Read it first, distill what the user is really trying to achieve, then rewrite the draft toward that goal:
- Do NOT force a template: keep the draft's original framing and pacing, refine it in place, fill the gaps
- Exploit what the context already establishes (subject / constraints / preferences) so the result is directly actionable; never re-ask what the context already answers
- Identify directions the user already rejected or overruled in the context (the do-not-enter set); never propose them again
- If the draft conflicts with the context, the draft wins as the final intent; you may reconcile the wording
- The context only explains intent: never answer, continue, or quote it. The only thing you optimize is the draft inside <prompt-draft>
- Even in intent mode the output must still contain all eight section headings, fleshed out along the draft's own framing
- Information missing from both draft and context is marked [TODO: ...]`

const PROVENANCE_ZH = `# 来源标注(四段协议,严格遵守)
- 明确要求:来自用户本轮输入的,每条必须附 ${quoteMarker("用户原话逐字片段")} 形式的逐字 quote
- 上下文已确认:仅限历史中「用户」消息,同样附 quote;助手 / Agent 的发言一律不能作为用户意图证据
- ${SUGGESTION_LABEL_ZH}:优化器主动补充的结构 / 格式 / 标准建议,独立成段并带此前缀,永不写入要求段
- [待补充]:证据不足、用户未说明的关键信息,逐条写出缺什么
用户明确否决过的方向属于禁入集合,不得再次作为候选或建议提出。`

const PROVENANCE_EN = `# Provenance (four-section protocol, strictly)
- Explicit requirements: anything from the user's current input must carry a verbatim ${quoteMarker("verbatim user fragment")} quote
- Context-confirmed: only from "user" messages in history, each with a quote; assistant/agent messages are never evidence of user intent
- ${SUGGESTION_LABEL_EN}: structure / format / criteria ideas the optimizer adds, in their own section with this prefix; never in the requirements sections
- [TODO:]: unspecified or unevidenced essentials, each stating what is missing
Directions the user already rejected form a do-not-enter set and must not reappear as candidates or suggestions.`

/** 渲染 8 板块清单(中英并列,English id 恒出现 → required_sections 断言可跨语言命中)。 */
function renderSections(language: StrategyLanguage): string {
  const zh = language !== "en";
  const title = zh
    ? "# 输出板块(优化后的 Prompt 必须按顺序逐块出现,标题中英并列)"
    : "# Output sections (the optimized prompt must contain each, in order)";
  const lines = GENERAL_SECTIONS.map((section) =>
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
    ? `先输出来源段(明确要求 / 上下文已确认 / ${SUGGESTION_LABEL_ZH} / [待补充]),再输出优化后的 Prompt。
- 明确要求:每条附 ${quoteMarker("用户原话")}
- 上下文已确认:仅用「用户」消息,每条附 ${quoteMarker("原话")}
- ${SUGGESTION_LABEL_ZH}:独立成段
- [待补充]:证据不足项,写清缺什么`
    : `First the provenance block (Explicit requirements / Context-confirmed / ${SUGGESTION_LABEL_EN} / [TODO:]), then the optimized prompt.
- Explicit requirements: each with ${quoteMarker("verbatim user fragment")}
- Context-confirmed: user messages only, each with a quote
- ${SUGGESTION_LABEL_EN}: its own section
- [TODO:]: unevidenced items, stating what is missing`;
  const sections = GENERAL_SECTIONS.map((section) => section.id).join(" / ");
  const body = zh
    ? `优化后的 Prompt 必须按顺序包含这 8 个板块:${sections}。Task Goal 与 Success Criteria 不得省略;不得新增用户未给出的硬约束。除输出格式规定的内容外,不要输出多余解释。`
    : `The optimized prompt must contain these 8 sections in order: ${sections}. Task Goal and Success Criteria must not be omitted, and no user-unstated hard constraint may be added. Output nothing beyond the specified format.`;
  return [heading, provenance, body].join("\n");
}

/**
 * general 策略的 system prompt(双语同构,zh 优先)。
 *
 * mode = "auto"(默认)时同时给出 template 与 intent 两套纪律,由 user 载荷点明本次模式;
 * 显式传 mode 时只给出该模式的纪律(便于单测与上层按上下文裁剪)。
 */
export function buildGeneralSystem(
  language: StrategyLanguage,
  mode: GeneralMode | "auto" = "auto",
): string {
  const zh = language !== "en";
  const parts: string[] = [zh ? ROLE_ZH : ROLE_EN, zh ? FIDELITY_ZH : FIDELITY_EN];
  if (mode === "auto" || mode === GENERAL_MODE_TEMPLATE) {
    parts.push(zh ? MODE_TEMPLATE_ZH : MODE_TEMPLATE_EN);
  }
  if (mode === "auto" || mode === GENERAL_MODE_INTENT) {
    parts.push(zh ? MODE_INTENT_ZH : MODE_INTENT_EN);
  }
  parts.push(renderSections(language));
  parts.push(zh ? PROVENANCE_ZH : PROVENANCE_EN);
  parts.push(...sharedRules(language));
  parts.push(buildFormatNote(language));
  return parts.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// user 载荷(注入 raw_input / context / metadata / 缺口 / LLM 派生字段 + 本次模式)
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
  constraints: CompileVars["missing_constraints"],
  language: StrategyLanguage,
): string {
  const zh = language !== "en";
  const items = constraints ?? [];
  if (!items.length) {
    return zh
      ? `尚未提供缺口清单;请在编译中自行识别并以 ${TODO_PLACEHOLDER_PREFIX} …] 形式标出(尤其角色 / 输出格式 / 风格 / 硬约束)。`
      : "No gap list was provided; identify gaps during compilation and mark them as [TODO: ...] (especially role / output format / style / hard constraints).";
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
  push(
    "用户已否决的方向(禁入集合)",
    "Rejected directions (do-not-enter)",
    derived.rejected_directions,
  );
  push("用户已知约束", "Known constraints", derived.known_constraints);
  if (!groups.length) return "";
  const header = zh
    ? "上游 LLM 已提炼的字段(仅作参考;没有逐字证据的一律当假设处理):"
    : "Fields distilled upstream (reference only; anything without a verbatim quote is an assumption):";
  return `${header}\n${groups.join("\n")}`;
}

/** 本次模式的 user 侧显式指令(与 system 的双模式纪律对应)。 */
function renderModeInstruction(mode: GeneralMode, language: StrategyLanguage): string {
  const zh = language !== "en";
  if (mode === GENERAL_MODE_INTENT) {
    return zh
      ? "本次采用 intent 模式(检测到会话上下文):先提炼我的真实目的,再围绕目的润色草稿,不要强套模板,保留草稿原始表达框架。"
      : "This run uses intent mode (conversation context detected): distill my real goal first, then polish the draft toward it; do not force a template, keep the draft's own framing.";
  }
  return zh
    ? "本次采用 template 模式(无会话上下文):按八板块结构模板重排草稿,忠实原意,缺失信息写 [待补充: …]。"
    : "This run uses template mode (no conversation context): reorganize the draft into the eight-section template, stay faithful, and mark missing information as [TODO: ...].";
}

/** general 策略的 user 载荷;语言由 raw_input 主体语言决定(zh 优先)。 */
export function buildGeneralUser(vars: CompileVars): string {
  const language: StrategyLanguage = isChineseDominant(vars.raw_input) ? "zh" : "en";
  const zh = language !== "en";
  const mode = resolveGeneralMode(vars.context_turns);
  const sections: string[] = [];

  const context = renderContext(vars.context_turns, language);
  if (context) sections.push(context);
  const workspace = renderWorkspace(vars.workspace_metadata, language);
  if (workspace) sections.push(workspace);
  const derived = renderLlmDerived(vars.llm_derived, language);
  if (derived) sections.push(derived);
  sections.push(renderMissing(vars.missing_constraints, language));
  sections.push(renderModeInstruction(mode, language));
  sections.push(renderSections(language));

  sections.push(
    zh
      ? `以下是我的提示词草稿(你唯一需要编译的对象;八板块必须齐全,不得新增我未给出的硬约束):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`
      : `Here is my prompt draft (the only thing to compile; all eight sections must be present, and no hard constraint I did not state may be added):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`,
  );
  return sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 守卫(anti-drift):无证据硬约束 / 无证据强断言 / 未知不阻塞 / 建议不得升级
// ─────────────────────────────────────────────────────────────────────────────

/** 用户未给出却写死的量化 / 技术栈硬约束。 */
const INVENTED_HARD_CONSTRAINT_RE =
  /预算|万元|人民币|¥\s?\d|\$\s?\d|工期|截止日期|deadline|\d+\s*(?:天|周|个?月|小时|分钟)(?:内|以内)?|(?:一|两|三|四|五|六|七|八|九|十)\s*(?:天|周|个?月|小时|分钟)(?:内|以内)?|必须使用|只能使用|仅支持|强制使用|硬性要求/i;

/** 守卫 general-no-invented-hard-constraint:无证据的硬约束(铁律 2)。 */
const guardNoInventedHardConstraint: Guard = forbidUnprovenStrongClaim({
  id: "general-no-invented-hard-constraint",
  description: `${GENERAL_NO_INVENTED_CONSTRAINTS};输入未给出且无逐字证据的量化 / 技术栈硬约束即触发`,
  extraPattern: INVENTED_HARD_CONSTRAINT_RE,
});

// ─────────────────────────────────────────────────────────────────────────────
// 保真 / 建议 / 来源规则
// ─────────────────────────────────────────────────────────────────────────────

const preservationRules: PreservationRule[] = [
  {
    id: "general-preserve-subject-terms",
    description:
      "用户输入中的专有名词 / 型号 / 产品名 / 文件名 / 缩写(大写开头、含数字或全大写)必须原样出现在优化稿中",
    check(output, rawInput) {
      const tokens = (rawInput.match(/[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? []).filter(
        (token) => /^[A-Z]/.test(token) || /\d/.test(token),
      );
      if (tokens.length === 0) return true;
      return tokens.every((token) => output.includes(token));
    },
  },
  {
    id: "general-preserve-language",
    description: "优化稿语言必须与用户输入主体语言一致(中文输入 → 中文输出;英文输入 → 英文输出)",
    check(output, rawInput) {
      if (output.trim() === "") return false;
      return isChineseDominant(output) === isChineseDominant(rawInput);
    },
  },
  {
    id: "general-preserve-original-intent",
    description:
      "不得把草稿改写成另一个任务:任务目标 / 对象 / 范围必须可回溯到草稿或上下文已确认信息",
  },
  {
    id: "general-preserve-constraint-set",
    description:
      "用户已明确给出的约束不得被删除或反向;新增约束必须带逐字证据或标为建议 / [待补充: …]",
  },
];

const suggestionRules: SuggestionRule[] = [
  {
    id: "general-suggest-structure",
    description: `可建议用 Markdown 小节 / 编号组织长草稿,但必须标注「${SUGGESTION_LABEL_ZH}」且不得打乱草稿原意`,
  },
  {
    id: "general-suggest-output-format",
    description: "可建议补充输出格式 / 篇幅 / 受众,但不得写成用户已确定的要求",
  },
  {
    id: "general-suggest-success-criteria",
    description: "可建议可核查的成功标准,但不得代替用户判定完成或降低原标准",
  },
  {
    id: "general-suggest-missing-context",
    description:
      "可建议补充关键缺口(技术栈 / 平台 / 时间)及取值方向,但必须保持建议身份,不得凭空给具体数值",
  },
];

const provenanceRules: ProvenanceRule[] = [
  {
    id: "general-quote-explicit",
    description: "明确要求必须逐字来自用户本轮输入,每条附 quote,不得替换成相似说法",
  },
  {
    id: "general-context-user-only",
    description:
      "上下文已确认仅限历史中「用户」消息;助手 / Agent 的发言不能作为用户意图证据",
  },
  {
    id: "general-no-confirmed-without-evidence",
    description:
      "「已确认 / 已确定 / 最终」类结论必须有逐字 quote;否则降级为假设 / 待确认",
  },
  {
    id: "general-unknown-placeholder",
    description: "证据不足的信息写入 [待补充: …],不得自行假定",
  },
  {
    id: "general-suggested-separated",
    description: `优化器建议必须独立成段并标注「${SUGGESTION_LABEL_ZH}」,永不混入要求段`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 策略对象
// ─────────────────────────────────────────────────────────────────────────────

const outputContract: OutputContract = {
  sections: [...GENERAL_REQUIRED_SECTIONS],
  formatNote: buildFormatNote("zh"),
};

/** General PromptStrategy v0.1(纯数据 + 纯函数,零 ctx/UI/Host 依赖)。 */
export const generalStrategy: PromptStrategy = {
  type: "general",
  name: "General（通用 fallback）",
  version: GENERAL_STRATEGY_VERSION,
  purpose:
    "AUTO 无法判定或分类失败时的兜底策略:把口语化、结构松散的草稿编译成八板块齐全的通用 Prompt——忠实重组原意、暴露缺失、区分用户要求与优化器建议,无证据不新增硬约束;无上下文用结构模板模式,有上下文用提炼目的模式。",
  required_sections: [...GENERAL_REQUIRED_SECTIONS],
  optional_sections: [
    "Examples",
    "Background",
    "Acceptance Checklist",
    "Open Questions",
  ],
  preservationRules,
  suggestionRules,
  guards: [
    sectionPresence(GENERAL_REQUIRED_SECTIONS, {
      id: "general-required-sections",
      description: `优化稿必须包含全部 8 个必出板块:${GENERAL_REQUIRED_SECTIONS.join(" / ")}`,
    }),
    sectionPresence(GENERAL_MANDATORY_SECTIONS, {
      id: "general-mandatory-goal-and-success",
      description: `error 级:强制板块不得省略——${GENERAL_MANDATORY_SECTIONS.join(" / ")}(Task Goal 与 Success Criteria 必备)`,
    }),
    guardNoInventedHardConstraint,
    forbidUnprovenStrongClaim({
      id: "general-no-unproven-strong-claim",
      description:
        "「已确认 / 已确定 / 最终 / 已采用 / 不可行」类强断言必须有逐字证据或不确定性标注;无证据的结论一律触发",
      extraPattern: /已定稿|最终定稿|已敲定/,
    }),
    unknownNotBlocking(),
    suggestedNotInExplicit(),
    suggestedNotUpgraded(),
  ],
  provenanceRules,
  buildSystem(language: "zh" | "en"): string {
    return buildGeneralSystem(language);
  },
  buildUser(vars: CompileVars): string {
    return buildGeneralUser(vars);
  },
  outputContract,
};

export default generalStrategy;
