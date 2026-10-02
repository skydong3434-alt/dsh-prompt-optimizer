# P02-T05 — Review Strategy

**Status**: PENDING
**Phase**: P02
## Executor
Claude Code + DSH 验收

## Goal
`src/core/strategies/review.ts`：基于原目标与已完成结果的审查策略。

## Why
"看看这个项目现在还有什么问题" 类输入必须基于 Original Goal/Requirements 审查，不得发散成新项目。

## Preconditions
P02-T01 完成

## Inputs
PLAN-v1 §7 review sections：Review Target/Original Goal/Requirements/Evaluation Criteria/Evidence/Deviations/Missing Items/Risks/Suggested Corrections

## Allowed Scope
`src/core/strategies/review.ts` + `test/strategies-review.test.mjs`

## Forbidden Scope
其他策略/UI；发散成新项目规划

## Tools
node/tsc/node:test/git

## Exact Steps
1. 实现策略（sections 9 段；guards：输出含"新方案/新建功能/重构整个"类发散语言且无 Original Goal 对照 → warn；缺 Original Goal/Requirements 段 → error）
2. 单测

## Tests
- 9 段齐全；缺原目标/需求段 → error；发散语言触发守卫

## Acceptance Criteria
单测全绿；版本 v0.1.0

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p02(t05): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P02-T06
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
