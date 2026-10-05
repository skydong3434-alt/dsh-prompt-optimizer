/**
 * Diagnostic PromptStrategy v0.1 —— P02-T04。
 *
 * 把用户口语化的「排障诉求」(例如「P8-08 为什么一直超时?」)编译成一份可直接照做的
 * 诊断型 Prompt:先固定症状 / 期望 / 实际,再收集证据、复现、提出假设、做根因分析,
 * 用 Disprove-Verify 逐个证伪 / 验证,最后才给修复建议与回归测试。
 *
 * 诊断铁律(写进 system prompt + guards + 测试):
 *   1. 验证先于修改 —— 先取证、复现、验证假设,再谈修复;禁止未经验证直接给「修复代码」;
 *   2. Hypotheses 假设段必备 —— 候选原因只能是待验证假设,不得写成已确认结论;
 *   3. Disprove-Verify 证伪/验证段必备 —— 每个假设都要给出证伪 / 证实方式与判别标准;
 *   4. Fix Proposal 必须含验证 / 复测步骤 —— 只给改动、不给复测的修复建议视为不合格。
 *
 * 该模块是纯数据 + 纯函数:零 ctx.llm / UI / Host 依赖,独立 version,可独立测试与升级。
 * 复用 `_shared.ts` 的跨策略不变式 A(UNKNOWN ≠ BLOCKING)/ B(SUGGESTED ≠ USER REQUIREMENT)
 * 与「无证据强断言」守卫工厂。
 *
 * 全部文案为本项目独立撰写;设计思想(先证据后修改 + 假设证伪 + 回归测试)为通用排障实践,
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
export const DIAGNOSTIC_STRATEGY_VERSION = "0.1.0";

/** 铁律 1 的固定表述:验证先于修改。 */
export const EVIDENCE_BEFORE_MODIFICATION =
  "验证先于修改:先取证、复现、验证假设,再给修复建议";

/** 铁律 2 的固定表述:假设段必备且必须标为待验证。 */
export const HYPOTHESES_MANDATORY = "Hypotheses 假设段必备,候选原因只能标为待验证";

/** 铁律 3 的固定表述:证伪 / 验证段必备。 */
export const DISPROVE_VERIFY_MANDATORY = "Disprove-Verify 证伪/验证段必备";

/** 铁律 4 的固定表述:修复建议必须带验证 / 复测。 */
export const FIX_REQUIRES_VERIFICATION = "Fix Proposal 必须含验证/复测步骤";

/** 英文版铁律 2/3 的固定表述(与中文常量同义,供 en system 引用)。 */
const HYPOTHESES_MANDATORY_EN =
  "Hypotheses are mandatory and every candidate cause must stay unverified";
const DISPROVE_VERIFY_MANDATORY_EN = "Disprove-Verify is mandatory";

// ─────────────────────────────────────────────────────────────────────────────
// 10 个必出段落(English 段落名 = required_sections 断言锚点;中英并列渲染)
// ─────────────────────────────────────────────────────────────────────────────

interface DiagnosticSectionSpec {
  /** 契约段落名(English,required_sections 使用;不得改名)。 */
  id: string;
  /** 中文标题。 */
  zh: string;
  /** 该段要写什么(中文)。 */
  guidanceZh: string;
  /** 该段要写什么(英文)。 */
  guidanceEn: string;
}

