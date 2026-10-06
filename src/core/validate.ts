/**
 * 输出守卫执行器（validate.ts）——anti-drift 的机械防线（PLAN-v1 §9 / S-07 检查点）。
 *
 * 三层校验（借鉴「守卫分层」思想，全部独立实现；未复制任何 AGPL 项目源码/模板/测试）：
 *
 *   ① Preservation（保真）
 *      - explicit / context 每条必须有逐字 quote 证据（复用 P01-T02 `validateProvenance`
 *        的机械字面比对：raw_input / 上下文 user 消息；assistant 发言永不算数）；
 *      - 策略 `required_sections` 必须齐全（输出契约不完整 = 错误）；
 *      - explicit / context 记录必须在优化稿中「可寻回」（关键词级，防整条要求丢失）；
 *      - 原始输入中的术语 / 型号 / 版本号不得凭空消失（用户要求的一部分 → error，其余 → warn）。
 *
 *   ② Inference & Suggestion（推断 / 建议边界）
 *      - OPTIMIZER_SUGGESTED 的条目不得出现在 explicit / context 来源组
 *        （invariant B：建议永不升级为用户要求）；
 *      - 建议文本不得无标注地混入优化稿正文（要求段）；
 *      - 「不可行 / 最终 / 确定 / 采用 / 淘汰…」类强断言必须有逐字证据，否则 error；
 *      - 无证据量化（预算 / 金额 / 工期 / 时限 / 平台 / 模型 / 技术栈）→ error。
 *
 *   ③ Unknown（未知纪律）
 *      - evidence 不足的关键信息必须按**处置契约**表达(执行前须知 / 分支条件 / 省略),`[待补充:]` 已退役;
 *      - `missing_constraints` 的每条缺口都必须对用户可见，不得被悄悄吞掉；
 *      - 「自行假设的硬约束」由 ② 的无证据量化规则兜住。
 *
 * 结构化输出 `CompileValidationResult`（extends `ValidationResult`）：
 *   - `problems`：三层问题 + 策略自带 guards 的汇总（稳定 rule id，便于 UI 标注与回归断言）；
 *   - `ok`：不存在 error 级问题（warn 只提示，不改变 ok）；
 *   - `provenance_ok`：`ok` 的语义别名，可直接写入 `CompileResult.provenance_ok`；
 *   - `layers` / `strategyGuards`：分层与守卫来源，便于审计。
 *
 * 纯函数：零 `ctx.llm` / Harness / UI / DOM / Node 依赖，可独立测试与跨端复用。
 * 设计来源为通用守卫工程实践（引用字面比对、层次化校验），实现与文案均本项目独立撰写。
 */
import { RETIRED_PLACEHOLDER_RE, USER_QUESTION_RE } from "./disposition-render.js";
import type {
  CompileResult,
  ConversationTurn,
  PromptStrategy,
  ValidationProblem,
  ValidationResult,
} from "./types.js";
import { validateProvenance } from "./provenance.js";
import {
  SUGGESTION_LABEL_EN,
  SUGGESTION_LABEL_ZH,
  TODO_PLACEHOLDER_PREFIX,
  TODO_PLACEHOLDER_PREFIX_EN,
  readProtocolLines,
  stripSuggestionLabel,
  stripSuggestionQuotedRefs,
  stripSuggestionReason,
} from "./strategies/_shared.js";

// ─────────────────────────────────────────────────────────────────────────────
// 稳定 rule id / 层名（对外契约：UI 标注与回归断言可引用，不得随意改名）
// ─────────────────────────────────────────────────────────────────────────────

