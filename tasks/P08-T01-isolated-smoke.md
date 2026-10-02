# P08-T01 — 隔离 profile 安装与冒烟

**Status**: PENDING
**Phase**: P08（Isolated DSH Integration）
## Executor
DSH（主导）+ Claude Code（按需修复）

## Goal
在隔离 dev profile（headless 或新建 apo-dev，**不碰正式 desktop profile**）安装插件包并跑完整冒烟清单：button/dropdown/streaming/cancel/replace/undo/settings/context/override/AUTO/fallback/CSRF。

## Why
S-09 检查点：正式安装前必须证明隔离环境稳定且不污染周边。

## Preconditions
P07 通过（G-5）

## Inputs
构建产物 lib/ + cordis.patch.yml；PAB runner-profile 的审批补丁模式（思想）

## Allowed Scope
隔离 profile（headless 或新 apo-dev profile）的数据与配置；插件包构建产物

## Forbidden Scope
正式 desktop profile；PAB；个人工作台配置；AI 视频工作流

## Tools
dsh/headless、npm build、冒烟清单（手测+脚本）

## Exact Steps
1. 隔离 profile 准备（复用 headless；如需 approval never 补丁——先问用户，默认不动）
2. 安装 bundle（dsh plugin 或本地路径）
3. 冒烟清单逐项验证（真实 DSH Desktop 2.0.15）
4. 截图/记录留档；问题清单 → 修复分支 → 复验

## Tests
冒烟清单全过；S-09 记录（正式 profile 零改动证明）

## Acceptance Criteria
冒烟全过；问题清单清零或明确降级

## Human Gate
**G-6**（隔离环境用户体验认可——任务完成后停止等待用户）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p08(t01): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
G-6 → P08-T02