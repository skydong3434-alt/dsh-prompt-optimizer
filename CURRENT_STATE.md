# CURRENT STATE

```
project: dsh-adaptive-prompt-optimizer
last_updated: 2026-10-03T08:22:26+08:00
current_phase: P04
current_task: 
status: RUNNING
next_task: P04-T01
machine_gate: PASS
human_review: PASS_G2
phase_status: G-2 已通过（2026-10-03 七策略定稿）。G-2 后追加的 Performance/Effect 验收要求已入 P07 契约：A. per-strategy token/latency 测量（system/context/total input token + latency，不预防性压缩）；B. planning 历史事实误报 case（用户提供的既有完成事实允许引用，守卫只阻止 Optimizer 凭空宣称实施）；C. creative 显式覆盖优先级 case（CURRENT USER EXPLICIT > HISTORICAL USER EXPLICIT > CONTEXT FACT > OPTIMIZER SUGGESTED）。P03-T01 已完成：classify.ts 纯函数层（七类型 + 防误判三规则 + JSON 契约容错，1aebeec）。P03-T02 已完成：classifyViaLlm 调用侧封装（结构化最小 LLM 接口、temp0/512/lowest 钳制、thinkFilter、硬超时/abort/失败回退、CLASSIFY_LLM_ISSUE + request 快照，mock 单测 ll1..ll14，1e73fb2）。P03-T03 已完成：防误判规则与 Manual Override 测试契约（fixtures 五类场景 referent/multi-intent/assistant-bg/negation/current-vs-history + g1..g10；assistant 发言永不产生 explicit；override 函数级零分类调用；S-06 稳定性抽查 5 例×3 次 + 调用侧 3 次稳定签名完全一致 stable=true，记录 docs/classifier.md，a810ea1）。P03 三任务全部完成，next=P04-T01（compiler core）。
latest_commit: a810ea1ce3858419e36baaf861ab4eeac232de6c
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
