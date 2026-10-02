# ADAPTIVE PROMPT OPTIMIZER
# DEVELOPMENT EXECUTION PLAN v1

依据：《DSH ADAPTIVE PROMPT OPTIMIZER — CODE-LEVEL RESEARCH REPORT》（/tmp/dsh-prompt-optimizer-research/REPORT.md）
版本：v1（规划稿）
日期：2026-10-03
状态：**规划待确认**（未 fork、未写码、未安装、未改任何配置）

本规划是"可逐任务执行"的开发契约：每个 Task 含完整 Contract（Goal/Why/Preconditions/Inputs/Allowed Scope/Forbidden Scope/Executor/Tools/Exact Steps/Expected Outputs/Tests/Acceptance/Failure Handling/Stop Conditions/Docs Update/Git Rules/Next Transition）。执行方按 Executor 字段分工：**DSH**（本会话/主代理编排）/ **Claude Code**（独立代码委托）/ **Human**（用户本人）。
最低受托方需有完整五要素：目标 / 当前状态 / 允许修改范围 / 下一步 / 验收标准。

---

## 1. Product Definition

**一句话**：DSH Adaptive Prompt Optimizer 是一个 DSH 原生插件，把用户原始、口语化、不完整的表达**编译**成适合"下一层 Agent"执行的高质量 Prompt——它只做"输入编译"，**不做**执行、研究、建项目、路由、写 PAB、自动决策或任何下游动作。

- **是**：Intent Classifier（AUTO/manual）→ Strategy Registry（7 类）→ Prompt Compiler → Provenance 审计 → 结果面板 → 用户确认/编辑/替换输入框 → 用户自己发送。
- **不是**：Project Router / Project Manager / Orchestrator / Runner / Personal AI Brain / Taskboard / Claude Code 执行器 / phase 管理。

**最终链路（不变更）**：
```
User → Adaptive Prompt Optimizer → Optimized Prompt(+Provenance) → 用户确认/编辑 → Replace Input → 用户发送 → 后续 Agent
```

---

## 2. Final MVP Architecture

```
composer draft
   │ [AUTO ▾][✨ 优化]（手动类型=跳过 classifier）
   ▼
Optimizer UI (client, 基于 Y1X1n controller/ResultDock)
   ├─ Context Collector（确定性：raw_input + bounded turns + workspace metadata；
   │    不在此阶段做 LLM 摘要——LLM-derived 字段只能在 classifier/compiler 内产生且带 provenance）
   ├─ POST /dsh-prompt-optimizer/optimize {text, provider, model, reasoningEffort, context, previous, promptType?}
   ▼
Host handler（保留 Y1X1n：resolveRoute / 超时 / 断连 abort / fallback 链 / SSE / CSRF）
   ① normalizeInput()        core/context.ts（确定性，纯函数）
   ② classifyIntent()        core/classify.ts（AUTO 时 LLM 小调用；manual 直接取 override）
   ③ strategyRegistry.get()  core/registry.ts（7 策略 + general fallback）
   ④ compilePrompt()         core/compiler.ts（策略模板 + provenance 契约 + 输出协议）
   ⑤ validateOutput()        core/validate.ts（anti-drift 守卫 + provenance 机械比对）
   ⑥ 第二次 LLM 调用（沿用现有 SSE/流式/thinkFilter）
   SSE 事件序列：meta{type,confidence_level,missing_constraints,rationale} → delta… → done{…}
   ▼
Result Panel：类型徽章（高/中/低）＋需求诊断＋四组 provenance 展示＋缺口＋优化稿（流式）
   ▼  [替换输入框][复制][重新优化][关闭]（沿用 undo/Esc/slash 前缀/auto-close）
```

两次调用模型：AUTO = Call1 classifier（maxTokens 512、temperature 0、lowest reasoning、JSON 输出契约）→ Call2 compiler（策略编译）。Manual override = 只 Call2。失败路径：classifier 解析失败/低置信 → general + 提示人工检查；compiler 失败 → 沿用现有 error 事件，绝不伪造结果。

---

## 3. Repository Strategy

| 项 | 决策 |
|---|---|
| upstream | `https://github.com/Y1X1n/dsh-prompt-optimizer.git`（只读；基线 = 当前 v0.4.0，commit daf6fbd 附近；不 push、不改） |
| fork remote | 规划确认后由用户创建：`github.com/<user>/dsh-adaptive-prompt-optimizer`（命名待用户确认）；本规划执行时不创建 |
| 本地项目目录 | 独立目录（P00 创建，建议 `~/Projects/dsh-adaptive-prompt-optimizer/`，最终以 Human Gate G-0 确认为准）；**不是**当前 desktop profile 的 node_modules |
| 环境 | 独立 DSH dev profile（如 `dsh --profile dev-apo` 或隔离组合），**不装进正式 profile**（P08 之前） |
| branch 策略 | `main` 与 upstream 基线同步一次（fork-point 标签 `base-y1x1n-v0.4.0`）；每阶段独立 feature branch：`phase/p01-contracts`、`phase/p02-strategies`…；只有通过该阶段验收才合并 |
| commit 纪律 | 小步可构建；每条 commit 前缀阶段号（`p01(contracts): …`）；禁止 force/rewrite history；每条 PR = 1 阶段可回滚单元 |
| License | 保留 Y1X1n MIT LICENSE 与署名（原作者与 Jerry(@ruijiaang-lab) 致谢）；新增 `NOTICE.md` 记录设计来源（WestFox BSD-3 借鉴思想；linshenkx/zhangjiazhi AGPL 仅借鉴思想，**零代码复制**）；本项目派生包名变更（如 `@<user>/dsh-adaptive-prompt-optimizer`） |
| 测试先行 | 任何修改前先跑通该阶段基线测试；`test before install` |
| 回滚 | 正式安装前保留现 profile bundle 备份（P09 执行）；发布产物带版本 tag，可回退 |

