# P05-T02 — 兼容性回归（双版本面 + 全量测试）

**Status**: PENDING
**Phase**: P05
## Executor
DSH

## Goal
全量回归：旧三件套 + 新 pipeline 用例在 DSH Desktop 2.0.15（dsh 0.1.7-rc.2 / cordis 4.0.4）环境下全部通过；确认 settings 双版本接入（volatile/configForms/settingsScope）未被破坏。

## Why
S-04 检查点；发布前兼容基线。

## Preconditions
P05-T01

## Inputs
DSH checkout 基线（上文已实测）

## Allowed Scope
只读验证 + 测试；必要时仅修测试夹具（不修产品代码语义）

## Forbidden Scope
改 DSH；装 profile；改正式环境

## Tools
npm test/npm run build/git

## Exact Steps
1. `npm run build && npm test` 全绿记录
2. tsc core 层零新增错误
3. settings 双版本探测路径回归（smoke 既有用例）

## Tests
全量测试 + typecheck 记录

## Acceptance Criteria
全绿；记录版本矩阵到 BASELINE.md 追加

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p05(t02): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P06-T01
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
