# P03-T03 — 防误判规则与 Manual Override 测试

**Status**: DONE（2026-10-03；test/classify-guards.test.mjs g1–g10 + fixtures 全绿；S-06 抽查 stable=true，记录见 docs/classifier.md）
**Phase**: P03
## Executor
DSH（验收）+ Claude Code（补测）

## Goal
固化防误判行为为测试契约：当前请求 vs 历史讨论；assistant 建议≠用户决定；promptType override 直达 compiler（跳过分类）。

## Why
分类稳定性和"不把讨论当决定"是 S-06 的检查点；override 优先是产品硬需求。

## Preconditions
P03-T01/T02

## Inputs
PLAN-v1 §6；fixtures（含指代/多意图/assistant 讨论较长场景）

## Allowed Scope
`test/classify-guards.test.mjs` + fixtures（必要时极小修正 classify 提示词）

## Forbidden Scope
UI；改 ClassifierResult 契约（契约改需 G-1 复审）

## Tools
node:test/git

## Exact Steps
1. fixtures：指代类（"上面提到的那个方案怎么样"）、多意图（"分析并执行"）、assistant 长讨论仅背景、明确否定类
2. 断言：主类型选择依据当前输入；assistant 发言不产生 explicit；override 路径函数级不调用 classify
3. 运行稳定性抽查：同一输入 2 次同结果（mock 固定输出下确定性）

## Tests
全 fixtures 绿；override 旁路断言；S-06 检查点记录

## Acceptance Criteria
全绿；记录稳定性抽查结果到 docs/classifier.md

## Human Gate
无（G-6 才有人工体验；此处为机器门禁）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p03(t03): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P04-T01