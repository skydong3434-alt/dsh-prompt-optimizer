# PLAN v2 — 从「模板式 Prompt 扩写器」升级为「意图保真自适应提示词编辑器」

> 状态：**架构基线（已由用户给定，不得重新设计）** + 现状测绘 + 分期实施方案。
> 本文不改动 `docs/PLAN-v1.md`（v0.1.0-apo 已收官证据），是 v2 的新增层。
> 目标读者：实施者（本仓库后续 Phase）与验收者（用户）。

---

## 0. v2 目标流程（用户给定基线，逐字保留）

```
Input
  → Intent & Work-Mode Analysis        （主/辅工作意图 + 工作模式）
  → Prompt Target / Target Engine Analysis （提示词目标 + 目标引擎/模型）
  → Edit Triage                        （KEEP / PATCH / RESTRUCTURE / REBUILD）
  → Missing Resolution                 （UNKNOWN 分类 + 阻塞判定）
  → Requirement Discovery              （仅当有必要；多轮 1–2 问，≤3 轮）
  → Requirement Confirmation           （Discovery 跑过才出现；确认并优化 / 修改理解）
  → Strategy Router / Target-aware Compiler
  → Validator
  → Result
```

**硬约束（跨全部 Phase）**

| # | 约束 |
|---|---|
| C1 | 主流程 UI 移除强制模式选择器（AUTO/Research/Planning/…）：系统自动判断；被移除的选择器降级为「高级覆盖」，不再是必经步骤。 |
| C2 | 工作意图是 **Primary + Supporting**，不是单一标签。 |
| C3 | 新增 **Prompt Target**（Agent Task / Research / Coding / Image / Video / Writing / Data Analysis / General）与 **Target Engine/Model**（DSH、Claude Code、Codex、GPT Image、Midjourney、Flux、SD、即梦、Kling/可灵、Veo、Seedance、Runway…）——**可扩展表驱动，禁止巨型 if/else**。 |
| C4 | **Edit Triage**：KEEP / PATCH / RESTRUCTURE / REBUILD；**KEEP 绝不改写**；只有「输入无法构成有效任务」才 REBUILD。 |
| C5 | **废除固定 `required_sections`**：策略定义的是**信息责任**，不是必备标题。图像/视频提示词**不得**被编译成 Goal/Phase/Task/Tests。 |
| C6 | **Missing Resolution**：每个 UNKNOWN 必须分类为 `USER_REQUIRED \| AGENT_DISCOVERABLE \| OPTIONAL` 且带 `blocking=true/false`；**UNKNOWN ≠ ASK_USER**。 |
| C7 | **Requirement Discovery**：多轮、每轮 1–2 问、最多 3 轮、依赖感知；Question Planner 排序依据 = Solution Impact / User Exclusivity / Blocking / Branch Reduction；停止条件 = **blocking USER_REQUIRED 数 = 0**（决策完备，不是信息完备）。 |
| C8 | **Requirement Ledger**：值 + 来源（`USER_EXPLICIT / CONTEXT_EXPLICIT / OPTIMIZER_SUGGESTED / UNKNOWN`）+ 状态（`CONFIRMED / OPEN / DISCOVERABLE / PROVISIONAL / CONDITIONAL / DEFERRED / REJECTED / NOT_APPLICABLE`）。**来源与状态分离**；"按你的判断继续" 只可产生 PROVISIONAL/CONDITIONAL/DEFERRED，**永不** CONFIRMED/USER_EXPLICIT。 |
| C9 | **Requirement Confirmation**：Discovery 跑过后，编译前给一张简报面板（`确认并优化` / `修改理解`）。 |
| C10 | **Target-aware Strategy Router**：Primary/Supporting + Target + Engine + Modality + Requirement State + Edit Triage 联合路由。 |
| C11 | **Validator 能改变流程**：不是只告警——错误来源可**降级并退回 Missing Resolution**；校验意图保真、来源正确性、伪造 USER_EXPLICIT、静默假设、未决阻塞项、目标正确性、Triage 执行度、模板膨胀、可被 Agent 发现项误标 `[待补充:]`、建议被当需求、模型适配性。 |
| C12 | **状态驱动 UI**：`analyzing / discovery_required / requirement_confirmation / compiling / validating / complete`；**只有 Discovery 能阻断生成**。 |
| C13 | **再优化保留 Ledger**：旧需求分类为 still-valid / conflicting / invalidated。 |
| C14 | 验收用例 A–F：ComfyUI 控制 DSH；已完备 agent prompt → KEEP/PATCH；图像提示词；视频提示词；乱但完整 → RESTRUCTURE；「只检查，不修改文件」必须覆盖自动判定的 Execution。 |
| C15 | 不必要不重写；插件保持可运行、已安装；不动 release/push/tag；不做无关重构；每 Phase 必须有自动化测试；保持 DSH Desktop UI 风格；错误态用户可懂；provenance 不可回退；扩展现有 evaluator/fixtures/golden 而非丢弃。 |

