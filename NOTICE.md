# NOTICE — dsh-adaptive-prompt-optimizer

版本：v0.3.2-apo（2026-10-10）

本项目是 [@y1x1n/dsh-prompt-optimizer](https://github.com/Y1X1n/dsh-prompt-optimizer)
的派生增强（DSH Adaptive Prompt Optimizer，MIT），自 `v0.3.2-apo` 起以**独立包名**
`@skydong3434-alt/dsh-prompt-optimizer` 发布。本文件按 PLAN-v1 §3/§16 记录
**设计来源与 License 边界**，保证 License 清洁（DoD 第 9 项）。

## 1. 派生与署名（MIT 保留）

- **上游**：[Y1X1n/dsh-prompt-optimizer](https://github.com/Y1X1n/dsh-prompt-optimizer) —
  **MIT License**，是本插件的代码底座（Host 路由 / SSE / CSRF / settings /
  client UI / 构建与测试骨架）。全部上游代码保留原 MIT LICENSE 与署名，
  本仓库 LICENSE 文件即为原样保留。
- **贡献者致谢**：[@ruijiaang-lab (Jerry)](https://github.com/ruijiaang-lab) —
  上游贡献指南（上游 PR #2）；随上游一并致谢。
- 基线：上游 v0.4.0（commit daf6fbd 附近），fork-point 标签 `base-y1x1n-v0.4.0`。

## 2. 设计来源（借鉴思想，独立实现）

| 来源 | License | 借鉴内容 | 落地位置（本项目独立实现） |
|---|---|---|---|
| [WestFox/dsh-prompt-optimizer](https://github.com/WestFox/dsh-prompt-optimizer) | BSD-3 | quote 字面比对、来源身份分段、输出守卫思想 | `src/core/v3.ts`（`assessV3Safety`：交付前硬性约束机械核对 —— 输出守卫思想的现役实现）。原 `src/core/provenance.ts` / `src/core/validate.ts` 已随 V3 精简重构删除 |
| [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer) | **AGPL-3.0** | 仅思想：模板数据模型（id/type/version）、注册表索引、版本化 | 现役代码中**已无**模板 / 注册表机制（V3 单次调用架构不使用模板注册表；原 `src/core/registry.ts` 已删除）。`src/core/types.ts` 现仅保留 V3 共享契约类型 |
| [zhangjiazhi/dsh-prompt-optimizer](https://github.com/zhangjiazhi/dsh-prompt-optimizer) | **AGPL-3.0** | 仅思想：策略文件独立可 diff 可审阅、守卫分层、回归纪律 | 策略文件与 deterministic 回归目录已随 V3 删除（原 `src/core/strategies/*.ts`、`test/regression/`）；现役保留的是「回归纪律」本身 —— `npm test` 的确定性回归套件 |
| Co1ombiagly Prompt Optimize spec | MIT（仅思想文） | general 策略八板块结构 | 已随 V3 删除（原 `src/core/strategies/general.ts`）；现役 V3 不再使用八板块任务模板 |

> **落地位置列的读法**：V3 精简重构（单次调用架构）删除了 v2 的多阶段模块，因此上表
> 同时标注**现役实现**与**已删除位置**，以免溯源记录与仓库实际内容不符。被删除的模块
> 只影响「这些思想当时落在哪里」的记述，不影响本节的零复制声明与 License 边界。

> **零复制声明**：linshenkx / zhangjiazhi 两个 **AGPL** 仓库仅用于阅读思想
> （数据模型形态、守卫分层、模板资产化思路），**未复制任何一行源码 / 模板文本 /
> 测试 / 提示词文案**。发布前以 `scripts/check-license-contamination.mjs` 扫描
> AGPL 仓库特征串（指纹 15 项，扫描 src/test/scripts 代码区），结果为 **PASS**。

## 3. 发布版本与仓库

- 发布版本：`v0.3.2-apo`（当前；独立插件身份迁移 + 安装/文档统一）· 上一版 `v0.3.1-apo`（V3 单次调用自适应优化器 + 设置卡槽位注册修复）· `v0.3.0-apo`（V3 单次调用架构首发）· 首个可发布版本 `v0.1.0-apo`
- `v0.2.0-apo`（v2 自适应编辑器）：其多阶段架构已由 V3 整体替换，**从未打 tag / 从未发布**，仅保留为历史记录
- 包名：**独立包名** `@skydong3434-alt/dsh-prompt-optimizer`（`package.json name`，自 `v0.3.2-apo` 起；
  此前沿用上游同名派生包 `@y1x1n/dsh-prompt-optimizer` 以便旧安装链路无缝替换）
- 版本号：`package.json version` 自 `v0.3.2-apo` 起与 fork 发行线对齐（`0.3.2`），
  不再沿用上游 `0.4.0`（避免与 GitHub Release 的 `-apo` 版本号混淆；上游基线版本号见 §1）
- upstream（`Y1X1n/dsh-prompt-optimizer`）：**只读，不 push**（保留为上游参照与署名来源）
- origin（自有仓库）：`https://github.com/skydong3434-alt/dsh-prompt-optimizer`（Public；本 fork 的发布目标）

## 4. 运行边界（NON-GOAL 重申）

本插件只做「输入编译 + 结果展示 + 用户手动替换」，**不做**任何自动执行 /
自动发送 / 自动决策 / PAB 写入 / 下游任务编排（PLAN-v1 §1）。

## 5. 依赖 License 一览

- `@deepseek-ai/schemastery`：MIT（上游声明）
- 构建 / 类型 / 测试类 devDependencies（esbuild / typescript / react /
  @deepseek-ai/cordis / @deepseek-ai/dsh-llm 等）：按各自上游 License 使用，
  均为工程依赖，不进入插件产物（产物仅 lib/ 与 client bundle）。
