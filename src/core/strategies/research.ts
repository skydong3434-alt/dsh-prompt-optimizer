/**
 * Research PromptStrategy v0.2 —— Vertical Slice 验收路径,按正式契约整合完成。
 *
 * v0.1(P01.5)先打通真实案例;v0.2(P02-T07)在**不改动 15 段契约与 P01.5 验收线**的
 * 前提下补齐正式版内容:把来源规则(provenanceRules)写全,并挂载 `_shared` 的跨策略
 * 不变式 A(UNKNOWN ≠ BLOCKING)/ B(OPTIMIZER_SUGGESTED ≠ USER REQUIREMENT)守卫,
 * 与其余六个策略对齐。
 *
 * 把用户口语化的「研究诉求」编译成可直接交给 Research Agent 执行的研究型 Prompt。
 * 15 个必出段落是测试与校验的断言锚点(见 PLAN-v1 §7 research / §11.2 invariants)。
 *
 * 三条研究铁律(写进 system prompt + guards + 测试):
 *   1. Evidence before conclusion —— 先有证据,后有结论;
 *   2. 没有案例 ≠ 不可行 —— 检索不到现成案例只说明覆盖不足,不得据此淘汰候选;
 *   3. CUDA-only 类平台限制 —— 必须引导研究替代路径,而不是直接放弃。
 *
 * 该模块是纯数据 + 纯函数:零 ctx.llm / UI / Host 依赖,独立 version,可独立测试与升级。
 * 候选与结论分离,是否采用交由 Human Decision Points(用户)决定,优化器不得代选。
 *
 * 全部文案为本项目独立撰写;设计思想(候选/证据/人工决策点分层)为通用研究工程实践,
 * 未复制任何 AGPL 项目的源码 / 模板文本 / 测试。
 */
import { renderDispositionBrief, renderTriageDiscipline } from "../disposition-render.js";
import type {
  CompileResult,
  CompileVars,
  Guard,
  OutputContract,
  PreservationRule,
  PromptStrategy,
  ProvenanceRule,
  SuggestionRule,
} from "../types.js";
import {
  QUOTE_MARKER_PREFIX,
  SUGGESTION_LABEL_EN,
  SUGGESTION_LABEL_ZH,
  TODO_PLACEHOLDER_PREFIX,
  isChineseDominant,
  quoteMarker,
  sharedRules,
  suggestedNotInExplicit,
  suggestedNotUpgraded,
  todoPlaceholder,
  unknownNotBlocking,
  type StrategyLanguage,
} from "./_shared.js";

/** 本策略的独立版本(升级策略不改插件版本,见 PLAN-v1 §4⑤)。 */
export const RESEARCH_STRATEGY_VERSION = "0.2.0";

/** 「没有案例 ≠ 不可行」的固定表述:system 提示词必须包含,测试据此断言。 */
export const NO_CASE_IS_NOT_INFEASIBLE = "没有案例 ≠ 不可行";

// ─────────────────────────────────────────────────────────────────────────────
// 15 个必出段落(English 段落名 = required_sections 断言锚点;中英并列渲染)
// ─────────────────────────────────────────────────────────────────────────────

interface ResearchSectionSpec {
  /** 契约段落名(English,required_sections 使用;不得改名)。 */
  id: string;
  /** 中文标题。 */
  zh: string;
  /** 该段要写什么(中文)。 */
  guidanceZh: string;
  /** 该段要写什么(英文)。 */
  guidanceEn: string;
}

