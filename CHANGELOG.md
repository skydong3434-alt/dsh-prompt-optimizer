# CHANGELOG

本项目 = **DSH Adaptive Prompt Optimizer**（@y1x1n/dsh-prompt-optimizer 派生增强）。
版本号采用 fork 发行线 `v0.x.y-apo`；`package.json` 名义版本沿用上游 `0.4.0`
（派生包名不变，详见 NOTICE §3）。

## [v0.2.0-apo-dev] — 未发布（v2 升级进行中）

从「固定模板式 Prompt 扩写器」升级为「意图保真自适应提示词编辑器」。
设计基线与分期方案见 `docs/PLAN-v2-adaptive-editor.md`；本段只记录已落地的阶段。

### Phase 1 —— 分析阶段 + 阻塞门（已完成）

主流程前置四步 + 一个门：**Intent & Work-Mode Analysis**（主意图 + 辅意图 +
工作模式）、**Prompt Target / Target Engine**、**Edit Triage**
（KEEP / PATCH / RESTRUCTURE / REBUILD）、**Missing Resolution**
（UNKNOWN 三分类 + blocking），以及**阻塞即不生成**（唯一允许阻断的出口）。

- 新增 `src/core/targets.ts`：8 目标 + 表驱动引擎目录（DSH / Claude Code / Codex /
  Midjourney / Flux / SD / 即梦 / 可灵 / Veo / Seedance / Runway …），
  最长别名优先 + 短 ASCII 别名词边界；**无巨型 if/else**。
- 新增 `src/core/triage.ts`：KEEP 需机械判据与模型**双方一致**（否则降级 PATCH）；
  REBUILD 需机械同意（模型无权重写用户成稿）；长段落复读识别。
- 新增 `src/core/requirements.ts`：UNKNOWN 三分类（USER_REQUIRED /
  AGENT_DISCOVERABLE / OPTIONAL）+ blocking 单向收紧；需求台账**来源与状态分离**；
  「按你的判断继续」只可产生 PROVISIONAL / CONDITIONAL / DEFERRED，
  **永不** CONFIRMED / USER_EXPLICIT；`findLedgerViolations` 不变量自检。
- 新增 `src/core/analyze.ts`：一次结构化小调用（temp 0 / maxTokens 1024 / lowest
  reasoning）产出意图 + 目标 + 分诊 + 缺失解析 + 台账；**取代**旧的分类调用
  （AUTO 路径仍为 2 次调用，不新增开销）；容忍旧 `ClassifierResult` JSON 并
  确定性派生新字段。
- `src/core/classify.ts`：抽出通用 `runJsonCallViaLlm`（调用机制复用），
  `classifyViaLlm` 保留为薄封装，文案与失败归类逐字不变。
- `src/core/compiler.ts`：KEEP 路径 `finalizeKeepResult`（**零模型调用、零改写**，
  `optimized_prompt` 逐字等于用户输入）+ `assertKeepFidelity` 机械断言。
- `src/index.ts`：分析阶段接入两阶段管线；`discovery_required` 事件（阻塞时
  **不进入编译、不消耗编译 token**）；meta / done 携带 intent / target / triage /
  ledger / missing_resolution / gate。
- Client：`status` 新增 `discovery`；需求确认面板（阻塞项 + 建议问法 + 门禁理由）；
  头部目标 / 分诊徽章；KEEP「已原样保留」提示；中英各 20 条新文案。
- 测试：新增 `targets` / `triage` / `requirements` / `analyze` / `phase1-gate`
  五套件；`controller` 增 c26–c28。`npm test` 385 断言全绿，既有 22 套件零回归。
- 报告：`docs/phase1-report.md`（含验收标准逐条对照与已知限制）。

### Phase 2 —— 信息责任 + 目标契约 + 未决项处置（已完成；选项 A）

用户裁决 **A：现在就切换，不做过渡**。正式契约见 `docs/phase2-contract.md`。

