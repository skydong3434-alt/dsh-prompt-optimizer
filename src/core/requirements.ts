/**
 * Missing Resolution + Requirement Ledger —— v2 §C6 / §C8。
 *
 * 两条铁律:
 *  1. **UNKNOWN ≠ ASK_USER**。一个未决项必须先回答「谁有权/有能力决定它」:
 *        USER_REQUIRED(只有用户能决定)/ AGENT_DISCOVERABLE(执行方自己查得到)
 *        / OPTIONAL(有更好,没有也行);只有 `USER_REQUIRED && 高影响` 才 blocking。
 *  2. **来源与状态分离**。「这条信息从哪来」(source)与「它现在确认到什么程度」
 *     (status)是两个独立维度;用户的「按你的判断继续」只提升到
 *     PROVISIONAL / CONDITIONAL / DEFERRED,**永不**产生 CONFIRMED / USER_EXPLICIT。
 *
 * 分类判据是**表驱动的保守规则**:拿不准 → AGENT_DISCOVERABLE + blocking=false
 * (宁可生成后标注「由执行方自行确认」,也不无谓打断用户)。
 * 纯函数,零 LLM / 零 Harness / 零 UI 依赖。
 */
import type {
  AnalysisGate,
  ConversationTurn,
  EditTriage,
  MissingResolutionItem,
  ProvenanceRecord,
  ProvenanceSource,
  RequirementClass,
  RequirementLedgerEntry,
  RequirementStatus,
} from "./types.js";
import { resolveQuoteSource } from "./provenance.js";

// ─────────────────────────────────────────────────────────────────────────────
// 分类判据表
// ─────────────────────────────────────────────────────────────────────────────

/** 用户专属:只有用户本人能决定(偏好 / 预算 / 受众 / 合规 …)。 */
const USER_EXCLUSIVE_RE =
  /预算|成本|花费|价格|付费|受众|目标用户|目标读者|用户画像|风格|调性|语气|口吻|品牌|人设|偏好|倾向|喜好|取舍|优先级|上线时间|截止|工期|排期|交付时间|合规|法务|版权|许可|授权|隐私|密钥|凭据|账号|署名|名字|取名|标题偏好|多少[个条张页]|规模|范围|期望|希望|要求是|必须用|不要用|是否要|要不要|能不能只|用途|场景是|给谁|面向/i;

/** 执行方可自查:仓库/代码/文档/环境里能直接读到的确定性事实。 */
const DISCOVERABLE_RE =
  /文件名|路径|目录|文件夹|仓库|代码库|分支|提交|现有|当前(?:的)?(?:实现|代码|结构|配置|版本|状态)|已有(?:的)?(?:实现|代码|接口|字段)|实现细节|依赖|版本号|框架|技术栈现状|接口(?:定义|签名|文档)|函数签名|类型定义|数据结构|表结构|数据库结构|字段(?:类型|名)|配置(?:项|文件|格式)|环境变量|日志|堆栈|报错原文|错误码|测试(?:现状|文件|覆盖)|官方文档|文档地址|api 文档|规范|协议|路由|端口|部署(?:方式|环境)现状|默认值/i;

/** 有则更好:不影响任务成立。 */
const OPTIONAL_RE =
  /可选|额外|附加|顺带|如果方便|锦上添花|示例|例子|样例|参考(?:风格|资料)|补充说明|备注|风格微调|多给|多多益善/i;

/** 高影响:不同答案会导致**明显不同**的产出。 */
const HIGH_IMPACT_RE =
  /预算|成本|交付(?:形式|物|方式)|输出格式|交付格式|验收|完成标准|范围|规模|架构|技术栈|语言|框架选型|数据库|部署|上线|截止|工期|合规|版权|受众|目标用户|风格方向|调性|平台|渠道|量级|多少[个条张页]/i;

/** 中影响:影响细节质量,但不改变任务骨架。 */
const MEDIUM_IMPACT_RE = /命名|措辞|格式细节|排序|优先级|粒度|长度|篇[幅章]|语气|示例|顺序|维度/i;

/** 「按你的判断继续」这类盲授权(只可产出 PROVISIONAL / CONDITIONAL / DEFERRED)。 */
const BLIND_TRUST_RE =
  /按你的(?:判断|理解|想法|意思)|你(?:来|自己)?决定|随你|随便|都行|都可以|听你的|看着办|不用问|不用确认|你看着来|你定|自主决定|按需决定|你觉得(?:好|合适)就行/i;

