/**
 * Requirement Discovery 引擎 —— v2 Phase 3。
 *
 * 职责(严格按产品定义):
 *   · **只解决**「必须由用户决定 + Agent 查不到 + 不同答案显著改变方案 + 无安全默认值」
 *     的高影响缺失;
 *   · 停止条件是 **blocking USER_REQUIRED = 0**(decision completeness),
 *     **不是** UNKNOWN = 0(information completeness);
 *   · 动态循环:每轮重新计算,不沿用预生成的 Q2/Q3/Q4。
 *
 * 三个纯机械组件 + 一个安全保护:
 *   1. Question Planner —— 排序(方案影响 / 用户专属 / 阻塞 / 分支收敛)、依赖分轮、去重、1–2(≤3);
 *   2. Answer Resolver —— 把用户回答解析回 Requirement Ledger
 *      (confirm / reject / supersede / invalidate / not_applicable / derived);
 *   3. Sufficiency Evaluator —— 结合**当前**状态重算 live blocking,而不是数字段;
 *   4. Loop guards —— 重复问题 / 无新信息 / 最大轮次。
 *
 * 语义细腻的部分(问法、选项、取舍语义)由模型经**同一个分析契约**提供
 * (`AnalysisResult.questions` / `.decisions`),本模块不让模型决定「要不要问、问几个」
 * —— 那两件事必须是可审计的机械规则。
 *
 * 纯函数(除 LLM 契约投影外),零 Harness / UI 依赖。
 */
import type {
  AnalysisResult,
  AskedQuestion,
  DiscoveryAnswer,
  DiscoveryOption,
  DiscoveryQuestion,
  DiscoveryRound,
  DiscoverySessionState,
  EditTriage,
  MissingResolutionItem,
  RequirementConfirmation,
  RequirementLedgerEntry,
  RequirementStatus,
} from "./types.js";
import { computeAnalysisGate, findLedgerViolations, sanitizeLedger } from "./requirements.js";
import { planResponsibilities } from "./responsibilities.js";

/** 每轮默认问题数 / 硬上限。 */
export const DISCOVERY_DEFAULT_QUESTIONS = 2;
export const DISCOVERY_MAX_QUESTIONS_PER_ROUND = 3;
/** 最大轮次(安全保护,不是产品目标)。 */
export const DISCOVERY_MAX_ROUNDS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Session(客户端持有;宿主做不可信输入净化)
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoveryInput {
  raw_input: string;
  triage: EditTriage;
  ledger: RequirementLedgerEntry[];
  asked?: AskedQuestion[];
  answers?: DiscoveryAnswer[];
  questions?: DiscoveryQuestion[];
  round?: number;
  analysis?: AnalysisResult;
}

/** 净化客户端回传的会话:**只增不减地收紧**,绝不接受来源升格。 */
export function sanitizeSession(
  input: DiscoveryInput,
  contextTurns: readonly { role: "user" | "assistant"; text: string }[] = [],
): DiscoverySessionState {
  const ledger = sanitizeLedger(
    Array.isArray(input.ledger) ? input.ledger.filter(isLedgerEntry) : [],
    input.raw_input,
    [...contextTurns],
  );
  return {
    raw_input: input.raw_input,
    round: Number.isInteger(input.round) && (input.round ?? 0) > 0 ? (input.round as number) : 1,
    triage: input.triage,
    ledger,
    asked: Array.isArray(input.asked) ? input.asked.filter(isAsked) : [],
    answers: Array.isArray(input.answers) ? input.answers.filter(isAnswer) : [],
    questions: Array.isArray(input.questions) ? input.questions.filter(isQuestion) : [],
    ...(input.analysis ? { analysis: input.analysis } : {}),
  };
}

/** 会话不变量(宿主 fail-closed 用):任何违规都必须拒绝编译。 */
export function findSessionViolations(session: DiscoverySessionState): string[] {
  return findLedgerViolations(session.ledger);
}

function isLedgerEntry(value: unknown): value is RequirementLedgerEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.text === "string" && typeof record.source === "string";
}

function isAsked(value: unknown): value is AskedQuestion {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" && typeof record.question === "string";
}

