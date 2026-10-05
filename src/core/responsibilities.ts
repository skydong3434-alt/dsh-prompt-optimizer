/**
 * 未决项的**编译处置判定**(disposition)—— Phase 2 正式语义契约。
 *
 * 契约全文:`docs/phase2-contract.md`(用户 2026-10-05 指定,选项 A:现在就切换)。
 * 核心一句:`AGENT_DISCOVERABLE` **永远不得再输出成面向用户的 `[待补充:]`**;
 * 未决项按「谁有能力解决」分派为:省略 / 执行方责任(动作式) / 分支条件(条件式)
 * / 待用户定夺(不注入正文,留台账)/ 可选增强(进建议段)。
 *
 * 反膨胀纪律(用户明确要求):**不得**把 `[待补充: X]` 机械改写成
 * 「由执行方自行确认 X」——那只是换了个说法的另一种膨胀。因此处置是**分类分派**:
 *  - 自然获得的信息直接消失(不做任何提示);
 *  - 只有真正影响执行的才变成动作式指令;
 *  - 只有真正决定分支的才变成条件式指令;
 *  - 注入条数有上限。
 *
 * 本模块只负责**判定**与**注入**;怎么写成人话由 `disposition-render.ts` 负责。
 * 纯函数,零 LLM / 零 Harness / 零 UI 依赖。
 */
import type {
  CompileVars,
  DispositionedRequirementItem,
  MissingConstraint,
  MissingResolutionItem,
  RequirementClass,
  RequirementDisposition,
} from "./types.js";
import { REQUIREMENT_DISPOSITIONS } from "./types.js";
import { mechanicalRequirementClass } from "./requirements.js";
import {
  DISPOSITION_SECTION_TITLE,
  RETIRED_PLACEHOLDER_RE,
  conditionalLine,
  executionLine,
  renderDispositionBrief,
  renderNotes,
} from "./disposition-render.js";
import type { RenderLanguage } from "./disposition-render.js";

export {
  DISPOSITION_SECTION_TITLE,
  RETIRED_PLACEHOLDER_RE,
  conditionalLine,
  executionLine,
  renderNotes,
  renderDispositionBrief,
};
export type { RenderLanguage, ResponsibilityNotes } from "./disposition-render.js";
export { REQUIREMENT_DISPOSITIONS };
export type { RequirementDisposition };

// ─────────────────────────────────────────────────────────────────────────────
// 契约常量
// ─────────────────────────────────────────────────────────────────────────────

export const RESPONSIBILITY_CONTRACT_VERSION = "1.0.0";

/** 注入条数上限(反膨胀硬上限;超出只保留前 N 条)。 */
export const RESPONSIBILITY_INJECTION_LIMIT = 4;

// ─────────────────────────────────────────────────────────────────────────────
// 判据表(表驱动,可单测)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 「调查结果决定后续分支」信号:先例 / 存在性 / 二选一 → CONDITIONAL_BRANCH。
 */
const BRANCH_RE =
  /已有|已存在|是否存在|有没有现成|现成|复用|沿用|取决于|根据.{0,8}决定|存在.{0,8}(?:则|就)|若.{0,12}(?:则|就)|如果.{0,12}(?:则|就)|是.{0,10}还是/;

/**
 * 「行动前必须调查且影响正确执行」信号:版本 / 接口 / 签名 / 配置 / 字段 / 表结构 /
 * 依赖 / 环境 / 默认值 / 规范 等**会改变你怎么写**的事实 → EXECUTION_RESPONSIBILITY。
 */
const INVESTIGATE_RE =
  /版本|接口|签名|配置(?:项|文件|格式)?|字段(?:类型|名)?|表结构|数据结构|依赖|环境变量|默认值|规范|协议|文档|实现细节|测试现状|错误码|日志|堆栈|现状|限制/;

/**
 * 「纯定位类 / 自然获得」信号:路径、目录、文件名、位置 → OMIT(规则 1)。
 */
const NATURAL_LOCATOR_RE = /路径|目录|文件夹|文件名|位置|在哪个文件|仓库结构/;

/**
 * 取舍型陈述:必须由用户决定,永远不能靠检查环境得到答案
 * (Phase 3 重点反例:「只验证一次链路还是建设长期自动化」)。
 */
const TRADEOFF_RE =
  /还是|要么|取舍|不做.{0,6}还是|一次.{0,8}还是|长期.{0,10}还是|方案\s*[AB].{0,6}(?:还是|或)|优先级|更重要/;