---

## 1. 现状测绘（HEAD `5ddad71`，v0.1.0-apo）

### 1.1 模块地图（12,211 行，`src/**`）

| 层 | 文件 | 行 | 职责 |
|---|---|---|---|
| 契约 | `src/core/types.ts` | 269 | `PromptType`、`ClassifierResult`、`NormalizedContext`、`ProvenanceRecord`、`MissingConstraint`、`CompileResult`、`PromptStrategy`、`ValidationResult`、`OptimizeRequestV2`、`OptimizeMetaEvent` |
| 上下文 | `src/core/context.ts` | 59 | `normalizeInput()` → raw/bounded_turns/workspace_metadata（纯确定性） |
| 分类 | `src/core/classify.ts` | 962 | 七类型单标签分类：`buildClassifierSystem/User`、`parseClassifierResult`、`fallbackClassifierResult`、`manualClassifierResult`、`classifyViaLlm`（调用侧封装：硬参数钳制 / thinkFilter / 超时 / 认证归类） |
| 策略 | `src/core/strategies/*.ts` | 4,366 | 7 个策略（research/planning/execution/diagnostic/review/creative/general），每个含 `required_sections`（8–16 段）、`optional_sections`、preservation/suggestion/guard/provenance 规则、`buildSystem/buildUser`、`outputContract` |
| 注册表 | `src/core/registry.ts` | 123 | `createStrategyRegistry`、`defaultStrategyRegistry`、`isLegacyGeneral`（general 走 legacy `prompt.ts` 路径） |
| 编译器 | `src/core/compiler.ts` | 840 | 10 步编排 `compilePrompt`、四段标记协议（DIAGNOSIS/EXPLICIT/CONTEXT/SUGGESTED/UNKNOWN/OPTIMIZED/END）、`parseCompileOutput`、`finalizeCompile`、`dedupeConstraints`、`injectMissingPlaceholders` |
| 校验器 | `src/core/validate.ts` | 685 | 三层 anti-drift（Preservation / Inference & Suggestion / Unknown）+ 策略守卫汇总 → `provenance_ok` |
| 来源 | `src/core/provenance.ts` | 351 | `normalizeQuoteText`、`resolveQuoteSource`（raw / context-user / assistant-only / none）、`validateProvenance` |
| 宿主 | `src/index.ts` | 814 | Cordis 插件入口：Config、`resolveRoute`、`POST /dsh-prompt-optimizer/optimize`（两阶段：分类 → 流式编译）、SSE `meta/delta/done/error`、`assertTrustedOrigin`、settings 三种 API 分派 |
| 客户端 | `src/client/*` | 1,901 | `controller.ts` 状态机（idle/loading/done/error/cancelled）、`OptimizeButton.tsx`（AUTO▾ 下拉）、`ResultDock.tsx`（四组 provenance）、`SettingsCard.tsx`、`i18n.ts` |
| legacy | `src/prompt.ts` | 422 | Y1X1n 原优化器核心（general legacy 路径仍在用） |

### 1.2 现状数据流

```
[输入框草稿]
   │ OptimizeButton → controller.optimize()
   ▼
POST /dsh-prompt-optimizer/optimize { text, context, previous, promptType?, provider?, model? }
   │
   ├─ resolveRoute(cfg.model → body.provider/model → DSH 会话默认) + fallbackModel 链 + classifierModel
   ├─ normalizeInput → raw_input / bounded_turns / workspace_metadata
   ├─ manualType?  ── 有 ──▶ 跳过分类（函数级旁路）
   │                 └─ 无 ──▶ classifyViaLlm()  ← 【LLM 调用 ①】七类型单标签 JSON
   ├─ compilePrompt() → registry.get(type) → buildSystem/buildUser（含 required_sections 清单、缺口注入）
   ├─ send({type:'meta', prompt_type, confidence_level, missing_constraints, rationale, provenance_ok:true})
   ├─ llm.stream() ← 【LLM 调用 ②】流式四段协议输出 → send({type:'delta'}) × N
   ├─ finalizeCompile() → parseCompileOutput + 约束去重 + [待补充:] 注入
   ├─ validateCompileResult()（非 legacy）→ 三层 + 策略守卫 → provenance_ok
   └─ send({type:'done', analysis, optimized, explicit/context/suggested/unknowns, missing_constraints, …})
   ▼
controller：meta→阶段文案；delta→实时预览；done→ResultDock（四组 provenance + 缺口 + 低置信黄条）
```

