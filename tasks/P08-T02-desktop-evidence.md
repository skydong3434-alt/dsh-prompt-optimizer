# P08-T02 — 桌面端实测与回归证据

**Status**: PENDING
**Phase**: P08
## Executor
DSH

## Goal
DSH Desktop 2.0.15 真机实测（隔离环境）：三槽位渲染、双版本设置接入、SSE 流式、撤销/替换交互；环境版本矩阵记录。

## Why
正式安装前的最后真实证据；S-04 终检。

## Preconditions
P08-T01

## Inputs
DSH 2.0.15（cordis 4.0.4 / dsh 0.1.7-rc.2）；全量测试

## Allowed Scope
只读验证 + 记录

## Forbidden Scope
正式 profile

## Tools
DSH Desktop UI、npm test、截图工具

## Exact Steps
1. 全量 `npm run build && npm test`
2. 桌面端交互实测清单（含 lighthouse 风格 UI 检查）
3. 版本矩阵写入 BASELINE.md 追加节

## Tests
全量回归 + 实测清单

## Acceptance Criteria
全绿 + 实测通过 + BASELINE 更新

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p08(t02): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P09-T01
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