---

## 4. Core Contracts

定义于 `src/core/types.ts`（P01 唯一产出，**先于一切 UI/Host 改动**）：

```ts
// 封闭枚举（7 + fallback）
export type PromptType = 'research' | 'planning' | 'execution' | 'diagnostic' | 'review' | 'creative' | 'general'

// ① 分类输出（classifier 的 JSON 契约，LLM 必须逐字段输出）
export interface ClassifierResult {
  prompt_type: PromptType
  confidence_internal: number       // 0..1，仅供内部决策/日志，UI 不直接展示数值
  missing_constraints: string[]     // 编译期将注入 [待补充:] 的缺口
  rationale: string                 // 一句话理由（UI 展示）
  evidence_quotes: string[]         // 分类依据：必须是 raw_input 或 context-user 中的逐字子串
}

// ② 归一化上下文（deterministic 与 LLM-derived 分离，见 §5）
export interface NormalizedContext {
  raw_input: string                                  // deterministic：原样
  bounded_turns: ConversationTurn[]                  // deterministic：既有 8轮/1600字符 预算
  workspace_metadata: { cwd?: string; name?: string } // deterministic：来自 session 头
  // LLM-derived 字段显式带 provenance，且只能由 classifier/compiler 产出：
  llm_derived?: {
    user_goals: ProvenanceRecord[]
    rejected_directions: ProvenanceRecord[]          // 仅用户自己的否定/推翻可入
    known_constraints: ProvenanceRecord[]
  }
}

// ③ Provenance（§5 重点）
export type ProvenanceSource = 'USER_EXPLICIT' | 'CONTEXT_EXPLICIT' | 'WORKSPACE_FACT' | 'OPTIMIZER_SUGGESTED' | 'UNKNOWN'
export interface ProvenanceRecord {
  id: string
  text: string                    // 语义单元（最小粒度要求/事实/建议）
  source: ProvenanceSource
  evidence: string[]              // 逐字 quote：必须匹配 raw_input 或 context 中 user 消息
  confidence: 'high' | 'medium' | 'low'
  note?: string
}

// ④ 编译输出（compiler 协议 + OptimizerOutput 扩展）
export interface CompileResult {
  prompt_type: PromptType
  confidence_level: 'High' | 'Medium' | 'Low'       // UI 层：由 confidence_internal 阈值映射
  diagnosis: string                                  // 需求诊断（UI 展示）
  explicit_requirements: ProvenanceRecord[]          // USER_EXPLICIT（必带 quote）
  context_requirements: ProvenanceRecord[]           // CONTEXT_EXPLICIT（仅 user 消息证据）
  suggested_requirements: ProvenanceRecord[]         // OPTIMIZER_SUGGESTED（独立段落，禁止混入上述两组）
  unknowns: ProvenanceRecord[]                       // UNKNOWN / NEEDS_USER_INPUT
  missing_constraints: string[]
  optimized_prompt: string
  strategy_version: string
  provenance_ok: boolean                             // validate 通过标志（false → UI 警示）
}

// ⑤ 策略契约（§7）
export interface PromptStrategy {
  type: PromptType
  name: string
  version: string                    // 策略独立版本（升级策略不改插件版本）
  purpose: string
  required_sections: string[]        // 输出契约段落（测试断言锚点）
  optional_sections: string[]
  preservationRules: PreservationRule[]   // §9
  suggestionRules: SuggestionRule[]
  guards: Guard[]                    // 输出守卫（anti-drift 检查）
  provenanceRules: ProvenanceRule[]
  buildSystem(lang: 'zh'|'en'): string
  buildUser(vars: CompileVars): string
  outputContract: OutputContract
}

// ⑥ 校验结果
export interface ValidationResult {
  ok: boolean
  problems: { severity: 'warn' | 'error'; rule: string; detail: string }[]
}
```

协议兼容：`optimize` 请求体新增可选字段 `promptType?: PromptType`（旧字段不变）；SSE 事件新增 `meta`（旧 `delta/done/error` 不变）——**完全向后兼容**。

---

## 5. Provenance Design（重点章节）

### 5.1 目标与红线

> 插件必须"尽可能区分哪些信息来自用户，哪些是优化器建议"；**最担心的失败模式是：优化器理解错用户，然后把自己推断的东西伪装成用户要求。**

红线（写进 compiler system prompt + guards + tests）：
1. OPTIMIZER_SUGGESTED 的内容**永不进入** optimized_prompt 的"要求"部分——只能出现在带"建议（可忽略）"前缀的独立段；
2. 任何 explicit requirement 必须有**逐字 quote** 证据（raw_input 或 context 中 user 消息）；找不到 → 自动降级为 suggested/unknown 或触发 guard 警告；
3. Assistant/Agent 的发言**永不能**作为用户意图证据（只能标记 medium/low 的"可能相关"提示语）；
4. 无证据可查的关键信息 → 标 `UNKNOWN`，编译为 `[待补充: …]`，禁止自行假设。

### 5.2 五类来源（MVP 生效）

