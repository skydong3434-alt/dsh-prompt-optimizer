# P06-T02 — UI：ResultDock 四组 Provenance 渲染 + 类型徽章

**Status**: PENDING
**Phase**: P06
## Executor
Claude Code + DSH 验收

## Goal
ResultDock 渲染：任务类型 + 把握徽章（高/中/低，不显示小数）+ 诊断 + 四组来源（明确要求/上下文确认/优化器建议/待补充）+ 低置信提示 + 缺口清单；保持既有 replace/undo/copy/re-optimize/close 行为。

## Why
Provenance 的 UI 可审计性（MVP 第一优先级）落地；低置信不做伪精确。

## Preconditions
P05 完成（meta 事件携带 provenance_ok/missing）

## Inputs
PLAN-v1 §10；Meta 事件字段

## Allowed Scope
`src/client/ResultDock.tsx`、i18n；样式沿用 dsw-alias 令牌（零新依赖）

## Forbidden Scope
auto-close/Esc/slash 语义变更；显示 confidence_internal 数值

## Tools
node/tsc/controller.test.mjs/git

## Exact Steps
1. 四组 ProvenanceRecord 渲染（组标题+条目+quote tooltip；suggested 有"建议（可忽略）"前缀样式）
2. 把握徽章：High≥0.8/Medium≥0.6/Low（toConfidenceLevel）；Low 显示"可能是 X / Y，请检查类型"黄条（复用 warnBanner）
3. provenance_ok=false → 顶部警示 + 结果仍可替换（显式告知）
4. 单测扩展 + 手测清单

## Tests
四组渲染数据断言；Low 提示触发；provenance_ok 警示；替换/撤回回归

## Acceptance Criteria
单测全绿；手测清单通过

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p06(t02): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P06-T03
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
