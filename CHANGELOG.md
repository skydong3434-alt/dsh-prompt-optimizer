# CHANGELOG

本项目 = **DSH Adaptive Prompt Optimizer**（@y1x1n/dsh-prompt-optimizer 派生增强）。
版本号采用 fork 发行线 `v0.x.y-apo`；`package.json` 名义版本沿用上游 `0.4.0`
（派生包名不变，详见 NOTICE §3）。

## [Unreleased] — 真实 UI 验收修复（V3）

修复 DSH Desktop 真实 UI 人工验收发现的三个问题（真实模型 `minimax-m3` 复测）。

### 面向使用

- **只描述目标时不再被扩展成任务**：输入「我想用DSH控制ComfyUI生成视频。」过去会变成
  「请说明可行的实现方式……」并追加接口 / 控制流程 / 实施限制等要求；现在输出只是这句话的
  理顺版（实测 3/3，1 次模型调用，约 6 秒）。提示词里新增「不得扩展任务方向」硬规则，
  机械兜底 `detectIntentExpansion` 补齐真实失败样本里出现过的扩展表达。
- **缺一个名字不再被反问**：「帮我看看这个软件哪里不好用还有什么地方可以改怎么弄比较好。」
  过去要求先提供软件名称 / 版本 / 截图；现在直接整理为
  「请分析这个软件目前存在哪些不好用的地方，指出值得改进的问题，并提出具体可行的优化建议。」
  （实测 3/3，1 次调用，约 6 秒）。判断标准改为：这个缺失信息是否妨碍**优化这句话本身**，
  而不是将来执行任务是否需要它。真正的歧义（「把它改成第二种。」）仍然会提问，能力未被削弱。
- **特殊用途识别与界面显示一致**：「帮我优化一段可灵图生视频提示词……」识别为视频生成提示词；
  界面不再用「任务类型 / 把握度 / 提示词目标 / 编辑分诊」这些旧字段造成误读
  （V3 下「任务类型」恒为 general，显示出来只会让人以为识别错了）。
- **结果面板精简**：默认只显示**优化后的提示词**与「替换输入框 / 复制 / 重新优化 / 关闭」；
  判断依据、台账、分析、建议全部收进**默认折叠**的「优化说明」。澄清页只显示要回答的问题
  与继续操作，不再出现阻塞项计数等内部状态术语。

### 实现（技术附录）

- `src/core/v3.ts`：提示词新增「缺一个名字/标识不算歧义」规则与逐字反例（中英同步）；
  `EXPANSION_PHRASES` 补齐真实失败样本短语（实现方式 / 控制流程 / 实施限制 / 方案或指南 /
  整体思路 / 覆盖以下要点 / 列出优劣），`ASKS_FOR_PLAN_RE` 增加「思路」以免误伤想法讨论；
  `asksForGenerationPrompt` 接受「优化一段…提示词」这类明确诉求。
- `src/client/ResultDock.tsx`：移除头部旧字段徽章与置信度映射；结果正文改为
  「优化后的提示词 → 优化说明（折叠）」；澄清页去掉内部术语；删除死代码 `CONFIDENCE_KEY`。
- `src/client/controller.ts`：`OptimizeResult` 增加 `usage`（V3 真实用途），供「优化说明」如实显示。
- `src/client/i18n.ts`：新增 `panel.notes` / `panel.discovery.askTitle` / `panel.usage.*` / `panel.auto.usage`；
  低把握提示改为指向「优化说明」。
- 测试：`test/v3.test.mjs` 新增第 6b 组（提示词规则防线，防止规则被静默移除）与三例真实 UI 输入；
  `scripts/v3-real-check.mjs` 固定三例真实 UI 失败回归（`UI真实失败①②③`）。

### 复测中发现的另两个真实缺陷（已修）