| Source | 含义 | 证据要求 | 产出位置 |
|---|---|---|---|
| USER_EXPLICIT | 用户本轮明确表达 | raw_input 逐字子串 | explicit_requirements |
| CONTEXT_EXPLICIT | 最近对话中**用户**明确表达 | context 中 user 消息逐字子串 | context_requirements |
| WORKSPACE_FACT | workspace metadata 可验证的确定性事实 | 确定性读取（cwd/workspace name） | context_requirements（若被引用） |
| OPTIMIZER_SUGGESTED | 优化器为提升质量主动建议补充 | 无（但必须显式标注"建议"） | suggested_requirements |
| UNKNOWN | 证据不足 | 无（不得假设） | unknowns / missing_constraints |

### 5.3 产出机制

- **classifier**：输出 `evidence_quotes`（逐字引用用户原话/上下文 user 消息，机械校验——借鉴 WestFox quote-audit 思想，**独立实现**，BSD-3 允许借鉴设计）；
- **compiler**：按"四段协议"输出（`## 明确要求` / `## 上下文已确认` / `## 优化器建议（可忽略）` / `## 待补充`），每段条目附 `[quote: …]`；解析层把四段拆为 ProvenanceRecord 列表；
- **validate（机械比对）**：`core/validate.ts` 对每条 explicit/context 记录的 quote 做 `raw.includes(quote) || contextUserMessages.some(m => m.includes(quote))` 字面比对（参考 WestFox `validateProvenance` 思路，不复制其代码）；失败 → `provenance_ok=false` + UI 警示横幅 + 该条降级展示；
- **UI 展示**：四组分别渲染（§10），不同底色/前缀；suggested 组带"优化器建议"标签。

### 5.4 防"suggested→explicit"的强制点

1. 协议强制：`CompileResult` 分段不可合并（类型层面）；
2. 守卫强制：validate 扫描 optimized_prompt 文本——建议段条目出现在要求段 → error；
3. 测试强制：provenance.spec 用例矩阵（见 §11 Regression）；
4. Human Gate：P01 契约评审（G-1）。

### 5.5 License 边界

- 借鉴设计（quote 字面比对、分段注入、来源身份）：来自 WestFox（BSD-3，**合法**）；
- linshenkx/zhangjiazhi（AGPL）：**只读思想**（数据模型形态、守卫分层），实现全部自写；任何一行代码/模板文本/测试不得复制；merge 前 grep 检查（Git Rules）。

---

## 6. Classifier Design

- 架构：**Two-call**（REPORT §10 已论证）；MVP **无** heuristic classifier（明确不做）。
- AUTO 流程：classifier LLM 调用 → JSON 解析（复用 Y1X1n parse 容错 + thinkFilter）→ 失败/低置信回退：
  - `confidence_internal < 0.6` → type 仍用，但 UI 显示"低把握 + 建议检查类型"；
  - 解析失败 → `general` + `confidence_level='Low'` + 提示可手动选择；
- **防误判三规则**（写入 classifier system prompt + 测试）：
  1. 以**当前输入**为判断对象；历史讨论仅供参考；
  2. 区分"当前请求" vs "之前讨论过的内容"：当前请求是 user/message 源且时间最近的主谓；讨论仅能辅助判断意图方向；
  3. Assistant 建议 ≠ 用户决定：rejected_directions / known_constraints **只能从用户自己的否定/肯定发言提取**。
- 多意图输入：classifier 输出主类型 + `missing_constraints` 注明"疑似含规划+执行双重意图"；MVP 不拆分子请求（NON-GOAL：不自动拆分）。
- 手动覆盖：`promptType` override 直达 compiler（UI 永远最高优先级；classifier 完全不调用）。
- 输出契约：`ClassifierResult`（§4①）。temperature=0；maxTokens=512；lowest reasoning（沿用 resolveLowestEffortCached）。

## 7. Strategy Registry Design

- `src/core/strategies/` 每类型一文件 + `_shared/`（通用规则段），全部**纯数据+纯函数**，零 ctx.llm/UI/Host 依赖，独立 `version`，独立测试，可独立升级而不动插件。
- 策略元数据契约：§4⑤ `PromptStrategy`（含 required_sections / preservationRules / suggestionRules / guards / provenanceRules）。
- 注册表：启动时按 type 收集索引；`get(type)` 未知 → `general`；暴露 `list()/getVersion()/getSections()`；版本进 CompileResult（可审计）。
- 各策略 sections 基线（REPORT §11 落地，每个都是 test 锚点）：
  - research：Background / Research Goal / Existing Knowledge / Constraints / Candidate Approaches / Research Questions / Assumptions To Verify / Evidence Requirements / Source Priority / Conflicting Evidence / Evidence Gaps / Continue-search Conditions / Comparison Dimensions / Human Decision Points / Research Completion Criteria（纪律："Evidence before conclusion"、"没有案例≠不可行"、遇到 CUDA-only 类发现必须引导替代路径研究）
  - planning：Goal / Why / Preconditions / Inputs / Executor / Tools / Phases / Tasks / Dependencies / Exact Steps / Outputs / Tests / Acceptance Criteria / Failure Handling / Stop Conditions / Next Step Condition
  - execution：Current Task / Goal / Preconditions / Allowed Scope / Forbidden Scope / Inputs / Executor / Tools / Exact Actions / Tests / Acceptance / Failure Handling / Git·State Rules / Stop Conditions / Handoff
  - diagnostic：Symptom / Expected Behavior / Actual Behavior / Evidence Collection / Reproduction / Hypotheses / Root Cause Analysis / Disprove-Verify / Fix Proposal / Regression Test（纪律：验证先于修改）
  - review：Review Target / Original Goal / Requirements / Evaluation Criteria / Evidence / Deviations / Missing Items / Risks / Suggested Corrections
  - creative：Creative Goal / Audience / Platform / Style / Reference / Constraints / Structure / Tone / Output Format / Avoidances / Success Criteria
  - general：吸收 Y1X1n 现有 template/intent 双模式 + 八板块结构（角色/任务/输入/输出/内容/风格/约束/成功标准；板块来自 Co1ombiagly spec 思想，独立撰写文案）