/** diagnostic 策略的 10 个必出段落,顺序即输出顺序(PLAN-v1 §7 diagnostic)。 */
export const DIAGNOSTIC_SECTIONS: readonly DiagnosticSectionSpec[] = [
  {
    id: "Symptom",
    zh: "症状",
    guidanceZh:
      "用户观察到的表象(报错 / 超时 / 结果不对);只描述现象,不写任何因果结论,猜测不得写成事实",
    guidanceEn:
      "The observable symptom (error / timeout / wrong result); describe the phenomenon only, never assert a cause",
  },
  {
    id: "Expected Behavior",
    zh: "期望行为",
    guidanceZh:
      "用户期望发生什么;来源必须能回溯到用户输入或上下文用户消息,否则按未决项处置纪律处理(省略,或写成动作式/条件式指令)",
    guidanceEn:
      "What the user expects to happen; must trace to user input or user context, otherwise open items (omit, or write a before-acting/conditional instruction)",
  },
  {
    id: "Actual Behavior",
    zh: "实际行为",
    guidanceZh:
      "实际发生了什么;报错原文、错误码、关键数字与时间戳必须原样保留,不得改写或概括",
    guidanceEn:
      "What actually happens; error text, codes, numbers and timestamps kept verbatim, never paraphrased",
  },
  {
    id: "Evidence Collection",
    zh: "证据收集",
    guidanceZh:
      "需要收集哪些证据(日志原文 / 复现命令输出 / 环境与版本 / 时间线 / 影响范围);证据不足逐条按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得编造",
    guidanceEn:
      "Which evidence to collect (raw logs / command output / environment and versions / timeline / blast radius); gaps → follow the open-item disposition discipline, never fabricated",
  },
  {
    id: "Reproduction",
    zh: "复现",
    guidanceZh:
      "最小可复现步骤、触发条件与复现频率;不能稳定复现时必须如实说明,不得假装已复现",
    guidanceEn:
      "Minimal reproduction steps, trigger conditions and frequency; if not reproducible, say so, never pretend",
  },
  {
    id: "Hypotheses",
    zh: "假设",
    guidanceZh:
      "候选原因清单,每条标注状态并保持待验证(如 H1 待验证);禁止把假设写成根因结论",
    guidanceEn:
      "Candidate causes, each kept as unverified (e.g. H1 unverified); never state a hypothesis as the root cause",
  },
  {
    id: "Root Cause Analysis",
    zh: "根因分析",
    guidanceZh:
      "基于已验证证据的推理链;证据不足时明确写「根因待验证」,不得跳过验证直接下结论",
    guidanceEn:
      "Reasoning chain over verified evidence; when evidence is thin, say the root cause is unverified and never jump to a conclusion",
  },
  {
    id: "Disprove-Verify",
    zh: "证伪/验证",
    guidanceZh:
      "逐个假设给出证伪 / 证实方式与判别标准(实验 / 对照 / 观测);证伪优先,先排除再确认",
    guidanceEn:
      "For each hypothesis, how to disprove or verify it and the decision criterion (experiment / control / observation); falsify first",
  },
  {
    id: "Fix Proposal",
    zh: "修复建议",
    guidanceZh:
      "只针对已验证根因给修复方案,且必须含验证 / 复测步骤与回滚考虑;未验证前不得直接给「修复代码」",
    guidanceEn:
      "Fix only for a verified root cause, and it must include verification / re-test steps and rollback; no fix code before verification",
  },
  {
    id: "Regression Test",
    zh: "回归测试",
    guidanceZh:
      "防止复发的回归用例 / 命令 / 判定标准,必须可复现;不得只写「测试通过」",
    guidanceEn:
      "Regression cases / commands / pass criteria that prevent recurrence, fully reproducible; never just 'tests pass'",
  },
];

/** required_sections:10 个 English 段落名(顺序即输出顺序;测试断言锚点)。 */
export const DIAGNOSTIC_REQUIRED_SECTIONS: readonly string[] =
  DIAGNOSTIC_SECTIONS.map((section) => section.id);

/**
 * 强制段:任务契约点名 Hypotheses 与 Disprove-Verify 不得省略;
 * 同时把「先证据后修改」链条上的关键段(症状 / 证据 / 复现 / 修复 / 回归)一并锁死。
 */
export const DIAGNOSTIC_MANDATORY_SECTIONS: readonly string[] = [
  "Symptom",
  "Evidence Collection",
  "Reproduction",
  "Hypotheses",
  "Disprove-Verify",
  "Fix Proposal",
  "Regression Test",
];

// ─────────────────────────────────────────────────────────────────────────────
// 系统提示词片段
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_ZH = `你是「Diagnostic 诊断型 Prompt 编译器」。用户给你一段口语化、可能只有现象的排障诉求(常见如「P8-08 为什么一直超时?」「这里为什么报错?」),你要把它编译成一份可以直接照做的诊断型 Prompt。
你不替用户下结论、也不直接给出「修复代码」;你只负责:固定症状与期望 / 实际的差距、列出要收集的证据、给出复现步骤、提出待验证假设、做根因分析、用证伪 / 验证区分假设,最后才给带复测的修复建议与回归测试。`

