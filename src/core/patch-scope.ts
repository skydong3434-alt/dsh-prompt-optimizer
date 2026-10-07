/**
 * PATCH 行为不变量（v0.2.0-apo release blocker 修复）。
 *
 * 真实证据:mechanical=model=final=PATCH,但产物把 39 字的三条清单
 * 重写成 1109 字 / 11 个标题,且原始「先跑一遍测试」语义丢失。
 * → PATCH 的实际编辑行为违反产品定义(PATCH = minimal local edit)。
 *
 * 本模块只做**确定性**判定(不新增模型调用、不用单一长度阈值):
 *   ① ORIGINAL CONTENT PRESERVATION:输入里的实质语义单元必须在产物中仍然存在
 *      (允许改措辞/轻微扩充/局部明确化,不允许删除原始用户要求)
 *   ② STRUCTURE PRESERVATION:不得把已有简单结构重建为另一套 Prompt 骨架
 *   ③ LOCAL ADDITION:输入本来没有分节骨架时,不得新增成体系的分节架构
 *
 * 长度只作为诊断信号,不作为判定依据。
 */
import { normalizeQuoteText } from "./provenance.js";
import { sameRequirement } from "./requirements.js";

export interface PatchScopeAssessment {
  /** 是否违反 PATCH 范围。 */
  violated: boolean;
  /** 丢失的原始语义单元(人读)。 */
  missingUnits: string[];
  /** 结构骨架是否被改变。 */
  skeletonChanged: boolean;
  /** 诊断用:输入/产物的分节数(不作为判定阈值)。 */
  diagnostics: { inputHeadings: number; outputHeadings: number; inputLength: number; outputLength: number };
}

/** 从输入里提取**实质语义单元**(去掉编号/项目符号/纯标签行)。 */
export function extractSemanticUnits(rawInput: string): string[] {
  return String(rawInput ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(?:[-*•]|\d+[.)、]|[（(]\d+[)）])\s*/, "").trim())
    .filter((line) => line.length >= 4)
    .filter((line) => !/^[^:：]{1,8}[:：]$/.test(line));
}

/** 分节标题(# / ## …)。 */
function headingsOf(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+\S/.test(line.trim()))
    .map((line) => line.trim().replace(/^#{1,6}\s+/, "").replace(/[:：]\s*$/, "").trim())
    .filter(Boolean);
}

/** 语义单元切成可比较的 token(拉丁词 + 中文 2-gram)。 */
function tokensOf(text: string): string[] {
  const latin = String(text).match(/[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? [];
  const cjkRuns = String(text).match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const bigrams: string[] = [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 2 <= run.length; i += 1) bigrams.push(run.slice(i, i + 2));
  }
  return [...latin.map((w) => w.toLowerCase()), ...bigrams];
}

/**
 * 该语义单元是否仍在产物中。
 * PATCH **允许改写措辞**,所以三级判定:
 *   ① 逐字包含(空白折叠/去标点) ② 行级语义等价 ③ token 覆盖率 ≥ 0.6
 */
function unitPresent(unit: string, optimizedPrompt: string): boolean {
  const needle = normalizeQuoteText(unit);
  if (needle && normalizeQuoteText(optimizedPrompt).includes(needle)) return true;
  const lineMatch = optimizedPrompt
    .split(/\r?\n/)
    .some((line) => sameRequirement(unit, line.replace(/^(?:[-*•]|\d+[.)、])\s*/, "").trim()));
  if (lineMatch) return true;
  const tokens = tokensOf(unit);
  if (tokens.length === 0) return true;
  const haystack = String(optimizedPrompt).toLowerCase();
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  return hits / tokens.length >= 0.6;
}

/**
 * 判定 PATCH 是否越界。仅在调用方确认 triage === 'PATCH' 时调用。
 */
export function assessPatchScope(input: {
  rawInput: string;
  optimizedPrompt: string;
}): PatchScopeAssessment {
  const raw = String(input.rawInput ?? "");
  const out = String(input.optimizedPrompt ?? "");

  // 只在**多单元输入**(清单/多条要求)上判定:此时「原始要求是否被删除」
  // 与「结构骨架是否被重建」都能机械断言。单句自由输入不适用(无语义单元可比),
  // 强行判定会把「合理改写」误判为越界。
  const units = extractSemanticUnits(raw);
  if (units.length < 2) {
    return {
      violated: false,
      missingUnits: [],
      skeletonChanged: false,
      diagnostics: { inputHeadings: headingsOf(raw).length, outputHeadings: headingsOf(out).length, inputLength: raw.length, outputLength: out.length },
    };
  }
  const missingUnits = units.filter((unit) => !unitPresent(unit, out));

  // ②③ 结构骨架:输入没有分节骨架 → 不得新增成体系的分节架构;
  //     输入已有分节 → 原分节应大体保留(不得整体换骨架)。
  const inputHeadings = headingsOf(raw);
  const outputHeadings = headingsOf(out);
  let skeletonChanged = false;
  if (inputHeadings.length === 0) {
    // 简单结构(清单/段落)不得被重建为 ≥3 节的任务模板骨架
    skeletonChanged = outputHeadings.length >= 3;
  } else {
    const kept = inputHeadings.filter((h) =>
      outputHeadings.some((oh) => sameRequirement(h, oh) || oh.includes(h) || h.includes(oh)),
    );
    skeletonChanged = kept.length * 3 < inputHeadings.length * 2; // 保留不足 2/3
  }

  return {
    violated: missingUnits.length > 0 || skeletonChanged,
    missingUnits,
    skeletonChanged,
    diagnostics: {
      inputHeadings: inputHeadings.length,
      outputHeadings: outputHeadings.length,
      inputLength: raw.length,
      outputLength: out.length,
    },
  };
}

/** 回流提示:明确告诉 Compiler「这是 PATCH,不是重写」。 */
export function describePatchScopeViolation(a: PatchScopeAssessment): string {
  const parts: string[] = ["编辑分诊为 PATCH(最小局部编辑),但产物越界:"];
  if (a.missingUnits.length > 0) {
    parts.push(`原始要求被删除/改写丢失:${a.missingUnits.map((u) => `「${u}」`).join("、")};必须原义保留`);
  }
  if (a.skeletonChanged) {
    parts.push(
      `结构骨架被重建(输入 ${a.diagnostics.inputHeadings} 个分节 → 产物 ${a.diagnostics.outputHeadings} 个);` +
        "不得引入新的任务模板架构,只允许在原有结构内局部修改",
    );
  }
  parts.push("只修指出的局部缺陷,不要重新编译成更完整的任务模板");
  return parts.join(" ");
}
