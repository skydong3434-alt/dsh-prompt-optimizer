/**
 * 视觉模态(图像 / 视频)编译契约的共享工厂 —— v2 Phase 2。
 *
 * 硬约束(v2 §C5):图像 / 视频提示词**不得**被编译成 Goal / Phase / Task / Tests。
 * 因此这一族策略的责任清单完全是「描述式」的:主体 / 场景 / 风格 / 构图 / 光线 /
 * 画幅 / 排除项(视频另有镜头 / 动作时序 / 时长格式),并在守卫里**机械拒绝**
 * 结构化任务模板标题出现。
 *
 * 纯数据 + 纯函数,零 ctx / UI / Host 依赖。
 */
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
  isChineseDominant,
  quoteMarker,
  sharedRules,
  suggestedNotInExplicit,
  suggestedNotUpgraded,
  unknownNotBlocking,
} from "./_shared.js";
import type { StrategyLanguage } from "./_shared.js";
import { renderDispositionBrief } from "../disposition-render.js";

/** 视觉契约的单一版本号(图像与视频同步升级;改文案不改插件版本)。 */
export const VISUAL_CONTRACT_VERSION = "0.1.0";

/** 结构化任务模板标题:图像 / 视频契约里**禁止出现**(机械守卫)。 */
export const FORBIDDEN_TEMPLATE_HEADINGS: readonly string[] = [
  "Goal",
  "Phases",
  "Phase",
  "Task List",
  "Tasks",
  "Acceptance Criteria",
  "Success Criteria",
  "Verification Steps",
  "Handoff",
];

export interface VisualSpec {
  type: "image" | "video";
  name: string;
  version: string;
  purpose: string;
  responsibilities: readonly string[];
  optionalSections: readonly string[];
  roleZh: string;
  roleEn: string;
  /** 该模态特有的写法纪律(中/英)。 */
  disciplineZh: readonly string[];
  disciplineEn: readonly string[];
  responsibilityGuidanceZh: readonly string[];
  responsibilityGuidanceEn: readonly string[];
}

/**
 * 视觉策略守卫:优化稿必须只包含描述式内容,不得退化成任务模板。
 * 命中模板标题 → error(直接让 provenance_ok=false,用户可见)。
 */
export function visualNoTaskTemplate(options: {
  mandatory: readonly string[];
}): Guard {
  return {
    id: "visual-no-task-template",
    description: `图像 / 视频契约不得套用任务模板标题(${FORBIDDEN_TEMPLATE_HEADINGS.join(
      " / ",
    )});只允许描述式信息责任`,
    check(output) {
      const text = String(output ?? "");
      const hits = FORBIDDEN_TEMPLATE_HEADINGS.filter((heading) =>
        new RegExp(`(?:^|\\n)\\s*#{0,6}\\s*\\**${heading}\\b`, "i").test(text),
      );
      if (!hits.length) return null;
      return `图像 / 视频优化稿出现了任务模板标题:${hits.join(" / ")}——视觉契约只允许描述式信息责任`;
    },
  };
}

/** 视觉策略守卫:描述式责任必须基本齐全(至少 4 项命中)。 */
export function visualResponsibilityPresence(responsibilities: readonly string[]): Guard {
  const list = responsibilities.map((item) => String(item).trim()).filter(Boolean);
  return {
    id: "visual-responsibility-presence",
    description: `视觉优化稿至少要交代:${list.join(" / ")}`,
    check(output) {
      const text = String(output ?? "");
      const missing = list.filter((item) => !text.includes(item));
      if (missing.length <= list.length - 4) return null;
      return `视觉优化稿描述过于单薄,缺少 ${missing.length} 项信息责任:${missing.join(" / ")}`;
    },
  };
}

function buildSystem(spec: VisualSpec, language: StrategyLanguage): string {
  const zh = language !== "en";
  const responsibilityTitle = zh
    ? "# 信息责任(逐项交代清楚;标题可自拟,不得遗漏)"
    : "# Information responsibilities (cover each one; titles are yours to choose)";
  const responsibilities = spec.responsibilities.map((id, index) =>
    zh
      ? `- ${id}: ${spec.responsibilityGuidanceZh[index] ?? ""}`
      : `- ${id}: ${spec.responsibilityGuidanceEn[index] ?? ""}`,
  );
  const forbidden = zh
    ? `# 禁止事项(硬约束)
- **禁止**输出任务模板结构:${FORBIDDEN_TEMPLATE_HEADINGS.join(" / ")} 等标题一律不得出现
- 这是${spec.type === "image" ? "图像" : "视频"}生成提示词,不是给工程师的任务书:不要写阶段、任务清单、验收标准、交付流程
- 不得把风格 / 画幅 / 时长等未给出的项**替用户拍板**成硬约束;按未决项处置纪律处理`
    : `# Prohibited (hard constraints)
- **Never** emit task-template structure: ${FORBIDDEN_TEMPLATE_HEADINGS.join(" / ")} must not appear
- This is a ${spec.type} generation prompt, not an engineering brief: no phases, task lists, acceptance criteria or delivery steps
- Never decide unstated style / aspect ratio / duration as hard constraints for the user; follow the open-item disposition discipline`;
  const provenance = zh
    ? `# 来源标注
- 用户本轮明确要求必须逐字来自输入,附 ${quoteMarker("用户原话")}
- 上下文已确认仅限历史中「用户」消息;助手发言不算
- ${SUGGESTION_LABEL_ZH}:你主动补的风格 / 参数建议,独立成段
- 未知项:按未决项处置纪律处理;**禁止** [待补充:] / [TODO:] 占位符`
    : `# Provenance
- Explicit requirements must be verbatim from the input, with ${quoteMarker("user words")}
- Context-confirmed: user messages only; assistant messages never count
- ${SUGGESTION_LABEL_EN}: your own style/parameter ideas, in their own section
- Open items: follow the disposition discipline; **never** [TODO:] / [待补充:] placeholders`;
  return [
    zh ? spec.roleZh : spec.roleEn,
    responsibilityTitle,
    ...responsibilities,
    ...(zh ? spec.disciplineZh : spec.disciplineEn),
    forbidden,
    provenance,
    ...sharedRules(language),
  ].join("\n\n");
}

