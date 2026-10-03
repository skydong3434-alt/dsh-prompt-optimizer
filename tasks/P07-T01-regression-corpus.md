# P07-T01 — Behavioral/Effect Regression 语料固化

**Status**: PENDING
**Phase**: P07（Regression，强制阶段）
## Executor
DSH（草案）+ Human（G-3 定稿）

## Goal
`test/regression/fixtures/*.json`：六 golden examples（RESEARCH/PLANNING/EXECUTION/DIAGNOSTIC/REVIEW/CREATIVE）+ 用户真实历史需求；每例含 raw_input/context?/expected_type/invariants[]（require/prohibit）/prohibited_drift/effect?。

## Why
整个插件最重要的验收数据资产；不能只测 section/JSON/UI。

## Preconditions
P06 完成（G-4 通过）；六 golden 已在本项目规划中定义（用户提供）

## Inputs
用户指定的六例验收线（H3/黑鹤001/规划/执行/诊断/分镜等）；REPORT §11 语料设计

## Allowed Scope
`test/regression/fixtures/**` + `docs/regression.md`（语义说明）

## Forbidden Scope
放宽 invariants 以迁就实现

## Tools
JSON/文本编辑/git

## Exact Steps
1. 六 golden 案例 → fixtures JSON（deterministic invariants 用字符串/正则）
2. effect 字段（optional：evaluator_prompt_id=intent-fidelity-v1 + questions）
3. docs/regression.md：语义、断言写法、通过阈值语义（DEFERRED_TO_P07_CALIBRATION：先不定数值阈值，跑数据后按人工标注校准）

## Tests
fixtures JSON schema 校验（test/regression/schema.test.mjs）；语料级 cross-strategy invariants：每例可携带 `invariant_checks`（unknown 不阻断 / suggested 不升级），运行期强制。

**G-2 后追加的必收 case（2026-10-03，用户确认）：**
- **B. planning-historical-fact-false-positive**：用户明确提供"前置安装/开发已经完成，现在只做规划"→ 优化稿必须允许正确引用这些历史事实；planning 的"不得出现执行证据"守卫只允许阻止 Optimizer/Planning Agent 本轮凭空宣称自己实施过，**不得**把用户明确提供的既有完成事实误判为违规（`expected_type: planning` + invariant：用户提供的历史事实可原样进入 Background/Preconditions；prohibit："以为用户尚未完成"类语言）。
- **C. creative-explicit-override-priority**：历史上下文存在旧角色/资产/Blocking 约束，但用户当前消息明确修改该约束 → 优先级恒为 CURRENT USER EXPLICIT > HISTORICAL USER EXPLICIT > CONTEXT FACT > OPTIMIZER SUGGESTED；creative 实体 fidelity 不得阻止用户明确要求的修改（fixture 带 context turns：旧设定在 user 历史消息；raw_input 是明确修改指令；invariant：优化稿必须采用新设定且保真新实体；prohibit：沿用旧设定）。（注：provenance 的 raw 优先判定天然支持该优先级，此 case 用于固化验证。）

## Acceptance Criteria
六例 + 用户提供的真实历史需求（至少覆盖七类型）全部入库且可加载

## Human Gate
**G-3**（语料集定稿确认——注意：按 v1.1 R-2，**不在本轮设 model-assisted 固定阈值**；阈值在 P07-T03 跑出数据后按人工标注校准。任务完成后停止等待用户确认语料）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p07(t01): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
G-3 → P07-T02