/** research 策略的 15 个必出段落,顺序即输出顺序。 */
export const RESEARCH_SECTIONS: readonly ResearchSectionSpec[] = [
  {
    id: "Background",
    zh: "背景",
    guidanceZh: "用户原始问题、已有信息与信息来源(逐条,来自用户的部分附 quote)",
    guidanceEn: "The user's original question, known context, and where it comes from",
  },
  {
    id: "Research Goal",
    zh: "研究目标",
    guidanceZh: "这次研究要回答的核心问题与期望产出物",
    guidanceEn: "The core question this research must answer and the expected deliverable",
  },
  {
    id: "Existing Knowledge",
    zh: "已知信息",
    guidanceZh: "用户已提供的事实与线索;标注哪些是用户明确说的、哪些只是传闻",
    guidanceEn: "Facts and leads already provided by the user; mark explicit vs hearsay",
  },
  {
    id: "Constraints",
    zh: "约束",
    guidanceZh: "用户明确的硬件/平台/预算/时间/合规边界;未明确的一律按未决项处置纪律处理(省略,或写成动作式/条件式指令)",
    guidanceEn: "User-stated hardware/platform/budget/time/compliance limits; unknown → follow the open-item disposition discipline",
  },
  {
    id: "Candidate Approaches",
    zh: "候选方案",
    guidanceZh: "待研究的候选(仅列候选、适用条件与待验证点,不得写成结论或已选定)",
    guidanceEn: "Candidates to investigate (candidates/conditions/open points only — no conclusions)",
  },
  {
    id: "Research Questions",
    zh: "研究问题",
    guidanceZh: "需要检索与验证的具体问题清单,一问一条、可回答",
    guidanceEn: "Concrete, answerable questions to search and verify, one per line",
  },
  {
    id: "Assumptions To Verify",
    zh: "待验证假设",
    guidanceZh: "当前只是假设、必须有证据检验的判断(不得当成事实)",
    guidanceEn: "Judgments that are currently assumptions and must be tested with evidence",
  },
  {
    id: "Evidence Requirements",
    zh: "证据要求",
    guidanceZh: "每类结论分别需要什么级别的证据(官方文档/实测/可复现博客等)",
    guidanceEn: "What level of evidence each kind of conclusion requires",
  },
  {
    id: "Source Priority",
    zh: "来源优先级",
    guidanceZh: "检索来源优先级:官方文档与一手资料 > 可复现社区实践 > 单点博客/转述",
    guidanceEn: "Source priority: official/primary > reproducible community practice > single blog",
  },
  {
    id: "Conflicting Evidence",
    zh: "冲突证据",
    guidanceZh: "相互矛盾的说法必须并列呈现并标出来源,不得擅自裁决或隐去一方",
    guidanceEn: "Conflicting claims must be shown side by side with sources; never silently pick one",
  },
  {
    id: "Evidence Gaps",
    zh: "证据缺口",
    guidanceZh: "目前还缺哪些关键证据,逐条写清缺什么、为什么重要(不要写 [待补充:] 占位符)",
    guidanceEn: "Which key evidence is still missing, each stating what and why it matters (never a [TODO:] placeholder)",
  },
  {
    id: "Continue-search Conditions",
    zh: "继续检索条件",
    guidanceZh: "何时必须继续检索或更换检索词(如证据冲突、只有单一来源、平台限制未验证)",
    guidanceEn: "Conditions requiring more searching or different queries (conflict, single source, unverified limits)",
  },
  {
    id: "Comparison Dimensions",
    zh: "对比维度",
    guidanceZh: "候选方案的可比维度(兼容性/性能/成本/维护性/生态成熟度等)",
    guidanceEn: "Comparable dimensions across candidates (compatibility/performance/cost/maintenance/ecosystem)",
  },
  {
    id: "Human Decision Points",
    zh: "人工决策点",
    guidanceZh: "必须由用户拍板的选择;优化器只列选项与代价,不得代选",
    guidanceEn: "Choices only the user can make; list options and trade-offs, never decide for them",
  },
  {
    id: "Research Completion Criteria",
    zh: "研究完成标准",
    guidanceZh: "满足什么条件才算研究完成(证据齐、冲突已解释、缺口已显式列出)",
    guidanceEn: "What makes the research complete (evidence sufficient, conflicts explained, gaps explicit)",
  },
];

/** required_sections:15 个 English 段落名(顺序即输出顺序;测试断言锚点)。 */
export const RESEARCH_REQUIRED_SECTIONS: readonly string[] = RESEARCH_SECTIONS.map(
  (section) => section.id,
);

// ─────────────────────────────────────────────────────────────────────────────
// 系统提示词片段
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_ZH = `你是「Research 研究型 Prompt 编译器」。用户给你一段口语化、可能不完整的研究诉求,你要把它编译成一份可以直接交给 Research Agent 执行的研究型 Prompt。
你不回答用户的研究问题,也不替用户做研究;你只负责:忠实提取已知信息、暴露证据缺口、把候选与结论分开、列出必须由用户决定的选择。`

