# P02-T07 — General Fallback + Research 整合

**Status**: PENDING
**Phase**: P02
## Executor
Claude Code + DSH 验收

## Goal
`src/core/strategies/general.ts`（八板块结构 fallback，吸收 Y1X1n template/intent 双模式 + Co1ombiagly spec 思想，独立撰写中文文案）；并把 P01.5-T01 的 research 初版整合为正式版（补 guards/provenanceRules 完整化）。

## Why
AUTO 低置信/失败时必须有 general 兜底；research 完成 Vertical Slice 验证后按正式契约补全。

## Preconditions
P02-T01 完成；P01.5-T01 存在

## Inputs
PLAN-v1 §7 general；八板块（角色/任务目标/输入材料/输出格式/内容要求/风格/约束/成功标准）思想

## Allowed Scope
`src/core/strategies/general.ts`、`src/core/strategies/research.ts`（整合修订）、对应测试

## Forbidden Scope
其余策略/UI；AGPL 模板文本复制（八板块结构只借鉴思想）

## Tools
node/tsc/node:test/git

## Exact Steps
1. general.ts 实现（八板块 + template/intent 整合语义）
2. research.ts 正式化（补 provenanceRules；版本升至 v0.2.0）
3. 单测

## Tests
- general：八板块段齐全；suggested 独立段；无 evidence 不新增硬约束
- research 回归：P01.5 验收线用例仍全绿

## Acceptance Criteria
单测全绿；research 回归全绿；版本号递增

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p02(t07): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P02-T08
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
