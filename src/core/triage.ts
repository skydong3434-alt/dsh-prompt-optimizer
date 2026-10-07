/**
 * Edit Triage(KEEP / PATCH / RESTRUCTURE / REBUILD)—— v2 §C4。
 *
 * 产品立场:优化器的天职是「保住用户意图」,不是「把输入改成自己喜欢的样子」。
 * 因此分诊的第一原则是**最小必要干预**:
 *   - KEEP 一旦成立,就是硬承诺:原样返回,绝不改写;
 *   - REBUILD 是最后手段:只有「输入根本无法构成有效任务」才允许;
 *   - 拿不准时向「更轻」的一侧倒(宁可 PATCH,不轻易 RESTRUCTURE;
 *     宁可 RESTRUCTURE,不轻易 REBUILD)。
 *
 * 判据 = 机械信号(确定性,可测试) + LLM 建议(参考),合并规则见 `mergeTriage`。
 * 纯函数,零 LLM / 零 Harness / 零 UI 依赖。
 */
import type { EditTriage, TriageDecision } from "./types.js";
import { TRIAGE_SEVERITY } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 机械信号
// ─────────────────────────────────────────────────────────────────────────────

/** 可执行动词 / 任务线索:没有它基本不构成任务。 */
const ACTIONABLE_RE =
  /帮我|帮忙|帮忙做|请|写|做|改|修|查|找|分析|生成|创建|实现|设计|评审|review|检查|翻译|优化|规划|调研|研究|修复|部署|搭建|整理|总结|对比|计算|提取|转换|重写|润色|执行|跑一下|试一下|build|write|create|implement|refactor|fix|analyze|research|plan|review|translate|generate|design|optimize|summarize|compare|extract/i;

const ROLE_RE = /你是|你作为|扮演|角色|作为一[个名位]|assistant|你负责|你的任务|act as|you are/i;
const CONSTRAINT_RE =
  /要求|约束|必须|需要|不得|禁止|不要|仅限|只能|限制|边界|前置|依赖|先决|必须遵守|务必|至少|最多|不超过|不允许|must|should not|do not|only|at most|at least/i;
const FORMAT_RE =
  /输出格式|输出|返回|格式|以.{0,8}形式|json|markdown|表格|字段|结构|清单|逐条|分点|大纲|schema|format|output/i;
const ACCEPTANCE_RE =
  /验收|完成标准|成功标准|检查点|测试|自查|自检|通过标准|预期结果|满足以下|确保|acceptance|criteria|test|verify|definition of done/i;

/** 结构性信号:编号 / 项目符号 / 标题 / 方括号分段。 */
const STRUCTURE_RES: readonly { id: string; re: RegExp }[] = [
  { id: "numbered-list", re: /^[ \t]*\d+[.、)]\s+/m },
  { id: "bullet-list", re: /^[ \t]*[-*•·]\s+/m },
  { id: "heading", re: /^[ \t]*#{1,6}\s+\S/m },
  { id: "bracket-section", re: /【[^】]{1,20}】/ },
  { id: "labelled-lines", re: /^[ \t]*[^\n:：]{1,12}[:：]\s*\S/m },
];

/** 纯寒暄 / 无内容输入(REBUILD 的强信号)。 */
const GREETING_ONLY_RE =
  /^(?:你好|您好|hi|hello|hey|嗨|哈喽|在吗|在不在|谢谢|多谢|thanks|thank you|thx|ok|okay|好的|收到|嗯|哦|额|测试|test)[\s!！。,.，?？~～]*$/i;

export interface InputSignals {
  /** 去空白后的字符数。 */
  length: number;
  /** 可执行动词命中。 */
  actionable: boolean;
  role: boolean;
  constraint: boolean;
  format: boolean;
  acceptance: boolean;
  /** 命中的结构信号 id 列表。 */
  structures: string[];
  /** 段落数(空行分隔)。 */
  paragraphs: number;
  /** 句子数(中英句读分割,粗略)。 */
  sentences: number;
  /** 疑似重复行(同一非空行出现 ≥2 次)。 */
  repeatedLines: number;
  /** 疑似重复分句(同一 ≥4 字分句出现 ≥2 次;长段落里的复读机现象)。 */
  repeatedClauses: number;
  /** 纯寒暄 / 空输入。 */
  emptyOrGreeting: boolean;
}

