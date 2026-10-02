# ADAPTIVE PROMPT OPTIMIZER — DEVELOPMENT EXECUTION PLAN v1.1（修订版）

修订日期：2026-10-03 ｜ 用户已确认总体规划并批准进入 G-0 → P00。
v1.1 仅修订三处；未修订部分以 v1（PLAN-v1.md）为准。

## 修订 R-1（G-0 正式确认）
- 项目名：`dsh-adaptive-prompt-optimizer`
- 本地开发目录：`~/Projects/dsh-adaptive-prompt-optimizer/`
- Git：`origin` = 自有正式仓库；`upstream` = `https://github.com/Y1X1n/dsh-prompt-optimizer.git`（只读）
- 保留原 MIT LICENSE 与 attribution（上游署名 + Jerry(@ruijiaang-lab) 致谢）

## 修订 R-2（G-3 状态：DEFERRED_TO_P07_CALIBRATION）
- **P07 之前**：deterministic invariants 是唯一硬 Gate；model-assisted evaluator 仅提供辅助评价；
- evaluator **不得**覆盖 deterministic FAIL；不使用未经校准的固定阈值（如 0.8 / 80 分）作为发布标准；
- P07 用真实历史 Prompt corpus 跑出数据后，按**人工标注结果**校准 model-assisted threshold（此时才启用 G-3 阈值确认）。

## 修订 R-3（执行顺序：插入 Early Vertical Slice）
新阶段 **P01.5 — Research Vertical Slice**（位于 P01 之后、P02 全策略扩展之前）：

```
P00 Fork & Baseline
 ← P01 Core Contracts & Provenance
 ← P01.5 Early Vertical Slice（RESEARCH 单路径端到端，真实案例验收）
     · 范围：AUTO classifier → Research strategy → Compiler → Provenance →
            Host(SSE) → ResultDock → Replace Input（含 manual 覆盖骨架）
     · 第一条验收用例（真实案例）：
       "帮我研究 Mac M1 Pro 32GB 怎么使用 ComfyUI 做 AI 视频，我看到黑鹤001低显流，还有 H3……"
     · 验收线：正确识别 Research；不把 H3 写成已确认路线；不把"没找到 Mac 案例"写成"方案不可行"；
              能区分 USER_EXPLICIT / CONTEXT_EXPLICIT / OPTIMIZER_SUGGESTED / UNKNOWN；
              输出可直接交给 Research Agent 的完整 Prompt；ResultDock 可检查并替换输入框。
 ← G-VS（Human UX Gate：用户真实体验验收；通过后）
 ← P02 全策略扩展（Planning/Execution/Diagnostic/Review/Creative/General + Registry 完整化）
 ← 之后按 v1 的 P03→P09 继续（G-1 ~ G-7 原序；G-3 按 R-2 延后执行）
```

### P01.5 任务契约（New Tasks）

**P01.5-T01 Research 策略单片（research.ts 初版）**
- Goal：满足 Vertical Slice 验收线的 Research PromptStrategy v0.1。
- Allowed Scope：src/core/strategies/research.ts + _shared 初版 + test/strategies-research.test.mjs。
- Forbidden Scope：其余策略；UI；Host 既有路径。
- Executor：Claude Code（实现）+ DSH（验收）。
- Exact Steps：按 §7 research sections 初版实现（15 段 + 铁律：Evidence before conclusion / 没有案例≠不可行 / CUDA-only 类引导替代路径）；写 required_sections 锚点测试与"不得把候选写成已确认路线 / 不得发明预算时间平台模型"守卫用例。
- Tests：sections 齐全；prohibited 用例（H3 案例线 / 黑鹤001 案例线）触发守卫。
- Acceptance：单测全绿；真实案例草案编译输出抽查（DSH 用 mock llm 跑一次）。
- Next Transition：P01.5-T02。

**P01.5-T02 Vertical Slice 端到端打通（classifier→registry→compiler→validate→host→UI 最小路径）**
- Goal：AUTO 输入真实案例 → ResultDock 展示四组 provenance + 优化稿 → 替换输入框，全链路可跑。
- Allowed Scope：src/core/（classify/registry/compiler/context/validate 最小可用版）+ src/index.ts handler 两阶段编排（仅 Research 路径可用即验收）+ client（AUTO 下拉、ResultDock 四组渲染、replace）。
- Forbidden Scope：其余 6 策略；完整 settings 扩展；任何自动动作（自动发送/拦截）。
- Executor：Claude Code（实现）+ DSH（集成与回归）。
- Exact Steps：core 最小管线 → handler 编排 + SSE meta → UI 四组 + dropdown → mock llm 冒烟 → 真实 DSH 隔离 profile 手测（P08 前仅 dev profile）。
- Tests：smoke 扩展 meta 事件序；真实案例断言（H3 不确认 / 黑鹤001 不淘汰 / 四组来源区分 / [待补充:] 存在）。
- Acceptance：全部验收线绿 + G-VS 通过。
- Failure Handling：任一验收线失败 → 逐条回修（不绕过）；效果不符合需求 → STOP 报告（S-06/S-08 精神）。
- Stop Conditions：S-01/S-06/S-07/S-08 相关条款。

**G-VS（Human UX Gate，新增）**
- 时机：P01.5 完成后。
- 内容：用户在真实 DSH 中用该真实案例走完"输入→优化→检查→替换"，认可：类型正确、未曲解意图、四组来源可审计、输出直接可用；并抽测 Manual Override。
- 通过后：进入 P02 全策略扩展。

## 执行模式（用户已授权）
- P00 完成后按 Task Contract 自动推进；遇到既有 Human Gate（G-1..G-7、G-VS）或 Stop Condition 才停止询问。
- 普通开发 Task 完成不单独打断用户；阶段出口以 Gate 为准。

## 工作量影响
- Vertical Slice ≈ +2 人日（research 策略 0.5 + 最小管线/UI 1.5），且 P02-P04 中 research/general/registry/UI 部分与之重叠，净增 ≈ +1.5 人日。
- 总估算更新：≈ 19 → **≈ 20.5 人日**（含 v1.1 调整；P07 阈值校准另计）。
