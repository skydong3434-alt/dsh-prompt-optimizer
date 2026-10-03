# P04-T02 — 输出守卫（三层 Validation）

**Status**: DONE
**Phase**: P04
## Executor
Claude Code + DSH 验收

## Goal
`src/core/validate.ts` 三层守卫（纯函数）：Preservation（保真：explicit quote 证据/sections 齐全/对象·方向·数量·范围·术语可寻）、Inference & Suggestion（suggested 不得混入要求段；强断言须有证据；无证据量化→error）、Unknown（证据不足必须 [待补充:]），输出 ValidationResult + provenance_ok。

## Why
Anti-drift 的机械防线；S-07 检查点。

## Preconditions
P04-T01；P01-T02（provenance 校验器）

## Inputs
PLAN-v1 §9；types.ts ValidationResult/Guard

## Allowed Scope
`src/core/validate.ts` + `test/validate.test.mjs`

## Forbidden Scope
UI/Host；放宽禁令以过测试

## Tools
node/tsc/node:test/git

## Exact Steps
1. 实现三层守卫执行器（聚合策略 guards + 通用守卫）
2. 用例矩阵（见 Tests）
3. 接入 compilePrompt 尾部（provenance_ok 联动）

## Tests
- explicit 无证据→error；suggested 进 explicit→error；"不可行/最终/确定"无证据→error；无证据量化（预算/时间/平台/模型）→error；[待补充:] 覆盖未知项；WORKSPACE_FACT 豁免；assistant 证据→warn

## Acceptance Criteria
矩阵全绿；provenance_ok 语义正确

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p04(t02): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P04-T03
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
