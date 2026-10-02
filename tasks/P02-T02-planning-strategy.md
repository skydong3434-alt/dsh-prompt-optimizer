# P02-T02 — Planning Strategy

**Status**: PENDING
**Phase**: P02
## Executor
Claude Code + DSH 验收

## Goal
`src/core/strategies/planning.ts`：planning PromptStrategy（给下游 DSH/Claude Code 生成可执行规划）。

## Why
规划类任务是产品核心类型之一；必须不直接开始开发、产出可验收的各阶段。

## Preconditions
P02-T01 完成

## Inputs
PLAN-v1 §7 planning sections：Goal/Why/Preconditions/Inputs/Executor/Tools/Phases/Tasks/Dependencies/Exact Steps/Outputs/Tests/Acceptance Criteria/Failure Handling/Stop Conditions/Next Step Condition

## Allowed Scope
`src/core/strategies/planning.ts` + `test/strategies-planning.test.mjs`

## Forbidden Scope
其他策略/UI/ctx.llm；"规划"越权变成"执行"

## Tools
node/tsc/node:test/git

## Exact Steps
1. 实现策略（sections 16 段 + guards：不得出现"已开始实施/已修改文件"类执行证据；每阶段必须有 Acceptance）
2. 单测锚点

## Tests
- 16 段齐全；禁执行性语言；含验收标准段；失败处理/停止条件段必备

## Acceptance Criteria
单测全绿；版本 v0.1.0

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p02(t02): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P02-T03
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