- 共享规则段（`_shared/`）：保真原则、语言匹配、`[待补充:]` 纪律、建议标注纪律、禁入集合处理。

## 8. Compiler Design

Compiler 完成 10 步（§7 of spec）：Intent Preservation → Context Reconstruction（保守，§5.2 口径）→ Missing Information Detection → Hidden Constraint Detection（仅当有 evidence，带 quote）→ Risk/Ambiguity Detection（写入 diagnosis）→ Strategy-specific Structuring（registry）→ Output Contract Construction → Anti-drift Constraints（§9）→ Provenance Preservation（四段协议）→ Final Compilation。

- 输出：`CompileResult`（§4④）；compile 阶段也走 `llm.stream` + thinkFilter + 容错解析；输出协议用标记段（如 `<<<EXPLICIT>>>…<<<SUGGESTED>>>…<<<OPTIMIZED>>>…<<<END>>>`，复用 Y1X1n 标记模式扩展，解析层新建 `parseCompileOutput()`，纯函数可单测）。
- 关键规则："不替用户发明约束"——compiler system 硬性指令 + guards：
  - 允许：重组/澄清/明确输出格式/暴露缺失/推荐可选约束（suggested 段）/提醒风险/建议研究问题；
  - 禁止：讨论过的方向→已确认路线；推断→明确要求；没有案例→不可行；候选→最终方案；凭空生成预算/时间/平台/模型/技术栈硬约束；Assistant 建议当用户决定。
- `diagnosis` 内容：目标清晰度/上下文完整性/约束边界/结构表达/输出规格（吸收 Y1X1n ANALYSIS 五维 + 风险/歧义提示）。

## 9. Validation / Anti-drift Design

`core/validate.ts`（纯函数，无 LLM），三层（借鉴 zhangjiazhi 守卫分层思想，独立实现）：

1. **Preservation Rules（保真）**：explicit 段每条有 quote；required_sections 齐全；原输入的对象/方向/数量/范围/禁止项/术语在 optimized_prompt 中可寻（占位符/关键词级断言）；
2. **Inference & Suggestion Rules**：suggested 条目不得出现在要求段；"不可行/确定/最终/必须"类强断言只能在有 quote 证据时出现；无证据的量化（时间/预算/平台/模型）→ error；建议可标"如无特别说明/默认"措辞；
3. **Unknown Rules**：evidence 不足的关键信息必须落 `[待补充: …]` 或 unknowns 段；出现"自行假设的硬约束"→ error。
每个问题带 `{severity, rule, detail}`；`provenance_ok=false` 时 UI 顶部警示（复用 Y1X1n warnBanner），**结果仍可替换但必须显式告知**。

## 10. UI Design

基于 Y1X1n 全套（button/dock/settings/i18n），新增：

```
composer 输入卡： [AUTO ▾] [✨ 优化]        （优化按钮旁下拉：AUTO/Research/Planning/
                                             Execution/Diagnostic/Review/Creative）
第一阶段： “正在识别任务类型…”
第二阶段： “正在优化 Prompt…”               （meta 到达后切换）
结果面板：
  任务类型： Research                    [把握: 高|中|低]（低 → 黄条“可能是 Research / Planning，请检查类型”）
  需求诊断： ▸ 可折叠（五维 + 风险/歧义提示）
  来自你的明确要求： ✓ 逐条（每条旁可 hover/title 显示 quote 证据）
  从上下文确认：    ✓ 逐条（仅 user 消息证据；WORKSPACE_FACT 标来源）
  优化器建议补充：  ✎ 逐条（独立样式，前缀"建议（可忽略）"）
  仍需补充 / 不确定： [待补充: …] 清单
  优化后的 Prompt： 流式（沿用 live 分段）
  [替换输入框] [复制] [重新优化] [关闭]    （沿用 undo/Esc/发送即关闭/斜杠前缀/撤回）
```
- **Confidence 展示规则**：内部 `confidence_internal: 0..1` 不展示数值；映射 `≥0.8 High / ≥0.6 Medium / else Low`；低置信提示语 + 手动覆盖永远优先；
- Provenance 四组颜色/前缀复用现有设计令牌（dsw-alias-*）；零新依赖；
- 完全保留：streaming / SSE / settings（新增"默认类型、分类参数"2-3 字段）/ i18n（新增文案可回退中文）。

## 11. Testing Architecture

### 11.1 分层

| 层 | 内容 | 框架 |
|---|---|---|
| Unit | classifier / registry / strategies / compiler / provenance / validation / context（纯函数） | node:test（沿用） |
| Host Integration | classify→compile 编排、manual override、fallback、SSE 事件序（meta→delta→done）、abort、timeout、provider fallback、CSRF 回归 | 真 Context + mock llm（沿用 smoke 模式） |
| UI | dropdown 状态、四组 provenance 渲染、replace/undo/re-optimize/cancel、流式状态机 | controller.test 扩展 + 手测 |
| Compatibility | DSH Desktop 2.0.15（dsh 0.1.7-rc.2 / cordis 4.0.4）双版本探测回归 | smoke 现有路径 |
| Behavioral Regression | 真实 prompt corpus 自动检查（见下） | 新 runner，node:test 兼容 |
| Effect Regression | "优化后是否更准确"（见下） | 新 runner + evaluator |

