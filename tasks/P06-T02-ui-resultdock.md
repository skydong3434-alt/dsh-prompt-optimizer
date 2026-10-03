# P06-T02 — UI：ResultDock 四组 Provenance 渲染 + 类型徽章

**Status**: DONE
**Phase**: P06
## Executor
Claude Code + DSH 验收

## Goal
ResultDock 渲染：任务类型 + 把握徽章（高/中/低，不显示小数）+ 诊断 + 四组来源（明确要求/上下文确认/优化器建议/待补充）+ 低置信提示 + 缺口清单；保持既有 replace/undo/copy/re-optimize/close 行为。

## Why
Provenance 的 UI 可审计性（MVP 第一优先级）落地；低置信不做伪精确。

## Preconditions
P05 完成（meta 事件携带 provenance_ok/missing）

## Inputs
PLAN-v1 §10；Meta 事件字段

## Allowed Scope
`src/client/ResultDock.tsx`、i18n；样式沿用 dsw-alias 令牌（零新依赖）

## Forbidden Scope
auto-close/Esc/slash 语义变更；显示 confidence_internal 数值

## Tools
node/tsc/controller.test.mjs/git

## Exact Steps
1. 四组 ProvenanceRecord 渲染（组标题+条目+quote tooltip；suggested 有"建议（可忽略）"前缀样式）
2. 把握徽章：High≥0.8/Medium≥0.6/Low（toConfidenceLevel）；Low 显示"可能是 X / Y，请检查类型"黄条（复用 warnBanner）
3. provenance_ok=false → 顶部警示 + 结果仍可替换（显式告知）
4. 单测扩展 + 手测清单

## Tests
四组渲染数据断言；Low 提示触发；provenance_ok 警示；替换/撤回回归

## Acceptance Criteria
单测全绿；手测清单通过

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p06(t02): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P06-T03
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）

## Manual Test Checklist（G-4 阶段出口执行，dev profile）
> 无头自动化已覆盖数据面（controller.test c25）；下列为需要真实渲染的手测项，
> 与 P06-T03 settings/i18n 一起在 P06 出口 G-4 的 UI 预览中执行（不装正式 profile）。

1. 输入草稿点 ✨ 优化：meta 到达后顶部出现「任务类型 / 把握（高/中/低）」徽章，且不出现任何小数。
2. done 后依次核对四组区块：明确要求（✓，hover 显示 quote 证据）/ 上下文确认（✓，WORKSPACE_FACT 条目带「工作区事实」来源小标）/ 优化器建议补充（✎，条目带「建议(可忽略)」前缀）/ 仍需补充·不确定（?）。
3. 若存在 missing_constraints：缺口清单独立成段，显示 `[待补充: …]`；unknowns 非空时缺口清单仍可见、不重复。
4. 构造 `confidence_level=Low`：出现黄条，文案含当前识别类型与「可能属于其他类型，请检查任务类型」。
5. 构造 `provenance_ok=false`：顶部出现警示横幅；无逐字证据的 explicit 条目带「⚠ 缺证据」；结果仍可「替换输入框」。
6. 替换 → 撤回 → 重新优化 → 关闭：行为与旧版一致（Esc 取消/关闭、发送即关闭、斜杠前缀拼回不变）。
7. 中英界面语言切换：新增文案全部有译（缺译回退中文不报错）。

