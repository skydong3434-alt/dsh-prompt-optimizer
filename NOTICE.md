# NOTICE — dsh-adaptive-prompt-optimizer

版本：v0.1.0-apo（2026-10-04）

本项目是 [@y1x1n/dsh-prompt-optimizer](https://github.com/Y1X1n/dsh-prompt-optimizer)
的派生增强（DSH Adaptive Prompt Optimizer，MIT）。本文件按 PLAN-v1 §3/§16 记录
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
| [WestFox/dsh-prompt-optimizer](https://github.com/WestFox/dsh-prompt-optimizer) | BSD-3 | quote 字面比对、来源身份分段、输出守卫思想 | `src/core/provenance.ts`（quote 机械比对）、`src/core/validate.ts`（三层守卫） |
| [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer) | **AGPL-3.0** | 仅思想：模板数据模型（id/type/version）、注册表索引、版本化 | `src/core/types.ts`（PromptStrategy 契约）、`src/core/registry.ts`（注册表/版本暴露） |
| [zhangjiazhi/dsh-prompt-optimizer](https://github.com/zhangjiazhi/dsh-prompt-optimizer) | **AGPL-3.0** | 仅思想：策略文件独立可 diff 可审阅、守卫分层、回归纪律 | `src/core/strategies/*.ts`（每策略独立文件+版本）、`test/regression/`（deterministic 层） |
| Co1ombiagly Prompt Optimize spec | MIT（仅思想文） | general 策略八板块结构 | `src/core/strategies/general.ts` |

> **零复制声明**：linshenkx / zhangjiazhi 两个 **AGPL** 仓库仅用于阅读思想
> （数据模型形态、守卫分层、模板资产化思路），**未复制任何一行源码 / 模板文本 /
> 测试 / 提示词文案**。发布前以 `scripts/check-license-contamination.mjs` 扫描
> AGPL 仓库特征串（指纹 15 项，扫描 src/test/scripts 代码区），结果为 **PASS**。

## 3. 发布版本与仓库

- 发布版本：`v0.1.0-apo`（annotated tag；本 fork 的首个可发布版本）
- 包名：沿用派生包 `@y1x1n/dsh-prompt-optimizer`（`package.json name`，上游同名，
  便于既有安装链路无缝替换；如需更名按新契约流程另行决定）
- upstream（Y1X1n）：只读，不 push；origin（自有仓库）待用户提供 URL 后关联。

## 4. 运行边界（NON-GOAL 重申）

本插件只做「输入编译 + 结果展示 + 用户手动替换」，**不做**任何自动执行 /
自动发送 / 自动决策 / PAB 写入 / 下游任务编排（PLAN-v1 §1）。

## 5. 依赖 License 一览

- `@deepseek-ai/schemastery`：MIT（上游声明）
- 构建 / 类型 / 测试类 devDependencies（esbuild / typescript / react /
  @deepseek-ai/cordis / @deepseek-ai/dsh-llm 等）：按各自上游 License 使用，
  均为工程依赖，不进入插件产物（产物仅 lib/ 与 client bundle）。