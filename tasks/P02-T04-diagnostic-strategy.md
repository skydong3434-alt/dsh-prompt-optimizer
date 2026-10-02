# P02-T04 — Diagnostic Strategy

**Status**: PENDING
**Phase**: P02
## Executor
Claude Code + DSH 验收

## Goal
`src/core/strategies/diagnostic.ts`：先证据后修改的诊断策略。

## Why
"P8-08 为什么一直超时？" 类输入必须先 Evidence→Reproduce→Hypotheses→Verify/Disprove，禁止未经验证直接修改。

## Preconditions
P02-T01 完成

## Inputs
PLAN-v1 §7 diagnostic sections：Symptom/Expected Behavior/Actual Behavior/Evidence Collection/Reproduction/Hypotheses/Root Cause Analysis/Disprove-Verify/Fix Proposal/Regression Test

## Allowed Scope
`src/core/strategies/diagnostic.ts` + `test/strategies-diagnostic.test.mjs`

## Forbidden Scope
其他策略/UI；输出直接给"修复代码"而缺验证步骤

## Tools
node/tsc/node:test/git

## Exact Steps
1. 实现策略（sections 10 段；guards：Fix Proposal 必须含验证/复测步骤，缺则 error）
2. 单测

## Tests
- 10 段齐全；guard：修复建议无回归验证步骤 → error；含 Hypotheses 与 Disprove/Verify 强制段

## Acceptance Criteria
单测全绿；版本 v0.1.0

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p02(t04): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P02-T05
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