- **推理模型的思考被当成正文 → 稳定空产出**：`minimax-m3` 的 `reasoning_content` 为空，思考以
  思考标签直接混在 `content` 里，且思考中会出现 `{...}` 片段（含系统提示词里的协议示例）。
  旧解析按「第一个 JSON 对象」取值，取到的是思考里的片段 → 解析不到结果 → 纯文本兜底时又因
  整段含 `"status":"optimized"` 被判为协议信封 → 返回空产出（`VF_EMPTY_OUTPUT`），
  「严格 JSON 输出一个 agent 任务指令」用例因此 2/2 失败。现在 `parseV3Output` 先剥思考块
  （`stripThinking`），协议信封必须满足 `status` 为 `optimized` / `needs_clarification`
  （`extractProtocolEnvelope`，逐个尝试所有平衡 JSON 对象），思考里的 JSON 片段不再可能被误取。
- **快速模式的实时预览泄漏内部协议**：宿主原先把模型增量原样转发给界面，用户在「快速模式」下
  会看到思考标签与 `{"status":"optimized",…}`。现在只下发 `previewableText` 的结果
  （剥思考 + 在协议信封处截断）；预览为空时界面只显示加载态，正文里也没有思考内容。
- 测试：`test/v3.test.mjs` 新增第 9 组（思考剥离 / 协议信封识别 / 预览净化）；
  `test/smoke.mjs` 新增 1b（思考与协议不得下发，真实内容照常下发），并修正第 1 组断言
  （协议 JSON 形态的输出不再产生预览增量）。
- **中文提示词被改写成英文**：IMAGE 用例连续 2 次把中文输入输出成英文
  （`anime style illustration, …`），用户写中文却拿到英文。提示词此前只按配置选择中/英系统提示，
  **没有「与输入同语言」这条规则**。现在中英提示词都增加「输出语言」段：与用户输入保持同一语言
  （模型名、专有名词、代码标识可保留原文）。复测 4/4 输出中文（`kept=0.88`）。
- **`output` 给成对象时交付 `[object Object]`**：模型有时把协议里的 `output` 直接写成对象
  （实测 minimax-m3 严格 JSON 用例返回 `"output":{"title":"待确认"}`），旧代码 `String(parsed.output)`
  会产出 `[object Object]`。现在非字符串的 `output` / `question` 统一序列化为 JSON 文本。
- `scripts/build.mjs`：产物清单文案改为实际产物（旧链路文件已删除，避免误导）。

## [Unreleased] — V3 单次调用架构（精简重构）

把优化流程收敛为**一次模型调用**，并删除此前积累的多阶段链路。

### 面向使用

- **一次调用完成优化**：普通请求不再「先分析、再编译」，直接产出优化后的提示词；
  实测同一条输入的端到端耗时从约 134 秒降到数秒级，模型调用次数 2–4 次 → 1 次。
- **只在真有必要时问一个问题**：仅当原文存在**语义歧义**（指代不明、上下文里也找不到对象）
  才提一个关键问题；回答后立即继续优化，不重复确认。实现细节类信息（路径、接口、版本、
  技术选型）不再提问。
- **不再擅自扩展任务方向**：目标描述不会被改写成规划任务，想法交流不会被改写成执行任务，
  模型建议不会被写成你的明确要求；输入已经清楚时按保守方式优化，简单输入保持简洁。
- **特殊用途只按明确证据触发**：只有明确要「生图/视频/音频提示词」或「写给某个执行 Agent」
  才套用对应形态；仅出现关键词不改变用途，且这些形态不会被写成执行任务模板。
- **技术错误如实显示**：模型没产出、超时、协议异常都显示为可重试的技术错误，
  不会伪装成「需要你澄清」。

### 实现（技术附录）

- 新增 `src/core/v3.ts`：用途推断、单次调用提示词、协议解析（`status=optimized|needs_clarification`）、
  机械安全 `assessV3Safety`、意图扩展拦截 `detectIntentExpansion`、特殊用途模板漂移拦截
  `detectSpecialUsageTemplateDrift`、协议信封泄漏防护、`stripProtocolMarkers`。
- 删除旧多阶段链路：`src/core/` 旧模块 18 个 + `src/core/strategies/` 12 个（约 13.7k 行）、
  `v3:false` 回退分支与 `v3` 配置项、旧测试语料与诊断脚本；`src/core/` 只剩
  `v3.ts` / `triage.ts` / `types.ts`（types.ts 853 → 66 行）。