/** 抽取机械信号(确定性,可单测)。 */
export function analyzeInputSignals(rawInput: string): InputSignals {
  const text = typeof rawInput === "string" ? rawInput : "";
  const trimmed = text.trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.length < 4) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  // 长段落里的复读:按中英逗号 / 分号切分句,统计重复分句(≥4 字)。
  const clauseCounts = new Map<string, number>();
  for (const clause of text.split(/[，,;；]+/)) {
    const trimmedClause = clause.replace(/\s+/g, '').trim();
    if (trimmedClause.length < 4) continue;
    clauseCounts.set(trimmedClause, (clauseCounts.get(trimmedClause) ?? 0) + 1);
  }
  return {
    length: trimmed.length,
    actionable: ACTIONABLE_RE.test(trimmed),
    role: ROLE_RE.test(trimmed),
    constraint: CONSTRAINT_RE.test(trimmed),
    format: FORMAT_RE.test(trimmed),
    acceptance: ACCEPTANCE_RE.test(trimmed),
    structures: STRUCTURE_RES.filter((entry) => entry.re.test(text)).map((entry) => entry.id),
    paragraphs: trimmed ? trimmed.split(/\n\s*\n/).filter((part) => part.trim()).length : 0,
    sentences: trimmed ? trimmed.split(/[。！？!?.;；\n]+/).filter((part) => part.trim()).length : 0,
    repeatedLines: [...counts.values()].filter((count) => count >= 2).length,
    repeatedClauses: [...clauseCounts.values()].filter((count) => count >= 2).length,
    emptyOrGreeting: trimmed.length === 0 || GREETING_ONLY_RE.test(trimmed),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 机械分诊
// ─────────────────────────────────────────────────────────────────────────────

/** KEEP 的安全阈值:低于它就绝不判 KEEP(保守,避免「以为成稿其实很糊」)。 */
export const KEEP_MIN_LENGTH = 200;
/** KEEP 需要的最少「成稿特征」数(role/constraint/format/acceptance)。 */
export const KEEP_MIN_QUALITY_SIGNALS = 2;
/** RESTRUCTURE 需要的最少字符数(太短谈不上「乱但完整」)。 */
export const RESTRUCTURE_MIN_LENGTH = 80;

function qualitySignalCount(signals: InputSignals): number {
  return [signals.role, signals.constraint, signals.format, signals.acceptance].filter(Boolean).length;
}

/**
 * 机械分诊(确定性)。
 *
 * 判据表(自上而下,命中即返回):
 *  1. 空 / 纯寒暄 / 无动词且极短          → REBUILD
 *  2. 长 + 结构充分 + 成稿特征充分        → KEEP(keep_safe=true)
 *  3. 信息够 + 结构稀薄 + 明显冗长/重复   → RESTRUCTURE
 *  4. 有可保留的东西(结构 / 成稿要素)   → PATCH
 *  5. 只有模糊目标(无可保留内容)         → REBUILD
 */

/**
 * 是否存在**确定性结构混乱证据**(RESTRUCTURE 的唯一合法依据)。
 *
 * 与 mechanicalTriage 的 RESTRUCTURE 分支同一判据(复用同一 InputSignals,
 * 不再调用模型、不引入评分系统):
 *   组织混乱(重复行 / 重复分句 / 单段落多句 / 长且无结构)
 *   ∧ 长度达阈值 ∧ 成稿特征 ≥2
 *
 * 注意:**缺信息**(项目名 / 命令 / 环境 / API / 路径 / 日志位置)不是 restructure 证据 ——
 * 那些走 Missing Resolution / AGENT_DISCOVERABLE / USER_REQUIRED,不扩大编辑权限。
 */
export function hasRestructureEvidence(signals: InputSignals): boolean {
  const messy =
    signals.repeatedLines > 0 ||
    signals.repeatedClauses > 0 ||
    (signals.paragraphs <= 1 && signals.sentences >= 6) ||
    (signals.length >= RESTRUCTURE_MIN_LENGTH && signals.structures.length === 0 && signals.sentences >= 3);
  return signals.length >= RESTRUCTURE_MIN_LENGTH && messy && qualitySignalCount(signals) >= 2;
}

export function mechanicalTriage(rawInput: string): TriageDecision {
  const signals = analyzeInputSignals(rawInput);

  // ① 空 / 寒暄 → 无法构成任务
  if (signals.emptyOrGreeting) {
    return decide("REBUILD", ["输入为空或仅为寒暄,无法构成有效任务"], [], false, signals);
  }

  const quality = qualitySignalCount(signals);

  // ② KEEP:长 + 结构充分 + 成稿特征充分 → 原样保留(唯一有硬阈值的级别)
  if (
    signals.length >= KEEP_MIN_LENGTH &&
    signals.structures.length >= 2 &&
    quality >= KEEP_MIN_QUALITY_SIGNALS
  ) {
    return decide(
      "KEEP",
      ["输入已具备成稿特征(结构 + 约束/格式/验收),应原样保留"],
      [
        `长度=${signals.length}`,
        `结构信号=${signals.structures.join(",")}`,
        `成稿特征=${quality}`,
      ],
      true,
      signals,
    );
  }

  // ③ RESTRUCTURE:信息基本齐(成稿特征 ≥2)但组织混乱 → 只重组,不改语义
  const messy =
    signals.repeatedLines > 0 ||
    signals.repeatedClauses > 0 ||
    (signals.paragraphs <= 1 && signals.sentences >= 6) ||
    (signals.length >= RESTRUCTURE_MIN_LENGTH && signals.structures.length === 0 && signals.sentences >= 3);
  if (signals.length >= RESTRUCTURE_MIN_LENGTH && messy && quality >= 2) {
    return decide(
      "RESTRUCTURE",
      ["信息已基本完整,但组织混乱(缺结构 / 冗长 / 有重复),只需重组不改语义"],
      [
        `长度=${signals.length}`,
        `段落=${signals.paragraphs}`,
        `重复行=${signals.repeatedLines}`,
        `重复分句=${signals.repeatedClauses}`,
      ],
      false,
      signals,
    );
  }

  /**
   * ④ PATCH vs REBUILD 的分界(Phase 4 语义修正):
   *    PATCH = 「原 Prompt 的结构和表达基本成立」→ 必须**有可保留的东西**:
   *            已有提示词结构(编号 / 小标题 / 标签行),或已有成稿特征(角色 / 约束 / 格式 / 验收)。
   *    REBUILD = 什么都没有 —— 只有一句模糊目标(「我想用 dsh 控制 comfyui 生成视频」),
   *            需要先把需求问清楚、再从零构建 Prompt。
   *
   * 旧实现把「有动词」当成 PATCH 的依据,导致模糊目标被误判为「局部修改」;
   * 这里改为按「可保留性」判定,与 Edit Triage 的正式语义一致。
   */
  const hasStructure = signals.structures.length > 0;
  if (hasStructure || quality > 0) {
    return decide(
      "PATCH",
      [
        hasStructure
          ? "输入已有提示词结构,只需局部补充或修正"
          : "输入已给出可保留的成稿要素(约束 / 格式 / 角色 / 验收),只需补齐缺口",
      ],
      [
        `长度=${signals.length}`,
        `结构信号=${signals.structures.join(",") || "(无)"}`,
        `成稿特征=${quality}`,
      ],
      false,
      signals,
    );
  }

  return decide(
    "REBUILD",
    ["只有模糊目标,没有可保留的提示词结构或成稿要素;需先明确需求再从零构建 Prompt"],
    [`长度=${signals.length}`, `可执行动词=${signals.actionable}`, `结构信号=(无)`, `成稿特征=0`],
    false,
    signals,
  );
}

function decide(
  triage: EditTriage,
  reasons: string[],
  extraSignals: string[],
  keepSafe: boolean,
  signals: InputSignals,
): TriageDecision {
  return {
    triage,
    reasons,
    signals: [...extraSignals, ...signals.structures.map((id) => `structure:${id}`)],
    keep_safe: keepSafe,
    mechanical: triage,
    // 最小布尔量:确定性结构混乱证据(mergeTriage 判「模型能否升级到 RESTRUCTURE」用)
    restructure_eligible: hasRestructureEvidence(signals),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 与 LLM 建议合并
// ─────────────────────────────────────────────────────────────────────────────

function isTriage(value: unknown): value is EditTriage {
  return value === "KEEP" || value === "PATCH" || value === "RESTRUCTURE" || value === "REBUILD";
}

/**
 * 合并规则(保守优先,可机械验证):
 *  1. 取严重度较大者(max);
 *  2. KEEP **必须双方都同意**才成立,否则降级为 PATCH(绝不误承诺「不改写」);
 *  3. REBUILD **必须机械判据同意**才成立,否则降级为 RESTRUCTURE
 *     (LLM 无权把用户的长成稿判为「重写」);
 *  4. LLM 未给建议时完全按机械判据。
 */
export function mergeTriage(
  mechanical: TriageDecision,
  llmSuggestion: unknown,
  llmReasons: readonly string[] = [],
): TriageDecision {
  if (!isTriage(llmSuggestion)) return mechanical;

  const mechanicalLevel = mechanical.triage;
  const severity = Math.max(TRIAGE_SEVERITY[mechanicalLevel], TRIAGE_SEVERITY[llmSuggestion]);
  let merged: EditTriage = (Object.keys(TRIAGE_SEVERITY) as EditTriage[]).find(
    (level) => TRIAGE_SEVERITY[level] === severity,
  )!;

  const reasons = [...mechanical.reasons];
  const signals = [...mechanical.signals];
  if (llmSuggestion !== mechanicalLevel) {
    reasons.push(`模型建议 ${llmSuggestion}` + (llmReasons.length ? `:${llmReasons.join(";")}` : ""));
  }
  if (llmSuggestion === "KEEP" && mechanicalLevel !== "KEEP") {
    // 双向 KEEP 承诺:机械判据不认 → 不采纳模型的 KEEP。
    reasons.push(`模型建议 KEEP,但机械判据为 ${mechanicalLevel},已降级;KEEP 需双方一致`);
  }

  let keepSafe = mechanical.keep_safe;
  if (merged === "KEEP" && !(mechanicalLevel === "KEEP" && llmSuggestion === "KEEP")) {
    merged = "PATCH";
    keepSafe = false;
    reasons.push("KEEP 需机械判据与模型一致,已降级为 PATCH");
  }
  if (merged === "REBUILD" && mechanicalLevel !== "REBUILD") {
    merged = "RESTRUCTURE";
    reasons.push("REBUILD 需机械判据确认;模型无权重写用户的成稿");
  }

  // ★ v0.2.0-apo release blocker 修复(TRIAGE_ESCALATION):
  //   机械判为 PATCH 时,RESTRUCTURE **只能**由确定性结构混乱证据支持。
  //   旧行为:模型给 REBUILD 被守卫拦下后**借道**降级成 RESTRUCTURE —— 等于模型
  //   虽未获得 REBUILD 权限,却绕道拿到了 RESTRUCTURE 权限,并实际发生大面积重组
  //   (真实证据:B fixture 39 字 → 1058 字、7 个新标题、原条目措辞丢失)。
  //   违反 Edit Triage = 最小必要编辑。
  if (merged === "RESTRUCTURE" && mechanicalLevel === "PATCH") {
    if (mechanical.restructure_eligible === true) {
      reasons.push("模型建议 RESTRUCTURE,且存在确定性结构混乱证据(重复/冗长/无结构),采纳");
    } else {
      merged = "PATCH";
      reasons.push("模型建议 RESTRUCTURE,但无确定性结构混乱证据 → 保持 PATCH(最小必要编辑;不得借道升级)");
    }
  }

  return {
    triage: merged,
    reasons,
    signals,
    keep_safe: merged === "KEEP" ? keepSafe : false,
    llm_advised: true,
    mechanical: mechanicalLevel,
    llm_suggestion: llmSuggestion,
  };
}

/**
 * 分诊决策入口:机械判据 + 可选 LLM 建议 → 最终分诊。
 * KEEP 时 `keep_safe=true` 且 `triage==='KEEP'`,调用方据此**跳过编译 LLM 调用**。
 */
export function decideTriage(input: {
  raw_input: string;
  llm_suggestion?: unknown;
  llm_reasons?: readonly string[];
}): TriageDecision {
  const mechanical = mechanicalTriage(input.raw_input);
  return mergeTriage(mechanical, input.llm_suggestion, input.llm_reasons ?? []);
}

/** 该分诊是否需要 LLM 参与改写(KEEP 为 false)。 */
export function triageNeedsModel(triage: EditTriage): boolean {
  return triage !== "KEEP";
}