### 11.2 Behavioral / Effect Regression（MVP 强制阶段 P07）

**数据集**：`test/regression/fixtures/`，JSON 每例：
```json
{
  "id": "research-comfyui-mac",
  "raw_input": "帮我研究 Mac 上怎么用 ComfyUI 做 AI 视频，我看到黑鹤001低显流，还有 H3。",
  "context": ["（若真实历史有）最近对话 turns"],
  "expected_type": "research",
  "type_alternatives": ["planning"],
  "invariants": [   // 必须保留：deterministic 断言（字符串/正则/规则）
    {"desc": "不得把 MiniMax API 写成已确认路线", "prohibit": "MiniMax(已确认|确定|采用)"},
    {"desc": "不得淘汰黑鹤001", "prohibit": "黑鹤001(不可行|淘汰|放弃)"},
    {"desc": "不得发明预算/时间", "prohibit": "预算|万元|人民币|¥"},
    {"desc": "应暴露证据缺口", "require": "待补充|待确认|证据"}
  ],
  "prohibited_drift": [...],
  "effect": {     // 可选：model-assisted 判定
    "evaluator_prompt_id": "intent-fidelity-v1",
    "questions": ["优化后的 Prompt 是否比原文更清楚地表达用户意图？", ...]
  }
}
```
初始语料 = 本规划 §4-E 六个 golden examples（RESEARCH/PLANNING/EXECUTION/DIAGNOSTIC/REVIEW/CREATIVE），由 Human Gate G-3 确认后固化；后续每次策略迭代可追加。

**Runner**（`test/regression/run.mjs`）：逐例执行 分类→编译（mock llm 或真实 llm 可切换）→
- **deterministic 检查（优先）**：invariants/prohibited 用字符串/正则断言——能自动判定的绝不依赖 evaluator；
- **model-assisted 检查**：evaluator 读 raw vs optimized 回答固定问题（是/否+一句理由）。Evaluator 配置：默认当前会话模型，temperature=0，固定提示词 id（intent-fidelity-v1）；**防自身不稳定**：a) 只做结构/保真打标不做分数排序；b) 失败重跑一次，重跑不一致不计 PASS（借鉴 zhangjiazhi effect-regression 纪律思想）；c) 报告逐条带理由，x/N 通过率；d) evaluator 结果只做参考线，**DoD 以 deterministic + Human 判定为准**。
- 输出：`test/regression/report-<date>.json` + 控制台摘要；回归失败 = Stop Condition S-08。

### 11.3 关键验收口径

"通过"= deterministic 全过 + （model-assisted 通过率 ≥ 阈值，阈值由 Human 在 G-3 定）+ Human 抽检通过。**Unit 全绿 ≠ 完成**（P07 强制）。

---

## 12. Phase Map（P00–P09）

```
P00 Fork & Baseline ──► P01 Core Contracts & Provenance ──► P02 Strategy Registry
   │                        │                                   │
   ▼                        ▼                                   ▼
P05 Host Pipeline ◄──────── P04 Validator ◄── P03 Classifier ──┘
   │
   ▼
P06 UI Integration ──► P07 Behavioral/Effect Regression ──► P08 Isolated DSH Integration
                                                              │
                                                              ▼
                                                         P09 Release Candidate
```
依赖：P01 ← P00；P02 ← P01；P03 ← P01（可用 P02 部分策略做测试桩）；P04 ← P01+P02；P05 ← P03+P04；P06 ← P05（UI 可提前并行做 mock 版，但合并验收在 P05 后）；P07 ← P05+P06（behavioral 与 UI 半并行）；P08 ← P07；P09 ← P08。**P07 之前任何阶段不得声称"完成"，P08 之前不得装任何 profile。**

## 13. Detailed Task Contracts

执行约定：Executor 字段 = DSH / Claude Code / Human；Tools 明确工具面；每个 Task 完成以 Acceptance Criteria 全过为准，未过→Failure Handling。

### P00 — Fork & Baseline

**P00-T01 建立开发副本与基线验证**
- Goal：安全独立开发副本 + 在当前 DSH 2.0.15 可 build/test。
- Why：S-01 的验证点；确认 REPORT 底座事实未漂移（S-02/S-04 检查）。
- Preconditions：Human Gate G-0（用户确认 fork 仓库名/目录/是否开始）。
- Inputs：REPORT.md §2 基线事实；upstream URL。
- Allowed Scope：新建独立目录/仓库；npm install 于该目录；不动任何 DSH profile/配置。
- Forbidden Scope：不装进 desktop profile；不 npm link；不改 ~/.dsh；不 push upstream。
- Executor：DSH（clone/环境）+ Claude Code（如 baseline 修复）。
- Tools：git、node/npm（或 pnpm）、Y1X1n scripts/build.mjs、test 三件套。
- Exact Steps：1) 创建目录与 fork remote（Human 授权后）；2) `git clone upstream` 到本地；3) 打基线标签 `base-y1x1n-v0.4.0`；4) `npm install && npm run build && npm test`；5) 记录三件套全绿证据；6) 核对 src 结构与 REPORT 一致（diff 检查关键路径：index.ts/prompt.ts/client/controller.ts 等）；7) 产出 `BASELINE.md`（环境版本、测试结果、与 REPORT 差异清单）。
- Expected Outputs：BASELINE.md + 全绿测试记录。
- Tests：`npm test`（smoke/prompt/controller 三件套全绿）。
- Acceptance：①build+test 全绿；②与 REPORT 描述无重大差异（若有差异→S-02/S-04）；③环境确认为 DSH 2.0.15 / dsh 0.1.7-rc.2 / cordis 4.0.4。
- Failure Handling：环境装不上 → 停止并报告（S-01）；差异重大 → STOP 报告。
- Stop Conditions：S-01/S-02/S-04。
- Docs Update：BASELINE.md；README 阶段说明。
- Git Rules：仅本地 commit；不 push upstream；`base-y1x1n-v0.4.0` tag。
- Next Transition：G-1 后进入 P01。