/** 三层校验的稳定规则 id。 */
export const VALIDATION_RULE = {
  // ① Preservation
  /** 优化稿缺少策略要求的必出段落。 */
  requiredSectionMissing: "VALIDATION_REQUIRED_SECTION_MISSING",
  /** explicit / context 要求在优化稿中找不到任何可寻关键词（疑似丢失/改写）。 */
  requirementNotTraceable: "VALIDATION_REQUIREMENT_NOT_TRACEABLE",
  /** 原始输入中的术语 / 型号未在优化稿中出现（用户要求的一部分 → error，其余 → warn）。 */
  termDrift: "VALIDATION_TERM_DRIFT",
  // ② Inference & Suggestion
  /** 优化器建议出现在 explicit / context 来源组。 */
  suggestedInRequirements: "VALIDATION_SUGGESTED_IN_REQUIREMENTS",
  /** 优化器建议无标注地出现在优化稿正文（被无痕升级为要求）。 */
  suggestedUpgraded: "VALIDATION_SUGGESTED_UPGRADED",
  /** 无证据强断言（不可行 / 最终 / 确定 / 采用 / 淘汰…）。 */
  unprovenStrongClaim: "VALIDATION_UNPROVEN_STRONG_CLAIM",
  /** 无证据量化硬约束（预算 / 时间 / 平台 / 模型…）。 */
  unevidencedQuantification: "VALIDATION_UNEVIDENCED_QUANTIFICATION",
  // ③ Unknown
  /** 未知项 / 缺口未在优化稿中可定位(Phase 2 起接受执行前须知 / 分支条件形式)。 */
  unknownNotMarked: "VALIDATION_UNKNOWN_NOT_MARKED",
  /** v2 Phase 2(I-1):已退役的 [待补充:] / [TODO:] 占位符出现在优化稿中。 */
  retiredPlaceholder: "VALIDATION_RETIRED_PLACEHOLDER",
  /** v2 Phase 2(I-2):未决项被写成面向用户的追问。 */
  userFacingQuestion: "VALIDATION_USER_FACING_QUESTION",
  /** RC:交付稿为空(模型没有产出可用内容)。 */
  emptyOutput: "VALIDATION_EMPTY_OUTPUT",
  /** RC:交付稿残留协议标记(<<<DIAGNOSIS>>> 等),说明解析降级。 */
  protocolLeak: "VALIDATION_PROTOCOL_LEAK",
} as const;

/** 层名（顺序即执行 / 展示顺序）。 */
export const VALIDATION_LAYERS = [
  "preservation",
  "inference-suggestion",
  "unknown",
] as const;

export type ValidationLayer = (typeof VALIDATION_LAYERS)[number];

/** 单层校验结果。 */
export interface ValidationLayerReport {
  layer: ValidationLayer;
  ok: boolean;
  problems: ValidationProblem[];
}

/** 三层 + 策略守卫的完整校验结果。 */
export interface CompileValidationResult extends ValidationResult {
  /** `ok` 的语义别名：可直接写入 `CompileResult.provenance_ok`。 */
  provenance_ok: boolean;
  /** 分层明细（preservation / inference-suggestion / unknown）。 */
  layers: ValidationLayerReport[];
  /** 策略自带 `guards` 触发的问题（规则 id = 策略守卫 id）。 */
  strategyGuards: ValidationProblem[];
}

