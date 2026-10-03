# P04-T01 — Compiler 核心（four-section 协议）

**Status**: DONE
**Phase**: P04（Compiler + Validation）
## Executor
Claude Code + DSH 验收

## Goal
`src/core/compiler.ts`：compilePrompt()（10 步编排）+ 四段输出协议提示词 + parseCompileOutput（标记解析/容错/thinkFilter 适配）。

## Why
Compiler 是"不替用户发明约束"的执行点：explicit/context/suggested/unknown 四段协议是 provenance 的产出端。

## Preconditions
P02（registry 全）+ P03（classify 可用）完成

## Inputs
PLAN-v1 §8（compiler 10 步）；types.ts CompileResult

## Allowed Scope
`src/core/compiler.ts` + `test/compiler.test.mjs`

## Forbidden Scope
UI/Host；策略内容；suggested 混入 explicit 的宽松处理

## Tools
node/tsc/node:test/git

## Exact Steps
1. 四段标记协议（EXPLICIT/CONTEXT/SUGGESTED/UNKNOWN + OPTIMIZED/END），解析函数容错（缺段降级、重复取最后、think 剥离）
2. compilePrompt：normalize→(type)→strategy→compile system/user→输出 CompileResult（含 strategy_version/provenance_ok 初始 false 待 validate）
3. missing_constraints 注入 [待补充:]；suggested 独立段文案

## Tests
- 四段拆解正确；缺段降级；suggested 不在 explicit；[待补充:] 注入；override 类型直达 registry

## Acceptance Criteria
单测全绿；解析纯函数零依赖

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p04(t01): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P04-T02
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
