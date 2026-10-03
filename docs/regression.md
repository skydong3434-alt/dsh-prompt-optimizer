# Behavioral / Effect Regression 语料语义（P07）

> 状态：**G-3 已通过**（2026-10-04 用户预授权；14 例语料定稿）；P07-T02 双通道 runner 已实现。
> 真值实现：`test/regression/fixtures/*.json`（语料）＋ `test/regression/schema.test.mjs`
> （离线 schema / 语料级检查）＋ `test/regression/run.mjs`（P07-T02，运行期双通道 runner）
> ＋ `test/regression/run.test.mjs`（runner 自身单测）。
> 契约来源：PLAN-v1 §11.2 / §13 P07、PLAN-v1.1 R-2、`docs/provenance.md` §8。

## 1. 为什么需要语料

Unit 全绿 ≠ 产品完成（PLAN-v1 §11.3）。P07 用**真实语义语料**回答一个 unit 测不了的问题：
「优化后的 Prompt 是否比原文更准确、更完整地表达用户意图，且没有替用户发明东西」。

语料只做两件事：

1. **deterministic 层（硬 Gate）**：把「不得曲解 / 不得发明」写成字符串 / 正则断言，
   逐条可机械判定；
2. **model-assisted 层（参考线）**：`intent-fidelity-v1` evaluator 对 raw vs optimized 回答固定
   问题；**不得**覆盖 deterministic FAIL，也不得在阈值校准前当发布标准（R-2）。

## 2. Fixture schema（每例一个 JSON）

```jsonc
{
  "id": "research-comfyui-mac-h3",          // 必填；^[a-z0-9]+(-[a-z0-9]+)*$；文件名 = <id>.json
  "title": "……",                            // 可选；人读标题
  "tags": ["golden", "user-history"],       // 必填；至少含 golden | g4-regression | coverage 之一
  "source": "……",                           // 可选；来源说明（真实历史 / G-4 / G-2）
  "raw_input": "……",                        // 必填；用户本轮原始输入，原样，不截断
  "context": [                              // 可选；历史会话
    "字符串 = 历史 user 消息",
    { "role": "user|assistant", "text": "……" }
  ],
  "expected_type": "research",              // 必填；PromptType 枚举之一
  "type_alternatives": ["planning"],        // 可选；允许的次优分类（分类容错用）
  "manual_override": "planning",            // 可选；模拟 UI 手动下拉覆盖
  "invariants": [                           // 必填；deterministic 断言层
    { "desc": "……", "require": "正则" },
    { "desc": "……", "prohibit": "正则" }
  ],
  "prohibited_drift": ["……"],               // 必填；非空；人类可读的漂移清单
  "invariant_checks": [                     // 可选；cross-strategy 运行期检查（见 §4）
    { "id": "unknown-not-blocking", "desc": "……", "params": { } }
  ],
  "effect": {                               // 可选；model-assisted 参考线
    "evaluator_prompt_id": "intent-fidelity-v1",
    "questions": ["……"]
  }
}
```

规则：

- `invariants[]` 每条**必须且只能**有 `require` 或 `prohibit` 之一，值为合法 JS 正则字符串；
  `require` = 必须命中，`prohibit` = 不得命中。
- `context` 中字符串一律按**历史 user 消息**处理；assistant 消息必须显式写 `role`，
  且永远不会被当作「用户已确认」的证据（`docs/provenance.md` §2 原则 3）。
- `effect` 不得携带任何数值阈值字段（`threshold` / `pass_threshold` / `score` / `cutoff` …）：
  schema 测试会拒绝（R-2）。
- **禁止**通过弱化 / 删除 invariant 让回归变绿（PLAN-v1 §13 P07 Forbidden Scope）。

## 3. `invariants` 判定语义（P07-T02 runner）

| 层 | 输入 | 判定 |
|---|---|---|
| deterministic | 编译产物（四段协议原始输出 + `optimized_prompt`） | 每条 `require` 必须命中、每条 `prohibit` 必须不命中；任一违反 = 该例 FAIL（硬 Gate） |
| model-assisted | raw_input vs optimized_prompt | evaluator 逐问给「是/否 + 一句理由」；temperature 0；首个答案非「是」时重跑一次，重跑不一致不计 PASS；仅参考线 |