- 修复 V3 超时**没有终态事件**的缺陷（原 `throw` 被外层 aborted 静默返回吞掉）。
- 测试：`npm test` 101 断言全绿；`test/smoke.mjs` 为 V3 宿主半冒烟 20 例；
  `scripts/v3-real-check.mjs` 真实模型内容级检查；分类与删除记录见 `docs/v3-test-migration.md`。

## [v0.2.0-apo] — 2026-10-06（Adaptive Prompt Editor）

从「固定模板式 Prompt 扩写器」升级为**自适应提示词编辑器**：不再让你先选任务类型，
而是自动判断你要做什么、该写成什么形态、产物交给谁用、需要改多少。

### 主要变化（面向使用）

- **自动任务意图识别**：不用再在下拉里选 AUTO / Research / Planning / Execution 等类型；
  系统自己判断任务意图与工作方式。
- **Prompt Target / Target Engine 自动识别**：产物形态与目标引擎自动判定
  （结构化任务指令 / 图像描述 / 视频描述 / Agent 任务；例如自动识别 ComfyUI、可灵 Kling）。
- **KEEP / PATCH / RESTRUCTURE / REBUILD**：按「需要改多少」分四档 ——
  **无需修改**（原文逐字保留，不调用模型改写）、**局部修补**（只补少量缺口，不重排不加章节）、
  **重新整理**（去重重排，不新增你没提过的目标）、**重新构建**（先问清关键取舍再从零构建，
  且只写完成任务真正需要的信息）。
- **Requirement Discovery（需求发现）**：当某件事**真的需要你拍板、且会显著改变方案**时
  （范围取舍、一次性验证 vs 长期自动化、只分析 vs 真执行、能否修改/删除、不可逆动作授权…），
  先问少量关键问题（单轮 1–3 条），**在你说清楚之前不生成提示词**。
- **Requirement Ledger（需求台账）**：你说过的决定被记为台账条目，区分来源与状态；
  之后改措辞重新优化时，**仍然成立的要求会被保留**，不再重复问你。
- **Agent 可自行调查的信息不再变成 `[待补充:]`**：版本、路径、接口地址、项目结构、依赖、
  现有实现这类可读事实，改成「交给执行方动手前确认」的动作式指令或分支条件，
  不会要求你填写。**旧的 `[待补充:]` 占位符机制已退出正常生产路径。**
- **Image / Video 专用描述式 Prompt contract**：生图/视频提示词按视觉要素组织
  （主体 / 场景 / 风格 / 构图 / 光线 / 画幅 / 排除项；镜头 / 动作与时间 / 场景氛围 / 时长…），
  不再套用「目标 / 阶段 / 任务 / 测试」这类项目任务模板。
- **Provenance 保护**：明确要求必须有你的原话证据；优化器建议独立标注、永不混入要求；
  助手的历史发言不被当成你的意图；不替用户发明约束。
- **Validator 可控回流**：交付前的校验从「只告警」升级为**可控回流**
  （修正来源 / 修正处置 / 回到需求发现 / 回到分析 / 硬错误），带稳定原因码、有次数上限，
  同一失败不会无限循环；伪造来源与丢失你已确认的约束**不会**被静默交付。
- **re-optimize 需求对账**：再次优化时旧台账按「仍然成立 / 与新内容冲突 / 已不再适用」三类裁决，
  旧任务的要求不会污染新任务，也不会因为改了一句措辞就把问过的东西全丢掉。
- **主界面不再要求选择模式**：AUTO / Research / Planning / Execution 等下拉已从主界面移除；
  自动判断是默认行为，手动指定降级为结果页折叠区里的低优先级「调整判断」入口。
- **结果页只给本次真实判断摘要**（如「重新构建 · Agent 执行任务 · DSH」），
  展开「查看分析」才显示任务意图 / 辅助意图 / Prompt 类型 / 目标模型 / 需要修改多少 / 未决项处置。

### 稳定性与验收