### P01 — Core Contracts & Provenance

**P01-T01 定义核心契约类型（types.ts）**
- Goal：§4 全部类型定稿并编译通过。
- Why：全插件的数据契约；后阶段全部依赖。
- Preconditions：P00 通过。
- Inputs：§4 契约草案。
- Allowed Scope：仅 `src/core/types.ts` + 对应测试；**不动 UI/Host/现有 prompt.ts**。
- Forbidden Scope：任何实现逻辑；任何对现有行为的影响。
- Executor：Claude Code（实现）+ DSH（验收）。
- Tools：tsc/esbuild、node:test。
- Exact Steps：实现契约类型→类型级自检（写编译期断言样例）→单测（构造各类型实例的合法性断言）。
- Expected Outputs：types.ts + types.spec。
- Tests：编译通过 + 边界值（confidence 越界/空 evidence/未知 type 拒绝）。
- Acceptance：契约冻结清单由 Human Gate G-1 签字。
- Failure Handling：契约不清晰→回到 Human 澄清；类型设计冲突→DSH 裁决。
- Stop Conditions：S-03/S-05。
- Docs Update：docs/contracts.md。
- Git Rules：`phase/p01-contracts` 分支；小步 commit。
- Next Transition：P01-T02。

**P01-T02 Provenance 数据结构与机械校验器**
- Goal：ProvenanceRecord + validateProvenance（quote 字面比对）+ 分段协议解析骨架。
- Why：§5 第一优先级；防"推断伪装成用户要求"。
- Preconditions：P01-T01。
- Inputs：§5.2/5.3 设计。
- Allowed Scope：src/core/provenance.ts + test/provenance.test.mjs（纯函数）。
- Forbidden Scope：任何 LLM 调用；UI。
- Executor：Claude Code。
- Exact Steps：实现五类来源判定 + quote 比对 + 降级规则 → 用例矩阵测试。
- Expected Outputs：provenance.ts + 测试。
- Tests：矩阵——quote 在 raw/context-user/context-assistant/不存在/unicode 空白变体/大小写；
  - 核心断言：assistant 消息中的 quote 一律不算 CONTEXT_EXPLICIT；落在 explicit 段的条目无 quote ⇒ provenance_ok=false。
- Acceptance：全矩阵绿；S-07 检查点（机制有效）。
- Failure Handling：比对误报偏高→调整规范化（先测）；失败 → STOP（S-07）。
- Next Transition：P02。

### P02 — Strategy Registry

**P02-T01 共享规则段（_shared）**：保真原则/语言匹配/待补充纪律/建议标注/禁入集合处理。纯函数。
**P02-T02..T08 七个策略（research/planning/execution/diagnostic/review/creative/general）**，每个独立 Task：
- Goal：该策略 PromptStrategy 完整实现（sections/buildSystem/buildUser/outputContract/rules/guards/provenanceRules）。
- Why：不同类型真正使用不同策略；可独立测试/版本化/升级。
- Preconditions：P01。
- Inputs：§7 sections 规范 + 用户四-E 六示例的验收线。
- Allowed Scope：`src/core/strategies/<type>.ts` + `test/strategies-<type>.test.mjs`。
- Forbidden Scope：ctx.llm、UI、Host。
- Executor：Claude Code。
- Exact Steps：策略文案撰写（中文优先，双语同构可选）→ sections 锚点测试 → guards 自测用例。
- Tests：required_sections 全出现；suggestionRules 样例命中；guards 样例触发；prohibited（用例来自四-E 验收）。
- Acceptance：策略单测全绿；Human Gate G-2 对策略内容抽审（尤其 research/planning 两条铁律）。
- Failure Handling：策略文案与用户示例验收不符→退回修订（不出阶段）。
- Next Transition：P02-T09。
**P02-T09 Registry 与版本化**：索引/fallback general/version 暴露/list()。测试：未知类型→general；版本独立递增。
**P02 出口验收**：七策略+registry 全绿；不改 UI 即可"换策略"（编译产物独立）。

### P03 — Intent Classifier

**P03-T01 classifier 提示词与解析器（纯函数）**：system/user 构建、JSON 契约、容错解析、thinkFilter 复用、多意图标注、回退 general。
**P03-T02 classifier LLM 调用宿主侧接入（暂不接 pipeline）**：封装一次小调用（maxTokens 512/temp 0/lowest reasoning/超时），输出 ClassifierResult。
**P03-T03 防误判规则测试**：当前请求 vs 历史讨论；assistant 建议≠用户决定；手动覆盖旁路（override 时不发分类调用，函数级验证）。
- Allowed Scope：src/core/classify.ts + host 侧独立函数（不修改现有 handler 主路径）。
- Forbidden Scope：UI；修改现有 optimize 流。
- Tests：fixtures（含"上面提到的那个方案怎么样"类多意图/指代输入）判定正确；assistant-only 上下文不产生 explicit。
- Acceptance：分类稳定性抽查（同一输入 2 次同结果）；失败回退 general；S-06 检查点。
- Next Transition：P04。