- **`[待补充:]` / `[TODO:]` 彻底退役**（不变量 I-1）。未决项改为按「谁有能力解决」分派：
  - 执行 Agent 正常工作中自然获得（路径 / 目录 / 文件名）→ **省略**（不提示、不占位）；
  - 必须在行动前调查且影响正确执行（版本 / 接口 / 签名 / 配置 / 字段 / 依赖 / 环境 / 默认值）
    → **动作式**指令「动手前先确认:X」（`## 执行前须知`）；
  - 调查结果决定后续分支 → **条件式**指令「X:存在则优先复用/沿用,不存在则按新建路径处理」
    （`## 分支条件`）；
  - 非阻塞 `USER_REQUIRED` → `USER_DECISION`：**不写进优化稿**（留台账 / 面板，Phase 3 追问）；
  - `OPTIONAL` → 默认省略；确认显著改善结果才进**建议段**。
  - **反膨胀**：不得把缺口机械改写成「由执行方自行确认 X」；每类注入 ≤4 条且去重。
  - 新增 `src/core/responsibilities.ts`（判定 + 注入）、`src/core/disposition-render.ts`（渲染）。
- **`required_sections` → `informationResponsibilities`**：策略定义的是信息责任（标题可自拟、
  顺序可调整、责任不得遗漏），不再是必备模板段落；旧字段保留为 deprecated 别名。
- **Target-aware Router**（`src/core/router.ts`）：Primary/Supporting + Target + Engine +
  Modality + Requirement State + Triage 联合路由。优先级：手动覆盖 > 视觉目标 > Agent 目标 >
  意图 > 兜底。`CompileResult.contract` 记录实际契约；`prompt_type` 仍表达工作意图。
- **新增三套目标编译契约**：`strategies/agent.ts` / `image.ts` / `video.ts`（+ `_visual-shared.ts`
  工厂），与意图策略分属两张注册表（`targetContractRegistry`），分类器闭集仍是七值。
- **图像 / 视频不再套 Goal/Phase/Task/Tests**：描述式责任清单（主体/场景/风格/构图/光线/画幅/排除项；
  视频另有镜头/动作时序/时长格式）+ `visual-no-task-template` 守卫**机械拒绝**模板标题。
- **校验器**：新增 I-1（退役占位符出现即 error）与 I-2（未决项不得写成面向用户的追问）；
  「缺口未在正文出现」不再报问题（省略是合法处置，可见性由台账 / 面板承担）。
- **UI**：meta/done 透传 `contract`，新增「编译契约」徽章（图像描述式 / 视频描述式 / Agent 任务指令）。
- **测试**：新增 `responsibilities` / `router` / `phase2-fixtures`（验收 A/C/D/E）三套件；
  10 处既有 fixture/golden 按新契约更新。`npm test` 412 断言全绿。
- **文档**：`docs/phase2-contract.md`（正式契约）、`docs/phase2-report.md`（实施报告）、
  `docs/phase3-prerequisites.md`（Phase 3 准入清单，含用户指定的「取舍型不得被降级」必做项）。

### Phase 3 —— Requirement Discovery 完整闭环（已完成）

把「blocking → 停止」升级成「blocking → Discovery → 回答 → 重新分析 → 台账更新 →
确认 → Compiler」的**完整闭环**。报告：`docs/phase3-report.md`。

- **Phase 3 prerequisite（正式解决）**：取舍型 / 产品决策（「先验证还是直接做完」
  「先做 MVP 还是一步到位」「保持架构还是允许重构」）→ `USER_REQUIRED` + `impact=high`
  + `blocking=true`；**反向保护**：ComfyUI 版本 / API 地址 / workflow 文件位置 / 当前依赖 /
  项目结构等环境事实永远是 `AGENT_DISCOVERABLE`，不得升格。机械判据只是安全网，
  语义第一来源是分析契约的 `decisions[].kind = PRODUCT_DECISION`。
