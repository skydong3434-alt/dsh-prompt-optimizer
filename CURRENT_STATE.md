# CURRENT STATE

```
project: dsh-adaptive-prompt-optimizer
last_updated: 2026-10-05T14:10:00+08:00
current_phase: DONE
current_task: 
status: DONE
next_task: NONE
machine_gate: PASS
human_review: PASS_DOD
phase_status: **项目收官（v0.1.0-apo，DoD PASS，2026-10-04 用户最终产品验收通过）**。P00–P09 全部完成，G-1/G-VS/G-2/G-4/G-3/G-5/G-6/G-7 八个人工 Gate + DoD 全部 PASS；正式 desktop 安装落地（link/bundles=21/默认模型 opencode-go 未改/其他插件零改动/备份留存未回滚）；发布产物 v0.1.0-apo（NOTICE/CHANGELOG/README/check-dod/check-license-contamination/tag）。KNOWLEDGE：KNOWN_NON_BLOCKING_HARNESS_LIMITATION（research phrasing regex false positive）为已记录非阻塞已知限制。**Post-v0.1.0 backlog（不阻塞 DONE，未经用户开启不得自动执行）**：① 配置 origin 后决定是否推送远端 release/tag；② 以独立未参与 P07 调参的新语料做 evaluator 人工标注与正式阈值校准（R-2）；③ 后续单独治理 phrasing-sensitive deterministic regex。Runner 已停止（BLOCKING_DOD 后不再 resume）；launchd job com.apo.devrunner 保持安装但处于 not running（不自动启动）。
v2_track: **用户明确授权的 v2 升级轨道（与已收官的 v0.1.0-apo 发布范围相互独立）**。目标：从「固定模板式 Prompt 扩写器」升级为「意图保真自适应提示词编辑器」。基线：docs/PLAN-v2-adaptive-editor.md（含现状测绘 / 复用与重构清单 / 四个 Phase / 风险 / 测试计划）。进展：**Phase 1 DONE**（分析阶段 + 阻塞门；385 断言）、**Phase 2 DONE**（信息责任 + Target-aware 路由 + Agent/Image/Video 契约 + 未决项处置契约：`[待补充:]` 退役；411 断言全绿；正式契约 docs/phase2-contract.md、报告 docs/phase2-report.md）。**Phase 3 DONE**（Requirement Discovery 完整闭环：取舍型 prerequisite + 环境事实反向保护 + Question Planner/Answer Resolver/Sufficiency/Confirmation + 盲授权纪律 + 宿主 fail-closed + 最小 UI 闭环；436 断言全绿；报告 docs/phase3-report.md，演示 scripts/phase3-trace.mjs）。仅余 Phase 4（Validator 回流 + 六态 UI 收尾 + general legacy 迁移 + 再优化保留台账）。本轨道不经 Runner 自动续跑（auto_continue=false），由用户逐阶段驱动；不触碰 v0.1.0-apo tag、不做 release/push。
latest_commit: (v2 Phase 1 提交,见 git log)
auto_continue: false
stop_reason: completed: DoD PASS（user final acceptance 2026-10-04）
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
| P01-T02 provenance-validator | DONE | provenance.ts 校验器（e32858f） | **G-1** |
| P01.5-T01 research-strategy | DONE | Research 策略 v0.1（15 段 + 守卫矩阵 + _shared 初版，bb4c6a4） | — |
| P01.5-T02 vertical-slice-e2e | DONE | 端到端（AUTO→…→Replace），3276e1e | **G-VS** |
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
| P07-T01 | DONE | 语料固化：14 例 fixtures + schema 校验 + invariant_checks + docs/regression.md（f6f7466） | **G-3** |
| P07-T02 | DONE | regression runner：双通道 + 开销测量 + 报告（cc3aed0） | — |
| P07-T03 | DONE（G-5 裁定） | 首轮真实回归 8 轮 + 13 项纪律修复 + 报告存档（1d3de70）；deterministic 12/14 最佳单跑，残余端侧措辞方差；G-5 = PASS_WITH_KNOWN_HARNESS_FLAKINESS | **G-5** |
| P08-T01 | DONE | 隔离 profile apo-dev 安装 + 冒烟 12 项全过 + S-09 零改动证明（docs/p08-smoke.md） | **G-6** |
| P08-T02 | DONE | 桌面端实测/回归证据：四项真机探针全过（Follow DSH model route=opencode-go + fallback billing safety 双向验证）+ KNOWN_NON_BLOCKING_HARNESS_LIMITATION 记档 + BASELINE 附录 B（e26f960；docs/p08-desktop.md） | — |
| P09-T01 | DONE | 备份演练 + G-7 授权正式安装（备份 ~/.dsh/backups/apo/g7-install-20261004-140136/、bundles=21、未回滚；backup-profile.sh 随 P09-T02 入库 c88e922） | **G-7（已过，2026-10-04）** |
| P09-T02 | DONE | 发布产物 v0.1.0-apo：NOTICE/CHANGELOG/README/DoD 终检 + license 污染检查 + annotated tag（c88e922） | **DoD 终检（已过）** |
| V2-P1 | DONE | v2 升级 Phase 1：分析阶段（意图/目标/分诊/缺失解析）+ 阻塞门（discovery_required，零编译调用）+ KEEP 零改写；385 断言全绿（docs/PLAN-v2-adaptive-editor.md、docs/phase1-report.md） | — |
| V2-P3 | DONE | v2 升级 Phase 3:Requirement Discovery 完整闭环（blocking → 提问 → 回答 → 重新分析 → 台账更新 → 确认 → 首次编译）;取舍型 → USER_REQUIRED+blocking、环境事实不升格、盲授权不产 CONFIRMED、confirm fail-closed;436 断言全绿（docs/phase3-report.md、docs/phase3-prerequisites.md、scripts/phase3-trace.mjs） | — |
| V2-P2 | DONE | v2 升级 Phase 2（用户裁决选项 A）：`informationResponsibilities` + Target-aware Router + Agent/Image/Video 契约（图像视频不再套 Goal/Phase/Task/Tests）+ 未决项五处置（`[待补充:]` 退役）；412 断言全绿（docs/phase2-contract.md、docs/phase2-report.md、docs/phase3-prerequisites.md） | — |

Gates：G-1 契约+Provenance 定稿 → G-VS 真实体验 → G-2 策略抽审 → G-3 语料集（阈值 DEFERRED_TO_P07_CALIBRATION）→ G-4 UI 预览 → G-5 回归报告 → G-6 隔离体验 → G-7 正式安装许可（唯一动正式 profile 的开关）→ **DoD 终检（当前）：用户声明 PASS 即项目完成**（详见 docs/dod.md；AI 不代过）。

## 无人值守运行说明（简版，详见 docs/runner-ops.md）

- Runner 每轮读取本文件：current_task 非空即续跑；为空读 next_task。
- Agent 收尾协议：完成一个 Task → 更新本文件（current_task 置空 → next_task 设为下一 Task；status/stop_reason 相应更新）→ 一个内容提交 + 一个仅状态同步的提交。
- Human Gate（G-1/G-VS/G-2…）命中时：status 置 GATE_PENDING、human_review 置 BLOCKING_<门禁名>，stop_reason 用 "awaiting user confirmation: <门禁名>"，**不要硬做**。
- 无人值守：不会有人回答提问；需要人工裁决时写 stop_reason 后结束本轮。
- 边界（NON-GOAL）：不碰正式 DSH profile / ~/.dsh 正式配置 / PAB / Personal AI Brain / AI 视频工作流；不安装 launchd；不复制任何 AGPL 代码（linshenkx / zhangjiazhi）。
- 本仓库 git remote：upstream = Y1X1n/dsh-prompt-optimizer（只读）；origin 待用户提供自有仓库 URL。
- **项目里程碑**：P00–P09 全部 Task DONE；tag v0.1.0-apo 已建；DoD 机器证据齐备（docs/dod.md），等待用户最终 Human Product Acceptance 声明 PASS。