const ROLE_EN = `You are the "Research prompt compiler". The user gives you a colloquial, possibly incomplete research request. You compile it into a research prompt that a Research Agent can execute directly.
You do not answer the research question and you do not do the research. You only: faithfully extract what is known, expose evidence gaps, separate candidates from conclusions, and list the choices only the user can make.`

const DISCIPLINE_ZH = `# 研究纪律(铁律,优先于任何措辞偏好)
1. Evidence before conclusion:每条结论先问「证据在哪」;无证据的判断只能写成研究问题 / 假设 / 未决项(省略或写成动作式/条件式指令),不得写成结论。
2. ${NO_CASE_IS_NOT_INFEASIBLE}:检索不到现成案例,只说明「公开案例未覆盖」,必须继续给出替代路径与验证方式,不得据此判定任何候选方案不可行、不能予以淘汰。
3. 平台限制要落到替代路径:发现某方案仅支持 CUDA 等单一平台限制时,必须引导研究跨平台替代(CPU / Metal / DirectML / 云算力等)及其代价与适用条件,而不是直接放弃该方案。
4. 候选与结论分离:Candidate Approaches 只列候选、适用条件与待验证点;是否采用写入 Human Decision Points 交给用户,优化器不得替用户拍板。
5. 不得凭空发明预算、时间、平台、模型或技术栈等硬约束;用户没说的就是缺口,写成 未决项(省略或写成动作式/条件式指令)。`

const DISCIPLINE_EN = `# Research discipline (iron rules, above any style preference)
1. Evidence before conclusion: ask "where is the evidence?" first; any unevidenced judgment may only appear as a research question, assumption, or open items (omit, or write a before-acting/conditional instruction) — never as a conclusion.
2. Absence of examples is not evidence of infeasibility: not finding a ready-made example only means public coverage is incomplete. Keep proposing alternatives and verification paths; never declare a candidate infeasible or discard it on that basis.
3. Platform limits must lead to alternatives: when a candidate is found to be CUDA-only or otherwise platform-locked, require research into cross-platform alternatives (CPU / Metal / DirectML / cloud compute, etc.) and their costs, instead of dropping the candidate.
4. Candidates vs conclusions: Candidate Approaches lists candidates, conditions, and open points only; whether to adopt goes to Human Decision Points for the user. The optimizer never decides for them.
5. Never invent hard constraints (budget, time, platform, model, stack). If the user did not state it, it is a gap: follow the open-item disposition discipline (omit, or write a before-acting/conditional instruction).`

const PROVENANCE_ZH = `# 来源标注(四段协议,严格遵守)
- 明确要求:来自用户本轮输入的,每条必须附 ${quoteMarker("用户原话逐字片段")} 形式的逐字 quote
- 上下文已确认:仅限历史中「用户」消息,同样附 quote;助手 / Agent 的发言一律不能作为用户意图证据
- ${SUGGESTION_LABEL_ZH}:优化器主动补充的候选 / 维度 / 检索建议,独立成段并带此前缀,永不写入要求段
- 未知项:证据不足、用户未说明的关键信息,逐条写出缺什么
用户明确否决过的方向属于禁入集合,不得再次作为候选或建议提出。`

const PROVENANCE_EN = `# Provenance (four-section protocol, strictly)
- Explicit requirements: anything from the user's current input must carry a verbatim ${quoteMarker("verbatim user fragment")} quote
- Context-confirmed: only from "user" messages in history, each with a quote; assistant/agent messages are never evidence of user intent
- ${SUGGESTION_LABEL_EN}: candidates / dimensions / search ideas the optimizer adds, in their own section with this prefix; never in the requirements sections
- Unknown items: unspecified or unevidenced essentials, each stating what is missing
Directions the user already rejected form a do-not-enter set and must not reappear as candidates or suggestions.`

/** 渲染 15 段清单(中英并列,English id 恒出现 → required_sections 断言可跨语言命中)。 */
function renderSections(language: StrategyLanguage): string {
  const zh = language !== "en";
  const title = zh
    ? "# 信息责任(优化后的 Research Prompt 必须逐项交代清楚;标题可自拟、顺序可调整,责任不得遗漏)"
    : "# Information responsibilities (the optimized Research Prompt must cover each one; titles and order are yours, nothing may be omitted)";
  const lines = RESEARCH_SECTIONS.map((section) =>
    zh
      ? `- ${section.id}（${section.zh}）: ${section.guidanceZh}`
      : `- ${section.id}: ${section.guidanceEn}`,
  );
  return [title, ...lines].join("\n");
}

