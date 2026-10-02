# CURRENT STATE

```
project: dsh-adaptive-prompt-optimizer
last_updated: 2026-10-03T15:05:00+08:00
current_phase: P01
current_task:
status: GATE_PENDING
next_task: P01.5-T01
machine_gate: PASS
human_review: BLOCKING_G1
phase_status: P00 已完成（Fork & Baseline，da52f28）；P01-T01 已完成（src/core/types.ts 核心契约，17f4dee）；**P01-T02 已完成（2026-10-03；内容提交 e32858f）**：src/core/provenance.ts（五源判定 / quote 字面比对 / 记录工厂）+ test/provenance.test.mjs（19 组断言矩阵全绿）+ scripts/build.mjs 追加 lib/core/provenance.js 产物段；验收证据：npm run build 成功（五产物齐全）、node test/provenance.test.mjs all passed、npx tsc --noEmit 中 src/core/ 零新增错误（仅既有 client 基线错误）、npm test 与 python3 scripts/apo_state.py 全 PASS。**下一节点 = Human Gate G-1（核心契约与 Provenance 数据结构定稿）**：status=GATE_PENDING；用户确认后方可进入 P01.5-T01（Research Vertical Slice）。说明：docs/provenance.md 五源语义摘要按任务契约「如时间不足可在 G-1 前补」推迟到 G-1 审阅前补（本次未越出 Allowed Scope）；另以 human_review=BLOCKING_G1 触发 Runner 停止（Runner 的 classify_blocking 只识别 BLOCKED/RECOVERY_REQUIRED 状态与 BLOCKING* 的 human_review；stop_reason 按本轮要求保持非标记词）。
latest_commit: e32858f239d1b86879ee5a6737d79f4812a1ef58
auto_continue: false
stop_reason: awaiting user confirmation: G-1
```

> ⚠️ 状态字段纪律：`stop_reason` 不得包含 Runner 的 BLOCKING_STOP_REASONS 任何标记词
> （blocking / merge conflict / schema breaking / contract breaking / architecture change /
> irreversible / transport exhausted / retry exhausted / test failure out of scope /
> scope expanded），否则会被误判停止。G-1 为 Human Gate：`status: GATE_PENDING` +
> `human_review: BLOCKING_G1`，`stop_reason` 使用 "awaiting user confirmation: G-1"
> 这一非标记词表述（详见 AGENTS.md §4 与本文件顶部说明）。

## 任务图（Task Graph, 只读快照）

| Task | 状态 | 说明 | 出口 |
|---|---|---|---|
| P00-T01 fork-and-baseline | DONE | 基线（BASELINE.md, da52f28；tag base-y1x1n-v0.4.0） | — |
| P01-T01 core-contracts | DONE | src/core/types.ts（17f4dee） | — |
| P01-T02 provenance-validator | DONE | provenance.ts 校验器（e32858f） | **G-1（当前）** |
| P01.5-T01 research-strategy | PENDING ← next | Vertical Slice：Research 单片 | P01.5-T02 |
| P01.5-T02 vertical-slice-e2e | PENDING | 端到端（AUTO→…→Replace） | **G-VS** |
| P02-T01..T08 | PENDING | 共享规则/七策略/registry（tasks/P02-*） | **G-2** |
| P03-T01..T03 | PENDING | classifier 纯函数/LLM/防误判 | P04 |
| P04-T01..T03 | PENDING | compiler/validator/集成 | P05 |
| P05-T01..T02 | PENDING | host pipeline/兼容回归 | P06 |
| P06-T01..T03 | PENDING | 下拉/dock 四组渲染/settings+i18n | **G-4** |
| P07-T01..T03 | PENDING | 语料（**G-3**，阈值校准 R-2）/runner/首轮 | **G-5** |
| P08-T01..T02 | PENDING | 隔离冒烟/桌面证据 | **G-6** |
| P09-T01..T02 | PENDING | 备份演练（**G-7** 安装许可）/发布 | DoD 用户终检 |

Gates：G-1 契约+Provenance 定稿 → G-VS 真实体验 → G-2 策略抽审 → G-3 语料集（阈值 DEFERRED_TO_P07_CALIBRATION）→ G-4 UI 预览 → G-5 回归报告 → G-6 隔离体验 → G-7 正式安装许可（唯一动正式 profile 的开关）→ DoD 终检 PASS。

## 无人值守运行说明（简版，详见 docs/runner-ops.md）

- Runner 每轮读取本文件：current_task 非空即续跑；为空读 next_task。
- Agent 收尾协议：完成一个 Task → 更新本文件（current_task 置空 → next_task 设为下一 Task；status/stop_reason 相应更新）→ 一个内容提交 + 一个仅状态同步的提交。
- Human Gate（G-1/G-VS/G-2…）命中时：status 置 GATE_PENDING、human_review 置 BLOCKING_<门禁名>，stop_reason 用 "awaiting user confirmation: <门禁名>"，**不要硬做**。
- 无人值守：不会有人回答提问；需要人工裁决时写 stop_reason 后结束本轮。
- 边界（NON-GOAL）：不碰正式 DSH profile / ~/.dsh 正式配置 / PAB / Personal AI Brain / AI 视频工作流；不安装 launchd；不复制任何 AGPL 代码（linshenkx / zhangjiazhi）。
- 本仓库 git remote：upstream = Y1X1n/dsh-prompt-optimizer（只读）；origin 待用户提供自有仓库 URL。