运行期文本面 = `rawOutput`（模型四段协议原文） + `optimized_prompt`：默认 anti-drift 断言看
`optimized_prompt`，而四段协议类断言（如 `planning-override-contract` 的 `<<<EXPLICIT>>>`）
需要原始协议文本；两者都属编译产物，合并判定可同时覆盖「交付稿漂移」与「协议段落漂移」。

硬性纪律（P07-T02 实现，`test/regression/run.mjs`）：

- `overall` 只由 deterministic 决定：evaluator 给「是」也不能把 deterministic FAIL 翻成 PASS
  （`evaluator 不得覆盖 deterministic FAIL`，runner 单测 rr3 硬断言）；
- evaluator **不是**硬 Gate：deterministic PASS 而 evaluator FAIL 时该例仍记 PASS，仅以
  `reference_mismatch` 标注，供 P07-T03 / G-5 人工判读；
- evaluator 失败重跑不一致 → `inconsistent`，不计 PASS（S-08 防误伤）。

`optimized_prompt` 是 anti-drift 断言的默认文本面；涉及来源分组 / 四段协议的断言（如
`planning-override-contract`）由 `invariant_checks` 在运行期对完整 `CompileResult` 判定。

## 4. `invariant_checks` canonical 检查表

`invariant_checks[].id` 只能取下表值；`params` 是运行期检查的输入，schema 测试同时用它做
**语料层自洽校验**（确保该 fixture 真的构成了它声明的问题场景）。

| id | 含义 | 必需 params | 运行期判定（P07-T02） |
|---|---|---|---|
| `unknown-not-blocking` | invariant A：UNKNOWN ≠ 阻塞 | — | 存在 UNKNOWN 时 `provenance_ok` 可为 true；`optimized_prompt` 与四段文本不得出现阻塞句式（`请先回答` / `必须先确认` / `否则无法继续` …） |
| `suggested-not-upgraded` | invariant B：建议保持建议身份 | — | `suggested_requirements` 不得出现在 explicit/context 组，也不得以强约束句式进入要求段 |
| `unknown-semantic-dedup` | 语义重复的 UNKNOWN 合并 | `topic`、`aliases[]` | 与 `aliases` 语义等价的 UNKNOWN 合并为唯一项；去重后仍保留该 `topic` |
| `partial-quote-not-user-explicit` | 部分匹配 quote 不得过度归因 | `quote`、`claimed_requirement` | `quote` 仅部分覆盖 `claimed_requirement` 时，不得将该整条标为 `USER_EXPLICIT`/high |
| `conflicting-evidence-weighted` | 冲突证据并列 + 加权提示 | `conflict_a`、`conflict_b` | 两方说法并列呈现并给出证据强度 / 可复现性提示；不得静默择一 |
| `planning-override-contract` | 手动 Planning override 契约 | `protocol`、`expect_provenance_ok`、`sections[]` | `manual_override=planning` 时仍产出 `sections` 全部 16 段 + 四段协议，且 provenance 校验通过 |
| `explicit-priority-current-over-historical` | 显式优先级 | `historical_fact`、`current_override` | 优先级恒为 CURRENT USER EXPLICIT > HISTORICAL USER EXPLICIT > CONTEXT FACT > OPTIMIZER SUGGESTED |

`params.sections` 必须与 `defaultStrategyRegistry.getSections('planning')` 完全一致——
schema 测试会直接对比注册表，策略段落改动会立刻让语料校验失败（防止「实现漂移、语料跟着漂」）。

P07-T02 已在 `test/regression/run.mjs` 实现上表全部 7 个 canonical id；未知 id 一律
fail-closed（判 FAIL，不静默跳过）。运行期判定失败 = 该例 deterministic FAIL（硬 Gate）。

## 5. 通过阈值语义（DEFERRED_TO_P07_CALIBRATION）

