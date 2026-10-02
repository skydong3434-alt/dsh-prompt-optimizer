# P07-T03 — 首轮回归执行与调优

**Status**: PENDING
**Phase**: P07
## Executor
DSH（执行与判定）+ Claude Code（按需回修）+ Human（G-5 关键裁决/阈值校准）

## Goal
全语料首轮跑通；失败例逐条分析 → 回修策略/分类器（经各自主分支）→ 复跑；产出回归报告；按人工标注校准 model-assisted 阈值（R-2）。

## Why
P07 是强制阶段：unit 全绿 ≠ 完成；必须证明"优化后更准确表达用户意图"，并让 S-08 有机器可判定的退出条件。

## Preconditions
P07-T02

## Inputs
六 golden + 真实历史语料；PLAN-v1 §15 验收口径

## Allowed Scope
回归执行 + 对策略（P02 模块）/分类器（P03 模块）/编译协议文案的最小修订（走各自分支评审）；docs/regression.md 报告

## Forbidden Scope
为过回归弱化 invariants；改 CompileResult 契约（需 G-1 复审）

## Tools
node/scripts/git

## Exact Steps
1. 首轮全量（deterministic + evaluator 参考）
2. 失败例分类：drifting（保真丢失）/ 分类错（S-06 线索）/ 协议问题（解析层）
3. 逐类回修 → 复跑直至 deterministic 全绿（或触发 S-08/retry exhausted）
4. 人工标注样本（Human）→ 校准 evaluator 阈值与提示词 → 记录校准依据

## Tests
deterministic 全绿为准；evaluator 参考线达标（阈值经人工校准后生效）；S-08 记录

## Acceptance Criteria
deterministic 全绿；报告存档（report-<date>.json + docs/regression.md）；S-08 不触发

## Human Gate
**G-5**（regression 报告认可 + 通过阈值确认——任务完成后停止等待用户；含失败例处置确认）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p07(t03): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
G-5 → P08-T01