### 1.3 现状与新设计的差距（Gap）

| # | v2 要求 | 现状 | 差距性质 |
|---|---|---|---|
| G1 | 主/辅意图（Principal + Supporting） | `ClassifierResult.prompt_type` 单一标签；多意图只有一句 `MULTI_INTENT_NOTE` 注释 | **契约缺口** |
| G2 | Prompt Target + Target Engine 维度 | 完全不存在 | **新维度** |
| G3 | Edit Triage（KEEP/PATCH/RESTRUCTURE/REBUILD） | 不存在；任何输入都走「完整重写」路径 | **新阶段 + 破坏性行为缺口** |
| G4 | Missing Resolution（UNKNOWN 三分类 + blocking） | `missing_constraints: string[]` 平铺「缺口」；`unknowns` 只是 provenance 一组；无 blocking 概念 | **契约缺口** |
| G5 | 阻塞即不生成（Discovery 门） | 无条件进入编译；缺口一律注入 `[待补充:]` 后照常产出 | **流程缺口（Phase 1 必须解决）** |
| G6 | 策略定义「信息责任」而非 `required_sections` | 每个策略 `required_sections` 8–16 段，编译器按段组织输出；图像/视频会被套成 Goal/Phase/Task/Tests | **语义缺口（Phase 2）** |
| G7 | Requirement Ledger（值 + 来源 + 状态，来源/状态分离） | provenance 只有来源，没有状态；`provenance_ok` 是唯一质量信号 | **契约缺口** |
| G8 | Requirement Discovery 多轮问答 + Question Planner + 停止条件 | 完全不存在（「提问」不是本插件行为） | **新阶段（Phase 3）** |
| G9 | Requirement Confirmation 简报面板 | 不存在 | **新 UI（Phase 3）** |
| G10 | Target-aware Strategy Router | `registry.get(type)` 单键路由 | **路由缺口（Phase 2）** |
| G11 | Validator 可改变流程（退回 Missing Resolution） | `validateCompileResult` 只产出 `provenance_ok` + problems，不改变流程 | **控制流缺口（Phase 3）** |
| G12 | 状态驱动 UI（6 态） | `idle/loading/done/error/cancelled` + 提前下发的 `meta` 切文案 | **UI 缺口（Phase 4）** |
| G13 | 移除强制模式选择器 | `OptimizeButton` 的 AUTO▾ 下拉是主入口控件 | **UI 缺口（Phase 4）** |
| G14 | 再优化保留 Ledger，旧需求三分类 | `previous` 只做 1500 字文本截断再喂给编译器 | **契约缺口（Phase 3）** |

### 1.4 可直接复用（不重写）

1. **Provenance 引擎**（`provenance.ts`）：`normalizeQuoteText` / `resolveQuoteSource`（raw / context-user / assistant-only / none）是 v2 Requirement Ledger「来源」列的全部机械基础。
2. **三层校验器 + 策略守卫工厂**（`validate.ts` + `_shared.ts` 的 invariant A/B）：扩为 v2 Validator 的骨架。
3. **7 策略的规则内容**（preservation/suggestion/guard/provenance 文案）：降级为「信息责任来源」后仍全部有用，不丢弃。
4. **分类 JSON 契约容错层**（`parseClassifierResult` 的补默认 / 未知类型 / 证据丢弃 / multiIntent 元信息）：Analysis 解析直接沿用这套容错哲学。
5. **`classifyViaLlm` 的调用机制**（硬参数钳制 / thinkFilter / 超时 / 认证归类 / 取消语义 / 请求快照）：Analysis 调用**共用同一机制**（抽成通用 runner，行为零变更）。
6. **宿主两阶段管线 + SSE + fallback 路由链 + settings 三 API 分派**：全部保留，只**插入**分析阶段与门。
7. **ResultDock 四组 provenance 渲染** + 低置信黄条 + 缺口清单：v2 继续用，追加 Ledger 分组。
8. **14 fixture 语料 + 双通道 regression runner + 22 个单测套件**：扩展而非替换。
9. **launchd Runner 基础设施**（本轮不启用）。

### 1.5 需要重构（最小必要）

