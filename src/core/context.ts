/**
 * 上下文归一化(deterministic,纯函数,零 LLM / 零 Harness 依赖)。
 *
 * 与 PLAN-v1 §5「deterministic 与 LLM-derived 严格分离」对应:
 *   - raw_input     原样保留(不截断、不改写);
 *   - bounded_turns 沿用既有 8 轮 / 1600 字符预算(与 Y1X1n prompt.ts 同一口径);
 *   - workspace_metadata 只取可直接验证的字段(cwd / workspace_name)。
 *
 * 本模块**不产生**任何 LLM 派生字段(llm_derived 只允许 classifier / compiler
 * 填充,且每条必须携带 ProvenanceRecord 与逐字 evidence)。
 */
import type { ConversationTurn, NormalizedContext } from "./types.js";
import { capConversationContext } from "../prompt.js";

/** 归一化输入:宿主/客户端把可确定性读取的材料原样传入。 */
export interface NormalizeInput {
  /** 用户本轮原始输入(原样保留)。 */
  raw_input: string;
  /** 会话近期对话(时间升序);按共享预算收敛。 */
  turns?: readonly ConversationTurn[];
  /** 确定性 workspace metadata;仅接受字符串字段。 */
  workspace_metadata?: { cwd?: unknown; workspace_name?: unknown };
}

function cleanMetadataString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 生成 NormalizedContext。
 *
 * - `raw_input` 不截断(优化对象本身必须完整);
 * - `bounded_turns` 经 capConversationContext 收敛(条目数 / 单条 / 总量);
 * - `workspace_metadata` 只保留非空字符串,非法值静默丢弃(防御性)。
 */
export function normalizeInput(input: NormalizeInput): NormalizedContext {
  const raw = typeof input.raw_input === "string" ? input.raw_input : "";
  const turns = Array.isArray(input.turns) ? capConversationContext(input.turns.filter(isConversationTurn)) : [];
  const metadata = input.workspace_metadata ?? {};
  const cwd = cleanMetadataString(metadata.cwd);
  const workspaceName = cleanMetadataString(metadata.workspace_name);
  return {
    raw_input: raw,
    bounded_turns: turns,
    workspace_metadata: {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(workspaceName !== undefined ? { workspace_name: workspaceName } : {}),
    },
  };
}

/** 防御性过滤:只接受 role=user|assistant 且 text 为字符串的条目。 */
function isConversationTurn(turn: unknown): turn is ConversationTurn {
  if (!turn || typeof turn !== "object") return false;
  const record = turn as { role?: unknown; text?: unknown };
  return (record.role === "user" || record.role === "assistant") && typeof record.text === "string";
}
