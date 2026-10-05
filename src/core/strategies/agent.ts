/**
 * Agent PromptStrategy(Agent 任务编译契约)—— v2 Phase 2。
 *
 * 由 Target-aware Router 在 `PromptTarget === 'agent_task'` 且工作意图是
 * 执行 / 通用时选用:把用户「帮我做 X」的口语需求编译成**交给执行 Agent 的任务指令**,
 * 责任清单强调目标与完成定义、边界(允许/禁止)、工具与权限、输入上下文、验收方式、
 * 停止条件 —— 与文本类策略(研究/规划/评审等)正交,由目标而非意图决定。
 *
 * 结构化契约(允许 Goal 式表述),但不得把用户没说的边界 / 权限写成硬约束。
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

export const AGENT_CONTRACT_VERSION = "0.1.0";

/** Agent 契约的信息责任(id 是机械核对锚点)。 */
export const AGENT_RESPONSIBILITIES: readonly string[] = [
  "Objective & Definition of Done",
  "Scope & Boundaries",
  "Tools & Permissions",
  "Context & Inputs",
  "Verification",
  "Stop Conditions",
];

/** 边界纪律:任何「允许 / 禁止」都必须来自用户或明确标注为建议。 */
const AGENT_BOUNDARY_RULE =
  "边界只能来自用户明确表述或已确认上下文;优化器补充的边界必须标注为建议,不得写成硬性禁止";

const AGENT_NO_IRREVERSIBLE_WITHOUT_CONFIRM =
  "涉及不可逆动作(删除 / 覆盖 / 推送 / 发布 / 付费)时,必须写成「执行前确认」的条件式指令";

function buildAgentSystem(language: StrategyLanguage): string {
  const zh = language !== "en";
  const title = zh
    ? "# 信息责任(逐项交代清楚;标题可自拟,不得遗漏)"
    : "# Information responsibilities (cover each one; titles are yours to choose)";
  const list = zh
    ? [
        "- Objective & Definition of Done: 要达成什么,以及「做完」的可核查定义",
        "- Scope & Boundaries: 允许改什么、禁止改什么(仅来自用户表述)",
        "- Tools & Permissions: 可用工具 / 仓库 / 环境与权限边界",
        "- Context & Inputs: 相关文件、材料、约束、既有约定",
        "- Verification: 怎么证明做完了(测试 / 复现步骤 / 检查清单)",
        "- Stop Conditions: 遇到什么就停下来问,而不是自己决定",
      ]
    : [
        "- Objective & Definition of Done: what to achieve and a checkable definition of done",
        "- Scope & Boundaries: what may and may not be changed (from the user only)",
        "- Tools & Permissions: available tools / repos / environments and permission limits",
        "- Context & Inputs: relevant files, materials, constraints, existing conventions",
        "- Verification: how completion is proven (tests / reproduction steps / checklist)",
        "- Stop Conditions: when to stop and ask instead of deciding alone",
      ];
  const discipline = zh
    ? `# 写法纪律
- 写成**给执行 Agent 的指令**:目标、边界、验收可机械核对
- ${AGENT_BOUNDARY_RULE}
- ${AGENT_NO_IRREVERSIBLE_WITHOUT_CONFIRM}
- 不得把用户没说的技术栈 / 目录 / 工具写成硬约束;按未决项处置纪律处理`
    : `# Writing discipline
- Write an **instruction for the executing agent**: objective, boundaries and verification must be mechanically checkable
- Boundaries come from the user or from confirmed context only; anything the optimizer adds must be labelled a suggestion
- For irreversible actions (delete / overwrite / push / publish / pay), write a "confirm before acting" conditional instruction
- Never turn an unstated stack / directory / tool into a hard constraint; follow the open-item disposition discipline`;
  const provenance = zh
    ? `# 来源标注
- 明确要求必须逐字来自用户输入,附 ${quoteMarker("用户原话")}
- 上下文已确认仅限历史中「用户」消息;助手发言不算
- ${SUGGESTION_LABEL_ZH}:你主动补的工具 / 步骤建议,独立成段
- 未知项:按未决项处置纪律处理;**禁止** [待补充:] / [TODO:] 占位符`
    : `# Provenance
- Explicit requirements verbatim from the input, with ${quoteMarker("user words")}
- Context-confirmed: user messages only; assistant messages never count
- ${SUGGESTION_LABEL_EN}: your own tool/step ideas, in their own section
- Open items: follow the disposition discipline; **never** [TODO:] / [待补充:] placeholders`;
  return [zh ? buildRole("zh") : buildRole("en"), title, ...list, discipline, provenance, ...sharedRules(language)].join(
    "\n\n",
  );
}