const ROLE_EN = `You are the "Diagnostic prompt compiler". The user gives you a colloquial troubleshooting request that may only describe a symptom ("why does P8-08 keep timing out?", "why does this error?"). You compile it into a diagnostic prompt that can be followed directly.
You do not conclude for the user and you do not hand out fix code; you only: pin down symptom and expected-vs-actual, list the evidence to collect, give reproduction steps, raise unverified hypotheses, reason about the root cause, separate hypotheses by disproof / verification, and only then give a fix proposal with re-test plus regression tests.`

const DISCIPLINE_ZH = `# 诊断纪律(铁律,优先于任何措辞偏好)
1. ${EVIDENCE_BEFORE_MODIFICATION}:输出顺序必须是 症状 / 期望 / 实际 → 证据收集 → 复现 → 假设 → 根因分析 → 证伪·验证 → 修复建议 → 回归测试;Fix Proposal 不得出现在证据、复现、假设与证伪·验证之前。
2. ${HYPOTHESES_MANDATORY}:候选原因逐条列出并保持待验证状态;不得把假设、推断或「常见原因」直接写成根因结论。
3. ${DISPROVE_VERIFY_MANDATORY}:每个假设都要给出证伪 / 证实方式与判别标准;能先证伪的先证伪,不得只给「进一步排查」。
4. ${FIX_REQUIRES_VERIFICATION}:修复建议必须写清改完后如何验证 / 复测(命令、对照、预期结果)以及回滚方式;只给改动、不给复测的建议视为不合格。
5. 证据优先于结论:Root Cause Analysis 只使用已验证证据;证据不足时写「根因待验证」并按未决项处置纪律处理,不得跳过验证直接下结论。
6. 不发明证据:日志原文 / 报错码 / 版本 / 时间戳 / 复现频率不得编造;复现不了要如实写明「暂不可复现」。
7. 未验证不修改:在假设被验证前不得要求直接改代码;如需临时缓解,必须标注为「临时缓解(未经根因验证)」并说明代价。
8. UNKNOWN ≠ BLOCKING:未知信息保持未知,不阻塞后续合理推进;不代用户拍板,未知按未决项处置纪律处理(省略,或写成动作式/条件式指令)。`

const DISCIPLINE_EN = `# Diagnostic discipline (iron rules, above any style preference)
1. Verification before modification: order must be Symptom / Expected / Actual → Evidence Collection → Reproduction → Hypotheses → Root Cause Analysis → Disprove-Verify → Fix Proposal → Regression Test. Fix Proposal must never appear before evidence, reproduction, hypotheses and disprove/verify.
2. ${HYPOTHESES_MANDATORY_EN}: list candidate causes and keep each unverified; never write a hypothesis, guess, or "common cause" as the root-cause conclusion.
3. ${DISPROVE_VERIFY_MANDATORY_EN}: for every hypothesis give a disproof / verification method and a decision criterion; prefer falsifying first, never just "investigate further".
4. Fix Proposal must include verification / re-test steps (command, control, expected result) and rollback; a change without re-test is unacceptable.
5. Evidence before conclusion: Root Cause Analysis uses verified evidence only; when evidence is thin, say "root cause unverified" and follow the open-item disposition discipline (omit, or write a before-acting/conditional instruction), never jump to a conclusion.
6. Never fabricate evidence: raw logs / error codes / versions / timestamps / reproduction rate must not be invented; if it cannot be reproduced, say so.
7. No modification before verification: never ask to change code before a hypothesis is verified; a stopgap must be labeled "temporary mitigation (root cause unverified)" with its cost.
8. UNKNOWN ≠ BLOCKING: unknowns stay unknown and do not block reasonable progress; never decide for the user, follow the open-item disposition discipline (omit, or write a before-acting/conditional instruction).`

