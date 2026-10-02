# P04-T03 — Compiler + Validator 集成测试

**Status**: PENDING
**Phase**: P04
## Executor
DSH（验收）+ Claude Code（补测）

## Goal
compile→validate 全链路集成测试：每种类型 override 输出契约齐全；missing 注入；suggested 独立；provenance_ok 联动；失败路径。

## Why
P05 接入前确保 pipeline 语义闭环。

## Preconditions
P04-T01/T02

## Inputs
PLAN-v1 §8/§9

## Allowed Scope
`test/compiler-integration.test.mjs`（mock llm 可选）

## Forbidden Scope
UI/Host 主路径

## Tools
node:test/git

## Exact Steps
1. 七类型 override 用例：CompileResult 字段齐全 + required_sections 满足 + provenance_ok=true
2. 失败注入：compiler 流中断→error 事件语义；validate 失败→provenance_ok=false + 警示数据
3. 输出协议解析容错回归

## Tests
七类型 × 契约字段矩阵；provenance_ok 联动；S-07 复审记录

## Acceptance Criteria
全绿；S-07 复审通过（Provenance 机制有效防误标）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p04(t03): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P05-T01
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