function buildFormatNote(language: StrategyLanguage): string {
  const zh = language !== "en";
  const heading = zh
    ? "# 输出格式(严格遵守)"
    : "# Output format (strictly follow)";
  const provenance = zh
    ? `先输出来源段(明确要求 / 上下文已确认 / ${SUGGESTION_LABEL_ZH} / 未知项),再输出优化后的 Research Prompt。
- 明确要求:每条附 ${quoteMarker("用户原话")}
- 上下文已确认:仅用「用户」消息,每条附 ${quoteMarker("原话")}
- ${SUGGESTION_LABEL_ZH}:独立成段
- 未知项:证据不足项,写清缺什么`
    : `First the provenance block (Explicit requirements / Context-confirmed / ${SUGGESTION_LABEL_EN} / Unknown items), then the optimized Research Prompt.
- Explicit requirements: each with ${quoteMarker("verbatim user fragment")}
- Context-confirmed: user messages only, each with a quote
- ${SUGGESTION_LABEL_EN}: its own section
- Unknown items: unevidenced items, stating what is missing`;
  const sections = RESEARCH_SECTIONS.map((section) => section.id).join(" / ");
  const body = zh
    ? `优化后的 Research Prompt 必须逐项交代以下 15 项信息责任(id 作为核对锚点,顺序可调整):${sections}。其余细则:
- 转述用户提到的对立说法(如「只能 CUDA」「CUDA 是唯一」)时改写为中性转述(如「称必须依赖 CUDA」),不要原样重复这些口语短语;「只能 CUDA / CUDA 是唯一 / 只有 MPS 可行 / 无法在 Mac」等字面不得出现在任何位置(含 [quote: …] 片段),违者被机械 invariant 判定为「判定不可行」。
- 平台 / 环境 / 模型沿用用户原词(如「Mac M1 Pro」),不要改写成「macOS」「OS」等规范化名称。
- 论证用「缺乏证据 / 待验证 / 需替代路径」措辞;「不可行 / 无法实现」只允许出现在带假设 / 待验证 / 待补充 / 若·如果条件句中。
- 除输出格式规定的内容外,不要输出多余解释。`
    : `The optimized Research Prompt must cover these 15 information responsibilities (each id is a check anchor; order may vary): ${sections}. Further rules:
- When restating opposing claims the user mentioned (e.g. "only CUDA works"), rephrase them neutrally (e.g. "claims CUDA is required"); never repeat such colloquial phrasings verbatim, and pick [quote: ...] fragments that avoid them.
- Keep the user's own wording for platform / environment / model names (e.g. "Mac M1 Pro"); do not normalize to "macOS" / "OS".
- Argue with "lacks evidence / to verify / alternative-path" wording; "infeasible / cannot work" is allowed only inside sentences carrying hypothesis / to-verify / [TODO:] / if-conditional markers.
- Output nothing beyond the specified format.`;
  return [heading, provenance, body].join("\n");
}

