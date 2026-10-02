# P02-T01 — 共享规则段（_shared）

**Status**: PENDING
**Phase**: P02（Strategy Registry 完整化）
## Executor
Claude Code + DSH 验收

## Goal
`src/core/strategies/_shared.ts` 完整化：保真原则 / 语言匹配 / [待补充:] 纪律 / 建议标注纪律 / 禁入集合处理（纯常量+纯函数）。

## Why
七策略共用的理念段只有一份，改总纲不改策略；是策略可独立迭代的地基。

## Preconditions
G-VS 通过；P01.5 的 _shared.ts 初版存在

## Inputs
PLAN-v1 §5.4/§7/§9 规则；zhangjiazhi intent-rules 的**思想**（不复制文本）

## Allowed Scope
`src/core/strategies/_shared.ts` + `test/strategies-shared.test.mjs`

## Forbidden Scope
策略实现；UI；AGPL 文本复制

## Tools
node/tsc/node:test/git

## Exact Steps
1. 共享常量组：保真自检清单 / 建议前缀（"建议（可忽略）"）/ [待补充:] 格式 / 语言检测复用 estimateTokens
2. 共享守卫工厂：`forbidUnprovenStrongClaim()`、`suggestedNotInExplicit()`、`sectionPresence(sections)`

## Tests
- 建议前缀在产物协议中强制；强断言无证据触发守卫；sections 完整性断言工厂可复用

## Acceptance Criteria
单测全绿；无 ctx/UI import；版本号

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 pXX(tXX): ；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P02-T02（planning 策略）
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
