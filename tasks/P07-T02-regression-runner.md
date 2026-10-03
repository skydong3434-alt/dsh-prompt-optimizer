# P07-T02 — Regression Runner 实现

**Status**: DONE
**Phase**: P07
## Executor
Claude Code + DSH 验收

## Goal
`test/regression/run.mjs` 双通道 runner：deterministic 断言层（优先，硬 Gate）+ model-assisted evaluator（intent-fidelity-v1：temp 0、固定提示词 id、失败重跑一致才计、逐条带理由、只作参考线）+ **Per-Standard 开销测量** + 报告输出（test/regression/report-<date>.json + 控制台 x/N）。

## Why
"优化后是否更准确"必须可复跑、可审计；evaluator 不得成为不稳定源（S-08 防误伤）。

## Preconditions
P07-T01（语料入库）

## Inputs
REPORT §11.2；PLAN-v1 §13 P07-T02

## Allowed Scope
`test/regression/run.mjs` + schema 校验 + docs 更新

## Forbidden Scope
宽松 invariants；把 evaluator 分数当发布标准（R-2：阈值校准前不可用）

## Tools
node:test/真实或 mock llm（可切换）/git

## Exact Steps
1. deterministic 层：逐一执行 invariants require/prohibit
2. evaluator 层：raw vs optimized 固定问答；重跑不一致不计 PASS；报告带理由
3. **开销测量（G-2 追加要求 A）**：对每个 Strategy 记录实际发送给 LLM 的 system prompt token 数 / context token 数 / total input token 数 / latency（每次 classify 与 compile 调用分别测量；按 strategy 聚合 min/avg/max；550–650 行源码规模本身不是问题，**不预防性删内容**——仅当数据证明 token/延迟/instruction dilution 明显时才由后续任务压缩）
4. runner CLI：--mode deterministic|all、--fixture 过滤、报告输出

## Tests
runner 自身单测（fake fixture 通过/失败断言）；deterministic 失败覆盖 evaluator 结果（evaluator 不得置 PASS）

## Acceptance Criteria
runner 测试全绿；evaluator 不可覆盖 deterministic FAIL（硬性断言）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p07(t02): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P07-T03
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
