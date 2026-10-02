# Provenance（来源标注）— 定稿语义 v1

> 状态：**定稿**（Human Gate G-1 通过，2026-10-03）。本文档只整理已定稿的五源语义、
> 验证规则与示例，**不新增契约、不改变现有行为**。真值实现：
> `src/core/provenance.ts`（校验器）＋ `src/core/types.ts`（数据结构）＋
> `test/provenance.test.mjs`（pv1–pv19 断言矩阵）。

## 1. 设计目标

插件必须区分「信息来自用户」与「优化器推断/建议」，防止优化器把我们推断出的内容
伪装成用户要求。所有比对都是**机械字面比对**（无 LLM、无语义推断）。

## 2. 五源语义（定稿）

| Source | 含义 | 证据要求 | 产出位置 |
|---|---|---|---|
| `USER_EXPLICIT` | 用户**本轮**明确表达 | 必须存在于当前 raw user input | `explicit_requirements` |
| `CONTEXT_EXPLICIT` | 最近对话中**用户**明确表达 | 必须存在于历史 **user** message | `context_requirements` |
| `WORKSPACE_FACT` | 可机械验证的环境/工作区事实 | 证据可为空（metadata 本身确定性）；若有证据则按 context 规则查验，不可验证仅 warn | `context_requirements` |
| `OPTIMIZER_SUGGESTED` | 优化器为提高质量主动建议 | 无需证据；**必须保持建议身份**，不得升级成用户约束/决定 | `suggested_requirements` |
| `UNKNOWN` | 当前证据不足 | 无需证据；**必须保持未知**，Compiler 不得自行补成事实 | `unknowns` / `missing_constraints` |

**G-1 确认的 7 条原则（不可违反）**：
1. USER_EXPLICIT 必须有当前 raw user input 证据；
2. CONTEXT_EXPLICIT 必须来自历史 user message，**不得仅来自 assistant message**；
3. **assistant-only 永远不能作为"用户已经明确要求/确认"的证据**（命中仅发 warn，绝不 upgrade）；
4. OPTIMIZER_SUGGESTED 保持建议身份，不得升级成用户约束或决定；
5. UNKNOWN 保持未知，不得由 Compiler 自行补成事实；
6. WORKSPACE_FACT 仅限可机械验证的环境/工作区事实；
7. **quote matching 当前保持大小写不折叠**（保守逐字）；后续若真实语料证明召回不足，再单独评估调整，**不在 G-1 扩大范围**。

## 3. 文本规范化（normalizeQuoteText）

比对前先规范化，**仅做**：
- 折叠连续空白（`\s+` → 单个空格）＋ trim；
- 剥离首尾引号（`' " ` ‘ ’ “ ”`）与首尾句读（`。！？,.!?;` 等，见实现 `EDGE_NOISE`）；
- **不做大小写折叠**；
- 规范化后为空串的 quote 永不匹配（避免 `includes("")` 恒真）。

## 4. 来源判别（resolveQuoteSource）

按优先级逐级判定单条 quote：

1. raw input 命中 → `valid=true / matchedIn='raw' / USER_EXPLICIT / high`
2. 上下文 user 消息命中 → `valid=true / matchedIn='context-user' / CONTEXT_EXPLICIT / high`
3. 仅 assistant 消息命中 → `valid=false / matchedIn='assistant-only' / UNKNOWN / low`
   （assistant 发言**永不能**作为用户意图证据）
4. 无处命中 → `valid=false / matchedIn='none' / UNKNOWN / low`

## 5. 整组校验（validateProvenance）

- `USER_EXPLICIT`：至少一条 evidence quote 在 raw input 中 valid 匹配；否则 **error**；evidence 为空数组 → **error**；
- `CONTEXT_EXPLICIT`：至少一条 evidence quote 在上下文 user 消息中 valid 匹配；否则 **error**；evidence 为空 → **error**；
- `WORKSPACE_FACT`：evidence 可为空（豁免）；若有 evidence 按 context-user 规则查验，仅 assistant 命中/不可验证 → **warn**；
- `OPTIMIZER_SUGGESTED` / `UNKNOWN`：豁免（无需证据，不产生 issue）；
- 仅 assistant 命中的 explicit/context 证据 → **warn**（不 upgrade、不影响 ok，除非该记录完全无其他证据 → error 由上面规则覆盖）；
- 结果 `ValidationResult.ok = 无 error 级问题`；单 warn 不影响 ok。

## 6. 示例

用户输入："帮我研究 Mac 上怎么用 ComfyUI 做 AI 视频，我看到黑鹤001低显流。"

- quote "黑鹤001低显流" → raw 命中 → `USER_EXPLICIT / high`；
- quote "用户想比较速度、画质、内存"（raw 与历史 user 消息中都不存在）→ 无处命中 → `UNKNOWN / low`；若它由优化器提出 → 必须放 `suggested_requirements`，不得进入 explicit；
- 历史上 assistant 说过"我认为应该用 MiniMax API"而用户未表态 → quote "应该用 MiniMax API" **仅 assistant 命中** → `assistant-only`：invalid、warn，**不得**成为 CONTEXT_EXPLICIT 或用户决定；
- 会话标题/工作区名称等 metadata → `WORKSPACE_FACT`（可机械验证即可，不需 quote）。

## 7. 测试锚点

`test/provenance.test.mjs` pv1–pv19 覆盖：规范化边界、四类匹配去向、explicit/context 空证据与证据缺失的 error、assistant-only warn 语义、三类豁免、记录工厂默认值/唯一 id、组合校验（单 warn 不影响 ok）。
## 8. Cross-Strategy Invariants（G-VS 通过后追加，2026-10-03 用户确认为全局规则）

以下两条为 **cross-strategy invariant**：所有 Strategy（research/planning/execution/diagnostic/review/creative/general）、Validation 三层（Preservation/Inference·Suggestion/Unknown）与 Behavioral/Effect Regression 语料必须继承，任何策略不得推翻；新增策略必须满足它们的测试。

### A. UNKNOWN ≠ BLOCKING
- UNKNOWN 只表示"信息当前未知"，**不等于阻塞**；
- 仅当缺失信息会**实质改变当前任务方向**或导致任务无法继续时，才允许升级为 `NEEDS_USER_INPUT`（阻塞型未知）；
- 非阻塞 UNKNOWN：保留在结果中（unknowns / [待补充: …]）、**不得强制用户先回答**、下游任务应在合理边界内继续；
- 目标：避免 Prompt Optimizer 变成"问题制造器"。
- 测试锚点：大量 UNKNOWN 时 `provenance_ok` 仍为 true；优化稿把未知项写为阻塞问题（如"请先回答 X 才能继续"）→ 守卫触发。

### B. OPTIMIZER_SUGGESTED ≠ USER REQUIREMENT
- `OPTIMIZER_SUGGESTED` 永远保持"建议增强项"身份；
- **不得在最终 Prompt 中无痕升级**为：用户明确要求、必须满足的硬约束、已确认路线、Human Decision；
- 除非用户后续明确采纳（MVP 无采纳机制 ⇒ 恒为建议）；
- 测试锚点：`suggested_requirements` 的任何条目文本不得以"必须/需保证/要求/用户希望"等强约束句式出现在 optimized_prompt 的要求语境中；suggested 永不进入 explicit/context/human_decision 组（现有四项分组断言继续成立）。