/**
 * 机械处置判定。
 *
 * 顺序:
 *  1. `USER_REQUIRED` → 只有用户能定(blocking 由分析门拦下;非阻塞 → USER_DECISION);
 *  2. `OPTIONAL`      → impact high ? OPTIONAL_ENHANCEMENT : OMIT;
 *  3. `AGENT_DISCOVERABLE` → 分支信号 ? CONDITIONAL : 调查信号且非纯定位 ? EXECUTION : OMIT。
 */
export function classifyDisposition(item: {
  text: string;
  classification: RequirementClass;
  blocking?: boolean;
  impact?: "high" | "medium" | "low";
}): RequirementDisposition {
  const text = String(item.text ?? "").trim();
  if (item.classification === "USER_REQUIRED") {
    // 取舍型即使 impact 判低,也仍是「用户决定」,不得降级成可调查项。
    return "USER_DECISION";
  }
  if (item.classification === "OPTIONAL") {
    return item.impact === "high" ? "OPTIONAL_ENHANCEMENT" : "OMIT";
  }
  if (BRANCH_RE.test(text)) return "CONDITIONAL_BRANCH";
  if (NATURAL_LOCATOR_RE.test(text) && !INVESTIGATE_RE.test(text)) return "OMIT";
  if (INVESTIGATE_RE.test(text)) return "EXECUTION_RESPONSIBILITY";
  // 规则 1:执行 Agent 正常工作中自然会拿到 → 直接省略。
  return "OMIT";
}

/** 该文本是否为取舍型(Phase 3 Discovery 的必答题判据)。 */
export function isTradeoffStatement(text: string): boolean {
  return TRADEOFF_RE.test(String(text ?? ""));
}

// ─────────────────────────────────────────────────────────────────────────────
// 处置计划
// ─────────────────────────────────────────────────────────────────────────────

/** 一条带处置的未决项(契约形状见 types.ts)。 */
export type DispositionedRequirement = DispositionedRequirementItem;

export interface ResponsibilityPlan {
  /** 全部分派结果(顺序不变,便于审计与回归)。 */
  items: DispositionedRequirement[];
  /** 直接省略(自然获得 / 弱可选)。 */
  omitted: DispositionedRequirement[];
  /** 动作式:行动前须知。 */
  execution: DispositionedRequirement[];
  /** 条件式:分支条件。 */
  conditional: DispositionedRequirement[];
  /** 非阻塞的用户决定(不注入正文)。 */
  userDecisions: DispositionedRequirement[];
  /** 可选增强(进建议段)。 */
  enhancements: DispositionedRequirement[];
  /** 是否触发了条数上限。 */
  truncated: boolean;
}

function toDispositioned(input: {
  id: string;
  text: string;
  classification: RequirementClass;
  blocking: boolean;
  impact: "high" | "medium" | "low";
}): DispositionedRequirement {
  return {
    ...input,
    disposition: classifyDisposition({
      text: input.text,
      classification: input.classification,
      blocking: input.blocking,
      impact: input.impact,
    }),
  };
}

/** 由分析结果构造处置计划(首选路径:有完整三分类时直接用)。 */
export function planFromResolution(
  resolution: readonly MissingResolutionItem[],
): ResponsibilityPlan {
  const items = resolution
    .filter((item) => String(item.text ?? "").trim().length > 0)
    .map((item) =>
      toDispositioned({
        id: item.id,
        text: item.text.trim(),
        classification: item.classification,
        blocking: item.blocking === true,
        impact: item.impact ?? "low",
      }),
    );
  return bucket(items);
}

/** 回退路径的影响面提示(只认明显高影响;兜底绝不制造阻塞)。 */
const HIGH_IMPACT_HINT_RE = /预算|成本|输出格式|交付格式|验收|范围|规模|架构|技术栈|部署|合规/;

/**
 * 由裸缺口标签构造处置计划(回退路径:只有 `MissingConstraint[]`,无三分类时)。
 * 用与 Phase 1 同一套机械三分类,行为与「先分析再编译」一致(只少了 LLM 判断)。
 */
export function planFromLabels(labels: readonly MissingConstraint[]): ResponsibilityPlan {
  const items: DispositionedRequirement[] = [];
  for (const item of labels) {
    const text = String(item.label ?? "").trim();
    if (!text) continue;
    const classification = mechanicalRequirementClass(text);
    const impact = HIGH_IMPACT_HINT_RE.test(text) ? "high" : "low";
    items.push(
      toDispositioned({
        id: item.id,
        text,
        classification,
        // 无三分类时保守**不阻塞**(兜底路径绝不制造阻塞)。
        blocking: false,
        impact,
      }),
    );
  }
  return bucket(items);
}