### P04 — Compiler + Validation

**P04-T01 compiler（core/compiler.ts）**：四段协议输出提示词 + parseCompileOutput（标记解析、容错、thinkFilter）+ 10 步编排。
**P04-T02 输出守卫（core/validate.ts）**：三层（保真/推断建议/未知）+ guards 汇总执行 + 结构化 ValidationResult。
**P04-T03 compiler 集成测试**：手工 override 每种类型输出契约齐全；missing 注入 `[待补充:]`；suggested 独立段；provenance_ok 联动。
- Allowed Scope：core 层纯函数 + 测试。
- Forbidden Scope：UI/Host 主路径。
- Acceptance：anti-drift 全用例（§9 禁令样例）绿；S-07 复审通过。
- Next Transition：P05。

### P05 — Host Pipeline Integration

**P05-T01 handler 两阶段编排**：请求体 `promptType` 可选解析 → normalize → （AUTO: classify 调用）→ registry → compile 调用 → validate → SSE meta 事件（type/confidence_level/missing/rationale + provenance_ok）→ delta → done 扩展。
**P05-T02 兼容回归**：现有 resolveRoute/超时/断连/fallback/CSRF/settings 全不动前提下全绿。
- Allowed Scope：src/index.ts handler 内部（+~60 行）；协议扩展向后兼容。
- Forbidden Scope：路由/设置/安全层改写；UI。
- Executor：Claude Code（实现）+ DSH（回归判定）。
- Tests：smoke 全部旧用例 + 新增 meta 序/override/fallback 用例。
- Acceptance：旧用例全绿（证明零破坏）+ 新用例绿；S-03 检查点（未大量重写 Host）。
- Next Transition：P06。

### P06 — UI Integration

**P06-T01 AUTO 下拉 + 手动覆盖**（OptimizeButton + controller state）。
**P06-T02 结果面板四组 provenance 渲染 + 类型徽章（高/中/低）+ 低置信提示 + 缺口清单**（ResultDock）。
**P06-T03 settings 加字段（默认类型/分类参数）+ i18n。**
- Allowed Scope：client 三个文件 + 设置卡 + i18n。
- Forbidden Scope：改变现有交互语义（undo/Esc/auto-close/slash 全部保留）。
- Tests：controller.test 扩展（override 状态、meta 落盘、置信度映射）；手测清单（Human G-4 前的基础冒烟）。
- Acceptance：既有 UI 冒烟全过 + 新交互手测通过。
- Next Transition：P07。

### P07 — Behavioral / Effect Regression（强制）

