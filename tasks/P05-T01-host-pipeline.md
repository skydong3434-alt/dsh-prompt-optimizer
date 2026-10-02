# P05-T01 — Host Pipeline 集成（handler 两阶段编排）

**Status**: PENDING
**Phase**: P05（Host Pipeline）
## Executor
Claude Code（实现）+ DSH（回归判定）

## Goal
`src/index.ts` handler 两阶段：promptType? 解析 → (AUTO: classifyViaLlm) → registry → compile → validate → SSE meta 事件（type/confidence_level/missing/rationale/provenance_ok）→ delta → done 扩展。协议完全向后兼容。

## Why
把 core pipeline 接入既有 Host，同时保持 resolveRoute/超时/断连 abort/fallback 链/CSRF/settings 零改动。

## Preconditions
P04 完成

## Inputs
PLAN-v1 §2/§13 P05；Y1X1n index.ts handler 现状

## Allowed Scope
`src/index.ts` handler 内部（预计 +60 行）；OptimizeRequestV2/meta 事件类型已在 types.ts

## Forbidden Scope
路由/设置/安全层改写；旧请求字段语义变更；UI（P06）

## Tools
node/tsc/esbuild/node:test/mock llm/git

## Exact Steps
1. 请求体扩展解析（promptType optional）
2. AUTO 分支：classify（复用 resolveRoute/lowest reasoning/超时）→ meta 事件先行推送
3. compile 分支：registry.get(type) → compile → validate → SSE delta/done（done 包 CompileResult 字段）
4. override：跳过 classify 直入 compile（不发分类调用）
5. 回归：旧 smoke 全绿

## Tests
- meta→delta→done 事件序；override 无 classify 调用；classify 失败回退 general + Low 提示；旧用例零回归；abort/timeout/回退链行为不变

## Acceptance Criteria
旧用例全绿（零破坏证明，S-03 检查点）+ 新用例绿

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p05(t01): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P05-T02
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
