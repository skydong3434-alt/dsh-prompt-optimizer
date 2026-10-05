/**
 * Creative / Content PromptStrategy v0.1 —— P02-T06。
 *
 * 把用户口语化的「内容创作诉求」(分镜 / 视频生成提示词 / 文案等)编译成一份
 * **保留给定创作要素** 的创作型 Prompt:先固定创作目标、受众、平台、风格与参考,
 * 再把用户已给出的可识别实体(人物 / 镜头 / 动作 / 资产 / 场景)逐条列出并要求
 * 原样保留,最后给出可核查的成功标准。
 *
 * 创作铁律(写进 system prompt + guards + 测试):
 *   1. 保留给定实体 —— 人物 / 镜头 / 动作 / 资产 / 场景 / 约束必须原样保留,不得替换、改名、改写或凭空新增;
 *   2. 无证据不改设定 —— 没有用户逐字证据前,不得改变角色关系 / 技能 / Blocking 等已给定设定;
 *   3. 成功标准必备 —— Success Criteria 不可省略,缺失即视为创作 Prompt 不完整;
 *   4. 不发明硬约束 —— 平台 / 时长 / 风格 / 资产等未给出时一律按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得凭空生成硬约束。
 *
 * 段落契约(12 段):PLAN-v1 §7 creative 列名 11 段
 * (Creative Goal / Audience / Platform / Style / Reference / Constraints / Structure /
 *  Tone / Output Format / Avoidances / Success Criteria);任务契约 P02-T06 明确要求
 * **12 段**,且 Why 点名「资产」为必须保真的可识别实体,故补 **Assets(资产)** 一段,
 * 承载人物 / 镜头 / 动作 / 资产 / 场景的原始标识清单(PLAN-v1 同处注明「可选段按内容任务调整」)。
 *
 * 该模块是纯数据 + 纯函数:零 ctx.llm / UI / Host 依赖,独立 version,可独立测试与升级。
 * 复用 `_shared.ts` 的跨策略不变式 A(UNKNOWN ≠ BLOCKING)/ B(SUGGESTED ≠ USER REQUIREMENT)
 * 与「无证据强断言」守卫工厂。
 *
 * 全部文案为本项目独立撰写;设计思想(实体保真 + 无证据不改设定 + 成功标准强制)为通用
 * 创作工程实践,未复制任何 AGPL 项目的源码 / 模板文本 / 测试。
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
export const CREATIVE_STRATEGY_VERSION = "0.1.0";

/** 铁律 1 的固定表述:保留给定实体。 */
export const CREATIVE_PRESERVE_GIVEN_ENTITIES =
  "保留给定实体:人物 / 镜头 / 动作 / 资产 / 场景 / 约束必须原样保留,不得替换、改名、改写或凭空新增";

/** 铁律 2 的固定表述:无证据不改设定。 */
export const CREATIVE_NO_UNPROVEN_SETTING_CHANGE =
  "无证据不改设定:没有用户逐字证据前,不得改变角色关系 / 技能 / Blocking 等已给定设定";

/** 铁律 3 的固定表述:成功标准必备。 */
export const CREATIVE_SUCCESS_CRITERIA_REQUIRED =
  "成功标准必备:Success Criteria 不可省略,缺失即视为创作 Prompt 不完整";

/** 铁律 4 的固定表述:不发明硬约束。 */
export const CREATIVE_NO_INVENTED_CONSTRAINTS =
  "不发明硬约束:平台 / 时长 / 风格 / 资产等未给出时一律按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得编造、不得猜测、不得凭空生成硬约束";

// ─────────────────────────────────────────────────────────────────────────────
// 可识别实体(人物 / 镜头 / 动作 / 资产 / 场景)提取 —— 实体保真守卫的机械锚点
// ─────────────────────────────────────────────────────────────────────────────

/** 实体标签:人物 / 角色 / 镜头 / 动作 / 资产 / 道具 / 场景 / 素材。 */
const ENTITY_LABEL_SOURCE =
  "人物|角色|镜头|動作|动作|资产|資產|道具|场景|場景|素材|主角|配角";