**P07-T01 语料固化**：六 golden examples + 用户真实历史需求（Human 提供/确认）；JSON fixtures + invariant/prohibited 编写。
**P07-T02 runner 实现**：deterministic 断言层 + model-assisted evaluator（intent-fidelity-v1，temp 0，重跑纪律）+ 报告输出。
**P07-T03 首轮回归执行与调优**：全例跑通；失败例逐条分析 → 回修策略/分类器（走各自阶段分支）→ 复跑；产出 regression 报告。
- Allowed Scope：test/regression/** + 对策略/分类器文案的修订（提交路径回到 P02/P03 已验收模块）。
- Forbidden Scope：为过回归而放宽 invariants（不得弱化验收）。
- Tests：deterministic 全绿为准；model-assisted 为参考线；Human G-5 抽检关键用例。
- Acceptance：S-08 不触发（优化后不得比原文更容易曲解）；report 存档。
- Failure Handling：某类型反复失败 → 该类型 STOP + 专项诊断（可能 S-06/S-08）。
- Next Transition：P08。

### P08 — Isolated DSH Integration

**P08-T01 隔离 profile 安装与冒烟**（独立 dev profile，不碰正式）。
- 验证项：button/dropdown/streaming/cancel/replace/undo/settings/context/override/AUTO/fallback/CSRF 回归。
**P08-T02 桌面端实测**（DSH Desktop 2.0.15 本机隔离开测）：截图留档 + 问题清单。
- Allowed Scope：独立 dev profile 及其数据；插件包构建产物。
- Forbidden Scope：正式 desktop profile；PAB；个人工作台配置。
- Tests：冒烟清单全过；S-09 检查点。
- Acceptance：Human Gate G-6（用户体验认可）。
- Next Transition：P09。

### P09 — Release Candidate

**P09-T01 全量回归**（unit+integration+behavioral+effect）+ 正式 profile 备份 + 安装演练（先备份后装）。
**P09-T02 发布产物**：版本 tag（v0.1.0-apo）、CHANGELOG、README 更新（厂商致谢与 NOTICE）。
- Allowed Scope：正式 profile 的**安装动作**（仅在 G-7 授权后）；仓库发布。
- Forbidden Scope：卸载前无备份禁止操作；PAB 任何写入。
- Acceptance：DoD（§18）全过 + G-7（用户正式安装许可）。
- Failure Handling：装后冒烟失败 → 回滚备份（Release rollback 预案）。
- Next Transition：产品进入使用；后续增强按新契约流程。

## 14. Human Gates（必须由用户确认）

| Gate | 时机 | 确认内容 |
|---|---|---|
| G-0 | P00 前 | fork 仓库名/本地目录/是否开始（本规划确认即 G-0 的第一项） |
| G-1 | P01 后 | 核心契约与 Provenance 数据结构定稿 |
| G-2 | P02 后 | 七个策略内容抽审（铁律/措辞/边界） |
| G-3 | P07 前 | effect 语料集定稿 + model-assisted 通过阈值 |
| G-4 | P06 后 | UI 基础冒烟预览认可 |
| G-5 | P07 后 | regression 报告认可（含失败例处置） |
| G-6 | P08 后 | 隔离 profile 用户体验认可 |
| G-7 | P09 前 | **正式安装许可**（唯一允许动正式 profile 的开关） |

## 15. Stop Conditions

沿用项目治理（契约不一致 STOP，不擅自换大架构）。S-01..S-10 原样生效；触发时：**停止推进 → 报告原因与证据 → 等待用户裁决**。附加两条执行规则：
- S-11：任一阶段 3 次验收不通过且无进展 → STOP 报告（防无效循环）；
- 触发 S-03/S-06/S-07/S-08 时，可选方案只列给用户，不自行选路。

## 16. Git & Release Strategy

- fork-point 标签 `base-y1x1n-v0.4.0`；阶段分支 `phase/pXX-*`；合并前置条件=阶段验收全绿；
- commit 前缀规范：`pXX(task): summary`；禁止 force/rewrite；禁止提交生成物（lib/ 打包产物按上游 .gitignore）；
- License：`LICENSE`（MIT，保留上游署名）+ `NOTICE.md`（设计来源：Y1X1n MIT / WestFox BSD-3 借鉴设计 / linshenkx·zhangjiazhi AGPL 仅思想，零复制；merge 前运行 `scripts/check-license-contamination.mjs`：扫描含 AGPL 仓库特征串的复制痕迹）；
- Release：版本 `v0.1.0-apo`；CHANGELOG；正式安装前备份现 profile bundle；回滚=恢复备份+卸载插件包；
- **本规划执行期间（直至 G-7）：任何一步都不触碰正式 profile、PAB、AI 视频工作流。**

## 17. Estimated Workload（重估）

基线 REPORT：10–12 人日。本规划新增强项：Provenance 全链（数据结构/校验器/四段协议/UI 展示）+ Context 保守化 + 低置信 UI + **MVP 强制 Effect Regression**（语料+runner+evaluator+首轮调优）+ License 检查工具。

| 阶段 | REPORT 基线 | v1 规划增量 | 重估 |
|---|---|---|---|
| P00 fork/baseline | 0.5 | +0 | 0.5 |
| P01 contracts+provenance | 1.0 | +1.5（provenance 全链） | 2.5 |
| P02 strategies(7)+registry | 2.5 | +0.5（guards/provenanceRules 每策略） | 3.0 |
| P03 classifier | 1.5 | +0.5（防误判规则） | 2.0 |
| P04 compiler+validate | 2.0 | +1.0（四段协议解析/三层守卫） | 3.0 |
| P05 host integration | 1.0 | +0（编排即含） | 1.0 |
| P06 UI | 2.0 | +1.0（四组 provenance 渲染/低置信 UI） | 3.0 |
| P07 regression | 1.0（原仅估算外） | +2.0（语料/runner/evaluator/首轮调优） | 2.0（原 REPORT 未含，新增） |
| P08 isolated 集成 | 1.0 | +0 | 1.0 |
| P09 release | 0.5 | +0.5（备份/安装演练/license 检查） | 1.0 |
| **合计** | **≈11** | | **≈19 人日**（单人约 4 周；两名执行者并行（Claude Code 编码 + DSH 编排/验收）约 2.5–3 周） |

说明：P03/P04 与 P02 高度并行可压缩；P07 是门槛不是附属。**估算方差主要来自策略文案质量与回归首轮调优轮次（1–2 轮预算）。**

## 18. Definition of Done

插件真正完成 = 以下全部成立（不只"能运行"）：

1. **类型识别**：AUTO 能稳定区分 7 类（含 general fallback），手动覆盖始终优先；
2. **策略真实生效**：research/planning/execution/diagnostic/review/creative 使用不同策略与输出契约（sections 断言 + 策略独立版本）；
3. **意图保留**：优化稿中 explicit 要求的每条都有用户原话 quote 证据；`provenance_ok` 校验通过；UI 四组来源清晰可审计；
4. **不替用户发明**：suggested 永不混入 explicit；"不可行/最终/确定"类强断言无证据即告警；`[待补充:]` 覆盖所有 evidence 不足项；
5. **Effect Regression 通过**：六 golden + 真实语料全部通过 deterministic invariants；model-assisted 达到 Human 认可阈值；报告存档；
6. **稳定运行**：DSH Desktop 2.0.15（dsh 0.1.7-rc.2 / cordis 4.0.4）隔离 profile 与正式 profile 均稳定；不破坏现有任何功能（全量回归绿）；
7. **不影响周边**：PAB / 个人工作台 / AI 视频工作流 / 其它插件零改动零影响；
8. **用户完整闭环可用**：输入一句口语需求 → 点优化 → 得到类型正确、结构完整、含来源标注、明显更准确的 Prompt → 检查/编辑 → 替换输入框 → 自己发送；全程无自动发送/自动执行/自动决策；
9. **License 清洁**：MIT 署名保留；无 AGPL 代码复制（check 脚本绿）；NOTICE.md 完整；
10. **可维护**：策略升级不改 UI（contract 隔离）；全部新增纯函数有单测；回归可重跑。

---

**规划完成。按停止条件：不 fork、不 clone 正式开发仓库、不写码、不安装、不改 DSH——以上等待用户确认（G-0 + 本规划认可）后再进入正式开发。**