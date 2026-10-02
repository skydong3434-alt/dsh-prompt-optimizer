# P02-T08 — Registry 与版本化

**Status**: PENDING
**Phase**: P02
## Executor
Claude Code + DSH 验收

## Goal
`src/core/registry.ts` 完整版：七类型索引、`get()` fallback general、`list()/getVersion()`、策略版本暴露。

## Why
P01.5 只有 research/general 两类型；P02 收尾时七策略全注册并可独立升级。

## Preconditions
P02-T01..T07 完成（七策略齐）

## Inputs
PLAN-v1 §7；types.ts PromptStrategy

## Allowed Scope
`src/core/registry.ts` + `test/registry.test.mjs`

## Forbidden Scope
UI/ctx.llm/策略内容

## Tools
node/tsc/node:test/git

## Exact Steps
1. registry 实现（按 type 收集；未知类型 → general；getVersion 汇总各策略版本）
2. 单测：7 类型全注册、未知→general、版本可审计

## Tests
- 7 类型齐全；未知类型 fallback；getVersion 返回 {type, version} 映射

## Acceptance Criteria
单测全绿；G-2 前 final check（策略内容抽审）

## Human Gate
**G-2**（七策略内容抽审：铁律/措辞/边界——任务完成后停止等待；用户确认后继续 P03）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p02(t08): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
G-2 → P03-T01（classifier 纯函数）