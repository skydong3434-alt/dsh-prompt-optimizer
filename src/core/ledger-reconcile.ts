/**
 * 再优化时的 Requirement Ledger 对账(reconcile)—— v2 Phase 4。
 *
 * 问题:用户答过一轮 Discovery 之后再改一版 Prompt 重新优化,旧 requirement 不能
 * 一股脑保留(会污染新任务),也不能一股脑丢掉(等于白问)。
 *
 * 三类裁决(概念与用户指定一致):
 *   STILL_VALID  原 Prompt 的修改没影响该需求 → 继续保留(例:只改了输出格式)
 *   CONFLICTING  新 Prompt 与旧 requirement 明确冲突 → 新正文 USER_EXPLICIT 优先,
 *                旧条目 supersede(标记 REJECTED 并留痕)
 *   INVALIDATED  新任务已经和旧 requirement 无关 → NOT_APPLICABLE
 *
 * 铁律(§14):
 *   · 旧任务 requirement 不得污染新任务;
 *   · 用户删掉的明确约束**不能**永远假装仍是当前 USER_EXPLICIT;
 *   · 对账只做机械判定,不新增任何用户来源。
 *
 * 纯函数,零 Harness / UI 依赖。
 */
import type { AnalysisResult, PromptTarget, RequirementLedgerEntry } from "./types.js";
import { containmentRatio } from "./discovery.js";

export type ReconcileVerdict = "STILL_VALID" | "CONFLICTING" | "INVALIDATED";

export interface ReconciledEntry {
  entry: RequirementLedgerEntry;
  verdict: ReconcileVerdict;
  /** 裁决理由(审计 / 测试用)。 */
  reason: string;
}

export interface ReconcileResult {
  ledger: RequirementLedgerEntry[];
  stillValid: string[];
  conflicting: string[];
  invalidated: string[];
  /** 一句话摘要(可给 UI / 日志)。 */
  summary: string;
}

/** 「还认得出来」的包含率阈值(措辞微调要保留,换任务要失效)。 */
export const RECONCILE_SIMILARITY = 0.5;

/**
 * 换向标记:用户明确在**替换**之前的决定(「现在改成…」)。
 * 命中且旧条目未被保留 → CONFLICTING(新正文优先,旧条目 supersede);
 * 没有换向标记却不再提及 → INVALIDATED(新任务与它无关)。
 */
const CHANGE_MARKER_RE = /改成|改为|现在改|不再是|改做|换成|转成|instead|switch to|change to/i;

/** 目标族:换族(如 agent_task → image_generation)时旧需求大量失效。 */
export function targetFamily(target: PromptTarget | string): string {
  switch (target) {
    case "image_generation":
    case "video_generation":
      return "visual";
    case "agent_task":
    case "coding":
      return "agent";
    case "research":
      return "research";
    case "writing":
      return "writing";
    case "data_analysis":
      return "data";
    default:
      return "general";
  }
}

/** 该台账条目是否值得对账(只有「当前有效」的条目才需要)。 */
function isLive(entry: RequirementLedgerEntry): boolean {
  return entry.status !== "NOT_APPLICABLE" && entry.status !== "DEFERRED";
}

/**
 * 对账入口。
 *
 * @param input.previous 上一轮的台账(来自客户端;调用方应先净化)
 * @param input.analysis 新一轮的分析结论
 * @param input.rawInput 用户本轮原始输入
 * @param input.previousTarget 上一轮的目标(用于换族判定)
 */
export function reconcileLedger(input: {
  previous: readonly RequirementLedgerEntry[];
  analysis: AnalysisResult;
  rawInput: string;
  previousTarget?: PromptTarget | string;
}): ReconcileResult {
  const rawInput = String(input.rawInput ?? "");
  const analysisTexts = [
    ...input.analysis.missing_resolution.map((item) => item.text),
    ...input.analysis.ledger.map((entry) => entry.text),
    ...input.analysis.missing_constraints.map((label) => String(label)),
  ];
  const familyChanged =
    input.previousTarget !== undefined &&
    targetFamily(input.previousTarget) !== targetFamily(input.analysis.target.target);

  const results: ReconciledEntry[] = [];
  for (const entry of input.previous) {
    if (!isLive(entry)) {
      results.push({ entry, verdict: "INVALIDATED", reason: "上一轮已判为不适用 / 已延后" });
      continue;
    }
    const core = entry.text;
    // ① 新输入里仍能认出它(措辞微调也算)→ 保留
    if (rawInput.length > 0 && containmentRatio(core, rawInput) >= RECONCILE_SIMILARITY) {
      results.push({ entry, verdict: "STILL_VALID", reason: "新输入仍包含该要求" });
      continue;
    }
    // ② 新一轮分析仍提到它 → 保留
    if (analysisTexts.some((text) => containmentRatio(core, text) >= RECONCILE_SIMILARITY)) {
      results.push({ entry, verdict: "STILL_VALID", reason: "新一轮分析仍引用该要求" });
      continue;
    }
    // ③ 同 id 但文本已变 → 冲突(新正文优先,旧条目 supersede)
    const sameId = input.analysis.missing_resolution.find(
      (item) => item.id === entry.id.replace(/^ledger-/, ""),
    );
    if (sameId && containmentRatio(core, sameId.text) < RECONCILE_SIMILARITY) {
      results.push({ entry, verdict: "CONFLICTING", reason: "新输入对该项给出了不同说法,新内容优先" });
      continue;
    }
    // ④ 用户明确在换向(「现在改成…」)→ 旧条目被新内容取代
    if (CHANGE_MARKER_RE.test(rawInput)) {
      results.push({ entry, verdict: "CONFLICTING", reason: "新输入明确替换了该项,新内容优先" });
      continue;
    }
    // ⑤ 任务族已变(Agent → 图像等)→ 旧需求不再相关
    if (familyChanged) {
      results.push({ entry, verdict: "INVALIDATED", reason: "任务目标已换族,该要求与新任务无关" });
      continue;
    }
    // ⑥ 同族但新输入不再提及 → 不再假装它仍是当前用户要求(§14-D)
    results.push({ entry, verdict: "INVALIDATED", reason: "新输入未再提及该要求,不再作为当前要求" });
  }

  const ledger = results.map(({ entry, verdict, reason }) => {
    switch (verdict) {
      case "STILL_VALID":
        return entry;
      case "CONFLICTING":
        return {
          ...entry,
          status: "REJECTED" as const,
          note: [entry.note, `再优化对账:${reason}`].filter(Boolean).join(";"),
        };
      default:
        return {
          ...entry,
          status: "NOT_APPLICABLE" as const,
          note: [entry.note, `再优化对账:${reason}`].filter(Boolean).join(";"),
        };
    }
  });

  const stillValid = results.filter((r) => r.verdict === "STILL_VALID").map((r) => r.entry.id);
  const conflicting = results.filter((r) => r.verdict === "CONFLICTING").map((r) => r.entry.id);
  const invalidated = results.filter((r) => r.verdict === "INVALIDATED").map((r) => r.entry.id);
  return {
    ledger,
    stillValid,
    conflicting,
    invalidated,
    summary:
      `再优化对账:保留 ${stillValid.length} 项、被新内容取代 ${conflicting.length} 项、` +
      `不再适用 ${invalidated.length} 项`,
  };
}

/** 对账后仍需用户决定的项(交给 Missing Resolution 重新判定)。 */
export function liveOpenRequirements(ledger: readonly RequirementLedgerEntry[]): RequirementLedgerEntry[] {
  return ledger.filter((entry) => entry.status === "OPEN");
}
