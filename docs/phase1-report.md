# Phase 1 实施报告 —— 分析阶段 + 阻塞门（v2 升级第一段）

> 对应 `docs/PLAN-v2-adaptive-editor.md` §2「Phase 1」。
> 本报告是**实施记录**（做了什么 / 为什么 / 改了哪些模块 / 测试与验收证据 / 下一步），
> 不是新的设计基线；设计基线仍以 `PLAN-v2-adaptive-editor.md` §0 为准。

---

## 1. 本阶段做了什么（范围）

主流程前四步落地 + 一个门：

| 步 | 能力 | 落地位置 |
|---|---|---|
| 1 | **Intent & Work-Mode Analysis**（主意图 + 辅意图 + 工作模式） | `src/core/analyze.ts`（契约 / 解析）、`src/core/types.ts`（`IntentProfile`） |
| 2 | **Prompt Target / Target Engine**（8 目标 + 表驱动引擎目录） | `src/core/targets.ts` |
| 3 | **Edit Triage**（KEEP / PATCH / RESTRUCTURE / REBUILD） | `src/core/triage.ts` |
| 4 | **Missing Resolution**（UNKNOWN 三分类 + blocking） | `src/core/requirements.ts` |
| 门 | **阻塞即不生成**（唯一允许阻断的出口） | `src/index.ts`（`discovery_required` 分支） |
| — | 台账（来源 / 状态分离） | `src/core/requirements.ts` + `types.ts`（`RequirementLedgerEntry`） |
| — | 一次小调用取代旧分类调用 | `src/core/classify.ts`（抽出通用 `runJsonCallViaLlm`） |

**刻意不含**（留给后续 Phase，避免一次性大改）：多轮 Discovery 问答、Requirement
Confirmation 面板、`required_sections` 语义改造、Target-aware 路由、Validator
回流、六态 UI 与选择器降级。

## 2. 为什么这样做

1. **不新增 LLM 调用**：旧流程「分类 1 次 + 编译 1 次」；新流程「分析 1 次 + 编译 1 次」。
   分析是分类的**超集**（主/辅意图取代单标签），因此把分类的调用机制抽成通用 runner
   复用，`classifyViaLlm` 保留为薄封装 —— 回归语料与 22 个既有套件零改动。
2. **向后兼容不靠约定靠解析**：`parseAnalysisResult` 容忍旧 `ClassifierResult` JSON
   并确定性派生新字段，因此旧 model 输出 / 旧 mock / 旧回归语料全部继续可用。
3. **保守优先**：拿不准的未决项一律判 `AGENT_DISCOVERABLE`（不打扰用户）；
   兜底路径**绝不制造阻塞**；KEEP 需机械判据与模型**双方一致**才成立。
4. **provenance 不回退**：`sanitizeLedger` 对伪造的用户来源做机械降级；
   `findLedgerViolations` 提供不变量自检。

## 3. 改动清单

### 新增
| 文件 | 内容 |
|---|---|
| `src/core/targets.ts` | `TARGET_CATALOG` / `ENGINE_CATALOG`（表驱动）/ `findEngine`（最长别名优先 + 短 ASCII 别名词边界）/ `resolveTargetDeterministic` / `resolveEngine` |
| `src/core/triage.ts` | `analyzeInputSignals` / `mechanicalTriage` / `mergeTriage` / `decideTriage`（KEEP 双方一致；REBUILD 需机械同意；`repeatedClauses` 识别长段落复读） |
| `src/core/requirements.ts` | `mechanicalRequirementClass` / `classifyUnknown(s)` / `computeAnalysisGate` / `buildLedger` / `sanitizeLedger` / `hasBlindTrust` / `applyBlindTrust` / `findLedgerViolations` |
| `src/core/analyze.ts` | 分析 JSON 契约（中英）/ `parseAnalysisResult` / `fallbackAnalysisResult` / `manualAnalysisResult` / `analyzeViaLlm` / `analysisToClassifier` / `isMetaAnalysisCall` / `ANALYSIS_MAX_TOKENS=1024` |
| `test/targets.test.mjs` `test/triage.test.mjs` `test/requirements.test.mjs` `test/analyze.test.mjs` `test/phase1-gate.test.mjs` | 5 个新套件（详见 §4） |
| `docs/PLAN-v2-adaptive-editor.md` | 架构升级基线 + 现状测绘 + 分期方案 |

