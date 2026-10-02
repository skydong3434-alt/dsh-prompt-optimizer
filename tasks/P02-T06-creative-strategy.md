# P02-T06 — Creative / Content Strategy

**Status**: PENDING
**Phase**: P02
## Executor
Claude Code + DSH 验收

## Goal
`src/core/strategies/creative.ts`：内容创作类策略（分镜/视频提示词/文案等）。

## Why
必须保留用户给出的 人物/镜头/动作/资产/场景/约束，不得自行改变角色关系/技能/Blocking 等。

## Preconditions
P02-T01 完成

## Inputs
PLAN-v1 §7 creative sections：Creative Goal/Audience/Platform/Style/Reference/Constraints/Structure/Tone/Output Format/Avoidances/Success Criteria（可选段按内容任务调整）

## Allowed Scope
`src/core/strategies/creative.ts` + `test/strategies-creative.test.mjs`

## Forbidden Scope
其他策略/UI

## Tools
node/tsc/node:test/git

## Exact Steps
1. 实现策略（sections 12 段；guards：可识别实体（人物/镜头/动作/资产）不得被替换——用占位符保真断言；无证据的"改变角色关系"类语言 → warn）
2. 单测：给分镜示例，断言关键实体在 buildUser 模板中保真

## Tests
- 12 段齐全；实体保真守卫；Success Criteria 强制段

## Acceptance Criteria
单测全绿；版本 v0.1.0

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p02(t06): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P02-T07
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