按 PLAN-v1.1 **R-2**：

- **P07 之前 / 本轮（P07-T01）不设任何数值阈值**；语料里出现的只能是「问题 + 断言」，
  不得预设 0.8 / 80 分之类的通过线；
- P07-T03 用真实历史 corpus 跑出数据后，由 **Human 人工标注**校准 model-assisted threshold，
  届时才启用 G-3 阈值确认；
- 无论阈值如何校准：**deterministic 全过是硬 Gate**，evaluator 分数永远不能把 deterministic
  FAIL 翻成 PASS；evaluator 自身重跑不一致也不计 PASS（S-08 防误伤）。

## 6. 语料清单（P07-T01 定稿，14 例）

| id | expected_type | tags | 覆盖 |
|---|---|---|---|
| `research-comfyui-mac-h3` | research | golden, user-history, real-case, gvs | G-VS 真实案例；H3/黑鹤001 不确认不淘汰；UNKNOWN 非阻塞；建议不升级 |
| `research-conflicting-evidence-weighted` | research | g4-regression, user-history | G-4 #4 冲突证据并列 + 强度提示 |
| `planning-historical-fact-true-negative` | planning | golden, g2-appended, user-history | G-2 case B：用户明确提供的已完成事实不得误判 |
| `planning-manual-override-contract` | planning | golden, g4-regression, user-history | G-4 #5（最高优先级）：override 16 段 + 四段协议 + provenance |
| `planning-partial-quote-over-attribution` | planning | g4-regression, user-history | G-4 #1：partial-quote 过度归因 |
| `planning-unknown-semantic-dedup` | planning | g4-regression, user-history | G-4 #2：UNKNOWN 语义去重 |
| `planning-unknown-non-blocking` | planning | g4-regression, user-history | G-4 #3：UNKNOWN 非阻塞完成 |
| `execution-scoped-change` | execution | golden, user-history | Allowed/Forbidden 范围 + 真实跑测试 + NON-GOAL |
| `diagnostic-planning-override-provenance-failure` | diagnostic | golden, g4-regression, user-history | G-4 实测失败现象；验证先于修改 |
| `review-compiler-contract` | review | golden, user-history | 基于原目标审查、不发散、不无证据下结论 |
| `creative-storyboard-explicit-override` | creative | golden, g2-appended, user-history | G-2 case C：当前明确指令 > 历史设定 |
| `general-vague-request` | general | coverage, user-history | general 兜底：信息不足不臆造、仍给可用结构 |
| `assistant-only-context-not-user-decision` | research | golden, g3-appended, user-history, provenance, assistant-only | **G-3 fixture 13**：assistant-only 历史内容（「H3 路线最终确认走 MiniMax API」）不得升级为 USER_EXPLICIT / 已确认路线 / 用户硬约束 / Human Decision；当前 USER_EXPLICIT 优先；assistant 内容只能忽略或作待验证线索；E2E provenance 可审计 |
| `execution-safe-mutation-boundary` | execution | golden, g3-appended, user-history, execution, mutation-boundary | **G-3 fixture 14**：不得 kill 活跃 worker / 写脏 repo / reset-force；先确认 worker 活跃 + git/worktree + task boundary 再 mutation；支持 graceful stop 到安全边界；「等待安全边界」不得改写成「立即停止并修改」；且**不是永久规则**——CURRENT USER EXPLICIT 明确要求强制取消时用户指令优先 |

新增两例的覆盖目标（G-3 用户裁决，2026-10-04）：
- `assistant-only-context-not-user-decision`：assistant-only provenance 完整 E2E regression——历史 Assistant 自述不得伪装成用户已确认决定；
- `execution-safe-mutation-boundary`：真实无人值守 execution safe-mutation 回归——不 kill 活跃 worker、不写脏 repo、先确认安全边界再改、用户明确强制指令优先（非永久禁令）。

覆盖检查（由 schema 测试强制）：七类型齐全；六个非 general 类型各有一条 `golden`；
至少一条 `user-history`；G-4 五项 + G-2 case B/C 全部在库；assistant-only provenance 与 execution safe-mutation 各有一条真实回归。