### 修改
| 文件 | 改动 |
|---|---|
| `src/core/types.ts` | 加法契约：`WorkIntent`/`WorkMode`/`IntentProfile`/`PromptTarget`/`PromptModality`/`TargetResolution`/`EditTriage`/`TriageDecision`/`RequirementClass`/`MissingResolutionItem`/`AnalysisGate`/`RequirementStatus`/`RequirementLedgerEntry`/`AnalysisResult`/`OptimizeDiscoveryRequiredEvent`；`CompileResult` 与 `OptimizeMetaEvent` 加法字段 |
| `src/core/classify.ts` | 抽出 `runJsonCallViaLlm` + `JsonCallSpec<T>`/`JsonCallOutcome<T>`/`JsonCallOptions`；`classifyViaLlm` 改为薄封装（文案与失败归类逐字保留）；导出 `lastJsonRegion` |
| `src/core/compiler.ts` | `FinalizeCompileOptions.analysis?`；`attachAnalysis`；`finalizeKeepResult`（KEEP 零改写）；`assertKeepFidelity` |
| `src/index.ts` | 分析阶段取代分类阶段；`discovery_required` 分支（阻塞即不生成）；KEEP 分支（零模型调用）；meta/done 携带 v2 结论 |
| `src/client/controller.ts` | `AnalysisView` 等视图 + `asAnalysisView` 解析；`status` 增 `discovery`；`discovery_required` 事件处理；done 缺 v2 字段时回落 meta |
| `src/client/ResultDock.tsx` | 头部目标 / 分诊徽章；需求确认面板（阻塞项 + 建议问法）；KEEP 原样保留提示 |
| `src/client/i18n.ts` | 中英各 20 条新文案（意图 / 目标 / 分诊 / 需求确认） |
| `scripts/build.mjs` | 新增 `lib/core/types.js` 与 v2 四个模块的独立 ESM 产物 |
| `package.json` | `test` 脚本纳入 5 个新套件 |
| `test/smoke.mjs` `test/compat-settings.test.mjs` `test/host-pipeline.test.mjs` `test/vertical-slice.test.mjs` | 元任务调用的判据从 `maxTokens===512` 改为 system 文案锚点（分析预算 512→1024 后旧判据失效）；断言语义不变 |

## 4. 测试与验收证据

`npm test` → **exit 0，385 个断言全绿**（含新增 5 套件；既有 22 套件零回归）。

| 套件 | 覆盖 |
|---|---|
| `targets.test.mjs` | 目标目录完整性 / 引擎目录不变量 / 别名最长优先 + 短别名词边界（SDK≠SD）/ 目标解析优先级（引擎 > 线索 > general）/ 图像视频责任项不含模板标题 |
| `triage.test.mjs` | 完备成稿→KEEP（keep_safe）/ KEEP 需双方一致否则降级 PATCH / 模型 REBUILD 无机械依据→RESTRUCTURE / 乱但完整→RESTRUCTURE / 口语需求→PATCH / 空·寒暄·无动词→REBUILD / 严重度单调 |
| `requirements.test.mjs` | 三分类表驱动 / blocking 单向收紧（LLM 能否决不能放大）/ KEEP 永不追问 / 台账来源状态分离 / 伪造来源降级 / 盲授权只降不升（永不 CONFIRMED）/ 违规检测器反向用例 |
| `analyze.test.mjs` | 新契约全字段解析 / **旧分类器 JSON 兼容派生** / 证据与要求逐字校验（伪造丢弃）/ 目标与引擎冲突采纳引擎 / 无 JSON·think·非法枚举容错 / 兜底与手动路径不制造阻塞 / 投影回旧契约 / `analyzeViaLlm` 硬参数与取消超时 / 元任务判据 |
| `phase1-gate.test.mjs` | **阻塞→仅 `discovery_required`、编译调用 0 次**；无阻塞→meta→delta→done 且带完整结论；**KEEP→1 次调用 + 输出逐字等于输入**；图像目标如实标注；手动覆盖零分析调用；分析失败兜底不误阻断 |
| `controller.test.mjs`（扩展 c26–c28） | v2 视图落盘（含 ledger 来源/状态分离）/ `discovery_required` → `status=discovery` 且零结果 / `asAnalysisView` 向后兼容 |

