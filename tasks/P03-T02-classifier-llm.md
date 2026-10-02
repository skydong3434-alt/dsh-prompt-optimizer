# P03-T02 — Classifier LLM 调用封装（宿主侧，暂不接入主路径）

**Status**: PENDING
**Phase**: P03
## Executor
Claude Code + DSH 验收

## Goal
封装一次分类小调用：复用 resolveRoute/reasoningEffort 钳制（lowest）/thinkFilter/超时；输出 ClassifierResult；失败回退 general（degraded 标记）。

## Why
Two-call 的第一调；成本控制（maxTokens 512/temp 0）与失败语义必须在接入 handler 前独立验证。

## Preconditions
P03-T01

## Inputs
PLAN-v1 §6；Y1X1n index.ts 现有 collectText/resolveLowestEffortCached

## Allowed Scope
`src/core/classify.ts` 的调用侧 + 独立测试（mock llm）；不修改现有 handler 主路径

## Forbidden Scope
handler 注入（P05）；UI

## Tools
node/tsc/mock llm/node:test/git

## Exact Steps
1. classifyViaLlm(ctx.llm, route, input, opts)（temp0/maxTokens512/signal/thinkFilter）
2. 失败路径：error→general+Low；超时/abort 语义与现有风格一致
3. 单测：mock llm 各失败分支 + 正常 JSON + 回退标记

## Tests
- 正常/超时/AUTH 失败/流中断 → 各自回退语义；abort 立即生效

## Acceptance Criteria
独立测试全绿；不触碰 handler 主路径（git diff 验证）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p03(t02): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P03-T03
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