const PROVENANCE_ZH = `# 来源标注(四段协议,严格遵守)
- 明确要求:来自用户本轮输入的,每条必须附 ${quoteMarker("用户原话逐字片段")} 形式的逐字 quote
- 上下文已确认:仅限历史中「用户」消息,同样附 quote;助手 / Agent 的发言一律不能作为用户意图证据
- ${SUGGESTION_LABEL_ZH}:优化器主动补充的取证手段 / 观测方式 / 临时缓解,独立成段并带此前缀,永不写入要求段
- 未知项:证据不足、用户未说明的关键信息(如复现条件 / 环境版本),逐条写出缺什么
用户明确否决过的方向属于禁入集合,不得再次作为假设 / 建议提出。`

const PROVENANCE_EN = `# Provenance (four-section protocol, strictly)
- Explicit requirements: anything from the user's current input must carry a verbatim ${quoteMarker("verbatim user fragment")} quote
- Context-confirmed: only from "user" messages in history, each with a quote; assistant/agent messages are never evidence of user intent
- ${SUGGESTION_LABEL_EN}: evidence-gathering methods / observability / temporary mitigations the optimizer adds, in their own section with this prefix; never in the requirements sections
- Unknown items: unspecified or unevidenced essentials (reproduction conditions, environment versions), each stating what is missing
Directions the user already rejected form a do-not-enter set and must not reappear as hypotheses or suggestions.`