function bucket(items: DispositionedRequirement[]): ResponsibilityPlan {
  const omitted: DispositionedRequirement[] = [];
  const executionAll: DispositionedRequirement[] = [];
  const conditionalAll: DispositionedRequirement[] = [];
  const userDecisions: DispositionedRequirement[] = [];
  const enhancements: DispositionedRequirement[] = [];
  for (const item of items) {
    switch (item.disposition) {
      case "EXECUTION_RESPONSIBILITY":
        executionAll.push(item);
        break;
      case "CONDITIONAL_BRANCH":
        conditionalAll.push(item);
        break;
      case "USER_DECISION":
        userDecisions.push(item);
        break;
      case "OPTIONAL_ENHANCEMENT":
        enhancements.push(item);
        break;
      default:
        omitted.push(item);
    }
  }
  const execution = dedupeCap(executionAll);
  const conditional = dedupeCap(conditionalAll);
  return {
    items,
    omitted,
    execution,
    conditional,
    userDecisions,
    enhancements,
    truncated: execution.length < executionAll.length || conditional.length < conditionalAll.length,
  };
}

/** 去重(同文本只留一条)+ 条数上限(反膨胀硬约束 I-4)。 */
function dedupeCap(items: readonly DispositionedRequirement[]): DispositionedRequirement[] {
  const seen = new Set<string>();
  const out: DispositionedRequirement[] = [];
  for (const item of items) {
    const key = item.text.replace(/\s+/g, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= RESPONSIBILITY_INJECTION_LIMIT) break;
  }
  return out;
}

/** 入口:优先用 resolution(有三分类),否则用 labels(机械三分类)。 */
export function planResponsibilities(input: {
  resolution?: readonly MissingResolutionItem[];
  labels?: readonly MissingConstraint[];
}): ResponsibilityPlan {
  if (input.resolution && input.resolution.length > 0) return planFromResolution(input.resolution);
  return planFromLabels(input.labels ?? []);
}

/** 便捷:从 CompileVars 取未决项并分派(策略的 renderMissing / 编译器共用)。 */
export function dispositionedFromVars(vars: CompileVars): ResponsibilityPlan {
  return planResponsibilities({
    resolution: vars.missing_resolution,
    labels: vars.missing_constraints,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 编译稿后处理注入
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 编译稿后处理注入(取代旧的 `injectMissingPlaceholders`)。
 *
 * - 只注入 `EXECUTION_RESPONSIBILITY` 与 `CONDITIONAL_BRANCH` 两类;
 * - 正文已覆盖的条目不重复注入(按文本包含判定);
 * - **绝不**产出 `[待补充:]` / `[TODO:]`;
 * - 纯函数:不发明文本之外的任何信息。
 */
export function injectResponsibilityNotes(
  prompt: string,
  plan: ResponsibilityPlan,
  language: RenderLanguage = "zh",
): { prompt: string; injected: string[] } {
  const base = String(prompt ?? "");
  const injected: string[] = [];
  const blocks: string[] = [];

  /**
   * 覆盖判定按**条目文本**而不是渲染后的整句:模型可以用自己的句式表达同一条目
   * (例如把它写成完整条件句),只要条目本身已在正文出现,就不重复注入。
   */
  const pushBlock = (
    title: string,
    items: readonly DispositionedRequirement[],
    render: (item: DispositionedRequirement) => string,
  ): void => {
    const fresh = items
      .filter((item) => item.text.length > 0 && !base.includes(item.text))
      .map(render);
    if (!fresh.length) return;
    blocks.push(`${title}\n${fresh.join("\n")}`);
    injected.push(...fresh);
  };

  pushBlock(DISPOSITION_SECTION_TITLE.execution[language], plan.execution, (item) =>
    executionLine(item, language),
  );
  pushBlock(DISPOSITION_SECTION_TITLE.conditional[language], plan.conditional, (item) =>
    conditionalLine(item, language),
  );

  if (!blocks.length) return { prompt: base, injected };
  const separator = base.trim() ? "\n\n" : "";
  return { prompt: `${base.trimEnd()}${separator}${blocks.join("\n\n")}`, injected };
}