- **新增 `src/core/discovery.ts`**：
  - Question Planner：四维加权（Solution Impact / User Exclusivity / Blocking /
    Branch Reduction）、依赖分轮（`depends_on`）、同轮不得问有依赖关系的两项、
    默认 1–2 最多 3、重复问题（含换措辞）不再问；
  - Answer Resolver：`confirm / reject / supersede / invalidate / not_applicable / derived`，
    回答写回台账为 `USER_EXPLICIT` + **逐字证据**；选项声明的 `invalidates` → `NOT_APPLICABLE`；
  - Sufficiency Evaluator：结合台账**当前状态**重算 live blocking（不是数字段）；
    `CONFIRMED/REJECTED/NOT_APPLICABLE/PROVISIONAL/CONDITIONAL/DEFERRED` 均视为已安全处理；
  - 循环安全保护：最大轮次 3 / 无新信息 / 无高价值问题 → 停止追问并给出理由；
  - Requirement Confirmation：目标 / 你已确认 / Agent 自行调查 / 暂定·条件 + 指纹。
- **盲授权**（「按你的判断继续」）只产生 `PROVISIONAL` / `CONDITIONAL`，
  **永不** `USER_EXPLICIT` / `CONFIRMED`（机械测试钉住）。
- **未决项 id 改为内容派生**（`unknown-<hash>`）：跨轮次稳定，否则第二轮会把已回答的
  决定当成新问题重复问；模型问题里的 `requirement_id` / `depends_on` 按「下标 → 第 N 项」重映射。
- **宿主**：`discovery: { mode: 'answer' | 'confirm' }`；新事件 `requirement_confirmation`；
  **confirm 复用上一轮分析（0 次额外调用）**并在编译前**重算 live blocking**——
  仍有阻塞即拒绝编译并退回确认流程（fail-closed）；客户端回传的台账一律净化
  （伪造的 `USER_EXPLICIT` 被降级，绝不以此身份存活）。
- **UI**：Discovery 答题面板（选项 + 推荐 + 推荐理由 + 自由回答 + 其他 + 按你的判断继续）、
  Confirmation 四组摘要面板、「修改理解」编辑面板（保持台账，不全部重来）；
  新增 `discovery` / `confirmation` 两个状态。
- **LLM 调用预算**：一次分析调用同时产出取舍语义 + 问法/选项；Planner / Sufficiency /
  Confirmation 全机械；确认后不再分析。总计 = 首轮 1 + 每回答轮 1 + 编译 1。
- **测试**：新增 `discovery`(13 组) 与 `phase3-e2e`(13 组，含 ComfyUI 完整闭环与 §19 九类场景)；
  `rc12` 翻转为新行为。`npm test` **436 断言全绿**。
- **证据工具**：`scripts/phase3-trace.mjs`（输出即 ComfyUI 完整事件流与编译调用次数）。

## [v0.1.0-apo] — 2026-10-04（首个可发布版本，Release Candidate）

DSH Adaptive Prompt Optimizer 完成全部 9 个阶段（P00–P09），通过 G-1..G-7
全部 Human Gate，进入 DoD 用户终检。基于上游 Y1X1n v0.4.0（MIT，fork-point
`base-y1x1n-v0.4.0`）的增强版本。

### 新增（相对上游 v0.4.0）

- **核心契约**（`src/core/types.ts`）：封闭七类型 `PromptType`
  （research/planning/execution/diagnostic/review/creative/general）、
  `ClassifierResult`、`NormalizedContext`（deterministic 与 LLM-derived 分离）、
  `ProvenanceRecord`（五类来源）、`CompileResult`（四组 provenance + 缺口 +
  `provenance_ok`）、`PromptStrategy`（策略契约：sections/rules/guards/
  provenanceRules/buildSystem/buildUser/outputContract）、`ValidationResult`。
- **Provenance 全链**（`src/core/provenance.ts` + `validate.ts`）：
  quote 逐字字面比对（raw_input 或 context user 消息）、assistant 消息不作
  USER_EXPLICIT 证据、evidence 不足自动降级 suggested/unknown、
  `[待补充:]` 缺口注入、三层守卫（保真 / 推断建议 / 未知）；
  `provenance_ok=false` 时 UI 顶部警示。
- **策略注册表**（`src/core/registry.ts` + `src/core/strategies/`）：
  七策略独立文件 + 独立 `version`；`_shared` 共享规则段（保真原则 / 语言匹配 /
  待补充纪律 / 建议标注纪律 / 禁入集合）；未知类型回落 general；
  `list()/getVersion()/getSections()` 对 UI/测试暴露。