/** 渲染 10 段清单(中英并列,English id 恒出现 → required_sections 断言可跨语言命中)。 */
function renderSections(language: StrategyLanguage): string {
  const zh = language !== "en";
  const title = zh
    ? "# 信息责任(优化后的 Diagnostic Prompt 必须逐项交代清楚;标题可自拟、顺序可调整,责任不得遗漏)"
    : "# Information responsibilities (the optimized Diagnostic Prompt must cover each one; titles and order are yours, nothing may be omitted)";
  const lines = DIAGNOSTIC_SECTIONS.map((section) =>
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
    ? `先输出来源段(明确要求 / 上下文已确认 / ${SUGGESTION_LABEL_ZH} / 未知项),再输出优化后的 Diagnostic Prompt。
- 明确要求:每条附 ${quoteMarker("用户原话")}
- 上下文已确认:仅用「用户」消息,每条附 ${quoteMarker("原话")}
- ${SUGGESTION_LABEL_ZH}:独立成段
- 未知项:证据不足项,写清缺什么`
    : `First the provenance block (Explicit requirements / Context-confirmed / ${SUGGESTION_LABEL_EN} / Unknown items), then the optimized Diagnostic Prompt.
- Explicit requirements: each with ${quoteMarker("verbatim user fragment")}
- Context-confirmed: user messages only, each with a quote
- ${SUGGESTION_LABEL_EN}: its own section
- Unknown items: unevidenced items, stating what is missing`;
  const sections = DIAGNOSTIC_SECTIONS.map((section) => section.id).join(" / ");
  const body = zh
    ? `优化后的 Diagnostic Prompt 必须逐项交代以下 10 项信息责任(id 作为核对锚点,顺序可调整):${sections}。Hypotheses / Disprove-Verify / Fix Proposal / Regression Test 不得省略;Fix Proposal 必须含验证 / 复测步骤,且不得出现在证据与复现之前。除输出格式规定的内容外,不要输出多余解释。`
    : `The optimized Diagnostic Prompt must cover these 10 information responsibilities (each id is a check anchor; order may vary): ${sections}. Hypotheses / Disprove-Verify / Fix Proposal / Regression Test must not be omitted; Fix Proposal must include verification / re-test steps and must not precede evidence and reproduction. Output nothing beyond the specified format.`;
  return [heading, provenance, body].join("\n");
}

/** diagnostic 策略的 system prompt(双语同构,zh 优先)。 */
export function buildDiagnosticSystem(language: StrategyLanguage): string {
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
    "请在编译中自行识别缺口(尤其复现条件 / 环境版本 / 证据来源)。",
    "identify gaps during compilation (especially reproduction conditions / environment versions / evidence sources).",
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
    ? "上游 LLM 已提炼的字段(仅作参考;没有逐字证据的一律当假设处理,不得当作已确认证据):"
    : "Fields distilled upstream (reference only; anything without a verbatim quote is a hypothesis, not confirmed evidence):";
  return `${header}\n${groups.join("\n")}`;
}

/** diagnostic 策略的 user 载荷;语言由 raw_input 主体语言决定(zh 优先)。 */
export function buildDiagnosticUser(vars: CompileVars): string {
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
      ? `以下是我的排障诉求(你唯一需要编译的对象;先证据、后结论,未验证不得直接改):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`
      : `Here is my troubleshooting request (the only thing to compile; evidence first, then conclusions, no unverified fix):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`,
  );
  return sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 段落块解析(供「修复必须带验证」「不得先改后查」守卫共用)
// ─────────────────────────────────────────────────────────────────────────────

/** Markdown 标题行(只把标题作为段落边界;正文提及不算)。 */
const HEADING_RE = /^#{1,6}\s*(.+?)\s*$/;

/** 一个标题块:标题 + 该标题到下一个标题之间的正文。 */
interface HeadingBlock {
  heading: string;
  body: string;
}

/** 按 Markdown 标题切块(无标题的散行不归属任何块)。 */
function splitHeadingBlocks(output: string): HeadingBlock[] {
  const blocks: HeadingBlock[] = [];
  let current: HeadingBlock | null = null;
  for (const rawLine of String(output ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = HEADING_RE.exec(line);
    if (match) {
      current = { heading: match[1], body: "" };
      blocks.push(current);
      continue;
    }
    if (current && line) {
      current.body = current.body ? `${current.body}\n${line}` : line;
    }
  }
  return blocks;
}

/** 段落标题别名(中英并列;标题包含任一别名即命中)。 */
const FIX_PROPOSAL_ALIASES: readonly string[] = ["Fix Proposal", "修复建议"];
const EVIDENCE_ALIASES: readonly string[] = ["Evidence Collection", "证据收集"];
const REPRODUCTION_ALIASES: readonly string[] = ["Reproduction", "复现"];
const HYPOTHESES_ALIASES: readonly string[] = ["Hypotheses", "假设"];
const DISPROVE_VERIFY_ALIASES: readonly string[] = ["Disprove-Verify", "Disprove", "证伪"];
const REGRESSION_TEST_ALIASES: readonly string[] = ["Regression Test", "回归测试"];

/** 找到第一个命中任一别名的标题块。 */
function findBlock(blocks: HeadingBlock[], aliases: readonly string[]): HeadingBlock | undefined {
  return blocks.find((block) =>
    aliases.some((alias) => block.heading.toLowerCase().includes(alias.toLowerCase())),
  );
}

/** 找到第一个命中任一别名的标题块位置(找不到返回 -1)。 */
function blockPosition(blocks: HeadingBlock[], aliases: readonly string[]): number {
  return blocks.findIndex((block) =>
    aliases.some((alias) => block.heading.toLowerCase().includes(alias.toLowerCase())),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 守卫(anti-drift):修复必须带验证 / 不得先改后查 / 强制段 + 不变式 A·B
// ─────────────────────────────────────────────────────────────────────────────

/** 修复建议中「验证 / 复测」的可识别措辞(中英同构,suggested 段不参与)。 */
const FIX_VERIFICATION_RE =
  /验证|复测|重测|回归|复现|证伪|证实|反证|对照|实验|测试|确认修复|证明|verify|verification|regression|re-?test|reproduce|disprove|prove|test/i;

/** 守卫 1:Fix Proposal 必须含验证 / 复测步骤(任务契约点名 error)。 */
const guardFixRequiresVerification: Guard = {
  id: "diagnostic-fix-requires-verification",
  description: `${FIX_REQUIRES_VERIFICATION};修复建议段为空、或只给改动而没有任何验证 / 复测步骤即触发`,
  check(output) {
    const blocks = splitHeadingBlocks(output);
    const fix = findBlock(blocks, FIX_PROPOSAL_ALIASES);
    // 段落缺失由 required-sections / mandatory 守卫负责,这里只判「有修复但没验证」。
    if (!fix) return null;
    const body = fix.body.trim();
    if (!body) {
      return `Fix Proposal（${fix.heading}）段为空:修复建议必须含验证 / 复测步骤,不得只给结论`;
    }
    if (!FIX_VERIFICATION_RE.test(body)) {
      return `Fix Proposal 只给出改动、没有任何验证 / 复测步骤:${FIX_REQUIRES_VERIFICATION}`;
    }
    return null;
  },
};

/** 守卫 2:验证先于修改 —— Fix Proposal 不得出现在证据 / 复现 / 假设 / 证伪验证之前。 */
const guardNoFixBeforeEvidence: Guard = {
  id: "diagnostic-no-fix-before-evidence",
  description: `${EVIDENCE_BEFORE_MODIFICATION};Fix Proposal 出现在 Evidence Collection / Reproduction / Hypotheses / Disprove-Verify 之前即触发`,
  check(output) {
    const blocks = splitHeadingBlocks(output);
    const fixPos = blockPosition(blocks, FIX_PROPOSAL_ALIASES);
    if (fixPos < 0) return null;
    const prerequisites: readonly [string, readonly string[]][] = [
      ["Evidence Collection", EVIDENCE_ALIASES],
      ["Reproduction", REPRODUCTION_ALIASES],
      ["Hypotheses", HYPOTHESES_ALIASES],
      ["Disprove-Verify", DISPROVE_VERIFY_ALIASES],
    ];
    for (const [label, aliases] of prerequisites) {
      const pos = blockPosition(blocks, aliases);
      if (pos >= 0 && pos > fixPos) {
        return `Fix Proposal 出现在 ${label} 之前:${EVIDENCE_BEFORE_MODIFICATION}`;
      }
    }
    return null;
  },
};

/** 守卫 3:Fix Proposal 与 Regression Test 必须衔接(修复后必须可回归复测)。 */
const guardFixNeedsRegressionTest: Guard = {
  id: "diagnostic-fix-needs-regression-test",
  description:
    "Fix Proposal 必须能落到 Regression Test(回归测试段不得缺位或为空);否则触发",
  check(output) {
    const blocks = splitHeadingBlocks(output);
    const fix = findBlock(blocks, FIX_PROPOSAL_ALIASES);
    if (!fix) return null;
    const regression = findBlock(blocks, REGRESSION_TEST_ALIASES);
    if (!regression) {
      return "缺少 Regression Test（回归测试）段:修复建议必须有可复现的回归用例";
    }
    if (!regression.body.trim()) {
      return "Regression Test（回归测试）段为空:必须给出可复现的回归用例 / 命令 / 判定标准";
    }
    return null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 保真 / 建议 / 来源规则
// ─────────────────────────────────────────────────────────────────────────────

const preservationRules: PreservationRule[] = [
  {
    id: "diagnostic-preserve-error-signals",
    description:
      "用户输入中的报错码 / Task 编号 / 专有名词 / 型号 / 文件与模块名 / 数字(大写开头、含数字或全大写)必须原样出现在优化稿中",
    check(output, rawInput) {
      const tokens = (rawInput.match(/[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? []).filter(
        (token) => /^[A-Z]/.test(token) || /\d/.test(token),
      );
      if (tokens.length === 0) return true;
      return tokens.every((token) => output.includes(token));
    },
  },
  {
    id: "diagnostic-preserve-language",
    description: "优化稿语言必须与用户输入主体语言一致(中文输入 → 中文输出)",
    check(output, rawInput) {
      if (output.trim() === "") return false;
      return isChineseDominant(output) === isChineseDominant(rawInput);
    },
  },
  {
    id: "diagnostic-preserve-evidence-verbatim",
    description:
      "用户已给出的报错原文 / 日志片段 / 时间戳不得改写、概括或重新编号;缺失的证据按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得编造",
  },
  {
    id: "diagnostic-preserve-symptom-boundary",
    description:
      "症状描述不得被扩大成「已知根因」;用户只说了现象时,优化稿不得替用户补上原因或影响范围",
  },
];

const suggestionRules: SuggestionRule[] = [
  {
    id: "diagnostic-suggest-evidence-to-collect",
    description: `可建议补充哪些证据 / 观测手段(日志级别、计时、抓包),但必须标注「${SUGGESTION_LABEL_ZH}」`,
  },
  {
    id: "diagnostic-suggest-instrumentation",
    description:
      "可建议加临时日志 / 断点 / 最小复现脚本,但不得代替用户执行,也不得声称已执行",
  },
  {
    id: "diagnostic-suggest-disproof-experiment",
    description: "可建议证伪实验 / 对照方案与判别标准,帮助区分假设,但不得替用户下定论",
  },
  {
    id: "diagnostic-suggest-rollback",
    description: "可建议修复前的备份 / 回滚 / 灰度方案,不得代替用户决定是否采纳",
  },
];

const provenanceRules: ProvenanceRule[] = [
  {
    id: "diagnostic-quote-symptom",
    description:
      "症状 / 期望行为 / 实际行为 / 报错原文必须逐字来自用户输入或上下文用户消息,不得替换成相似说法",
  },
  {
    id: "diagnostic-no-conclusion-without-evidence",
    description:
      "「已确认 / 已定位 / 根因是」类结论必须有逐字证据;否则降级为待验证假设或 未决项(省略或写成动作式/条件式指令)",
  },
  {
    id: "diagnostic-assumption-not-confirmed",
    description:
      "假设 / 常见原因 / 经验判断一律保持候选身份,不得写成已确认根因或必然结论",
  },
  {
    id: "diagnostic-suggested-separated",
    description: `优化器建议(取证手段 / 临时缓解)必须独立成段并标注「${SUGGESTION_LABEL_ZH}」,永不混入要求段`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 策略对象
// ─────────────────────────────────────────────────────────────────────────────

const outputContract: OutputContract = {
  /** v2:信息责任清单(不再强制模板段落;id 作为核对锚点)。 */
  responsibilities: [...DIAGNOSTIC_REQUIRED_SECTIONS],
  /** @deprecated 与 responsibilities 内容一致;保留给旧消费方。 */
  sections: [...DIAGNOSTIC_REQUIRED_SECTIONS],
  formatNote: buildFormatNote("zh"),
};

/** Diagnostic PromptStrategy v0.1(纯数据 + 纯函数,零 ctx/UI/Host 依赖)。 */
export const diagnosticStrategy: PromptStrategy = {
  type: "diagnostic",
  name: "Diagnostic（诊断）",
  version: DIAGNOSTIC_STRATEGY_VERSION,
  purpose:
    "把用户口语化的排障诉求编译成可直接照做的诊断型 Prompt:先固定症状 / 期望 / 实际并收集证据与复现步骤,再提出待验证假设、分析根因、用证伪 / 验证区分假设,最后才给带验证 / 复测的修复建议与回归测试——验证先于修改。",
  informationResponsibilities: [...DIAGNOSTIC_REQUIRED_SECTIONS],
  /** @deprecated 保留给旧消费方;内容与 informationResponsibilities 一致。 */
  required_sections: [...DIAGNOSTIC_REQUIRED_SECTIONS],
  optional_sections: ["Environment", "Timeline", "Impact Scope", "Workaround", "Open Questions"],
  preservationRules,
  suggestionRules,
  guards: [
    guardFixRequiresVerification,
    guardNoFixBeforeEvidence,
    guardFixNeedsRegressionTest,
    sectionPresence(DIAGNOSTIC_REQUIRED_SECTIONS, {
      id: "diagnostic-required-sections",
      description: `优化稿必须包含全部 10 个必出段落:${DIAGNOSTIC_REQUIRED_SECTIONS.join(" / ")}`,
    }),
    sectionPresence(DIAGNOSTIC_MANDATORY_SECTIONS, {
      id: "diagnostic-mandatory-hypotheses-disprove-verify",
      description: `强制段不得省略:${DIAGNOSTIC_MANDATORY_SECTIONS.join(" / ")}(Hypotheses 与 Disprove-Verify 必备)`,
    }),
    forbidUnprovenStrongClaim({
      id: "diagnostic-no-unproven-root-cause",
      description:
        "「已确认 / 已定位 / 确定 / 不可行」类根因强断言必须有逐字证据;无证据的结论一律触发",
    }),
    unknownNotBlocking(),
    suggestedNotInExplicit(),
    suggestedNotUpgraded(),
  ],
  provenanceRules,
  buildSystem(language: "zh" | "en"): string {
    return buildDiagnosticSystem(language);
  },
  buildUser(vars: CompileVars): string {
    return buildDiagnosticUser(vars);
  },
  outputContract,
};

export default diagnosticStrategy;
