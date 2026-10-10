# 文档索引

> 当前有效版本:**v0.3.2-apo · V3 单次调用架构**(2026-10-10)。本文回答一个问题:**哪份文档还能照着做。**
> 判断依据只有一条:**文中描述的模块 / 命令 / 测试在当前代码里是否还存在。**

## 当前有效(可以照着做)

| 文档 | 作用 |
| --- | --- |
| [`../CURRENT_STATE.md`](../CURRENT_STATE.md) | **入口**:当前阶段、机器门禁、模型路由、已知问题 |
| [`../README.md`](../README.md) / [`../README.en.md`](../README.en.md) / [`../README.simple.md`](../README.simple.md) | 面向用户:怎么用、会做什么、不会做什么 |
| [`release-notes-v0.3.2-apo.md`](release-notes-v0.3.2-apo.md) | **当前版本**的发布说明(做了什么 / 怎么用 / 迁移 / 门禁 / 已知限制) |
| [`release-notes-v0.3.1-apo.md`](release-notes-v0.3.1-apo.md) | 上一版(v0.3.1-apo)—— 设置卡槽位注册修复 + 安装/溯源说明 |
| [`release-notes-v0.3.0-apo.md`](release-notes-v0.3.0-apo.md) | 更早(v0.3.0-apo)—— V3 单次调用架构首发 |
| [`ui-acceptance-m03813.md`](ui-acceptance-m03813.md) | 35 项真实 UI 人工测试台账 + 根因 + 逐字前后对比 + 最终人工门禁(5/5 PASS) |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 版本变更(`v0.3.2-apo` 段含独立插件身份迁移与安装/文档统一;`v0.3.1-apo` 段含设置卡槽位注册修复;`v0.3.0-apo` 段含 V3 精简重构与真实 UI 验收修复) |
| [`../NOTICE.md`](../NOTICE.md) | 版本标识与来源说明 |
| [`../AGENTS.md`](../AGENTS.md) | 仓库协作约束(给 Agent 看) |
| [`dod.md`](dod.md) | DoD 机器子集终检清单(`node scripts/check-dod.mjs` 对应) |
| [`../BASELINE.md`](../BASELINE.md) | 上游基线记录 |
| [`promotion/`](promotion/) | 推广材料(演示文稿与渲染脚本) |

代码结构(只有三个核心文件):

```
src/index.ts          Host 半:HTTP 路由 + 一次模型调用 + 事件流
src/core/v3.ts        提示词规则 / 协议解析 / 机械用途兜底 / 忠实优化模式
src/core/triage.ts    编辑分诊(机械层,给结果面板用)
src/core/types.ts     共享类型
src/client/           客户端半:输入区、结果面板、设置页
```

## 历史文档(已过时,仅作记录)

这些文档描述的是 **V3 之前的旧多阶段架构**(意图分析 → 编辑分诊 → 需求发现 → 编译器 → 校验器 → 策略路由),
相关代码已在提交 `435b643` 删除。**其中的模块名、文件路径、测试名、npm 命令均已失效**,不要照着做。
每份文档顶部都带有「已过时」标记。

- 计划:`PLAN-v1.md`、`PLAN-v1.1.md`、`PLAN-v2-adaptive-editor.md`
- 阶段报告:`phase1-report.md`、`phase2-contract.md`、`phase2-report.md`、`phase3-prerequisites.md`、`phase3-report.md`、`phase4-report.md`
- 专题:`classifier.md`、`provenance.md`、`regression.md`、`gvs-result.md`
- 验证报告:`rc-report.md`、`rc2-report.md`、`p08-desktop.md`、`p08-smoke.md`
- 运行器:`RUNNER-READY.md`、`runner-ops.md`
- 历史发布材料:`release-notes-v0.2.0-apo.md`、`release-smoke-v0.2.0-apo.md`、`release-v0.3.17.md`
- 迁移档案:[`v3-test-migration.md`](v3-test-migration.md)(记录旧测试如何分类处置,**当前仍准确**,但不是使用文档)
- [`../tasks/`](../tasks/) 下的 P0x 任务卡:旧阶段计划的工作项,**已过时**(见 [`../tasks/README.md`](../tasks/README.md))

## 为什么保留而不是删除

历史文档记录了「为什么当时那么做」以及「哪些做法被真实失败推翻」。删掉它们会让同一个坑再踩一次;
但让它们和当前文档混在一起,会让读者照着已删除的模块名去改代码。所以:**保留 + 标记 + 集中索引。**