function buildUser(spec: VisualSpec, vars: CompileVars): string {
  const language: StrategyLanguage = isChineseDominant(vars.raw_input) ? "zh" : "en";
  const zh = language !== "en";
  const parts: string[] = [];
  if (vars.context_turns?.length) {
    const lines = vars.context_turns.map((turn) => {
      const role = turn.role === "user" ? (zh ? "用户" : "User") : zh ? "助手" : "Assistant";
      return `${role}: ${turn.text}`;
    });
    parts.push(
      zh
        ? `以下是当前会话的近期对话(仅供参考;只有「用户」的发言能作为用户意图证据):\n\n<conversation-context>\n${lines.join("\n")}\n</conversation-context>`
        : `Recent conversation (reference only; only "user" messages count as user intent):\n\n<conversation-context>\n${lines.join("\n")}\n</conversation-context>`,
    );
  }
  const metadata = vars.workspace_metadata ?? {};
  if (metadata.cwd || metadata.workspace_name) {
    const bits: string[] = [];
    if (metadata.workspace_name) bits.push(`workspace: ${metadata.workspace_name}`);
    if (metadata.cwd) bits.push(`cwd: ${metadata.cwd}`);
    parts.push(`${zh ? "确定性 workspace 事实(不要扩写):" : "Deterministic workspace facts (do not extrapolate):"}\n${bits.join("\n")}`);
  }
  parts.push(
    renderDispositionBrief(
      {
        missing_constraints: vars.missing_constraints,
        dispositions: vars.missing_dispositions,
        missing_resolution: vars.missing_resolution,
      },
      language,
      zh
        ? "请在编写视觉提示词时自行识别仍缺的描述项。"
        : "identify any still-missing descriptive slot while writing the visual prompt.",
      "identify any still-missing descriptive slot while writing the visual prompt.",
    ),
  );
  parts.push(
    zh
      ? `以下是用户本轮输入(你唯一需要重写的对象):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`
      : `Here is the user's current input (the only thing to rewrite):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`,
  );
  return parts.join("\n\n");
}

/** 由规格创建视觉策略(图像 / 视频共用;注册表按 target 取用)。 */
export function createVisualStrategy(spec: VisualSpec): PromptStrategy {
  const preservationRules: PreservationRule[] = [
    {
      id: `${spec.type}-preserve-subject`,
      description: "主体 / 角色 / 场景标识必须原样保留,不得换名、合并或替换",
    },
    {
      id: `${spec.type}-preserve-user-constraints`,
      description: "用户已给出的风格 / 画幅 / 时长 / 排除项不得删除或反向",
    },
    {
      id: `${spec.type}-no-invented-hard-constraints`,
      description: "用户未给出的风格 / 画幅 / 时长等不得被写成硬约束(按未决项处置纪律处理)",
    },
  ];
  const suggestionRules: SuggestionRule[] = [
    {
      id: `${spec.type}-suggest-details`,
      description: `可建议补充构图 / 光线 / 镜头细节,但必须标注「${SUGGESTION_LABEL_ZH}」,不得写成用户要求`,
    },
    {
      id: `${spec.type}-suggest-negative`,
      description: "可建议排除项,但不得把建议写成已确定的负面约束",
    },
  ];
  const provenanceRules: ProvenanceRule[] = [
    { id: `${spec.type}-quote-explicit`, description: "明确要求必须逐字来自用户本轮输入,每条附 quote" },
    { id: `${spec.type}-context-user-only`, description: "上下文已确认仅限历史中「用户」消息;助手发言不算证据" },
    {
      id: `${spec.type}-no-confirmed-without-evidence`,
      description: "「已确认 / 已确定 / 最终」类结论必须有逐字 quote;否则降级为建议或未决项",
    },
    {
      id: `${spec.type}-unknown-not-placeholder`,
      description: "未决项按处置纪律处理,永远不得写成 [待补充:] / [TODO:]",
    },
  ];
  const responsibilities = [...spec.responsibilities];
  const outputContract: OutputContract = {
    responsibilities,
    /** @deprecated 与 responsibilities 内容一致;保留给旧消费方。 */
    sections: [...responsibilities],
    formatNote: `${spec.type}: 描述式契约 —— 逐项交代信息责任(${responsibilities.join(
      " / ",
    )});严禁任务模板标题(${FORBIDDEN_TEMPLATE_HEADINGS.join(" / ")})`,
  };
  return {
    type: spec.type,
    name: spec.name,
    version: spec.version,
    purpose: spec.purpose,
    informationResponsibilities: responsibilities,
    /** @deprecated 保留给旧消费方;内容与 informationResponsibilities 一致。 */
    required_sections: [...responsibilities],
    optional_sections: [...spec.optionalSections],
    preservationRules,
    suggestionRules,
    guards: [
      visualNoTaskTemplate({ mandatory: responsibilities }),
      visualResponsibilityPresence(responsibilities),
      unknownNotBlocking(),
      suggestedNotInExplicit(),
      suggestedNotUpgraded(),
    ],
    provenanceRules,
    buildSystem(language: "zh" | "en"): string {
      return buildSystem(spec, language);
    },
    buildUser(vars: CompileVars): string {
      return buildUser(spec, vars);
    },
    outputContract,
  };
}
