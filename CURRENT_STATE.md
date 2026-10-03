# CURRENT STATE

```
project: dsh-adaptive-prompt-optimizer
last_updated: 2026-10-04T00:35:00+08:00
current_phase: P07
current_task: P07-T02
status: RUNNING
next_task: P07-T02
machine_gate: PASS
human_review: PASS_G3
phase_status: G-3 已通过（2026-10-04 用户预授权，本次追加即确认）：语料集定稿 14 例（原 12 例全部保留，新增 fixture 13 assistant-only 不升级为用户决定、fixture 14 execution safe-mutation-boundary 非永久规则）；schema 全过 + npm test 22 套全绿 + apo_state PASS + 原 12 例未改；R-2 保持：G-3 不设 model-assisted 固定阈值（deterministic FAIL=硬 Gate，evaluator=参考线，P07-T03 首轮数据+人工标注后校准）。 next=P07-T02（regression runner + token/latency 测量）→ P07-T03（首轮真实回归，只基于失败证据修复）→ 停靠 G-5。
latest_commit: f6f7466
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
| P02-T02 planning-strategy | DONE | planning 策略 v0.1：16 段 + 三铁律 + 守卫（9784dbe） | — |
| P02-T03 execution-strategy | DONE | execution 策略 v0.1：15 段 + 三铁律 + 守卫（543f737） | — |
| P02-T04 diagnostic-strategy | DONE | diagnostic 策略 v0.1：10 段 + 验证先于修改/假设证伪/修复必带复测 + 守卫（e0ec912） | — |
| P02-T05 review-strategy | DONE | review 策略 v0.1：9 段 + 基于原目标审查/不发散/偏离对应需求 + 守卫（11315af） | — |
| P02-T06 creative-strategy | DONE | creative 策略 v0.1：12 段（+Assets）+ 实体保真/无证据不改设定 + 守卫（7c9bde3） | — |
| P02-T07 general-research-integration | DONE | general 策略 v0.1：八板块 + template/intent 双模式；research v0.2.0：provenanceRules 4→7 + invariant A·B（bb37841） | — |
| P02-T08 registry-versioning | DONE | registry 七策略全注册/版本暴露/list/getSections；general 过渡期 legacy（419f999） | **G-2** |
| P03-T01 | DONE | classifier 纯函数层：七类型 + 防误判三规则 + JSON 契约容错（1aebeec） | — |
| P03-T02 | DONE | classifyViaLlm 调用侧封装：硬参数钳制/thinkFilter/超时与失败回退 + mock 单测（1e73fb2） | — |
| P03-T03 | DONE | 防误判规则测试（fixtures 五类 + g1..g10 + S-06 稳定性抽查，a810ea1） | P04 |
| P04-T01 | DONE | compiler core：compilePrompt 10 步编排 + 四段协议解析容错 + 缺口注入（8248c22） | — |
| P04-T02 | DONE | validate.ts 三层守卫（Preservation/Inference&Suggestion/Unknown）+ 策略 guards 汇总 + provenance_ok 联动契约（156b857） | — |
| P04-T03 | DONE | compiler + validator 集成测试：七类型契约矩阵 / provenance_ok 联动 / S-07 复审（16eedb4） | P05 |
| P05-T01 | DONE | host pipeline：handler 两阶段（classifyViaLlm→compilePrompt→finalize→validate）+ SSE meta/delta/done 扩展（9ffb320） | — |
| P05-T02 | DONE | 兼容回归：旧用例零回归证明（S-03，33cd988） | — |
| P06-T01 | DONE | AUTO 下拉 + 手动覆盖：TYPE_OPTIONS 单一真值源 + 逐类型请求体/重优化沿用（4f515db） | — |
| P06-T02 | DONE | ResultDock 四组 provenance 定稿 + 缺口清单独立 + 低置信类型黄条（1f3d530） | — |
| P06-T03 | DONE | settings 新字段（默认类型/分类模型）+ i18n 收尾（3dc97af） | **G-4** |
| P07-T01 | DONE（G-3 待确认） | 语料固化：12 例 fixtures + schema 校验 + invariant_checks + docs/regression.md（f6f7466） | **G-3** |
| P07-T02..T03 | PENDING | runner 双通道 + 首轮执行/人工校准 | **G-5** |
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
