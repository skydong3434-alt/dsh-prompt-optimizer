# CURRENT STATE

```
project: dsh-adaptive-prompt-optimizer
last_updated: 2026-10-03T14:20:00+08:00
current_phase: P01
current_task: P01-T02
status: RUNNING
next_task: P01.5-T01
machine_gate: PENDING
human_review: PENDING_NON_BLOCKING
phase_status: P00 已完成（Fork & Baseline，build+test 三件套全绿，BASELINE.md 已提交 da52f28）；P01-T01 已完成（src/core/types.ts 核心契约落盘，core 层 typecheck 零错误，分支 phase/p01-contracts）；**P01-T02（Provenance 机械校验器）待执行：current_task = P01-T02 = NOT_STARTED**。
latest_commit: <由 runner 每轮读取时核对>
auto_continue: true
stop_reason: none
```

> ⚠️ 状态字段纪律：`stop_reason` 不得包含 Runner 的 BLOCKING_STOP_REASONS 任何标记词
> （blocking / merge conflict / schema breaking / contract breaking / architecture change /
> irreversible / transport exhausted / retry exhausted / test failure out of scope /
> scope expanded），否则会被误判停止。P01-T02 完成后进入 Human Gate G-1（核心契约与
> Provenance 数据结构定稿）：收尾时把 `status` 置 `GATE_PENDING` 并把原因写入
> `stop_reason`（使用 "awaiting user confirmation" 等非标记词，详见 AGENTS.md §4）。

## 任务图（Task Graph, 只读快照）

| Task | 状态 | 说明 |
|---|---|---|
| P00-T01 fork-and-baseline | DONE | 基线验证（BASELINE.md，da52f28） |
| P01-T01 core-contracts | DONE | src/core/types.ts（契约层） |
| **P01-T02 provenance-validator** | **NOT_STARTED ← current** | src/core/provenance.ts + test/provenance.test.mjs + build.mjs 产物段 |
| GATE:G-1 | PENDING | Human Gate：契约+Provenance 定稿（P01-T02 完成后停止等待） |
| P01.5-T01 research-strategy | PENDING | Vertical Slice：Research 策略单片 |
| P01.5-T02 vertical-slice-e2e | PENDING | AUTO→classifier→research→compiler→provenance→host→SSE→ResultDock→replace |
| GATE:G-VS | PENDING | Human Gate：真实体验验收 |

之后按 PLAN-v1.1：P02 全策略扩展 → P03/P04/P05/P06 → P07 regression → P08 隔离集成 → P09 release（G-1..G-7 原序，G-3 延后校准）。

## 无人值守运行说明（简版，详见 docs/runner-ops.md）

- Runner 每轮读取本文件：current_task 非空即续跑；为空读 next_task。
- Agent 收尾协议：完成一个 Task → 更新本文件（current_task 置空 → next_task 设为下一 Task；status/stop_reason 相应更新）→ 一个内容提交 + 一个仅状态同步的提交。
- Human Gate（G-1/G-VS/G-2…）命中时：status 置 GATE_PENDING、stop_reason 写 "blocking human gate: <门禁名>"，**不要硬做**。
- 无人值守：不会有人回答提问；需要人工裁决时写 stop_reason 后结束本轮。
- 边界（NON-GOAL）：不碰正式 DSH profile / ~/.dsh 正式配置 / PAB / Personal AI Brain / AI 视频工作流；不安装 launchd；不复制任何 AGPL 代码（linshenkx / zhangjiazhi）。
- 本仓库 git remote：upstream = Y1X1n/dsh-prompt-optimizer（只读）；origin 待用户提供自有仓库 URL。