- **Intent Classifier**（`src/core/classify.ts`）：LLM 小调用（maxTokens 512 /
  temperature 0 / 最低推理 / thinkFilter / 超时与失败回退）、防误判三规则
  （当前请求优先 / 当前请求 vs 历史讨论 / assistant 建议≠用户决定）、
  低置信提示、手动 override 旁路 classifier。
- **Compiler**（`src/core/compiler.ts`）：10 步编排 + 四段协议输出
  （明确要求 / 上下文已确认 / 优化器建议（可忽略）/ 待补充）+ 容错解析
  `parseCompileOutput`。
- **Host Pipeline**（`src/index.ts` handler 内部）：两阶段编排
  （classify→compile→finalize→validate）+ SSE `meta{done}` 事件扩展；
  完全向后兼容（旧 delta/done/error 不变，resolveRoute/超时/断连/fallback/
  CSRF/settings 零改写）。
- **UI**（client）：AUTO 下拉 + 六类型手动覆盖（`TYPE_OPTIONS` 单一真值源）、
  ResultDock 四组 provenance 分级渲染 + 类型徽章（高/中/低）+ 低置信黄条 +
  缺口清单独立展示、Settings 新增默认类型/分类模型字段 + i18n。
- **回归体系**（P07）：14 例真实语料 fixtures + deterministic 硬 Gate
  （invariants + 7 个 canonical `invariant_checks`）+ model-assisted 参考线
  （intent-fidelity-v1，R-2 阈值未校准不计发布标准）+ 报告存档；
  首轮 8 轮证据链确定性 12/14（单跑全例通过），残余端侧措辞方差经 G-5 裁定
  PASS_WITH_KNOWN_HARNESS_FLAKINESS。
- **隔离与正式安装证据**：apo-dev 隔离 profile（DSH Desktop 2.0.15 /
  dsh 0.1.7-rc.2 / cordis 4.0.4）冒烟 12 项 + 桌面端四项真机探针
  （Follow DSH model route=opencode-go/deepseek-v4-flash + 758 帧真实流式、
  fallback billing safety 双向验证）；G-7 授权后正式 profile 安装
  （bundles=21，备份 `~/.dsh/backups/apo/g7-install-20261004-140136/` 可回滚）。
- **发布配套**：`NOTICE.md`（设计来源与 License 边界）、
  `scripts/check-license-contamination.mjs`（AGPL 污染指纹扫描，PASS）、
  `docs/dod.md`（DoD 终检清单）、`docs/p08-smoke.md` / `docs/p08-desktop.md`、
  `scripts/backup-profile.sh`（正式 profile 备份/恢复，P09 回滚预案）。

### 修复与纪律（P07-T03 首轮回归 13 项）

compile maxTokens 镜像 host、UNKNOWN 同话题去重+剥内嵌占位符、建议剥离触发理由/
引文、编译纪律文案落盘、execution 编号标题守卫、planning 阶段去重计数+元说明豁免、
provenance 全角/半角归一、STRONG_CLAIM 收窄+UNCERTAINTY 扩、缺口说明
`[编译说明]` 前缀、动词+对象并置禁则、约束总起句/非来源段引述禁则等。

### 已知记录（KNOWN_NON_BLOCKING_HARNESS_LIMITATION）

research `provenance_ok=false` 为 phrasing-sensitive deterministic regex
假阳性族（「[待补充: …]」前缀式 / 「取决于…」转述 / 「声称支持…但无实测」
条件句），记录、不修、不重开已验收模块（docs/p08-desktop.md 附录）。

### 验证状态

- `npm test`：26 个测试文件全部通过（build + smoke/prompt/controller +
  provenance + 七策略 + registry + classify 三件 + compiler + validate +
  集成 + host-pipeline + vertical-slice + compat-settings + settings-i18n +
  regression schema/run）。
- `python3 scripts/apo_state.py`：控制平面一致性 PASS。
- DoD（PLAN-v1 §18）10 项 + G-1..G-7 全部通过；最终 Human Product
  Acceptance（用户验收）待用户声明。

### 安装 / 使用 / 回滚

见 `README.md`（本 fork 章节）与 `docs/dod.md`；正式 profile 回滚：
`bash scripts/backup-profile.sh restore <备份目录>`。

---