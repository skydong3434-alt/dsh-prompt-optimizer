# CURRENT STATE

```
project: dsh-adaptive-prompt-optimizer
last_updated: 2026-10-03T07:16:28+0800
current_phase: P02
current_task:
status: RUNNING
next_task: P02-T02
machine_gate: PASS
human_review: PASS_G_VS
phase_status: G-VS 已通过（2026-10-03 用户验收）。P02-T01（共享规则段 _shared 完整化）已完成并提交 e06bf3b：常量组 + 五个守卫工厂 + cross-strategy invariants A（UNKNOWN≠BLOCKING）/B（OPTIMIZER_SUGGESTED≠USER REQUIREMENT）纳入六段共享规则；Research 0.1.4 保持为已验证基线，不做重设计。next=P02-T02（planning 策略）。
latest_commit: e06bf3b1e5d77e5cb8633bbf4124e72b4e699ffa
auto_continue: true
stop_reason: none
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
| P01.5-T01 research-strategy | DONE | Research 策略 v0.1（15 段 + 守卫矩阵 + _shared 初版，bb4c6a4） | — |
| P01.5-T02 vertical-slice-e2e | DONE | 端到端（AUTO→…→Replace），3276e1e | **G-VS（当前）** |
| P02-T01 shared-rules | DONE | _shared 完整化：六段规则 + 5 守卫工厂 + invariant A·B（e06bf3b） | — |
| P02-T02..T08 | PENDING | 七策略/registry（tasks/P02-*） | **G-2** |
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
