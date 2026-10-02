# P09-T02 — 发布产物（tag/CHANGELOG/NOTICE/DoD 终检）

**Status**: PENDING
**Phase**: P09
## Executor
DSH + Claude Code（文档产物）

## Goal
发布收尾：版本 tag（v0.1.0-apo）、CHANGELOG.md、NOTICE.md（设计来源：Y1X1n MIT 署名/ WestFox BSD-3 借鉴设计 / linshenkx·zhangjiazhi AGPL 仅思想零复制 + 污染检查脚本）、README 更新；DoD（PLAN-v1 §18）全项终检。

## Why
License 清洁与可发布性是收官条件；DoD 不能只是"插件能运行"。

## Preconditions
P09-T01（G-7）通过；正式安装冒烟通过

## Inputs
PLAN-v1 §16/§18；check-license-contamination 脚本草案（若未在早期实现，此处补）

## Allowed Scope
发布产物与文档；许可证检查脚本

## Forbidden Scope
改契约；放宽 DoD 条目

## Tools
git tag、文本编辑、node 检查脚本

## Exact Steps
1. NOTICE.md + license 污染检查脚本（扫描 AGPL 仓库特征串）跑绿
2. CHANGELOG + README（含安装/使用/致谢）
3. DoD 18 项逐条证据收集（tests/regression 报告、BASELINE、provenance 测试等）
4. annotated tag v0.1.0-apo

## Tests
DoD 检查清单（docs/dod.md 自动核对脚本或人工逐条）

## Acceptance Criteria
DoD 全过；license 检查绿；tag 创建

## Human Gate
**DoD 终检由用户声明 PASS**（机器证据齐备后，用户验收宣布完成）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p09(t02): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
项目完成（进入使用期；后续增强按新契约流程）