/** validateCompileResult 入参（全部可确定性提供）。 */
export interface ValidateCompileOptions {
  /** 用户本轮原始输入（逐字证据比对基准）。 */
  rawInput: string;
  /** 会话近期对话（上下文 user 证据基准）。 */
  contextTurns?: readonly ConversationTurn[];
  /** 被编译的策略（提供 required_sections 与自带 guards）。 */
  strategy?: PromptStrategy | null;
  /** 覆盖 required_sections（缺省取 strategy.required_sections）。 */
  requiredSections?: readonly string[];
  /**
   * 原始模型输出（可选）。提供时用于「协议段落级」扫描，口径与 finalizeCompile 一致；
   * 缺省时退化为对 `result.optimized_prompt` + 来源记录做扫描。
   */
  rawOutput?: string;
  /** 是否执行策略自带 guards（缺省 true；仅当提供 strategy 时生效）。 */
  runStrategyGuards?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 基础工具（纯函数）
// ─────────────────────────────────────────────────────────────────────────────

function issue(
  severity: ValidationProblem["severity"],
  rule: string,
  detail: string,
): ValidationProblem {
  return { severity, rule, detail };
}

function dedupeProblems(problems: ValidationProblem[]): ValidationProblem[] {
  const seen = new Set<string>();
  const out: ValidationProblem[] = [];
  for (const problem of problems) {
    const key = `${problem.severity}|${problem.rule}|${problem.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(problem);
  }
  return out;
}

function hasError(problems: ValidationProblem[]): boolean {
  return problems.some((problem) => problem.severity === "error");
}

/** 英文停用词：区分「术语 / 型号」与普通英文单词。 */
const TOKEN_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "these", "those",
  "are", "was", "were", "will", "would", "can", "could", "should", "shall",
  "you", "your", "our", "its", "his", "her", "their", "them", "they",
  "not", "but", "all", "any", "some", "such", "only", "also", "than",
  "then", "there", "here", "been", "being", "does", "did", "doing",
  "have", "has", "had", "into", "out", "about", "over", "under", "more",
  "most", "how", "what", "which", "when", "where", "why", "who",
  "make", "made", "get", "got", "use", "using", "used", "may", "might",
  "must", "yes", "ok", "okay", "please", "need", "needs", "want", "wants",
]);

/**
 * 强断言词（无逐字证据即 error）。
 * P07-T03 收窄：去掉裸「最终 / 确定」——它们常作交付物修饰语（「最终产出物 / 最终清单」）
 * 或既有前提引用（「按确定的口径」），并非新结论，误报会把干净产出判成 provenance_ok=false。
 * 保留全部**结论式**短语；与策略侧 `STRONG_CLAIM_SOURCE`（_shared）同口径。
 */
/**
 * 强断言词（无逐字证据即 error）。
 *
 * 「排除」的语义收窄（v0.2.0-apo release blocker 修复）：
 *   同一个词有两种用法，只有**事实结论**才是强断言：
 *     A. 动作 / 约束（合法，不得拦截）：「请排除不相关内容」「筛选时排除重复项」
 *        「约束：排除需要付费 API 的方案」——表达的是用户要求 / 执行要求。
 *     B. 事实结论（缺证据才拦）：「已排除网络问题」「可以排除权限问题」
 *        「因此排除配置异常」——声称某个可能原因已被事实证明不存在。
 *   因此「排除」只在**带结论标记**时才算强断言（已/已经/可以/能/得以/因此/由此/所以
 *   + 排除，或完成体「排除了 / 排除掉」）；裸「排除」不再匹配。
 *   这是**句法行为**规则（不是短语白名单），可测试、可审计。
 */
const STRONG_CLAIM_RE =
  /(已确认|已确定|已定论|已拍板|确认采用|确定采用|最终采用|最终方案|定为最终|选定为|不可行|无法实现|行不通|淘汰|放弃|(?:(?:已|已经|可以|可|能|得以|因此|由此|所以)\s*排除|排除(?:了|掉)))/;

/** 候选名（拉丁词）紧跟确认动词，如「H3 已确认 / ComfyUI 采用」。捕获组 2 为确认动词。 */
const CANDIDATE_CONFIRMED_RE =
  /([A-Za-z][A-Za-z0-9.+-]{1,})\s*(已确认|确定|采用|选用|定为)/;

/** 已降级 / 建议 / 候选 / 疑问等标注：命中即视为该行不是「无证据结论」。 */
const UNCERTAINTY_MARKER_RE =
  /待补充|待确认|待验证|待定|待复核|假设|候选|可能|建议|需研究|需验证|需核实|存疑|未经证实|无法确认|不排除|研究问题|不得|禁止|切勿|不要|勿|无需|不允许|不能(?:判定|认定|视为|看作|当作|得)|缺失|缺少|未说明|未提供|未给出|未给定|未提及|未明确|上下文已确认|已确认(?:约束|值|信息|事项|清单|口径|范围|条件|标准|前提|的|项|内容|事实|要求|需求|方案|路线|状态|配置|硬件|环境|参数|目标|假定|基础|材料|资料|细节|结论|结果)|[?？]|如何|怎样|怎么|是否|能否|哪些|哪个|为什么|若|如果|假如|倘若/;

/** 结构性行：Markdown 标题 / 四段协议标签（标签本身不是结论）。 */
const STRUCTURAL_LINE_RE =
  /^(?:#{1,6}\s|\*\*[^*]+\*\*\s*$|(?:明确要求|上下文已确认|优化器建议(?:\(可忽略\))?|待补充)\s*[:：]?\s*$)/;

/** 逐字证据标记。 */
const EVIDENCE_MARKER_RE = /\[quote:|\[证据:|【证据:/;

/** 该行是否已被证据 / 占位符 / 降级标注 / 建议前缀「保护」，从而不算无证据断言。 */
/** 已写明规格的前缀:规格行里的动词是**用户给的约束**,不是优化器的新结论。 */
const STATED_SPEC_PREFIX_RE =
  /^\s*(?:约束|要求|限制|禁止|排除|输出格式|格式|验收|验收标准|成功标准|风格|语气|篇幅)\s*[:：]/;

function isExemptLine(line: string): boolean {
  if (STATED_SPEC_PREFIX_RE.test(line)) return true;
  return (
    STRUCTURAL_LINE_RE.test(line) ||
    EVIDENCE_MARKER_RE.test(line) ||
    line.includes(TODO_PLACEHOLDER_PREFIX) ||
    line.includes(TODO_PLACEHOLDER_PREFIX_EN) ||
    line.includes(SUGGESTION_LABEL_ZH) ||
    line.includes(SUGGESTION_LABEL_EN) ||
    UNCERTAINTY_MARKER_RE.test(line)
  );
}

/** 该断言是否被 raw_input 或 explicit/context 记录的逐字 evidence 支撑。 */
function evidenceBacks(
  claim: string,
  result: CompileResult,
  rawInput: string,
): boolean {
  const clean = String(claim ?? "").trim();
  if (!clean) return false;
  if (String(rawInput ?? "").includes(clean)) return true;
  const records = [
    ...(result.explicit_requirements ?? []),
    ...(result.context_requirements ?? []),
  ];
  return records.some(
    (record) =>
      (record?.evidence ?? []).some((quote) => {
        const value = String(quote ?? "").trim();
        return value.length > 0 && (value.includes(clean) || clean.includes(value));
      }) ||
      ((record?.evidence ?? []).length > 0 &&
        String(record?.text ?? "").includes(clean)),
  );
}

/** 具体值是否已有逐字证据（raw_input 或 explicit/context 的 evidence quote）。 */
function evidenceContains(
  value: string,
  result: CompileResult,
  rawInput: string,
): boolean {
  const clean = String(value ?? "").trim();
  if (!clean) return false;
  if (String(rawInput ?? "").includes(clean)) return true;
  const records = [
    ...(result.explicit_requirements ?? []),
    ...(result.context_requirements ?? []),
  ];
  return records.some((record) =>
    (record?.evidence ?? []).some((quote) =>
      String(quote ?? "").includes(clean),
    ),
  );
}

/** CJK 连续文本的二字滑窗（用于「要求是否在优化稿中可寻回」的关键词级判断）。 */
function cjkBigrams(text: string): string[] {
  const out: string[] = [];
  const runs =
    String(text ?? "").match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? [];
  for (const run of runs) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** 从文本提取「可寻回关键词」：英文词（去停用词）+ CJK 二字滑窗。 */
function contentKeywords(text: string): string[] {
  const out = new Set<string>();
  for (const match of String(text ?? "").matchAll(/[A-Za-z][A-Za-z0-9.+#_-]{1,}/g)) {
    const token = match[0];
    if (!TOKEN_STOPWORDS.has(token.toLowerCase())) out.add(token.toLowerCase());
  }
  for (const bigram of cjkBigrams(text)) out.add(bigram);
  return [...out];
}

/** 关键词包含判定：纯英文关键词大小写不敏感，CJK 关键词逐字。 */
function containsKeyword(haystack: string, keyword: string): boolean {
  const hay = String(haystack ?? "");
  if (/^[a-z0-9.+#_-]+$/i.test(keyword) && /[a-z]/i.test(keyword)) {
    return hay.toLowerCase().includes(keyword.toLowerCase());
  }
  return hay.includes(keyword);
}

/**
 * 技术术语 / 型号 token：含数字的字母数字串（M1 / 32GB / H3）、
 * 至少两个大写字母的缩写或驼峰词（CUDA / AI / ComfyUI）、显存类数字+单位。
 * 普通英文单词不算术语，避免把正常改写误判为术语漂移。
 */
const TECH_TOKEN_RE =
  /[A-Za-z][A-Za-z0-9.+#_-]*|[0-9]+(?:[.][0-9]+)?\s?(?:GB|TB|MB|KB|GHz|MHz|fps)/g;

function technicalTokens(text: string): string[] {
  const out = new Set<string>();
  for (const match of String(text ?? "").matchAll(TECH_TOKEN_RE)) {
    const token = match[0].trim();
    if (token.length < 2) continue;
    const hasDigit = /[0-9]/.test(token);
    const upperCount = (token.match(/[A-Z]/g) ?? []).length;
    if (!hasDigit && upperCount < 2) continue;
    out.add(token);
  }
  return [...out];
}

/** 两条记录文本是否指向同一条语义单元（去建议前缀、触发理由与原话引用后逐字比较；短串要求包含）。 */
function sameSemanticUnit(left: string, right: string): boolean {
  const a = stripSuggestionLabel(stripSuggestionReason(stripSuggestionQuotedRefs(String(left ?? ""))));
  const b = stripSuggestionLabel(stripSuggestionReason(stripSuggestionQuotedRefs(String(right ?? ""))));
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.includes(short);
}

// ─────────────────────────────────────────────────────────────────────────────
// ① Preservation（保真）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 保真层：
 *   - explicit / context 逐字证据（复用 provenance 机械比对）；
 *   - required_sections 齐全；
 *   - 每条 explicit/context 要求在优化稿中至少一个关键词可寻回；
 *   - 原始输入术语 / 型号未丢失（用户要求的一部分 → error，其余 → warn）。
 */
export function validatePreservation(
  result: CompileResult,
  opts: ValidateCompileOptions,
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const rawInput = String(opts.rawInput ?? "");
  const contextTurns = [...(opts.contextTurns ?? [])];
  const optimized = String(result.optimized_prompt ?? "");
  const requirementRecords = [
    ...(result.explicit_requirements ?? []),
    ...(result.context_requirements ?? []),
  ];

  // 1a. 逐字证据：直接纳入 P01-T02 的机械比对结果（规则 id 属既有契约，不改名）。
  const provenance = validateProvenance(requirementRecords, rawInput, contextTurns);
  problems.push(...provenance.problems);

  // 1b. required_sections 齐全（策略输出契约）。
  const required =
    opts.requiredSections ?? opts.strategy?.required_sections ?? [];
  for (const section of required) {
    const name = String(section ?? "").trim();
    if (!name) continue;
    if (!optimized.includes(name)) {
      problems.push(
        issue(
          "error",
          VALIDATION_RULE.requiredSectionMissing,
          `优化稿缺少策略必出段落「${name}」:输出契约不完整`,
        ),
      );
    }
  }

  // 1c. 要求可寻回（关键词级，防整条要求被静默丢弃）。
  for (const record of requirementRecords) {
    const keywords = contentKeywords(
      `${record?.text ?? ""} ${(record?.evidence ?? []).join(" ")}`,
    );
    if (!keywords.length) continue;
    if (!keywords.some((keyword) => containsKeyword(optimized, keyword))) {
      problems.push(
        issue(
          "error",
          VALIDATION_RULE.requirementNotTraceable,
          `要求「${String(record?.text ?? "").trim()}」在优化稿中找不到任何可寻关键词:疑似丢失或改写用户要求`,
        ),
      );
    }
  }

  // 1d. 术语 / 型号漂移。
  if (optimized.trim()) {
    for (const token of technicalTokens(rawInput)) {
      if (containsKeyword(optimized, token)) continue;
      const userBacked = requirementRecords.some((record) =>
        (record?.evidence ?? []).some((quote) =>
          String(quote ?? "").includes(token),
        ),
      );
      problems.push(
        issue(
          userBacked ? "error" : "warn",
          VALIDATION_RULE.termDrift,
          userBacked
            ? `原始输入中的术语/型号「${token}」是用户明确要求的一部分,却未在优化稿中出现`
            : `原始输入中的术语/型号「${token}」未在优化稿中出现:请确认是否需要保留`,
        ),
      );
    }
  }

  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// ② Inference & Suggestion（推断 / 建议边界 + 无证据强断言 + 无证据量化）
// ─────────────────────────────────────────────────────────────────────────────

interface QuantificationPattern {
  label: string;
  pattern: RegExp;
}

/** 无证据量化硬约束的识别模式（捕获组 1 = 具体值，用于证据豁免判定）。 */
const QUANTIFICATION_PATTERNS: readonly QuantificationPattern[] = [
  {
    label: "预算/成本",
    pattern:
      /(?:预算|经费|成本|花费|费用|价格|定价|开销|budget)[^\n]{0,8}?((?:[¥￥$]\s?)?[0-9][0-9,.]*\s*(?:万|千|元|块|美元|USD|CNY|RMB|人民币|欧元|日元|k|K|w|W)?)/i,
  },
  {
    label: "工期/时限",
    pattern:
      /(?:耗时|时长|用时|工期|周期|截止|deadline|交付时间|完成时间|时间预算|time\s?budget|timeframe)[^\n]{0,8}?([0-9][0-9,.]*\s*(?:秒|分钟|分|小时|钟头|天|日|周|星期|个?月|年|min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years))/i,
  },
  {
    label: "平台/运行环境",
    pattern:
      // 注意:必须给裸 OS 加词边界 —— 否则会命中 `<<<DIAGNOSIS>>>` 里的 "OSIS"
      // (Phase 4 清理:这是历史 regex bug,迁移 general 后才暴露出来)。
      /(?:平台|操作系统|运行环境|部署到|运行在|系统版本|(?<![A-Za-z])OS(?![A-Za-z]))[^\n]{0,8}?[：:为是]?\s*([A-Za-z][A-Za-z0-9.+\-_]{1,20})/,
  },
  {
    label: "模型/引擎/框架",
    pattern:
      /(?:模型|引擎|算法|框架|技术栈|model|engine|framework)[^\n]{0,6}?(?:使用|采用|选用|为|是|用)?\s*([A-Z][A-Za-z0-9.+\-_]{1,})/,
  },
];

/** 构建「要求语境」行清单：优先协议段落（与 finalizeCompile 口径一致），再补来源记录文本。 */
function requirementLines(
  result: CompileResult,
  opts: ValidateCompileOptions,
): string[] {
  const lines: string[] = [];
  if (opts.rawOutput) {
    for (const { line, section } of readProtocolLines(opts.rawOutput)) {
      if (
        section === "explicit" ||
        section === "context" ||
        section === "optimized" ||
        section === "none"
      ) {
        lines.push(line);
      }
    }
  } else {
    for (const rawLine of String(result.optimized_prompt ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line) lines.push(line);
    }
  }
  for (const record of [
    ...(result.explicit_requirements ?? []),
    ...(result.context_requirements ?? []),
  ]) {
    const text = String(record?.text ?? "").trim();
    if (text) lines.push(text);
  }
  return [...new Set(lines)];
}

/**
 * 推断 / 建议层：
 *   - 建议不得出现在 explicit / context 来源组；
 *   - 建议不得无标注地混入优化稿正文；
 *   - 无证据强断言 → error；
 *   - 无证据量化（预算/时间/平台/模型）→ error。
 */
export function validateInferenceAndSuggestion(
  result: CompileResult,
  opts: ValidateCompileOptions,
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const rawInput = String(opts.rawInput ?? "");
  const suggested = result.suggested_requirements ?? [];
  const requirementRecords = [
    ...(result.explicit_requirements ?? []),
    ...(result.context_requirements ?? []),
  ];

  // 2a. 建议出现在 explicit / context 来源组。
  for (const record of suggested) {
    const text = stripSuggestionLabel(stripSuggestionReason(stripSuggestionQuotedRefs(String(record?.text ?? "")))).trim();
    if (!text) continue;
    const hit = requirementRecords.find((item) =>
      sameSemanticUnit(text, String(item?.text ?? "")),
    );
    if (hit) {
      problems.push(
        issue(
          "error",
          VALIDATION_RULE.suggestedInRequirements,
          `优化器建议「${text}」出现在「${String(hit.source ?? "explicit")}」来源组:建议必须保持建议身份,不得升级为用户要求`,
        ),
      );
    }
  }

  // 2b. 建议无标注地混入优化稿正文（被无痕升级为要求）。
  const optimized = String(result.optimized_prompt ?? "");
  for (const rawLine of optimized.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isExemptLine(line)) continue;
    for (const record of suggested) {
      const text = stripSuggestionLabel(stripSuggestionReason(stripSuggestionQuotedRefs(String(record?.text ?? "")))).trim();
      if (text && line.includes(text)) {
        problems.push(
          issue(
            "error",
            VALIDATION_RULE.suggestedUpgraded,
            `优化器建议「${text}」无标注地出现在优化稿要求语境:建议必须独立成段并带「${SUGGESTION_LABEL_ZH}」前缀`,
          ),
        );
        break;
      }
    }
  }

  // 2c. 无证据强断言。
  for (const line of requirementLines(result, opts)) {
    if (!line || isExemptLine(line)) continue;
    const claim =
      line.match(STRONG_CLAIM_RE)?.[0] ??
      line.match(CANDIDATE_CONFIRMED_RE)?.[2] ??
      null;
    if (claim && !evidenceBacks(claim, result, rawInput)) {
      problems.push(
        issue(
          "error",
          VALIDATION_RULE.unprovenStrongClaim,
          `发现无证据强断言「${claim}」:只能写成假设 / 研究问题 / 执行前须知(动作式),不得作为结论`,
        ),
      );
    }
  }

  // 2d. 无证据量化硬约束。
  for (const line of requirementLines(result, opts)) {
    if (!line || isExemptLine(line)) continue;
    for (const { label, pattern } of QUANTIFICATION_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      const phrase = String(match[0] ?? "").trim();
      const value = String(match[1] ?? "").trim();
      if (value && evidenceContains(value, result, rawInput)) break;
      if (evidenceContains(phrase, result, rawInput)) break;
      problems.push(
        issue(
          "error",
          VALIDATION_RULE.unevidencedQuantification,
          `发现无证据量化约束「${phrase}」(${label}):用户未提供的量化硬约束必须写成执行前须知(动作式)或分支条件,不得当作已知事实`,
        ),
      );
      break;
    }
  }

  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ Unknown（未知纪律）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 未知层：`[待补充:]` / `[TODO:]` 已退役(出现即 error);未决项按处置契约表达
 * 且在优化稿中可定位；出现无法定位的未知项 → error。
 */
export function validateUnknowns(
  result: CompileResult,
  opts: ValidateCompileOptions,
): ValidationProblem[] {
  void opts;
  const problems: ValidationProblem[] = [];
  const optimized = String(result.optimized_prompt ?? "");

  // ── RC:交付稿必须非空、且不含内部协议标记 ────────────────────────────────
  if (optimized.trim().length === 0) {
    problems.push(
      issue(
        "error",
        VALIDATION_RULE.emptyOutput,
        "交付稿为空:模型没有产出可用内容,不能作为提示词交付",
      ),
    );
  }
  if (/<<<[A-Z_]+>>>/.test(optimized)) {
    problems.push(
      issue(
        "error",
        VALIDATION_RULE.protocolLeak,
        "交付稿残留内部协议标记(<<<DIAGNOSIS>>> 等):解析降级,必须剥离后重出",
      ),
    );
  }

  // ── I-1 / I-2(Phase 2 契约,见 docs/phase2-contract.md)──────────────────
  // [待补充:] / [TODO:] 已退役:**出现即 error**(不再有任何合法用途)。
  if (RETIRED_PLACEHOLDER_RE.test(optimized)) {
    problems.push(
      issue(
        "error",
        VALIDATION_RULE.retiredPlaceholder,
        "优化稿出现已退役的 [待补充:] / [TODO:] 占位符:未决项必须写成执行前须知(动作式)、分支条件(条件式),或直接省略",
      ),
    );
  }
  // 未决项不得变成面向用户的追问(UNKNOWN ≠ ASK_USER)。
  if (USER_QUESTION_RE.test(optimized)) {
    problems.push(
      issue(
        "error",
        VALIDATION_RULE.userFacingQuestion,
        "优化稿把未决项写成了面向用户的追问:未决项应由执行方自行确认或按通用做法推进,不得反问用户",
      ),
    );
  }

  // ── 缺口可见性的归属(v2 契约)────────────────────────────────────────────
  // 优化稿**不再**承担「列出所有缺口」的职责:缺口由 Requirement Ledger / 面板
  // 对用户可见,只有「执行方须自行确认」与「分支条件」两类才写入正文。
  // 因此这里不再对「未在正文出现」报任何问题(省略是合法处置,见 phase2-contract §2)。

  return dedupeProblems(problems);
}

// ─────────────────────────────────────────────────────────────────────────────
// 守卫汇总 + 总入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 汇总策略自带 `guards`：每个守卫返回问题描述即记 error（规则 id = 守卫 id）。
 * `strategy` 缺省时返回空数组。
 */
export function collectStrategyGuardProblems(
  strategy: PromptStrategy | null | undefined,
  result: CompileResult,
  output: string,
  rawInput: string,
): ValidationProblem[] {
  if (!strategy) return [];
  const problems: ValidationProblem[] = [];
  for (const guard of strategy.guards ?? []) {
    const detail = guard.check(output, result, rawInput);
    if (detail) problems.push(issue("error", guard.id, detail));
  }
  return problems;
}

/**
 * 三层校验 + 策略守卫汇总（单一入口）。
 *
 * - `ok = !problems.some(severity === 'error')`；warn 只提示；
 * - `provenance_ok = ok`，可直接写入 `CompileResult.provenance_ok`；
 * - 策略守卫的 `output` 取 `opts.rawOutput ?? result.optimized_prompt`。
 */
export function validateCompileResult(
  result: CompileResult,
  opts: ValidateCompileOptions,
): CompileValidationResult {
  const preservation = dedupeProblems(validatePreservation(result, opts));
  const inference = dedupeProblems(validateInferenceAndSuggestion(result, opts));
  const unknown = dedupeProblems(validateUnknowns(result, opts));

  const runGuards = opts.runStrategyGuards !== false;
  const strategyGuards = runGuards
    ? collectStrategyGuardProblems(
        opts.strategy,
        result,
        opts.rawOutput ?? String(result.optimized_prompt ?? ""),
        String(opts.rawInput ?? ""),
      )
    : [];

  const layers: ValidationLayerReport[] = [
    { layer: "preservation", ok: !hasError(preservation), problems: preservation },
    {
      layer: "inference-suggestion",
      ok: !hasError(inference),
      problems: inference,
    },
    { layer: "unknown", ok: !hasError(unknown), problems: unknown },
  ];

  const problems = dedupeProblems([
    ...preservation,
    ...inference,
    ...unknown,
    ...strategyGuards,
  ]);
  const ok = !hasError(problems);

  return { ok, provenance_ok: ok, problems, layers, strategyGuards };
}

/** 便捷判定：结果是否通过全部三层 + 策略守卫（= `provenance_ok`）。 */
export function isCompileResultValid(
  result: CompileResult,
  opts: ValidateCompileOptions,
): boolean {
  return validateCompileResult(result, opts).ok;
}