| 目标 | 做法 | 风险控制 |
|---|---|---|
| 单标签 `PromptType` → 主/辅意图 | **加法**：新增 `primary_intent` / `supporting_intents`；`prompt_type` 保留为 `primary_intent` 的投影 | 旧字段语义不变；旧消费方零改动 |
| `required_sections` → 信息责任 | **Phase 2**：把 `required_sections` 降级为「责任清单」（不再作为输出段落断言锚点），新增 `informationResponsibilities` | 旧硬断言测试改判据；general legacy 路径不动 |
| 编译输出被套模板 | **Phase 2**：`target.modality` 为 image/video 时走非结构化「描述式」编译契约 | 用 acceptance case C/D 做回归 |
| Validator 只读 | **Phase 3**：返回 `ValidationOutcome { action: 'accept' \| 'return_to_missing_resolution', … }` | 保留 `provenance_ok` 兼容字段 |
| mode 选择器 | **Phase 4**：降级为「高级覆盖」，默认自动 | 保留 override 请求体字段 |

---

## 2. 分期实施方案

### Phase 1 — 分析阶段 + 阻塞门（本次实施）
**范围**：Intent & Work-Mode Analysis（主/辅）、Prompt Target / Target Engine、Edit Triage、Missing Resolution（UNKNOWN 三分类 + blocking）、**阻塞即不生成**。
**不含**：多轮 Discovery 问答、Confirmation 面板、Ledger 状态机全量、策略/路由重构、UI 状态机重做。

交付物：
1. `src/core/types.ts` 加法契约（`WorkIntent`、`PromptTarget`、`TargetEngine`、`EditTriage`、`RequirementClass`、`MissingResolution`、`AnalysisResult`、`RequirementLedgerEntry`，以及 `CompileResult` / SSE 事件加法字段）。
2. `src/core/targets.ts`：目标/引擎**表驱动**目录（`TARGET_CATALOG` / `ENGINE_CATALOG` / `MODALITY_BY_TARGET` / 引擎→目标适配表），零 if/else 链。
3. `src/core/triage.ts`：`decideTriage()` 确定性判据（KEEP/PATCH/RESTRUCTURE/REBUILD）+ 与 LLM 建议的合并规则（KEEP 优先级最高）。
4. `src/core/requirements.ts`：`classifyUnknown()`（USER_REQUIRED / AGENT_DISCOVERABLE / OPTIONAL + blocking）、`computeAnalysisGate()`（blocking USER_REQUIRED 计数）、`toLedger()`（来源/状态分离）。
5. `src/core/analyze.ts`：Analysis JSON 契约 + `buildAnalysisSystem/User` + `parseAnalysisResult`（**容忍旧 classifier 形状**并确定性派生新字段）+ `fallbackAnalysisResult` + `manualAnalysisResult` + `analyzeViaLlm`。**Analysis 取代分类，仍只发一次 LLM 小调用**。
6. `src/core/classify.ts`：抽出通用 `runJsonCallViaLlm`（行为逐字不变），`classifyViaLlm` 改为其薄封装。
7. `src/index.ts`：插入分析阶段；`gate.blocked === true` 时下发 `{type:'discovery_required'}`，**不进入编译**、不消耗编译 token。
8. `src/client/*`：控制器识别 `discovery_required` 与新字段；ResultDock 展示目标/引擎/Triage（Phase 1 只读展示）。
9. 测试：`test/analyze.test.mjs`、`test/targets.test.mjs`、`test/triage.test.mjs`、`test/requirements.test.mjs`、`test/phase1-gate.test.mjs`；全部并入 `npm test`。

### Phase 2 — 策略 = 信息责任 + Target-aware 路由
- `PromptStrategy` 增 `informationResponsibilities`；`required_sections` 降级为 legacy 兼容字段（不再作为输出断言锚点）。
- 图像/视频：`modality` 判定后走「描述式编译契约」（不再产出 Goal/Phase/Task/Tests）。
- Target-aware Strategy Router：`route(primary, supporting[], target, engine, modality, requirementState, triage)`。
- 验收用例 C（图像）/ D（视频）/ E（乱但完整 → RESTRUCTURE）。

### Phase 3 — Discovery + Ledger + Confirmation + Validator 回流

> **准入清单见 [phase3-prerequisites.md](./phase3-prerequisites.md)**（含用户指定的必做项：取舍型 / 产品决策不得被降级为「Agent 可调查项」）。
- Ledger 全状态机 + 再优化保留（still-valid / conflicting / invalidated）。
- Question Planner（1–2 问/轮、≤3 轮、依赖感知、四维排序）+ `blocking USER_REQUIRED = 0` 停止条件。
- Requirement Confirmation 面板（`确认并优化` / `修改理解`）。
- Validator 返回流程动作（`return_to_missing_resolution`），补齐 C11 全部校验项。
- 验收用例 A（ComfyUI 控制 DSH）/ B（完备 prompt → KEEP/PATCH）/ F（「只检查，不修改文件」压制自动 Execution）。