/** research 策略的 system prompt(双语同构,zh 优先)。 */
export function buildResearchSystem(language: StrategyLanguage): string {
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
  if (metadata.workspace_name) bits.push(`${zh ? "workspace 名称" : "workspace name"}: ${metadata.workspace_name}`);
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
      "请在研究中自行识别缺口。",
      "identify gaps during research.",
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
  const push = (labelZh: string, labelEn: string, records: { text: string; evidence: string[] }[]) => {
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

/** research 策略的 user 载荷;语言由 raw_input 主体语言决定(zh 优先)。 */
export function buildResearchUser(vars: CompileVars): string {
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
      ? `以下是我的研究诉求(你唯一需要编译的对象):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`
      : `Here is my research request (the only thing to compile):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`,
  );
  return sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 守卫(anti-drift):无证据强断言 / 凭空量化 / 由「没案例」推「不可行」/ 缺口未暴露
// ─────────────────────────────────────────────────────────────────────────────

/** 强断言词:出现即须有逐字证据或不确定性标注,否则触发。 */
const STRONG_ASSERTION =
  /(已确认|已确定|已定论|已拍板|确认采用|确定采用|最终采用|最终方案|定为最终|选定为|不可行|无法实现|行不通|淘汰|放弃|排除)/;

/** 候选名(拉丁词)紧跟确认动词,如「MiniMax 已确认 / H3 采用」。 */
const CANDIDATE_CONFIRMED =
  /([A-Za-z][A-Za-z0-9.+-]{1,})\s*(已确认|确定|采用|选用|定为)/;

/** 凭空量化硬约束(预算 / 金额 / 工期 / 具体时限)。 */
const INVENTED_QUANTITY =
  /(预算(?!\s*(?:边界|取舍|限额))|万元|人民币|¥\s?\d|\$\s?\d|工期(?![^\n。]*待补充)|截止日期|deadline|\d+\s*(?:天|周|个?月|小时|分钟)(?:内|以内)?|(?:一|两|三|四|五|六|七|八|九|十)\s*(?:天|周|个?月|小时|分钟)(?:内|以内))/i;

/** 「没有案例 / 未找到」类前提(允许中间夹少量限定词,如「没有找到 Mac 案例」)。 */
const ABSENCE =
  /(没有[^\n]{0,12}?案例|未(?:能)?找到[^\n]{0,12}?案例|无(?:现成)?案例|暂无案例|找不到[^\n]{0,12}?案例|缺乏案例)/;

/** 「不可行 / 淘汰 / 放弃」类结论。 */
const INFEASIBLE = /(不可行|无法实现|行不通|淘汰|放弃|排除|不予考虑)/;

/** 不确定性 / 建议 / 候选等「已降级」标注:命中则视为该行不是结论。 */
const UNCERTAINTY_MARKER =
  /待补充|待确认|待验证|待定|待复核|假设|候选|可能|建议|需研究|需验证|需核实|存疑|未经证实|无法确认|不排除|研究问题|(?:^|\s)[?？]|不得|禁止|切勿|不要|勿|无需|不允许|不能(?:判定|认定|视为|看作|当作|得)|缺失|缺少|未说明|未提供|未给出|未给定|未提及|未明确|若|如果|假如|倘若/;

function hasEvidenceMarker(text: string): boolean {
  return (
    text.includes(QUOTE_MARKER_PREFIX) ||
    text.includes("[证据:") ||
    text.includes("【证据:")
  );
}

/** 结构性行:Markdown 标题 / 加粗小标题 / 四段协议标签(标签本身不是结论,不得触发守卫)。 */
const STRUCTURAL_LINE =
  /^(?:#{1,6}\s|\*\*[^*]+\*\*\s*$|(?:明确要求|上下文已确认|优化器建议(?:\(可忽略\))?|待补充)\s*[:：]?\s*$)/;

function isStructuralLine(line: string): boolean {
  return STRUCTURAL_LINE.test(line);
}

/** 该行是否已被证据 / 不确定性 / 占位符「保护」,从而不是无证据强断言。 */
function isClaimGuarded(line: string): boolean {
  return (
    isStructuralLine(line) ||
    hasEvidenceMarker(line) ||
    line.includes(TODO_PLACEHOLDER_PREFIX) ||
    UNCERTAINTY_MARKER.test(line)
  );
}

/** 该强断言是否被用户原话或 explicit/context 记录的逐字证据支撑。 */
function evidenceBacks(
  claim: string,
  result: CompileResult,
  rawInput: string,
): boolean {
  const clean = String(claim ?? "").trim();
  if (!clean) return false;
  if (rawInput.includes(clean)) return true;
  const records = [
    ...(result?.explicit_requirements ?? []),
    ...(result?.context_requirements ?? []),
  ];
  return records.some((record) =>
    (record.evidence ?? []).some((quote) => {
      const q = String(quote ?? "").trim();
      return q.length > 0 && (q.includes(clean) || clean.includes(q));
    }),
  );
}

function scanLines(
  output: string,
  result: CompileResult,
  rawInput: string,
  match: (line: string) => string | null,
): string | null {
  // 协议段条目(UNKNOWN / SUGGESTED)本身是「未知/建议」载体,不是断言,整段剔除
  // 四段协议中的元数据段（诊断/建议/未知）本身不是断言或要求,整段跳过;
  // EXPLICIT / CONTEXT / OPTIMIZED 段照常扫描(后者即最终交付文本)。
  let inMetaSection = false;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const marker = /^<<<([A-Z]+)>>>$/.exec(line);
    if (marker) {
      inMetaSection = ["DIAGNOSIS", "SUGGESTED", "UNKNOWN"].includes(marker[1]);
      continue;
    }
    if (!line || inMetaSection || isClaimGuarded(line)) continue;
    const claim = match(line);
    if (claim && !evidenceBacks(claim, result, rawInput)) return claim;
  }
  return null;
}

/** 守卫 1:无证据强断言(已确认 / 最终 / 不可行 / 淘汰…)。 */
const guardNoUnfoundedStrongAssertion: Guard = {
  id: "research-no-unfounded-strong-assertion",
  description:
    "「已确认/确定/最终/采用/不可行/淘汰」类强断言必须有逐字证据或标注为假设;否则触发",
  check(output, result, rawInput) {
    const claim = scanLines(output, result, rawInput, (line) => {
      const strong = line.match(STRONG_ASSERTION)?.[0];
      if (strong) return strong;
      return line.match(CANDIDATE_CONFIRMED)?.[2] ?? null;
    });
    if (!claim) return null;
    return `发现无证据强断言「${claim}」:只能写成假设 / 研究问题 / 未决项(省略或写成动作式/条件式指令),不得作为结论`;
  },
};

/** 守卫 2:凭空量化硬约束(预算 / 金额 / 时限)。 */
const guardNoInventedQuantities: Guard = {
  id: "research-no-invented-quantities",
  description: "预算/金额/工期/时限等量化约束若用户未提供且无证据,不得写入;触发",
  check(output, result, rawInput) {
    const matched = scanLines(output, result, rawInput, (line) => {
      return line.match(INVENTED_QUANTITY)?.[0] ?? null;
    });
    if (!matched) return null;
    return `发现无证据量化约束「${matched}」:用户未提供的预算/工期/时限必须写成 未决项(省略或写成动作式/条件式指令)`;
  },
};

/** 守卫 3:把「没有案例」当成「不可行」的依据。 */
const guardNoInfeasibleFromAbsence: Guard = {
  id: "research-no-infeasible-from-absence",
  description:
    "同一行内用「没有案例/未找到」佐证「不可行/淘汰/放弃」时触发(没有案例 ≠ 不可行)",
  check(output, result, rawInput) {
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || isClaimGuarded(line)) continue;
      if (!ABSENCE.test(line) || !INFEASIBLE.test(line)) continue;
      const claim = line.match(INFEASIBLE)?.[0] ?? "";
      if (evidenceBacks(claim, result, rawInput)) continue;
      return `用「未找到案例」推出「${claim}」:${NO_CASE_IS_NOT_INFEASIBLE},必须改为继续研究替代路径`;
    }
    return null;
  },
};