## 7. 运行方式（P07-T02 runner CLI）

```bash
npm run build
node test/regression/schema.test.mjs        # P07-T01：离线 schema / 语料自洽校验
node test/regression/run.test.mjs           # P07-T02：runner 自身单测（fake fixture + scripted adapter）
node test/regression/run.mjs                # P07-T02：双通道 runner（默认 deterministic + mock）
node test/regression/run.mjs --mode all     # + evaluator 参考线（intent-fidelity-v1，temp 0）
node test/regression/run.mjs --fixture <id>[,<id>]   # 只跑部分语料
node test/regression/run.mjs --adapter live --provider deepseek --model deepseek-chat
node test/regression/run.mjs --adapter external --external ./my-adapter.mjs
node test/regression/run.mjs --report <path>  # 默认 test/regression/report-<date>.json
```

- **adapter 三态**：`mock`（离线机制冒烟，默认，**不代表模型效果**）、`live`
  （真实模型，P07-T03 用；凭据只从 env `DEEPSEEK_API_KEY` / `DSH_REGRESSION_API_KEY`
  或显式 `--credentials <yaml>` 读取，**不默认读 `~/.dsh`**）、`external`
  （外部模块导出 `createAdapter()` / `default`，返回 `{ name, call(ctx) }`）。
- **exit code**：deterministic 全过 = 0，任一 FAIL = 1；`npm test` 只跑 runner 的
  **自身单测**（`run.test.mjs`），不把 mock 语料运行结果当门禁。
- `run.mjs` 的编排与 host 一致：AUTO 走 `classifyViaLlm`（manual override 函数级旁路分类）
  → `compilePrompt` → `finalizeCompile` → 非 legacy 再跑 `validateCompileResult`
  并以三层结果覆盖 `provenance_ok`（general 保持 legacy 路径）。

### 7.1 开销测量（G-2 追加要求 A）

每次 classify / compile 调用分别记录：

| 字段 | 含义 |
|---|---|
| `system_tokens` | 实际下发的 system prompt token 数（项目 `estimateTokens`，CJK≈1 token/字、其余≈4 字符/token） |
| `context_tokens` | user 载荷（原始输入 + 上下文 + 缺口清单 + 记忆链）token 数 |
| `total_input_tokens` | 优先用真实 `usage.prompt_tokens`；无 usage 时 = system + context 估算 |
| `latency_ms` | 本次调用墙钟耗时 |

报告按 `strategy → phase` 聚合 `min/avg/max`（另有 `_total` 合计）；真实 `usage` 可用时
`actual_prompt_tokens` 单独记录。**550–650 行策略源码规模本身不是问题**：本阶段只测量、
**不预防性删内容**；仅当数据证明 token / 延迟 / instruction dilution 明显时才由后续任务压缩。

### 7.2 报告结构（`report-<date>.json`）

顶层：`schema`(`apo-regression-report-v1`) / `generated_at` / `mode` / `adapter` /
`evaluator_prompt_id` / `threshold`(**恒为 null**，R-2) / `threshold_status`
(`DEFERRED_TO_P07_CALIBRATION`) / `gate`(`deterministic`) / `totals` / `costs` / `results[]`。
每例含 `classification` / `deterministic.invariants` / `deterministic.invariant_checks` /
`evaluator`（参考线，逐问带理由与重跑记录）/ `overall`（**只看 deterministic**）/
`reference_mismatch` / `provenance_ok` / `problems`。

`npm test` 已包含 schema 校验与 runner 单测；真实语料运行由 P07-T03 驱动。

## 8. 维护规则

- 每次策略迭代可**追加**语料；追加只能加严，不得放宽既有 `invariants`；
- 报告存档：`test/regression/report-<date>.json`（P07-T02/T03 产出）；
- 语料变更需同步本文档 §6 清单与覆盖矩阵；
- 若某类型反复失败 → 该类型 STOP + 专项诊断（可能触发 S-06/S-08），只把可选方案列给用户，
  不自行选路（PLAN-v1 §15）。