/** 条件式授权:带条件的放行 → CONDITIONAL。 */
const CONDITIONAL_RE = /如果|若|除非|在.{0,10}情况下|只要|当.{0,10}时/i;

function isRequirementClass(value: unknown): value is RequirementClass {
  return value === "USER_REQUIRED" || value === "AGENT_DISCOVERABLE" || value === "OPTIONAL";
}

function asImpact(value: unknown): "high" | "medium" | "low" | undefined {
  return value === "high" || value === "medium" || value === "low" ? value : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// UNKNOWN 三分类
// ─────────────────────────────────────────────────────────────────────────────

export interface UnknownInput {
  text: string;
  /** LLM 给出的分类(可选;只能用于**收紧**,不能用于放大阻塞)。 */
  classification?: unknown;
  /** LLM 的 blocking 判断(可选;`false` 一律尊重,`true` 不单独成立)。 */
  blocking?: unknown;
  rationale?: string;
  impact?: unknown;
  user_exclusive?: unknown;
  question?: string;
}

/** 机械影响面判定。 */
export function mechanicalImpact(text: string): "high" | "medium" | "low" {
  if (HIGH_IMPACT_RE.test(text)) return "high";
  if (MEDIUM_IMPACT_RE.test(text)) return "medium";
  return "low";
}

/**
 * 机械三分类(保守,可单测):
 *  1. 命中 OPTIONAL 且不命中用户专属 / 可自查 → OPTIONAL;
 *  2. 命中可自查且**不**命中用户专属 → AGENT_DISCOVERABLE;
 *  3. 命中用户专属 → USER_REQUIRED;
 *  4. 都没命中 → AGENT_DISCOVERABLE(默认不打扰用户)。
 */
export function mechanicalRequirementClass(text: string): RequirementClass {
  const userExclusive = USER_EXCLUSIVE_RE.test(text);
  const discoverable = DISCOVERABLE_RE.test(text);
  const optional = OPTIONAL_RE.test(text);
  if (optional && !userExclusive && !discoverable) return "OPTIONAL";
  if (discoverable && !userExclusive) return "AGENT_DISCOVERABLE";
  if (userExclusive) return "USER_REQUIRED";
  return "AGENT_DISCOVERABLE";
}

/**
 * 一条 UNKNOWN → MissingResolutionItem。
 *
 * 合并规则(与 triage 同一哲学:保守、单向收紧):
 *  - 机械判为 USER_REQUIRED 时,LLM 的降级**不被采纳**(有证据的「用户专属」特征保留);
 *  - 机械判为可自查 / 可选时,LLM 的 USER_REQUIRED 会被**降级**(不无谓追问);
 *  - `blocking` 仅在 `USER_REQUIRED && impact==='high'` 且 LLM 未显式否决时为 true。
 */
export function classifyUnknown(input: UnknownInput, index = 0): MissingResolutionItem {
  const text = (input.text ?? "").trim();
  const mechanical = mechanicalRequirementClass(text);
  const llm = isRequirementClass(input.classification) ? input.classification : undefined;

  let classification: RequirementClass = mechanical;
  const notes: string[] = [];
  if (mechanical === "USER_REQUIRED") {
    if (llm && llm !== "USER_REQUIRED") {
      notes.push(`模型判为 ${llm},但文本含用户专属特征,保留 USER_REQUIRED`);
    }
  } else if (llm && llm !== mechanical) {
    classification = mechanical;
    notes.push(`模型判为 ${llm},按保守规则降级为 ${mechanical}`);
  }

  const impact = asImpact(input.impact) ?? mechanicalImpact(text);
  const userExclusive = classification === "USER_REQUIRED";
  const llmBlocking = input.blocking === true ? true : input.blocking === false ? false : undefined;
  const blocking = classification === "USER_REQUIRED" && impact === "high" && llmBlocking !== false;

  const baseRationale =
    input.rationale?.trim() ||
    (classification === "USER_REQUIRED"
      ? "只有用户本人能决定,且会影响产出方向"
      : classification === "AGENT_DISCOVERABLE"
        ? "执行方可以直接从代码 / 文档 / 环境中查到,不需要问用户"
        : "有没有都不影响任务成立");

  return {
    id: `unknown-${index + 1}`,
    text,
    classification,
    blocking,
    rationale: [baseRationale, ...notes].join(";"),
    impact,
    user_exclusive: userExclusive,
    ...(input.question?.trim() ? { question: input.question.trim() } : {}),
  };
}

/** 批量分类(保持输入顺序;空文本条目被丢弃)。 */
export function classifyUnknowns(inputs: readonly UnknownInput[]): MissingResolutionItem[] {
  return inputs
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (item.text ?? "").trim().length > 0)
    .map(({ item, index }) => classifyUnknown(item, index));
}