### Phase 4 — 状态驱动 UI + 选择器降级
- 六态 UI（analyzing / discovery_required / requirement_confirmation / compiling / validating / complete）。
- AUTO▾ 降级为「高级覆盖」（默认自动）。
- 保持 DSH Desktop 视觉风格；错误态用户可懂。

---

## 3. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 分析阶段额外 LLM 调用拖慢每次点击 | 体验倒退 | **不新增调用**：Analysis 取代原分类调用（同为 1 次小调用，`maxTokens` 512→1024） |
| 新 JSON 契约让模型输出不稳 | 解析退化 | `parseAnalysisResult` 容忍旧形状并确定性派生；失败→保守兜底（general + Triage=PATCH，绝不 KEEP 误判为改写） |
| 阻塞门误判（把可发现的当阻塞） | 用户被无谓追问 / 无法产出 | 判据表驱动 + **默认保守**：拿不准 → `AGENT_DISCOVERABLE`、`blocking=false`（宁可生成后标注，不可无谓阻断） |
| KEEP 被错误执行成改写 | 违反 C4，破坏用户已有 prompt | `decideTriage()` 中 KEEP 优先级最高；KEEP 路径**跳过编译 LLM 调用**，原样返回 + 校验「输出 === 输入」 |
| 破坏已安装的 desktop 插件 | 用户无法使用 | 每 Phase 结束 `npm test` + `npm run build` 全绿；`lib/` 是 desktop 实际入口；任一门未过不提交 |
| 与 P07 regression 语料冲突 | 回归证据失效 | 不动 `test/regression/**` 与 `classifyViaLlm` 语义；新增套件独立 |
| 「静默假设」通过 | provenance 回退 | Phase 1 即让 Analysis 的 UNKNOWN 全部落 Ledger；`[待补充:]` 只允许源自 `USER_REQUIRED && blocking`；`AGENT_DISCOVERABLE` 一律标注「由执行方自行确认」而非 `[待补充:]`（C11） |

**测试计划（Phase 1）**
- 契约/目录：`targets.test.mjs`（目标↔模态↔引擎映射完整、无重复、可扩展追加）
- 判据：`triage.test.mjs`（KEEP 不改写；完备 agent prompt → KEEP/PATCH；乱但完整 → RESTRUCTURE；空白/不可构成任务 → REBUILD）
- 三分类：`requirements.test.mjs`（UNKNOWN≠ASK_USER；缺可发现项不产生阻塞；缺用户专属决策才阻塞；再优化 Ledger 保留）
- 解析容错：`analyze.test.mjs`（新契约解析 / 旧 classifier JSON 派生 / 证据伪造丢弃 / 失败兜底 / 取消与超时语义）
- 端到端门：`phase1-gate.test.mjs`（mock LLM：blocking>0 → 只发 `discovery_required`，**无 delta、无编译调用**；blocking=0 → 正常 meta→delta→done，且 meta 携带 target/triage/ledger）
- 既有 22 套件必须保持全绿（零回归）。

**验收标准（Phase 1）**
1. `npm test` 全绿（含新增 5 套件）。
2. `npm run build` 成功，`lib/` 可被 desktop 继续加载。
3. blocking USER_REQUIRED > 0 时**不产生任何编译输出**（机械可验证：mock LLM 的编译调用次数 = 0）。
4. Analysis 只发 1 次 LLM 小调用（不新增调用次数）。
5. 图像/视频目标可被识别并进入 `modality=image|video`（Phase 2 才改编译契约，Phase 1 只如实标注）。
6. Ledger 条目来源/状态分离，且 "按你的判断继续" 不可能产出 `CONFIRMED`/`USER_EXPLICIT`。

---

## 4. 新旧模块映射

| 新 | 旧 | 关系 |
|---|---|---|
| `core/analyze.ts` | `core/classify.ts` | **并存**：Analysis 是分类的超集；classify 供 regression/单测继续使用 |
| `core/targets.ts` | — | 新增 |
| `core/triage.ts` | — | 新增 |
| `core/requirements.ts` | `core/provenance.ts`（部分） | 新增；来源列复用 provenance 机械比对 |
| `core/router.ts`（P2） | `core/registry.ts` | 扩展为多维路由，registry 保留为策略表 |
| `core/validate.ts` | 同名 | 扩展动作输出，保留 `provenance_ok` |
| `client/controller.ts` | 同名 | 状态机扩展 6 态，旧态保留兼容 |