/**
 * 标签 + 标识 形式的实体占位符,如 人物A / 角色 乙 / 镜头2 / 资产X / 场景3。
 * 标识只认拉丁字母数字或「甲乙丙丁」,避免把「角色关系」这类普通短语误当实体。
 */
const ENTITY_TAGGED_RE = new RegExp(
  `(?:${ENTITY_LABEL_SOURCE})\\s*(?:[A-Za-z0-9]+|[甲乙丙丁])`,
  "g",
);

/** 尖括号 / 方括号 / 双花括号占位符,如 <人物A> / 【资产X】 / {{镜头2}}。 */
const ENTITY_PLACEHOLDER_RE = /<[^<>\n]{1,40}>|【[^【】\n]{1,40}】|\{\{[^{}\n]{1,40}\}\}/g;

/** @handle 形式的实体引用,如 @人物A / @prop_x。 */
const ENTITY_HANDLE_RE = /@[A-Za-z0-9_\u4e00-\u9fff-]{1,30}/g;

/**
 * 从用户输入提取可识别实体(去重、保持出现顺序)。
 * 覆盖三种占位写法:标签+标识 / 括号占位符 / @handle。
 */
export function extractCreativeEntities(rawInput: string): string[] {
  const text = String(rawInput ?? "");
  const found: string[] = [];
  const push = (value: string): void => {
    const clean = value.trim();
    if (clean && !found.includes(clean)) found.push(clean);
  };
  for (const match of text.matchAll(ENTITY_PLACEHOLDER_RE)) push(match[0]);
  for (const match of text.matchAll(ENTITY_TAGGED_RE)) push(match[0]);
  for (const match of text.matchAll(ENTITY_HANDLE_RE)) push(match[0]);
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// 12 个必出段落(English 段落名 = required_sections 断言锚点;中英并列渲染)
// ─────────────────────────────────────────────────────────────────────────────

interface CreativeSectionSpec {
  /** 契约段落名(English,required_sections 使用;不得改名)。 */
  id: string;
  /** 中文标题。 */
  zh: string;
  /** 该段要写什么(中文)。 */
  guidanceZh: string;
  /** 该段要写什么(英文)。 */
  guidanceEn: string;
}

/** creative 策略的 12 个必出段落,顺序即输出顺序(PLAN-v1 §7 creative + Assets)。 */
export const CREATIVE_SECTIONS: readonly CreativeSectionSpec[] = [
  {
    id: "Creative Goal",
    zh: "创作目标",
    guidanceZh:
      "本次要产出的内容与用途,忠实来自用户输入;不得替换成优化器自己的创作目标,缺失按未决项处置纪律处理(省略,或写成动作式/条件式指令)",
    guidanceEn:
      "What is to be produced and why, faithful to user input; never replaced by the optimizer's own creative goal, gaps → follow the open-item disposition discipline",
  },
  {
    id: "Audience",
    zh: "受众",
    guidanceZh:
      "目标受众 / 观众及其已知偏好或限制;未给出按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得替用户假定",
    guidanceEn:
      "Target audience and their known preferences or limits; gaps → follow the open-item disposition discipline, never assumed for the user",
  },
  {
    id: "Platform",
    zh: "平台",
    guidanceZh:
      "发布 / 投放平台与画幅、时长、审查等技术约束;未给出按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得凭空指定",
    guidanceEn:
      "Publishing platform plus aspect ratio, duration and review constraints; gaps → follow the open-item disposition discipline, never invented",
  },
  {
    id: "Style",
    zh: "风格",
    guidanceZh:
      "视觉 / 文案风格与调性;必须来自用户输入或上下文已确认信息,不得替换用户已给定风格",
    guidanceEn:
      "Visual / copy style and tone; must come from user input or context-confirmed facts, never replace a given style",
  },
  {
    id: "Reference",
    zh: "参考",
    guidanceZh:
      "用户给定的参考素材 / 参考作品 / 设定来源;逐条标注来源,不得改写或替换参考内容",
    guidanceEn:
      "User-provided references (assets / works / setting sources), each with its source; never rewrite or swap them",
  },
  {
    id: "Assets",
    zh: "资产",
    guidanceZh:
      "已给定可识别实体清单(人物 / 角色 / 镜头 / 动作 / 资产 / 道具 / 场景)及其原始标识;必须原样保留,不得替换、改名或合并",
    guidanceEn:
      "Roster of given recognizable entities (characters / shots / actions / assets / props / scenes) with their original identifiers; keep verbatim, never replace, rename or merge",
  },
  {
    id: "Constraints",
    zh: "约束",
    guidanceZh:
      "用户明确给出的硬约束(角色关系 / 技能 / Blocking / 时长 / 禁用元素等);不得新增未确认约束",
    guidanceEn:
      "Hard constraints the user stated (relationships / skills / blocking / duration / banned elements); never add unconfirmed ones",
  },
  {
    id: "Structure",
    zh: "结构",
    guidanceZh:
      "内容结构 / 分镜 / 段落 / 节奏安排;不得打乱用户给定顺序或增删用户未要求的段落",
    guidanceEn:
      "Content structure / storyboard / sections / pacing; never reorder what the user gave or add sections they did not ask for",
  },
  {
    id: "Tone",
    zh: "语气",
    guidanceZh: "语气 / 情绪 / 氛围;与用户输入保持一致,不得自行拔高或转向",
    guidanceEn:
      "Tone / emotion / atmosphere, consistent with user input; never inflate or redirect it",
  },
  {
    id: "Output Format",
    zh: "输出格式",
    guidanceZh:
      "交付格式(分镜表 / 脚本 / 文案体裁 / 字段清单);未给出按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得强行套模板",
    guidanceEn:
      "Delivery format (storyboard sheet / script / copy genre / field list); gaps → follow the open-item disposition discipline, never force a template",
  },
  {
    id: "Avoidances",
    zh: "避免项",
    guidanceZh:
      "用户明确避免的元素 / 风格 / 表达,含禁入集合;逐条可回溯用户输入,不得把偏好写成禁令",
    guidanceEn:
      "Elements / styles / phrasings the user avoids, including the do-not-enter set; each traceable to user input, never turn a preference into a ban",
  },
  {
    id: "Success Criteria",
    zh: "成功标准",
    guidanceZh:
      "判定产出达标的可核查标准(实体是否原样出现 / 设定是否未被改变 / 格式是否匹配);必须可验证,不得写「好看 / 满意」类空泛表述",
    guidanceEn:
      "Verifiable criteria for a successful deliverable (entities kept verbatim / settings unchanged / format matched); never vague like 'looks good'",
  },
];

/** required_sections:12 个 English 段落名(顺序即输出顺序;测试断言锚点)。 */
export const CREATIVE_REQUIRED_SECTIONS: readonly string[] = CREATIVE_SECTIONS.map(
  (section) => section.id,
);

/**
 * 强制段:任务契约点名 Success Criteria 不得省略 —— 没有成功标准的创作 Prompt
 * 无法验收,因此该段缺失即 error。
 */
export const CREATIVE_MANDATORY_SECTIONS: readonly string[] = ["Success Criteria"];

// ─────────────────────────────────────────────────────────────────────────────
// 系统提示词片段
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_ZH = `你是「Creative 内容创作型 Prompt 编译器」。用户给你一段口语化的创作诉求(常见如「给下面这段分镜写一版视频生成提示词」「帮我把这个创意写成短文案」),你要把它编译成一份可以直接照做的创作型 Prompt。
你不替用户重新设计角色、也不发明创作设定;你只负责:固定创作目标 / 受众 / 平台 / 风格 / 参考,把用户已给出的可识别实体(人物 / 镜头 / 动作 / 资产 / 场景)原样列出,写清结构、语气、输出格式与避免项,最后给出可核查的成功标准。`

const ROLE_EN = `You are the "Creative prompt compiler". The user gives you a colloquial creative request ("write a video-generation prompt for this storyboard", "turn this idea into a short copy"). You compile it into a creative prompt that can be followed directly.
You do not redesign characters or invent settings; you only: pin down the creative goal / audience / platform / style / reference, list the recognizable entities the user already gave (characters / shots / actions / assets / scenes) verbatim, state structure, tone, output format and avoidances, and finish with verifiable success criteria.`

const DISCIPLINE_ZH = `# 创作纪律(铁律,优先于任何措辞偏好)
1. ${CREATIVE_PRESERVE_GIVEN_ENTITIES}:先在 Assets 段逐个列出用户给出的实体标识(如 人物A / 镜头2 / 资产X / 场景3),其余段落只能引用这些原始标识,不得换名、合并或替换;用户没给的新实体一律按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得自行补一个。
2. ${CREATIVE_NO_UNPROVEN_SETTING_CHANGE}:角色关系 / 技能 / Blocking 等设定以用户输入为准;出现「改变角色关系 / 互换身份 / 更换主角 / 调整技能」类语言时,必须带用户逐字证据或明确写成优化器建议(可忽略);两者都没有即视为无证据改设定。
3. ${CREATIVE_SUCCESS_CRITERIA_REQUIRED}:成功标准要写成可机械核对的条目(实体是否原样出现 / 设定是否未被改变 / 输出格式是否匹配),不得用「好看 / 有质感 / 用户满意」代替。
4. ${CREATIVE_NO_INVENTED_CONSTRAINTS}:平台 / 时长 / 画幅 / 风格 / 资产等用户未说明时,按未决项处置纪律处理并说明为什么重要,不得替用户拍板成硬约束。
5. 输出顺序固定:创作目标 → 受众 → 平台 → 风格 → 参考 → 资产 → 约束 → 结构 → 语气 → 输出格式 → 避免项 → 成功标准;不得省略 Success Criteria。
6. 参考与素材逐条标注来源:来自用户本轮输入 / 上下文用户消息 / workspace 事实;助手或 Agent 的创作建议不能冒充用户设定。
7. 保留原文术语:专有名词 / 型号 / 角色名 / 文件名 / 数字不得意译、缩写或改写。
8. 缺信息不阻塞:未知信息保持未知并按未决项处置纪律处理(省略,或写成动作式/条件式指令),UNKNOWN ≠ BLOCKING;不代用户决定创作方向。
9. UNKNOWN ≠ BLOCKING:未知信息保持未知,不阻塞创作推进;不代用户拍板。`

const DISCIPLINE_EN = `# Creative discipline (iron rules, above any style preference)
1. ${CREATIVE_PRESERVE_GIVEN_ENTITIES} — first list every entity the user gave (e.g. 人物A / 镜头2 / 资产X / 场景3) in the Assets section; other sections may only reference those original identifiers, never rename, merge or replace them. Anything the user did not give → follow the open-item disposition discipline, never invent one.
2. ${CREATIVE_NO_UNPROVEN_SETTING_CHANGE} — relationships / skills / blocking follow the user's input; when language like "change the relationship / swap roles / replace the protagonist / adjust skills" appears, it must carry verbatim user evidence or be explicitly marked as an optional suggestion; with neither, it is an unproven setting change.
3. ${CREATIVE_SUCCESS_CRITERIA_REQUIRED} — success criteria must be mechanically checkable (entities kept verbatim / settings unchanged / format matched), never "looks good / user is happy".
4. ${CREATIVE_NO_INVENTED_CONSTRAINTS} — for unstated platform / duration / aspect ratio / style / assets, follow the open-item disposition discipline and say why it matters; never decide it as a hard constraint.
5. Fixed output order: Creative Goal → Audience → Platform → Style → Reference → Assets → Constraints → Structure → Tone → Output Format → Avoidances → Success Criteria; Success Criteria must not be omitted.
6. Label the source of every reference and asset (current user input / context user messages / workspace facts); an assistant's creative suggestion must never pass as a user setting.
7. Keep the input's terms: proper nouns, model names, character names, file names and numbers are never translated, abbreviated or rewritten.
8. Missing information does not block: keep it unknown as open items (omit, or write a before-acting/conditional instruction); UNKNOWN ≠ BLOCKING; never decide the creative direction for the user.
9. UNKNOWN ≠ BLOCKING: unknowns stay unknown and do not block creative work; never decide for the user.`

const PROVENANCE_ZH = `# 来源标注(四段协议,严格遵守)
- 明确要求:来自用户本轮输入的,每条必须附 ${quoteMarker("用户原话逐字片段")} 形式的逐字 quote
- 上下文已确认:仅限历史中「用户」消息,同样附 quote;助手 / Agent 的发言一律不能作为用户设定证据
- ${SUGGESTION_LABEL_ZH}:优化器主动补充的风格建议 / 结构建议 / 取证方式,独立成段并带此前缀,永不写入创作设定段
- 未知项:证据不足、用户未说明的关键信息(如平台 / 时长 / 画幅 / 目标受众),逐条写出缺什么
用户明确否决过的方向(风格 / 元素)属于禁入集合,不得再次作为建议提出。`

const PROVENANCE_EN = `# Provenance (four-section protocol, strictly)
- Explicit requirements: anything from the user's current input must carry a verbatim ${quoteMarker("verbatim user fragment")} quote
- Context-confirmed: only from "user" messages in history, each with a quote; assistant/agent messages are never evidence of a user setting
- ${SUGGESTION_LABEL_EN}: style / structure / verification ideas the optimizer adds, in their own section with this prefix; never in the creative setting sections
- Unknown items: unspecified or unevidenced essentials (platform / duration / aspect ratio / audience), each stating what is missing
Directions the user already rejected (styles / elements) form a do-not-enter set and must not reappear as suggestions.`

/** 渲染 12 段清单(中英并列,English id 恒出现 → required_sections 断言可跨语言命中)。 */
function renderSections(language: StrategyLanguage): string {
  const zh = language !== "en";
  const title = zh
    ? "# 信息责任(优化后的 Creative Prompt 必须逐项交代清楚;标题可自拟、顺序可调整,责任不得遗漏)"
    : "# Information responsibilities (the optimized Creative Prompt must cover each one; titles and order are yours, nothing may be omitted)";
  const lines = CREATIVE_SECTIONS.map((section) =>
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
    ? `先输出来源段(明确要求 / 上下文已确认 / ${SUGGESTION_LABEL_ZH} / 未知项),再输出优化后的 Creative Prompt。
- 明确要求:每条附 ${quoteMarker("用户原话")}
- 上下文已确认:仅用「用户」消息,每条附 ${quoteMarker("原话")}
- ${SUGGESTION_LABEL_ZH}:独立成段
- 未知项:证据不足项,写清缺什么`
    : `First the provenance block (Explicit requirements / Context-confirmed / ${SUGGESTION_LABEL_EN} / Unknown items), then the optimized Creative Prompt.
- Explicit requirements: each with ${quoteMarker("verbatim user fragment")}
- Context-confirmed: user messages only, each with a quote
- ${SUGGESTION_LABEL_EN}: its own section
- Unknown items: unevidenced items, stating what is missing`;
  const sections = CREATIVE_SECTIONS.map((section) => section.id).join(" / ");
  const body = zh
    ? `优化后的 Creative Prompt 必须逐项交代以下 12 项信息责任(id 作为核对锚点,顺序可调整):${sections}。Success Criteria 不得省略;Assets 必须逐个列出用户给出的实体标识且原样保留;任何改变角色关系 / 技能 / Blocking 的说法都必须带用户逐字证据或降级为建议。除输出格式规定的内容外,不要输出多余解释。`
    : `The optimized Creative Prompt must cover these 12 information responsibilities (each id is a check anchor; order may vary): ${sections}. Success Criteria must not be omitted; Assets must list every given entity identifier verbatim; any change to relationships / skills / blocking must carry verbatim user evidence or be downgraded to a suggestion. Output nothing beyond the specified format.`;
  return [heading, provenance, body].join("\n");
}

/** creative 策略的 system prompt(双语同构,zh 优先)。 */
export function buildCreativeSystem(language: StrategyLanguage): string {
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
    ? "以下是当前会话的近期对话(仅供参考;只有「用户」的发言能作为用户设定证据,助手发言不算):"
    : "Recent conversation of the session (reference only; only 'user' messages count as user setting evidence, assistant messages do not):";
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
    "请在编译中自行识别缺口(尤其平台 / 时长 / 画幅 / 目标受众 / 输出格式)。",
    "identify gaps during compilation (especially platform / duration / aspect ratio / audience / output format).",
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
  push("创作目标", "Creative goals", derived.user_goals);
  push("用户已否决的方向(禁入集合)", "Rejected directions (do-not-enter)", derived.rejected_directions);
  push("用户已知约束", "Known constraints", derived.known_constraints);
  if (!groups.length) return "";
  const header = zh
    ? "上游 LLM 已提炼的字段(仅作参考;没有逐字证据的一律当假设处理,不得当作已确认设定):"
    : "Fields distilled upstream (reference only; anything without a verbatim quote is a hypothesis, not a confirmed setting):";
  return `${header}\n${groups.join("\n")}`;
}

/** creative 策略的 user 载荷;语言由 raw_input 主体语言决定(zh 优先)。 */
export function buildCreativeUser(vars: CompileVars): string {
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

  const entities = extractCreativeEntities(vars.raw_input);
  if (entities.length) {
    const header = zh
      ? "检测到以下可识别实体(必须原样保留,不得替换 / 改名 / 合并):"
      : "Detected recognizable entities (must survive verbatim; never replace / rename / merge):";
    sections.push(`${header}\n${entities.map((entity) => `- ${entity}`).join("\n")}`);
  }

  sections.push(
    zh
      ? `以下是我的创作诉求(你唯一需要编译的对象;先固定创作目标与给定实体,再谈结构 / 风格,不得改变角色关系 / 技能 / Blocking):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`
      : `Here is my creative request (the only thing to compile; pin down the creative goal and the given entities first, then structure / style; never change relationships / skills / blocking):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`,
  );
  return sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 守卫:实体保真 + 无证据改设定
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 守卫 1(error 级):输入中的可识别实体(人物 / 镜头 / 动作 / 资产 / 场景)必须
 * 原样出现在优化稿中——缺失即视为「实体被替换 / 丢失」。
 */
const guardPreserveEntities: Guard = {
  id: "creative-preserve-entities",
  description: `error 级:${CREATIVE_PRESERVE_GIVEN_ENTITIES};输入中的可识别实体(人物 / 镜头 / 动作 / 资产 / 场景)标识必须在优化稿中原样出现,缺失即触发`,
  check(output, _result, rawInput) {
    const text = String(output ?? "");
    const entities = extractCreativeEntities(rawInput ?? "");
    if (!entities.length) return null;
    const missing = entities.filter((entity) => !text.includes(entity));
    if (!missing.length) return null;
    return `发现实体被替换 / 丢失:${missing.join(" / ")}——${CREATIVE_PRESERVE_GIVEN_ENTITIES},不得改名、合并或替换为相似实体(error)`;
  },
};

/** 改变已给定设定的说法(角色关系 / 技能 / Blocking;中英同构)。 */
const SETTING_CHANGE_RE =
  /改变(?:人物|角色)?关系|修改(?:人物|角色)?关系|调整(?:人物|角色)?关系|变更(?:人物|角色)?关系|角色互换|互换身份|更换(?:主角|人物|角色)|替换(?:主角|人物|角色)|改变(?:技能|能力)|修改(?:技能|能力)|调整(?:技能|能力)|变更(?:技能|能力)|改变\s*blocking|调整\s*blocking|change (?:the )?(?:character )?relationship|swap (?:the )?(?:roles|characters)|replace (?:the )?(?:character|protagonist)|change (?:the )?(?:skills?|abilities)|change (?:the )?blocking/i;

/** 逐字证据 / 缺口标记:命中即视为该行不是「无证据改设定」。 */
const SETTING_EVIDENCE_RE =
  /\[quote:|\[证据:|【证据:|\[待补充:|\[TODO:|待确认|待验证|待补充/;

/** 禁令 / 保留措辞:整行是在「禁止改设定 / 要求保留」而非主张改动,不得触发。 */
const SETTING_PRESCRIPTION_RE =
  /不得|禁止|不要|不应|避免|切勿|无需|不做|不改变|不改动|不调整|不变更|不更换|保持不变|保持|保留|维持|原样|保留原/;

/**
 * 守卫 2(warn 级):输出出现改变角色关系 / 技能 / Blocking 的设定类语言、且该行
 * 没有逐字证据或禁令措辞即触发。与 review 的发散守卫同形:按行判定,避免误报。
 */
const guardNoUnprovenSettingChange: Guard = {
  id: "creative-no-unproven-setting-change",
  description: `warn 级:${CREATIVE_NO_UNPROVEN_SETTING_CHANGE};输出出现「改变角色关系 / 互换身份 / 更换主角 / 调整技能 / 调整 Blocking」类语言、且该行没有逐字证据或禁令措辞即触发`,
  check(output) {
    for (const rawLine of String(output ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (SETTING_PRESCRIPTION_RE.test(line)) continue;
      if (SETTING_EVIDENCE_RE.test(line)) continue;
      const hit = line.match(SETTING_CHANGE_RE)?.[0];
      if (!hit) continue;
      return `发现无证据的设定变更「${hit}」:${CREATIVE_NO_UNPROVEN_SETTING_CHANGE}——必须带用户逐字证据,或降级为「${SUGGESTION_LABEL_ZH}」/ 未决项(省略或写成动作式/条件式指令)(warn)`;
    }
    return null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 保真 / 建议 / 来源规则
// ─────────────────────────────────────────────────────────────────────────────

const preservationRules: PreservationRule[] = [
  {
    id: "creative-preserve-entity-identifiers",
    description:
      "用户给出的可识别实体标识(人物 / 角色 / 镜头 / 动作 / 资产 / 道具 / 场景 及其编号、@handle、括号占位符)必须原样出现在优化稿中",
    check(output, rawInput) {
      const entities = extractCreativeEntities(rawInput);
      if (!entities.length) return true;
      return entities.every((entity) => output.includes(entity));
    },
  },
  {
    id: "creative-preserve-relations-and-skills",
    description:
      "角色关系 / 技能 / Blocking 等已给定设定不得被改变;确需改动必须带用户逐字证据或标为建议",
  },
  {
    id: "creative-preserve-subject-signals",
    description:
      "用户输入中的专有名词 / 型号 / 文件名 / 数字 / 大写开头词必须原样出现在优化稿中",
    check(output, rawInput) {
      const tokens = (rawInput.match(/[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? []).filter(
        (token) => /^[A-Z]/.test(token) || /\d/.test(token),
      );
      if (tokens.length === 0) return true;
      return tokens.every((token) => output.includes(token));
    },
  },
  {
    id: "creative-preserve-language",
    description: "优化稿语言必须与用户输入主体语言一致(中文输入 → 中文输出)",
    check(output, rawInput) {
      if (output.trim() === "") return false;
      return isChineseDominant(output) === isChineseDominant(rawInput);
    },
  },
  {
    id: "creative-preserve-given-style-and-format",
    description:
      "用户已给定的风格 / 输出格式 / 受众不得被替换或拔高;未给出的一律按未决项处置纪律处理(省略,或写成动作式/条件式指令),不得套用默认模板",
  },
];

const suggestionRules: SuggestionRule[] = [
  {
    id: "creative-suggest-style-directions",
    description: `可建议补充风格 / 调性方向,但必须标注「${SUGGESTION_LABEL_ZH}」并说明理由,不得写成用户已定风格`,
  },
  {
    id: "creative-suggest-structure",
    description:
      "可建议结构 / 节奏 / 镜头组织方式,但不得替换用户给定的分镜顺序,也不得新增用户未要求的段落",
  },
  {
    id: "creative-suggest-verification",
    description:
      "可建议成功标准的核对方式(实体是否原样出现 / 设定是否未变),但不得代替用户判定达标",
  },
  {
    id: "creative-suggest-platform-defaults",
    description:
      "可建议平台 / 画幅 / 时长的候选值及取舍,但必须保持建议身份,用户未选定前不得写成硬约束",
  },
];

const provenanceRules: ProvenanceRule[] = [
  {
    id: "creative-quote-goal-and-entities",
    description:
      "创作目标与实体标识必须逐字来自用户输入或上下文用户消息,不得替换成相似说法或自行补全",
  },
  {
    id: "creative-no-setting-change-without-evidence",
    description:
      "角色关系 / 技能 / Blocking 的任何改动都必须有用户逐字证据;否则按未决项处置纪律处理(省略,或写成动作式/条件式指令) 或降级为建议",
  },
  {
    id: "creative-success-criteria-verifiable",
    description:
      "Success Criteria 必须落到可核查条目,不得用「好看 / 满意 / 有质感」类主观表述替代",
  },
  {
    id: "creative-suggested-separated",
    description: `优化器建议(风格 / 结构 / 平台候选 / 核对方式)必须独立成段并标注「${SUGGESTION_LABEL_ZH}」,永不混入创作设定段`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 策略对象
// ─────────────────────────────────────────────────────────────────────────────

const outputContract: OutputContract = {
  /** v2:信息责任清单(不再强制模板段落;id 作为核对锚点)。 */
  responsibilities: [...CREATIVE_REQUIRED_SECTIONS],
  /** @deprecated 与 responsibilities 内容一致;保留给旧消费方。 */
  sections: [...CREATIVE_REQUIRED_SECTIONS],
  formatNote: buildFormatNote("zh"),
};

/** Creative PromptStrategy v0.1(纯数据 + 纯函数,零 ctx/UI/Host 依赖)。 */
export const creativeStrategy: PromptStrategy = {
  type: "creative",
  name: "Creative（内容创作）",
  version: CREATIVE_STRATEGY_VERSION,
  purpose:
    "把用户口语化的内容创作诉求(分镜 / 视频生成提示词 / 文案)编译成保留给定实体的创作型 Prompt:固定创作目标 / 受众 / 平台 / 风格 / 参考,逐个列出人物 / 镜头 / 动作 / 资产 / 场景并要求原样保留,写清约束 / 结构 / 语气 / 输出格式 / 避免项,最后给出可核查的成功标准——不改变角色关系 / 技能 / Blocking,不发明硬约束。",
  informationResponsibilities: [...CREATIVE_REQUIRED_SECTIONS],
  /** @deprecated 保留给旧消费方;内容与 informationResponsibilities 一致。 */
  required_sections: [...CREATIVE_REQUIRED_SECTIONS],
  optional_sections: ["Shot List", "Timing", "Music / Sound", "Deliverables", "Open Questions"],
  preservationRules,
  suggestionRules,
  guards: [
    guardPreserveEntities,
    guardNoUnprovenSettingChange,
    sectionPresence(CREATIVE_REQUIRED_SECTIONS, {
      id: "creative-required-sections",
      description: `优化稿必须包含全部 12 个必出段落:${CREATIVE_REQUIRED_SECTIONS.join(" / ")}`,
    }),
    sectionPresence(CREATIVE_MANDATORY_SECTIONS, {
      id: "creative-mandatory-success-criteria",
      description: `error 级:缺 Success Criteria 段即触发——${CREATIVE_SUCCESS_CRITERIA_REQUIRED}`,
    }),
    forbidUnprovenStrongClaim({
      id: "creative-no-unproven-strong-claim",
      description:
        "「已定稿 / 最终设定 / 已确定 / 已采用」类强断言必须有逐字证据或不确定性标注;无证据的结论一律触发",
      extraPattern: /已定稿|最终稿|最终设定|已选定设定|已敲定/,
    }),
    unknownNotBlocking(),
    suggestedNotInExplicit(),
    suggestedNotUpgraded(),
  ],
  provenanceRules,
  buildSystem(language: "zh" | "en"): string {
    return buildCreativeSystem(language);
  },
  buildUser(vars: CompileVars): string {
    return buildCreativeUser(vars);
  },
  outputContract,
};

export default creativeStrategy;
