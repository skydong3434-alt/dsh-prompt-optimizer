# P03-T01 — Classifier 提示词与解析器（纯函数）

**Status**: PENDING
**Phase**: P03（Intent Classifier）
## Executor
Claude Code + DSH 验收

## Goal
`src/core/classify.ts` 纯函数层：buildClassifierSystem/buildClassifierUser（七类型 + 防误判三规则）、parseClassifierOutput（JSON 契约容错解析、未知→general、conf<0.6 低置信标记）。

## Why
AUTO 分类是 Two-call 架构第一步；纯函数层保证可单测、可复现（temp 0）、可回退。

## Preconditions
P02 完成（G-2 通过）

## Inputs
PLAN-v1 §6（classifier 设计/防误判规则/输出契约 ClassifierResult）

## Allowed Scope
`src/core/classify.ts` + `test/classify.test.mjs`

## Forbidden Scope
LLM 调用（P03-T02）；UI；策略内容

## Tools
node/tsc/node:test/git

## Exact Steps
1. 提示词构建（输出 JSON 契约：prompt_type/confidence_internal/missing_constraints/rationale/evidence_quotes；防误判三规则：以当前输入为对象/区分当前请求与历史讨论/assistant 建议≠用户决定）
2. parseClassifierOutput 容错（脏 JSON/缺字段/重复输出取最后；未知 type→general；confidence 越界钳制）
3. 单测矩阵

## Tests
- 有效输出解析正确；脏输出回退 general；类型闭集校验；多意图输入 → 主类型 + 缺口注明；evidence_quotes 只接受逐字子串

## Acceptance Criteria
单测全绿；无 ctx.llm 依赖

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p03(t01): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P03-T02
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
