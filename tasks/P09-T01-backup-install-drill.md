# P09-T01 — 正式 profile 备份与安装演练

**Status**: PENDING
**Phase**: P09（Release Candidate）
## Executor
DSH（演练）+ Human（G-7 授权）

## Goal
正式 profile 安装路径预演：备份现有 desktop profile bundle → 安装 → 冒烟 → 回滚预案验证。**实际安装动作仅在 G-7 授权后执行。**

## Why
S-09/S-10 终检；G-7 是唯一动正式 profile 的开关（不可逆操作前置演练）。

## Preconditions
P08 通过（G-6）

## Inputs
发布产物；回滚预案（docs/release.md）

## Allowed Scope
备份快照 + 演练文档（对正式 profile 的实际写入：仅 G-7 后）

## Forbidden Scope
G-7 前的任何正式 profile 写入；PAB 写入

## Tools
dsh plugin、备份/恢复脚本（提交到 scripts/）

## Exact Steps
1. scripts/backup-profile.sh（快照 bundle + 恢复脚本）验收
2. 演练：隔离环境模拟安装/回滚
3. G-7 后（仅）：真实备份 → 安装 → 冒烟 → 失败即回滚

## Tests
备份/恢复脚本单测（隔离模拟）；DoD §6/§7 检查点

## Acceptance Criteria
演练通过；G-7 未授权时状态保持 pending

## Human Gate
**G-7**（正式安装许可——唯一允许动正式 DSH profile 的开关）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p09(t01): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
G-7 → P09-T02