function isQuestion(value: unknown): value is DiscoveryQuestion {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" && typeof record.requirement_id === "string";
}

function isAnswer(value: unknown): value is DiscoveryAnswer {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" && typeof record.text === "string";
}

// ─────────────────────────────────────────────────────────────────────────────
// 问题指纹与去重(禁止换句话重复询问)
// ─────────────────────────────────────────────────────────────────────────────

/** 规范化:去空白 / 标点 / 常见改写前后缀,便于「同一问题换说法」去重。 */
export function normalizeQuestionText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s，。；、,.;:：!！?？"'“”‘’()（）[\]【】《》<>·…—-]/g, "")
    .replace(/^(?:请问|那么|所以|接下来|另外|还有)/, "")
    .replace(/(?:呢|吗|吧|么)$/, "");
}

/** 问题指纹 = requirement id + 规范化问法(改措辞也能命中)。 */
export function questionFingerprint(requirementId: string, question: string): string {
  return `${requirementId}::${normalizeQuestionText(question)}`;
}

/** 词元集合(bigram + 英文词),用于「同义改写」相似度判定。 */
function tokensOf(text: string): Set<string> {
  const normalized = normalizeQuestionText(text);
  const tokens = new Set<string>();
  for (const word of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 2) tokens.add(word);
  }
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    tokens.add(normalized.slice(i, i + 2));
  }
  return tokens;
}