### 验收标准对照（PLAN-v2 §2 Phase 1 验收标准）

| # | 标准 | 结果 |
|---|---|---|
| 1 | `npm test` 全绿（含新增 5 套件） | ✅ 385 断言 / exit 0 |
| 2 | `npm run build` 成功，`lib/` 可继续被 desktop 加载 | ✅ 构建成功；`test/smoke.mjs` 通过真实 cordis 加载 `lib/index.js` |
| 3 | blocking USER_REQUIRED > 0 时**不产生任何编译输出** | ✅ `phase1-gate` p1g1：编译调用次数 = 0，无 delta / 无 done |
| 4 | Analysis 只发 1 次 LLM 小调用（不新增调用次数） | ✅ `phase1-gate` p1g2：AUTO = 2 次调用（分析 + 编译），与改造前一致 |
| 5 | 图像/视频目标可被识别为 `modality=image|video` | ✅ `analyze` an6 / `phase1-gate` p1g4（编译契约切换属 Phase 2） |
| 6 | 台账来源/状态分离；盲授权不可能产出 CONFIRMED/USER_EXPLICIT | ✅ `requirements` rq6/rq8 + `controller` c26 |

## 5. 已知限制（非阻塞，交付时明确）

1. **可自查项仍以 `[待补充:]` 形式进入优化稿**：v2 §C11 要求「可被 Agent 发现项不得标
   `[待补充:]`」，这属于编译契约调整 → **Phase 2** 处理。Phase 1 保持既有占位行为以
   保证零回归（`missing_constraints` 仍由分析结果投影）。
2. **Discovery 只报不问答**：阻塞时下发清单与建议问法，多轮问答与 Confirmation 面板
   → **Phase 3**。
3. **`general` 类型仍走 legacy 编译路径**（`prompt.ts` 的 template/intent 双模式），
   因此该路径下的固定模板语义尚未消除 → **Phase 2** 与 `required_sections` 一起处理。
4. **UI 尚未收敛为六态**：Phase 1 只新增 `discovery` 态并展示清单；完整状态机与
   选择器降级 → **Phase 4**。
5. **桌面端实际界面确认**：正式 desktop profile 经本地 link 使用 `lib/`，构建已更新；
   按既定边界（browser-trust fence），真实界面观感仍由用户本人确认。

## 6. 下一步（Phase 2 建议）

1. `PromptStrategy` 由 `required_sections` 改为**信息责任**（新增
   `informationResponsibilities`，`required_sections` 降级为 legacy 兼容字段）。
2. 图像 / 视频走**描述式编译契约**（不再产出 Goal/Phase/Task/Tests）；可自查项
   不再注入 `[待补充:]`，改为「由执行方自行确认」措辞。
3. **Target-aware Strategy Router**：Primary/Supporting + Target + Engine + Modality +
   Requirement State + Triage 联合路由（替换 `registry.get(type)` 单键路由）。
4. 扩展回归语料：新增验收用例 C（图像）/ D（视频）/ E（乱但完整→RESTRUCTURE）
   的 fixtures 与 golden 断言，继续走既有双通道 runner。
