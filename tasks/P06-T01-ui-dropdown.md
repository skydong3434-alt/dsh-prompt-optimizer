# P06-T01 — UI：AUTO 下拉与手动覆盖

**Status**: PENDING
**Phase**: P06（UI Integration）
## Executor
Claude Code + DSH 验收

## Goal
OptimizeButton 加 `[AUTO ▾]`（AUTO/Research/Planning/Execution/Diagnostic/Review/Creative），选择写 controller state；点击优化时请求带 promptType。

## Why
手动类型覆盖 = 跳过 classifier，用户可强制指定。

## Preconditions
P05 完成（handler 已支持 promptType）

## Inputs
PLAN-v1 §10 UI 设计

## Allowed Scope
`src/client/OptimizeButton.tsx`、`src/client/controller.ts`（state+请求体）、i18n 文案

## Forbidden Scope
改变既有按钮行为（undo/Esc 等）；ResultDock（P06-T02）

## Tools
node/tsc/controller.test.mjs/git

## Exact Steps
1. 下拉组件（复用现有样式体系）
2. controller：overrideType state → 请求体 promptType；AUTO 默认
3. 单测：override 状态流转、请求体断言

## Tests
controller.test 扩展：默认 AUTO、选择后携带 promptType、重新优化沿用所选类型

## Acceptance Criteria
单测全绿；下拉交互手测清单通过（G-4 前的机器门禁）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p06(t01): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P06-T02
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
