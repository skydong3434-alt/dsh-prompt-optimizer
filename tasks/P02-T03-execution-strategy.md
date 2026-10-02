# P02-T03 — Execution Strategy

**Status**: PENDING
**Phase**: P02
## Executor
Claude Code + DSH 验收

## Goal
`src/core/strategies/execution.ts`：聚焦当前任务的 Execution 策略。

## Why
"按规划继续执行 P03-T02"类输入必须聚焦 current task，不得重新规划整个项目。

## Preconditions
P02-T01 完成

## Inputs
PLAN-v1 §7 execution sections：Current Task/Goal/Preconditions/Allowed Scope/Forbidden Scope/Inputs/Executor/Tools/Exact Actions/Tests/Acceptance/Failure Handling/Git·State Rules/Stop Conditions/Handoff

## Allowed Scope
`src/core/strategies/execution.ts` + `test/strategies-execution.test.mjs`

## Forbidden Scope
其他策略/UI；从"执行"膨胀成"重规划"

## Tools
node/tsc/node:test/git

## Exact Steps
1. 实现策略（sections 15 段；Forbidden Scope 与 Handoff 为强制段；guards：输出不得以"规划/分析"段落为主）
2. 单测

## Tests
- 15 段齐全；含 Allowed/Forbidden Scope 强制段；禁整项目规划语言；Handoff 段必备

## Acceptance Criteria
单测全绿；版本 v0.1.0

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p02(t03): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P02-T04
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
