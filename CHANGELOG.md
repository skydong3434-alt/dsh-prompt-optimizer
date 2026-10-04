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