- **Decision Stability**：同一句模糊输入不会因为模型采样而有时问你、有时不问 ——
  高影响决策由**机械安全层**保证（与模型输出质量无关），并已验证 8 条高歧义输入 × 8 轮全部稳定。
- **Confirmation 语义**：「本轮目标」显示你的任务目标（不是优化器的诊断），
  「你已确认」显示你真实给出的答案，Agent 可自查项不要求你填写。
- **对比 v0.1.0-apo 的真实语料回归**（25 条，同语料同模型）：交付稿中的 `[待补充:]`
  从 635 次降到 **0 次**；KEEP 由「改写 + 占位符」变为**逐字保留**；
  平均长度更接近「最小充分」，凭空出现的量化约束显著减少。
- 测试：`npm test` **486 断言全绿**。

### 实现细节（技术附录，按阶段）


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

### Phase 4 —— 产品收口 + 全链路一致性（已完成）

报告:`docs/phase4-report.md`(含 A–F 证据附录);证据脚本:`node scripts/phase4-trace.mjs`。

- **Triage 语义修正**:PATCH 必须**有可保留的东西**(≥1 结构信号 或 ≥1 成稿要素),
  否则 REBUILD —— 修掉「模糊目标被误判为局部修改」(ComfyUI 案例由 PATCH → REBUILD,通用规则,非特例)。
  Discovery **不得修改 Edit Triage**:首轮裁决钉住并逐轮回传,回答轮强制沿用。
- **Validator 从 fail-closed 升级为可控回流**:新增 `core/validation-flow.ts` ——
  `PASS / RETURN_TO_MISSING_RESOLUTION / RETURN_TO_DISCOVERY / RETURN_TO_ANALYSIS / HARD_ERROR`,
  每个回流带稳定 `reason_code`;同一失败第二次即 HARD_ERROR,总次数上限 2;完整性缺陷不回流
  (交付 + 警示)。新增 SSE `validating` 与 `returned` 事件。纯机械,不新增 LLM 调用。
- **六态 UI**:`analyzing / discovery_required / requirement_confirmation / compiling / validating / complete`
  (+ error / cancelled);分析诊断默认折叠,配一句结果摘要(`REBUILD · agent_task · DSH`)。
- **主界面移除模式选择器**:`OptimizeButton` 不再渲染 `<select>`;手动 override 降级为结果页折叠区里的
  低优先级「调整判断」。新增机械规则保证 **正文明确约束 > 手动 override**
  (「只检查,不修改文件」压过 Execution 选择)。
- **结果页语义收口**:「已确认需求」改读**真实 Requirement Ledger**(不从编译器输出反推);
  建议弱化并默认折叠;移除「仍需补充/不确定」大杂烩,改为 需要你决定 / Agent 自行调查 / 暂不影响 / 暂定·条件。
- **Confirmation 四类互斥**:id + 语义双重去重(包含率 + Jaccard),同一决定只属于一个当前状态。
- **general 迁入 v2 契约**:4 项 target-neutral 信息责任(`Request / Context & Inputs /
  Constraints & Exclusions / Deliverable Shape`),不再使用 Goal/Why/Phase/Task/Steps/Tests/Acceptance;
  fast 模式的无标记容错由 v2 解析层承接。
- **legacy 全部不可达**:`required_sections`(别名)、`injectMissingPlaceholders`、`parseOptimizerOutput`、
  `prompt.ts` 双模式、`LEGACY_GENERAL`/`isLegacyGeneral`、`classifyViaLlm` 均为
  `DEPRECATED-BUT-UNREACHABLE`,由可达性测试钉住;`compilePrompt({promptType})` 降级为高级 override。
- **再优化 Ledger 对账**:新增 `core/ledger-reconcile.ts` —— STILL_VALID / CONFLICTING / INVALIDATED,
  宿主新增 `mode:'reoptimize'`;对账结果贯穿编译/确认/门禁。测试覆盖「只改措辞保留 / 换向 supersede /
  换族失效 / 删除约束不再假装是 USER_EXPLICIT」。
- **测试**:新增 `validation-flow`(14)/`phase4-reconcile`(7)/`phase4-final`(9)三套件;
  `npm test` **468 断言全绿**。

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