function buildRole(language: StrategyLanguage): string {
  return language !== "en"
    ? "你是「Agent 任务指令编译器」。你的产出是交给执行 Agent 的任务指令:目标清楚、边界明确、验收可查、遇阻会停。"
    : 'You are the "agent task instruction compiler". Your output is an instruction for an executing agent: clear objective, explicit boundaries, checkable verification, and it stops when blocked.';
}

function buildAgentUser(vars: CompileVars): string {
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
    parts.push(
      `${zh ? "确定性 workspace 事实(可作为 WORKSPACE_FACT;不要扩写):" : "Deterministic workspace facts (usable as WORKSPACE_FACT; do not extrapolate):"}\n${bits.join(
        "\n",
      )}`,
    );
  }
  parts.push(
    renderDispositionBrief(
      {
        missing_constraints: vars.missing_constraints,
        dispositions: vars.missing_dispositions,
        missing_resolution: vars.missing_resolution,
      },
      language,
      zh ? "请在编写 Agent 指令时自行识别仍缺的边界 / 验收项。" : "identify missing boundary/verification items.",
      "identify missing boundary/verification items.",
    ),
  );
  parts.push(
    zh
      ? `以下是用户本轮输入(你唯一需要重写的对象):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`
      : `Here is the user's current input (the only thing to rewrite):\n\n<prompt-draft>\n${vars.raw_input}\n</prompt-draft>`,
  );
  return parts.join("\n\n");
}

/** Agent 守卫:必须给出可核查的完成定义(否则只是「帮我做点事」)。 */
const guardAgentDefinitionOfDone: Guard = {
  id: "agent-requires-definition-of-done",
  description: "Agent 指令必须给出可核查的完成定义与验收方式",
  check(output) {
    const text = String(output ?? "");
    if (/Definition of Done|完成定义|验收|Verification|检查清单|复现步骤/.test(text)) return null;
    return "Agent 指令缺少可核查的完成定义 / 验收方式";
  },
};

const preservationRules: PreservationRule[] = [
  {
    id: "agent-preserve-objective",
    description: "用户要达成的目标不得被替换或缩小,也不得被扩写成用户没提的任务",
  },
  {
    id: "agent-preserve-named-targets",
    description: "用户点名的文件 / 模块 / 平台 / 工具必须原样保留,不得换名",
  },
  { id: "agent-no-invented-boundaries", description: AGENT_BOUNDARY_RULE },
];

const suggestionRules: SuggestionRule[] = [
  {
    id: "agent-suggest-verification",
    description: `可建议验收 / 自查方式,但必须标注「${SUGGESTION_LABEL_ZH}」,不得写成用户要求`,
  },
  {
    id: "agent-suggest-tooling",
    description: `可建议可用工具或步骤,但不得把建议写成已确定的边界或权限`,
  },
];

const provenanceRules: ProvenanceRule[] = [
  { id: "agent-quote-explicit", description: "明确要求必须逐字来自用户本轮输入,每条附 quote" },
  { id: "agent-context-user-only", description: "上下文已确认仅限历史中「用户」消息;助手发言不算证据" },
  {
    id: "agent-no-confirmed-without-evidence",
    description: "「已确认 / 已确定 / 最终」类结论必须有逐字 quote;否则降级为建议或未决项",
  },
  {
    id: "agent-unknown-not-placeholder",
    description: "未决项按处置纪律处理,永远不得写成 [待补充:] / [TODO:]",
  },
];

const responsibilities = [...AGENT_RESPONSIBILITIES];

const outputContract: OutputContract = {
  responsibilities,
  /** @deprecated 与 responsibilities 内容一致;保留给旧消费方。 */
  sections: [...responsibilities],
  formatNote: `agent: 逐项交代信息责任(${responsibilities.join(" / ")});边界只来自用户,不可逆动作写成确认式条件`,
};

export const agentStrategy: PromptStrategy = {
  type: "agent",
  name: "Agent（任务指令）",
  version: AGENT_CONTRACT_VERSION,
  purpose:
    "把「帮我做 X」编译成交给执行 Agent 的任务指令:目标与完成定义、边界、工具权限、输入上下文、验收方式、停止条件逐项清楚;不发明用户未给的边界,不可逆动作必须写成确认式条件。",
  informationResponsibilities: responsibilities,
  /** @deprecated 保留给旧消费方;内容与 informationResponsibilities 一致。 */
  required_sections: [...responsibilities],
  optional_sections: ["Background", "Deliverable Format", "Reporting", "Risks"],
  preservationRules,
  suggestionRules,
  guards: [
    guardAgentDefinitionOfDone,
    unknownNotBlocking(),
    suggestedNotInExplicit(),
    suggestedNotUpgraded(),
  ],
  provenanceRules,
  buildSystem(language: "zh" | "en"): string {
    return buildAgentSystem(language);
  },
  buildUser(vars: CompileVars): string {
    return buildAgentUser(vars);
  },
  outputContract,
};

export default agentStrategy;