// ─────────────────────────────────────────────────────────────────────────────
// 分析门(唯一允许阻断生成的开关)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计算分析门。
 *
 * 产品规则:**KEEP 不追问**。输入既然是可用成稿,就不该因为「我们没看懂」而打断用户
 * ——KEEP 的语义是原样保留,追问与「原样保留」自相矛盾。
 */
export function computeAnalysisGate(items: readonly MissingResolutionItem[], triage: EditTriage): AnalysisGate {
  const all = [...items];
  const userRequired = all.filter((item) => item.classification === "USER_REQUIRED");
  const discoverable = all.filter((item) => item.classification === "AGENT_DISCOVERABLE");
  const optional = all.filter((item) => item.classification === "OPTIONAL");

  if (triage === "KEEP") {
    return {
      blocked: false,
      blocking_items: [],
      discoverable_items: discoverable,
      optional_items: optional,
      reason: "输入已是可用成稿(分诊 KEEP):原样保留,不追问也不改写",
    };
  }

  const blockingItems = userRequired.filter((item) => item.blocking);
  return {
    blocked: blockingItems.length > 0,
    blocking_items: blockingItems,
    discoverable_items: discoverable,
    optional_items: optional,
    reason:
      blockingItems.length > 0
        ? `有 ${blockingItems.length} 项只有你本人能决定的信息缺失,确认后再生成`
        : "没有阻塞项,可以直接生成",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Requirement Ledger
// ─────────────────────────────────────────────────────────────────────────────

/** 台账记录的来源权威性:只有用户本人表达才可产生高权威来源。 */
function isUserAuthority(source: ProvenanceSource): boolean {
  return source === "USER_EXPLICIT" || source === "CONTEXT_EXPLICIT";
}

function statusForSource(source: ProvenanceSource): RequirementStatus {
  switch (source) {
    case "USER_EXPLICIT":
    case "CONTEXT_EXPLICIT":
      return "CONFIRMED";
    case "WORKSPACE_FACT":
      return "CONFIRMED";
    case "OPTIMIZER_SUGGESTED":
      return "PROVISIONAL";
    default:
      return "OPEN";
  }
}

/**
 * 台账净化(provenance 不可回退的机械保证):
 *  - USER_EXPLICIT / CONTEXT_EXPLICIT 必须携带**逐字且来自用户**的证据,
 *    否则降级为 OPTIMIZER_SUGGESTED + PROVISIONAL(并把状态一并降级);
 *  - CONTEXT_EXPLICIT 的证据只认上下文中的 user 消息(助手发言永不算);
 *  - 任何情况下都不会把条目**升级**为更高权威来源。
 */
export function sanitizeLedger(
  entries: readonly RequirementLedgerEntry[],
  rawInput: string,
  contextTurns: readonly ConversationTurn[],
): RequirementLedgerEntry[] {
  return entries.map((entry) => {
    if (!isUserAuthority(entry.source)) return entry;
    const evidence = entry.evidence.filter((quote) => {
      const resolution = resolveQuoteSource(quote, rawInput, [...contextTurns]);
      return entry.source === "USER_EXPLICIT"
        ? resolution.matchedIn === "raw"
        : resolution.matchedIn === "context-user";
    });
    if (evidence.length > 0) return { ...entry, evidence };
    return {
      ...entry,
      source: "OPTIMIZER_SUGGESTED",
      status: "PROVISIONAL",
      evidence: [],
      confidence: "low",
      note: [entry.note, "证据不成立,已降级为优化器暂定(不得当作你的要求)"]
        .filter(Boolean)
        .join(";"),
    };
  });
}

function fromProvenanceRecord(record: ProvenanceRecord): RequirementLedgerEntry {
  return {
    id: `ledger-${record.id}`,
    text: record.text,
    source: record.source,
    status: statusForSource(record.source),
    evidence: [...record.evidence],
    confidence: record.confidence,
    ...(record.note ? { note: record.note } : {}),
  };
}

function statusForResolution(item: MissingResolutionItem): RequirementStatus {
  switch (item.classification) {
    case "AGENT_DISCOVERABLE":
      return "DISCOVERABLE";
    case "OPTIONAL":
      return "DEFERRED";
    default:
      return "OPEN";
  }
}

function fromResolutionItem(item: MissingResolutionItem): RequirementLedgerEntry {
  return {
    id: `ledger-${item.id}`,
    text: item.text,
    // 未决项的来源恒为 UNKNOWN:我们**不知道**它的值,更不知道用户有没有要求过。
    source: "UNKNOWN",
    status: statusForResolution(item),
    evidence: [],
    confidence: "low",
    note: `${item.classification}${item.blocking ? "(阻塞)" : ""}:${item.rationale}`,
  };
}

/**
 * 组装台账:用户要求 / 上下文要求(→CONFIRMED)+ 优化器建议(→PROVISIONAL)
 * + 未决项(→OPEN / DISCOVERABLE / DEFERRED)。来源与状态分离,且经过净化。
 */
export function buildLedger(input: {
  raw_input: string;
  context_turns?: readonly ConversationTurn[];
  explicit?: readonly ProvenanceRecord[];
  context?: readonly ProvenanceRecord[];
  suggested?: readonly ProvenanceRecord[];
  resolution?: readonly MissingResolutionItem[];
}): RequirementLedgerEntry[] {
  const entries: RequirementLedgerEntry[] = [
    ...(input.explicit ?? []).map(fromProvenanceRecord),
    ...(input.context ?? []).map(fromProvenanceRecord),
    ...(input.suggested ?? []).map(fromProvenanceRecord),
    ...(input.resolution ?? []).map(fromResolutionItem),
  ];
  return sanitizeLedger(entries, input.raw_input, input.context_turns ?? []);
}

// ─────────────────────────────────────────────────────────────────────────────
// 盲授权处理(「按你的判断继续」)
// ─────────────────────────────────────────────────────────────────────────────

/** 本轮输入里是否出现盲授权话术。 */
export function hasBlindTrust(rawInput: string): boolean {
  return BLIND_TRUST_RE.test(rawInput ?? "");
}

/**
 * 应用盲授权:**只**把 OPEN 项降到 PROVISIONAL / CONDITIONAL / DEFERRED,
 * 绝不产生 CONFIRMED / USER_EXPLICIT,也不改动用户自己已确认的条目。
 */
export function applyBlindTrust(
  entries: readonly RequirementLedgerEntry[],
  rawInput: string,
): RequirementLedgerEntry[] {
  if (!hasBlindTrust(rawInput)) return [...entries];
  const conditional = CONDITIONAL_RE.test(rawInput ?? "");
  return entries.map((entry) => {
    if (entry.status !== "OPEN") return entry;
    const status: RequirementStatus = conditional ? "CONDITIONAL" : "PROVISIONAL";
    return {
      ...entry,
      status,
      note: [entry.note, conditional ? "据你的条件式授权暂定(条件成立时生效)" : "据你的「按你的判断继续」暂定"]
        .filter(Boolean)
        .join(";"),
    };
  });
}

/**
 * 机械不变量(供校验器 / 单测调用):
 *  - 不存在「高权威来源但状态不是 CONFIRMED」的条目;
 *  - 不存在「USER_EXPLICIT / CONTEXT_EXPLICIT 但无证据」的条目;
 *  - 不存在「OPTIMIZER_SUGGESTED 但状态为 CONFIRMED」的条目。
 */
export function findLedgerViolations(entries: readonly RequirementLedgerEntry[]): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (isUserAuthority(entry.source)) {
      if (entry.evidence.length === 0) {
        problems.push(`${entry.id}: ${entry.source} 缺少逐字证据`);
      }
      if (entry.status !== "CONFIRMED") {
        problems.push(`${entry.id}: ${entry.source} 的状态应为 CONFIRMED,实为 ${entry.status}`);
      }
    }
    if (entry.source === "OPTIMIZER_SUGGESTED" && entry.status === "CONFIRMED") {
      problems.push(`${entry.id}: 优化器建议不得为 CONFIRMED`);
    }
  }
  return problems;
}