/** Jaccard 相似度。 */
export function questionSimilarity(a: string, b: string): number {
  const left = tokensOf(a);
  const right = tokensOf(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * 该问题是否已经问过(或只是换了个说法)。
 * 判定:同 requirement id + 指纹相同 → 命中;或同 requirement id + 相似度 ≥ 0.72 → 命中。
 */
export function isAlreadyAsked(
  question: { requirement_id: string; question: string; key: string },
  asked: readonly AskedQuestion[],
): boolean {
  const fingerprint = questionFingerprint(question.requirement_id, question.question);
  for (const record of asked) {
    if (record.key === question.key || record.fingerprint === fingerprint) return true;
    if (
      record.key.startsWith(`${question.requirement_id}::`) &&
      questionSimilarity(record.question, question.question) >= 0.72
    ) {
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Question Planner
// ─────────────────────────────────────────────────────────────────────────────

export interface PlannerInput {
  raw_input: string;
  triage: EditTriage;
  ledger: readonly RequirementLedgerEntry[];
  /** 当前仍阻塞的 USER_REQUIRED(由分析门给出)。 */
  blocking: readonly MissingResolutionItem[];
  asked?: readonly AskedQuestion[];
  answers?: readonly DiscoveryAnswer[];
  /** 模型给出的候选问题(分析契约 `questions[]`;可为空 → 机械兜底问法)。 */
  candidates?: readonly DiscoveryQuestion[];
  round?: number;
  /** 覆盖默认问题数(测试用)。 */
  maxQuestions?: number;
}

interface Scored {
  requirement: MissingResolutionItem;
  candidate?: DiscoveryQuestion;
  score: number;
  /** 该答案能消除多少个方案分支(答案不确定度 / 关联项数)。 */
  branchReduction: number;
  dependsOn: string[];
}

/**
 * 分支收敛度:该决定能消除多少「其它未决项」。
 * 机械近似:同一条 requirement 文本里出现「还是 / 或者」的选项数,加上它所 invalidate 的项数。
 */
function estimateBranchReduction(
  requirement: MissingResolutionItem,
  candidate: DiscoveryQuestion | undefined,
): number {
  const optionCount = candidate?.options?.length ?? 0;
  const invalidates = candidate?.options?.reduce((sum, option) => sum + (option.invalidates?.length ?? 0), 0) ?? 0;
  const alternatives = (requirement.text.match(/还是|或者|要么|或/g) ?? []).length;
  return optionCount + invalidates + alternatives;
}

/**
 * Question Planner:选出**本轮**最有价值的 1–2(≤3)个问题。
 *
 * 优先级(加权和,权重体现产品判断):
 *   Solution Impact(高=3/中=1/低=0)×3
 * + User Exclusivity(用户专属=2)×2
 * + Blocking(阻塞=3)×3
 * + Branch Reduction(消除分支数)×1
 *
 * 硬约束:
 *   1. 已问过(含换说法)→ 不问;
 *   2. 依赖未解决 → 不问(依赖分轮);
 *   3. 同轮**不得**同时问有依赖关系的两个问题;
 *   4. 数量上限:默认 2,最多 3。
 */
export function planQuestions(input: PlannerInput): DiscoveryRound {
  const round = input.round ?? 1;
  const asked = [...(input.asked ?? [])];
  const answers = new Set((input.answers ?? []).map((answer) => answer.key));
  const maxQuestions = Math.min(
    input.maxQuestions ?? DISCOVERY_DEFAULT_QUESTIONS,
    DISCOVERY_MAX_QUESTIONS_PER_ROUND,
  );

  const live = input.blocking.filter((item) => item.blocking && item.classification === "USER_REQUIRED");
  const blockingCount = live.length;

  if (blockingCount === 0) {
    return { round, verdict: "READY_TO_CONFIRM", questions: [], rationale: "没有阻塞性的用户决定,可以直接生成", blocking_count: 0 };
  }

  // 已解决的 requirement id(有回答 / 已被条件化)→ 不再问
  const resolved = new Set(
    input.ledger
      .filter((entry) => entry.status !== "OPEN")
      .map((entry) => entry.id.replace(/^ledger-/, "")),
  );
  // 已经问过的 requirement id → 不再问(**即使换了措辞**):同一条决策不重复盘问。
  // 「修改理解」重开某项时,调用方会先清掉该项的 asked 记录(见 index.ts)。
  const askedRequirementIds = new Set(asked.map((record) => String(record.key).split("::")[0]));

  const candidates = [...(input.candidates ?? [])];
  const scored: Scored[] = [];
  for (const requirement of live) {
    const requirementId = requirement.id;
    if (resolved.has(requirementId) || answers.has(requirementId)) continue;
    if (askedRequirementIds.has(requirementId)) continue;
    const candidate = candidates.find(
      (item) => item.requirement_id === requirementId || item.key === requirementId,
    );
    const branchReduction = estimateBranchReduction(requirement, candidate);
    const impact = requirement.impact === "high" ? 3 : requirement.impact === "medium" ? 1 : 0;
    const exclusivity = requirement.user_exclusive ? 2 : 0;
    const score = impact * 3 + exclusivity * 2 + 3 * 3 + branchReduction;
    scored.push({
      requirement,
      ...(candidate ? { candidate } : {}),
      score,
      branchReduction,
      dependsOn: candidate?.depends_on ? [...candidate.depends_on] : [],
    });
  }

  // 依赖分轮:先问「无依赖」的;若全部都有未解决依赖 → 退回问依赖链最浅的那个。
  const unresolvedIds = new Set(scored.map((entry) => entry.requirement.id));
  const askedIds = new Set(asked.map((record) => record.key.split("::")[0]));
  const ready = scored.filter(
    (entry) => entry.dependsOn.every((id) => !unresolvedIds.has(id) && !askedIds.has(id)),
  );
  const pool = ready.length > 0 ? ready : scored;
  pool.sort((a, b) => b.score - a.score || b.branchReduction - a.branchReduction);

  // 同轮不得问有依赖关系的两个问题
  const picked: Scored[] = [];
  const pickedIds = new Set<string>();
  for (const entry of pool) {
    if (picked.length >= maxQuestions) break;
    if (entry.dependsOn.some((id) => pickedIds.has(id))) continue;
    // 互相依赖(双向)也不得同轮
    if (picked.some((other) => other.dependsOn.includes(entry.requirement.id))) continue;
    picked.push(entry);
    pickedIds.add(entry.requirement.id);
  }

  // 防重复询问:把已问过的从候选中剔除;若全被剔除 → 无法形成高价值新问题 → 停止
  const fresh = picked.filter((entry) => {
    const question = toQuestion(entry.requirement, entry.candidate);
    return !isAlreadyAsked(question, asked);
  });

  if (fresh.length === 0) {
    const anyCandidate = pool.some((entry) => {
      const question = toQuestion(entry.requirement, entry.candidate);
      return !isAlreadyAsked(question, asked);
    });
    return {
      round,
      verdict: "READY_TO_CONFIRM",
      questions: [],
      rationale: anyCandidate
        ? "本轮没有高于现有答案价值的新问题,按决策完备处理"
        : "相关问题已经问过且没有新信息,不再重复询问",
      blocking_count: blockingCount,
      stopped_by: anyCandidate ? "no_high_value_question" : "no_new_information",
    };
  }

  return {
    round,
    verdict: "ASK",
    questions: fresh.map((entry) => toQuestion(entry.requirement, entry.candidate)),
    rationale: `还有 ${blockingCount} 个会明显改变方案的决定需要你确认`,
    blocking_count: blockingCount,
    ...(pool.length > fresh.length ? {} : {}),
  };
}

/** 由 requirement(+ 模型候选问题)构造面向用户的问题。 */
function toQuestion(
  requirement: MissingResolutionItem,
  candidate: DiscoveryQuestion | undefined,
): DiscoveryQuestion {
  const options = (candidate?.options ?? []).slice(0, 4).map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.value ? { value: option.value } : {}),
    ...(option.invalidates ? { invalidates: [...option.invalidates] } : {}),
  }));
  const recommended = candidate?.recommended_option_id;
  const recommendationInOptions = recommended && options.some((option) => option.id === recommended);
  return {
    key: `${requirement.id}::${normalizeQuestionText(candidate?.question ?? requirement.text).slice(0, 24)}`,
    requirement_id: requirement.id,
    // 模型给的问法是第一选择(它按「面向用户目标」的纪律生成);缺省退回 requirement 文本。
    question: candidate?.question?.trim() || requirement.text,
    options,
    ...(recommendationInOptions ? { recommended_option_id: recommended } : {}),
    ...(candidate?.recommendation_reason ? { recommendation_reason: candidate.recommendation_reason } : {}),
    why: candidate?.why?.trim() || requirement.rationale || "只有你能决定,且会明显改变方案",
    depends_on: [...(candidate?.depends_on ?? [])],
    allow_blind_trust: candidate?.allow_blind_trust !== false,
  };
}

/** 把「本轮提问」登记进 asked(客户端保存并回传)。 */
export function recordAsked(round: DiscoveryRound, asked: readonly AskedQuestion[]): AskedQuestion[] {
  const out = [...asked];
  for (const question of round.questions) {
    const fingerprint = questionFingerprint(question.requirement_id, question.question);
    if (out.some((record) => record.key === question.key || record.fingerprint === fingerprint)) continue;
    out.push({ key: question.key, question: question.question, round: round.round, fingerprint });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Answer Resolver
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolveInput {
  raw_input: string;
  ledger: readonly RequirementLedgerEntry[];
  questions: readonly DiscoveryQuestion[];
  answers: readonly DiscoveryAnswer[];
}

export interface ResolvedAnswer {
  key: string;
  /** 解析出的动作。 */
  action: "confirm" | "reject" | "supersede" | "invalidate" | "not_applicable" | "derived";
  requirementId: string;
  value: string;
  /** 写回台账的来源:选项 / 自由回答 / 盲授权。 */
  source: "USER_EXPLICIT" | "OPTIMIZER_SUGGESTED";
  status: RequirementStatus;
}

const REJECT_RE = /^(?:不需要|不要|不用|不需要了|否|no|none|都不要|放弃|取消)/i;
const NEGATIVE_RE = /不(?:需要|要|用)|无需|不做|暂不|放弃|取消|排除|不考虑/;

/**
 * 把用户回答解析成台账更新(机械,可审计)。
 *
 * 规则(铁律):
 *  1. **盲授权**("按你的判断继续")→ `PROVISIONAL`(或带条件时 `CONDITIONAL`),
 *     来源恒为 `OPTIMIZER_SUGGESTED`;**绝不**产生 `USER_EXPLICIT` / `CONFIRMED`;
 *  2. 用户选了具体选项 → `USER_EXPLICIT` + `CONFIRMED`,证据 = 用户提交的原话
 *     (逐字;选项文案由用户点击确认,原话即该选项 label 或用户自己输入的文字);
 *  3. 选项声明的 `invalidates` → 那些 requirement 变 `NOT_APPLICABLE`;
 *  4. 回答是否定式 → `REJECTED`;
 *  5. 原 requirement 被新值取代 → 原条目 `supersede`(旧条目 REJECTED/失效),
 *     新值作为 `derived` 条目加入。
 */
export function resolveAnswers(input: ResolveInput): {
  ledger: RequirementLedgerEntry[];
  updates: ResolvedAnswer[];
} {
  const byKey = new Map(input.questions.map((question) => [question.key, question]));
  const byRequirement = new Map<string, DiscoveryQuestion>();
  for (const question of input.questions) {
    if (!byRequirement.has(question.requirement_id)) byRequirement.set(question.requirement_id, question);
  }
  const registry = new Map(input.ledger.map((entry) => [entry.id, entry]));
  const notes: string[] = [];
  const updates: ResolvedAnswer[] = [];
  const invalidated = new Set<string>();

  for (const answer of input.answers) {
    const question = byKey.get(answer.key) ?? byRequirement.get(answer.key);
    // 回答 key 形如 `<requirementId>::<规范化问法>`;问题对象缺失时仍能从 key 还原。
    const requirementId = question?.requirement_id ?? String(answer.key).split("::")[0];
    const ledgerId = requirementId.startsWith("ledger-") ? requirementId : `ledger-${requirementId}`;
    const option = question?.options.find((item) => item.id === answer.option_id);
    const value = option?.value ?? option?.label ?? answer.text.trim();

    if (answer.blind_trust) {
      // ① 盲授权:只降不升。
      const conditional = /如果|若|当|取决于|视情况/.test(`${answer.text} ${value}`);
      const status: RequirementStatus = conditional ? "CONDITIONAL" : "PROVISIONAL";
      const existing = registry.get(ledgerId);
      if (existing) {
        registry.set(ledgerId, {
          ...existing,
          source: "OPTIMIZER_SUGGESTED",
          status,
          evidence: [],
          confidence: "low",
          note: [existing.note, conditional ? "据你的条件式授权暂定(条件成立时生效)" : "据你的「按你的判断继续」暂定"]
            .filter(Boolean)
            .join(";"),
        });
        updates.push({ key: answer.key, action: "confirm", requirementId: ledgerId, value, source: "OPTIMIZER_SUGGESTED", status });
      } else {
        // 台账里没有对应条目 → 作为优化器暂定条目加入
        registry.set(ledgerId, {
          id: ledgerId,
          text: question?.question ?? value,
          source: "OPTIMIZER_SUGGESTED",
          status,
          evidence: [],
          confidence: "low",
          note: conditional ? "据你的条件式授权暂定" : "据你的「按你的判断继续」暂定",
        });
        updates.push({ key: answer.key, action: "derived", requirementId: ledgerId, value, source: "OPTIMIZER_SUGGESTED", status });
      }
      continue;
    }

    const rejected = option ? false : REJECT_RE.test(value) || NEGATIVE_RE.test(value);
    const existing = registry.get(ledgerId);

    if (rejected) {
      // ④ 否定式回答 → REJECTED(证据仍来自用户原话)
      registry.set(ledgerId, {
        id: ledgerId,
        text: existing?.text ?? question?.question ?? value,
        source: "USER_EXPLICIT",
        status: "REJECTED",
        evidence: uniqueEvidence(answer.text),
        confidence: "high",
        ...(existing?.note ? { note: existing.note } : {}),
      });
      updates.push({ key: answer.key, action: "reject", requirementId: ledgerId, value, source: "USER_EXPLICIT", status: "REJECTED" });
    } else {
      // ② 正常确认(证据 = 用户提交的原话,逐字)
      registry.set(ledgerId, {
        id: ledgerId,
        text: existing?.text ?? question?.question ?? value,
        source: "USER_EXPLICIT",
        status: "CONFIRMED",
        evidence: uniqueEvidence(answer.text),
        confidence: "high",
        note: [existing?.note, option ? `你选择了:${option.label}` : "你的回答"].filter(Boolean).join(";"),
      });
      updates.push({ key: answer.key, action: "supersede", requirementId: ledgerId, value, source: "USER_EXPLICIT", status: "CONFIRMED" });
    }

    // ③ 选项声明的失效项 → NOT_APPLICABLE
    for (const id of option?.invalidates ?? []) {
      const targetId = id.startsWith("ledger-") ? id : `ledger-${id}`;
      const target = registry.get(targetId);
      invalidated.add(targetId);
      if (target) {
        registry.set(targetId, {
          ...target,
          status: "NOT_APPLICABLE",
          note: [target.note, `因「${option?.label ?? value}」不再适用`].filter(Boolean).join(";"),
        });
      } else {
        registry.set(targetId, {
          id: targetId,
          text: id,
          source: "UNKNOWN",
          status: "NOT_APPLICABLE",
          evidence: [],
          confidence: "low",
          note: `因「${option?.label ?? value}」不再适用`,
        });
      }
      updates.push({ key: answer.key, action: "not_applicable", requirementId: targetId, value: option?.label ?? value, source: "USER_EXPLICIT", status: "NOT_APPLICABLE" });
    }

    // 自由回答(无选项):额外产生一条 derived 值条目,便于下一轮分析看到具体内容
    if (!option && !rejected && value) {
      const derivedId = `ledger-derived-${normalizeQuestionText(value).slice(0, 16) || notes.length}`;
      if (!registry.has(derivedId) && value !== existing?.text) {
        registry.set(derivedId, {
          id: derivedId,
          text: `${question?.question ?? "用户回答"}:${value}`,
          source: "USER_EXPLICIT",
          status: "CONFIRMED",
          evidence: uniqueEvidence(answer.text),
          confidence: "high",
          note: "由自由回答解析出的具体取值",
        });
        updates.push({ key: answer.key, action: "derived", requirementId: derivedId, value, source: "USER_EXPLICIT", status: "CONFIRMED" });
      }
    }
  }

  return { ledger: [...registry.values()], updates };
}

function uniqueEvidence(text: string): string[] {
  const value = String(text ?? "").trim();
  return value ? [value] : [];
}

/** 「修改理解」:把指定 requirement 重新打开(OPINION → OPEN),其余台账保留。 */
export function reopenRequirements(
  ledger: readonly RequirementLedgerEntry[],
  requirementIds: readonly string[],
): RequirementLedgerEntry[] {
  const reopen = new Set(requirementIds.map((id) => (id.startsWith("ledger-") ? id : `ledger-${id}`)));
  return ledger.map((entry) =>
    reopen.has(entry.id)
      ? {
          ...entry,
          status: "OPEN",
          source: "UNKNOWN",
          evidence: [],
          note: [entry.note, "你要求重新决定这一项"].filter(Boolean).join(";"),
        }
      : entry,
  );
}

/** 「修改理解」:把某个已确认项改成新值(用户直接编辑)。 */
export function reviseRequirement(
  ledger: readonly RequirementLedgerEntry[],
  requirementId: string,
  newValue: string,
  evidence: string,
): RequirementLedgerEntry[] {
  const id = requirementId.startsWith("ledger-") ? requirementId : `ledger-${requirementId}`;
  return ledger.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          text: newValue,
          source: "USER_EXPLICIT",
          status: "CONFIRMED",
          evidence: uniqueEvidence(evidence || newValue),
          confidence: "high",
          note: [entry.note, "你修改了这一项"].filter(Boolean).join(";"),
        }
      : entry,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sufficiency Evaluator
// ─────────────────────────────────────────────────────────────────────────────

export interface SufficiencyInput {
  analysis: AnalysisResult;
  ledger: readonly RequirementLedgerEntry[];
  asked?: readonly AskedQuestion[];
  round: number;
}

export interface SufficiencyResult {
  ready: boolean;
  /** 仍然**真正**阻塞的项(结合当前状态重算,而不是数 blocking 字段)。 */
  liveBlocking: MissingResolutionItem[];
  /** 因状态变化而不再阻塞的项(审计用)。 */
  relaxed: MissingResolutionItem[];
  /** 安全保护触发原因。 */
  stoppedBy?: DiscoveryRound["stopped_by"];
  reason: string;
}

/** 台账状态 → 是否已「安全处理」(不再需要追问)。 */
const SETTLED_STATUSES: readonly RequirementStatus[] = [
  "CONFIRMED",
  "DISCOVERABLE",
  "PROVISIONAL",
  "CONDITIONAL",
  "DEFERRED",
  "REJECTED",
  "NOT_APPLICABLE",
];

/**
 * Sufficiency Evaluator:决策完备判定。
 *
 * 关键:不能只看 `blocking` 字段 —— 必须结合**当前**台账状态:
 *  - 已被用户确认 / 已拒绝 / 已不适用 → 不再阻塞;
 *  - 已被条件式或暂定安全处理(PROVISIONAL / CONDITIONAL / DEFERRED)→ 不再阻塞;
 *  - 已是可自查 / 可选 → 不阻塞(UNKNOWN 无需清零);
 *  - 其余仍为 OPEN 的用户专属高影响项 → 继续阻塞。
 */
export function evaluateSufficiency(input: SufficiencyInput): SufficiencyResult {
  const statusById = new Map(input.ledger.map((entry) => [entry.id, entry.status]));
  const live: MissingResolutionItem[] = [];
  const relaxed: MissingResolutionItem[] = [];

  for (const item of input.analysis.missing_resolution) {
    if (item.classification !== "USER_REQUIRED" || !item.blocking) continue;
    const ledgerId = item.id.startsWith("ledger-") ? item.id : `ledger-${item.id}`;
    const status = statusById.get(ledgerId);
    // 台账中查不到 → 按分析结论继续阻塞(不能因为缺条目就放行)
    if (status === undefined || status === "OPEN") {
      live.push(item);
      continue;
    }
    if (SETTLED_STATUSES.includes(status)) relaxed.push(item);
    else live.push(item);
  }

  const reachedMax = input.round >= DISCOVERY_MAX_ROUNDS;
  if (live.length === 0) {
    return {
      ready: true,
      liveBlocking: [],
      relaxed,
      reason: "所有阻塞性的用户决定都已解决(decision completeness)",
    };
  }
  if (reachedMax) {
    return {
      ready: true,
      liveBlocking: live,
      relaxed,
      stoppedBy: "max_rounds",
      reason: `已达最大轮次(${DISCOVERY_MAX_ROUNDS});未决项按暂定处理,不再追问`,
    };
  }
  return {
    ready: false,
    liveBlocking: live,
    relaxed,
    reason: `还有 ${live.length} 个阻塞性的用户决定`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Requirement Confirmation
// ─────────────────────────────────────────────────────────────────────────────

/** 构建确认摘要:目标 / 你已确认 / Agent 自行调查 / 暂定·条件(仅存在时)。 */
export function buildConfirmation(input: {
  analysis: AnalysisResult;
  ledger: readonly RequirementLedgerEntry[];
  raw_input: string;
}): RequirementConfirmation {
  const confirmed: { text: string; value?: string }[] = [];
  const provisional: { text: string; status: RequirementStatus; note?: string }[] = [];
  const agentResearches: string[] = [];

  for (const entry of input.ledger) {
    if (entry.source === "USER_EXPLICIT" || entry.source === "CONTEXT_EXPLICIT") {
      if (entry.status === "CONFIRMED" || entry.status === "REJECTED") {
        confirmed.push({ text: entry.text, ...(entry.evidence[0] ? { value: entry.evidence[0] } : {}) });
      }
      continue;
    }
    if (entry.status === "PROVISIONAL" || entry.status === "CONDITIONAL" || entry.status === "DEFERRED") {
      provisional.push({ text: entry.text, status: entry.status, ...(entry.note ? { note: entry.note } : {}) });
      continue;
    }
    if (entry.status === "DISCOVERABLE") agentResearches.push(entry.text);
  }

  // 分析阶段判定的可自查项也要出现(即使台账没有对应条目)
  for (const item of input.analysis.missing_resolution) {
    if (item.classification !== "AGENT_DISCOVERABLE") continue;
    if (agentResearches.includes(item.text)) continue;
    agentResearches.push(item.text);
  }

  const goal =
    confirmed.find((entry) => entry.text.length > 8)?.text ??
    input.analysis.rationale ??
    String(input.raw_input ?? "").trim().slice(0, 80);

  const fingerprint = confirmationFingerprint({ goal, confirmed, agentResearches, provisional });
  return { goal, confirmed, agent_researches: agentResearches, provisional, fingerprint };
}

/** 摘要指纹(确认时回传;防止「确认了另一个版本」)。 */
export function confirmationFingerprint(input: {
  goal: string;
  confirmed: readonly { text: string }[];
  agentResearches: readonly string[];
  provisional: readonly { text: string }[];
}): string {
  const payload = [
    input.goal,
    ...input.confirmed.map((entry) => entry.text),
    ...input.agentResearches,
    ...input.provisional.map((entry) => entry.text),
  ].join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ─────────────────────────────────────────────────────────────────────────────
// 一轮 Discovery 的总编排(纯函数,便于逐条断言)
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoveryTurnInput {
  raw_input: string;
  analysis: AnalysisResult;
  ledger: readonly RequirementLedgerEntry[];
  questions: readonly DiscoveryQuestion[];
  answers: readonly DiscoveryAnswer[];
  asked: readonly AskedQuestion[];
  round: number;
}

export interface DiscoveryTurnResult {
  ledger: RequirementLedgerEntry[];
  updates: ResolvedAnswer[];
  asked: AskedQuestion[];
  sufficiency: SufficiencyResult;
  /** 下一轮的问题计划(verdict=READY 时 questions 为空)。 */
  next: DiscoveryRound;
  /** 是否进入确认(决策完备且本轮确实跑过 Discovery)。 */
  confirmation: RequirementConfirmation | null;
}

/**
 * 一轮 Discovery:解析回答 → 更新台账 → 重算充足性 → 规划下一轮(或确认)。
 *
 * 说明:重新分析(难点解析 / 新分支)由调用方在**下一轮的分析调用**里完成;
 * 本函数只做机械的部分,保证可审计。
 */
export function runDiscoveryTurn(input: DiscoveryTurnInput): DiscoveryTurnResult {
  const resolved = resolveAnswers({
    raw_input: input.raw_input,
    ledger: input.ledger,
    questions: input.questions,
    answers: input.answers,
  });
  const sufficiency = evaluateSufficiency({
    analysis: input.analysis,
    ledger: resolved.ledger,
    asked: input.asked,
    round: input.round,
  });
  // 记录本轮问过的问题(下一轮不得换说法重复问)
  const asked = recordAsked(
    {
      round: input.round,
      verdict: "ASK",
      questions: [...input.questions],
      rationale: "",
      blocking_count: sufficiency.liveBlocking.length,
    },
    input.asked,
  );
  const gate = computeAnalysisGate(sufficiency.liveBlocking, input.analysis.triage.triage);
  const next = planQuestions({
    raw_input: input.raw_input,
    triage: input.analysis.triage.triage,
    ledger: resolved.ledger,
    blocking: sufficiency.liveBlocking,
    asked,
    answers: input.answers,
    candidates: input.analysis.questions ?? [],
    round: input.round + 1,
  });
  return {
    ledger: resolved.ledger,
    updates: resolved.updates,
    asked,
    sufficiency,
    next,
    confirmation: sufficiency.ready
      ? buildConfirmation({
          analysis: input.analysis,
          ledger: resolved.ledger,
          raw_input: input.raw_input,
        })
      : null,
  };
}

/** 台账 + 处置的审计快照(日志 / 测试用)。 */
export function describeLedger(ledger: readonly RequirementLedgerEntry[]): string[] {
  return ledger.map((entry) => `${entry.id}|${entry.source}|${entry.status}|${entry.text}`);
}

/** 处置计划(供 Planner 判断「问了会不会改变方案」;Phase 2 契约复用)。 */
export function dispositionSnapshot(input: {
  analysis: AnalysisResult;
  ledger: readonly RequirementLedgerEntry[];
}): ReturnType<typeof planResponsibilities> {
  return planResponsibilities({
    resolution: input.analysis.missing_resolution,
    labels: input.analysis.missing_constraints.map((label, index) => ({ id: `label-${index}`, label })),
  });
}

/** 便捷:选项构造(测试与机械兜底问法用)。 */
export function makeOption(id: string, label: string, extra: Partial<DiscoveryOption> = {}): DiscoveryOption {
  return { id, label, ...extra };
}