/**
 * 守卫 4:优化稿必须显式暴露证据缺口。
 *
 * v2 Phase 2 起缺口有两种合法表达(docs/phase2-contract.md):**证据要求**类正文段,
 * 或**执行前须知 / 分支条件**里的动作式 / 条件式指令;旧的 `[待补充:]` 已退役,
 * 因此不再作为合格形式(它反而会被 responsibilityDiscipline 判违规)。
 */
const guardEvidenceGapDisclosure: Guard = {
  id: "research-require-evidence-gap-disclosure",
  description: "优化稿必须包含证据缺口引导(证据要求 / 执行前须知 / 分支条件);否则触发",
  check(output) {
    if (
      /证据|Evidence|evidence|缺口|动手前先确认|执行前须知|分支条件|待验证|待确认/.test(output)
    ) {
      return null;
    }
    return "优化稿未暴露任何证据缺口:必须至少给出 证据要求 / 执行前须知 / 分支条件 三类形式之一";
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 保真 / 建议 / 来源规则
// ─────────────────────────────────────────────────────────────────────────────

const preservationRules: PreservationRule[] = [
  {
    id: "research-preserve-subject-terms",
    description:
      "用户输入中的专有名词 / 型号 / 产品名(大写开头、含数字或全大写)必须原样出现在优化稿中",
    check(output, rawInput) {
      const tokens = (rawInput.match(/[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? []).filter(
        (token) => /^[A-Z]/.test(token) || /\d/.test(token),
      );
      if (tokens.length === 0) return true;
      return tokens.every((token) => output.includes(token));
    },
  },
  {
    id: "research-preserve-language",
    description: "优化稿语言必须与用户输入主体语言一致(中文输入 → 中文输出)",
    check(output, rawInput) {
      if (output.trim() === "") return false;
      return isChineseDominant(output) === isChineseDominant(rawInput);
    },
  },
  {
    id: "research-preserve-candidate-count",
    description:
      "用户点名过的候选线索数量不得减少;不得擅自合并或丢弃用户已列出的候选",
  },
];

const suggestionRules: SuggestionRule[] = [
  {
    id: "research-suggest-output-format",
    description: `可建议补充输出格式 / 受众 / 用途,但必须标注「${SUGGESTION_LABEL_ZH}」`,
  },
  {
    id: "research-suggest-source-priority",
    description:
      "可建议来源优先级(官方文档 > 可复现社区实践 > 单点博客),不得代替用户决定",
  },
  {
    id: "research-suggest-time-box",
    description: "可建议设置检索时间窗口或搜索预算,但不得凭空给出具体数值",
  },
  {
    id: "research-suggest-fallback-paths",
    description:
      "发现 CUDA-only 等平台限制时,建议研究替代路径(CPU / Metal / DirectML / 云算力)",
  },
];

const provenanceRules: ProvenanceRule[] = [
  {
    id: "research-quote-candidates",
    description:
      "候选方案 / 产品名必须逐字来自用户输入或上下文用户消息,不得替换成相似名",
  },
  {
    id: "research-no-confirmed-without-evidence",
    description:
      "「已确认 / 最终 / 采用」类结论必须有逐字 quote;否则降级为假设 / 候选 / 待确认",
  },
  {
    id: "research-context-user-only",
    description:
      "上下文已确认仅限历史中「用户」消息;助手 / Agent 的发言不能作为用户意图证据(只能标为可能相关提示)",
  },
  {
    id: "research-conflicting-evidence-side-by-side",
    description:
      "冲突证据必须并列呈现并标出来源,不得擅自裁决、静默择一或隐去一方",
  },
  {
    id: "research-gaps-explicit",
    description:
      "证据缺口必须显式落成 未决项(省略或写成动作式/条件式指令) / Evidence Gaps 段,不得用默认值或未标注的假设替代",
  },
  {
    id: "research-unknown-placeholder",
    description: "证据不足的约束与事实写入 未决项(省略或写成动作式/条件式指令),不得自行假定",
  },
  {
    id: "research-suggested-separated",
    description: `优化器建议必须独立成段并标注「${SUGGESTION_LABEL_ZH}」,永不混入要求段`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 策略对象
// ─────────────────────────────────────────────────────────────────────────────

const outputContract: OutputContract = {
  /** v2:信息责任清单(不再强制模板段落;id 作为核对锚点)。 */
  responsibilities: [...RESEARCH_REQUIRED_SECTIONS],
  /** @deprecated 与 responsibilities 内容一致;保留给旧消费方。 */
  sections: [...RESEARCH_REQUIRED_SECTIONS],
  formatNote: buildFormatNote("zh"),
};

/** Research PromptStrategy v0.1(纯数据 + 纯函数,零 ctx/UI/Host 依赖)。 */
export const researchStrategy: PromptStrategy = {
  type: "research",
  name: "Research（研究）",
  version: RESEARCH_STRATEGY_VERSION,
  purpose:
    "把用户口语化的研究诉求编译成可直接交给 Research Agent 执行的研究型 Prompt:先证据、后结论;候选与结论分离;缺证据就写明缺口,平台限制引导替代路径。",
  informationResponsibilities: [...RESEARCH_REQUIRED_SECTIONS],
  /** @deprecated 保留给旧消费方;内容与 informationResponsibilities 一致。 */
  required_sections: [...RESEARCH_REQUIRED_SECTIONS],
  optional_sections: [
    "Search Log",
    "Open Questions",
    "Timeline",
    "Risk Notes",
  ],
  preservationRules,
  suggestionRules,
  guards: [
    guardNoUnfoundedStrongAssertion,
    guardNoInventedQuantities,
    guardNoInfeasibleFromAbsence,
    guardEvidenceGapDisclosure,
    unknownNotBlocking(),
    suggestedNotInExplicit(),
    suggestedNotUpgraded(),
  ],
  provenanceRules,
  buildSystem(language: "zh" | "en"): string {
    return buildResearchSystem(language);
  },
  buildUser(vars: CompileVars): string {
    return buildResearchUser(vars);
  },
  outputContract,
};

export default researchStrategy;
