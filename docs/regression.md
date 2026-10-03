# Behavioral / Effect Regression 语料语义（P07）

> 状态：**DSH 草案**（P07-T01 产出，待 Human Gate **G-3** 定稿）。
> 真值实现：`test/regression/fixtures/*.json`（语料）＋ `test/regression/schema.test.mjs`
> （离线 schema / 语料级检查）＋ `test/regression/run.mjs`（P07-T02，运行期双通道 runner）。
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
| deterministic | 编译产物（四段协议解析结果 + `optimized_prompt`） | 每条 `require` 必须命中、每条 `prohibit` 必须不命中；任一违反 = 该例 FAIL（硬 Gate） |
| model-assisted | raw_input vs optimized_prompt | evaluator 逐问给「是/否 + 一句理由」；temperature 0；失败重跑一次，重跑不一致不计 PASS；仅参考线 |

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

## 5. 通过阈值语义（DEFERRED_TO_P07_CALIBRATION）

按 PLAN-v1.1 **R-2**：

- **P07 之前 / 本轮（P07-T01）不设任何数值阈值**；语料里出现的只能是「问题 + 断言」，
  不得预设 0.8 / 80 分之类的通过线；
- P07-T03 用真实历史 corpus 跑出数据后，由 **Human 人工标注**校准 model-assisted threshold，
  届时才启用 G-3 阈值确认；
- 无论阈值如何校准：**deterministic 全过是硬 Gate**，evaluator 分数永远不能把 deterministic
  FAIL 翻成 PASS；evaluator 自身重跑不一致也不计 PASS（S-08 防误伤）。

## 6. 语料清单（P07-T01 草案，12 例）

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

覆盖检查（由 schema 测试强制）：七类型齐全；六个非 general 类型各有一条 `golden`；
至少一条 `user-history`；G-4 五项 + G-2 case B/C 全部在库。

## 7. 运行方式

```bash
npm run build
node test/regression/schema.test.mjs   # P07-T01：离线 schema / 语料自洽校验
node test/regression/run.mjs           # P07-T02：双通道 runner（deterministic + evaluator）
```

`npm test` 已包含 schema 校验；runner 由 P07-T02 接入。

## 8. 维护规则

- 每次策略迭代可**追加**语料；追加只能加严，不得放宽既有 `invariants`；
- 报告存档：`test/regression/report-<date>.json`（P07-T02/T03 产出）；
- 语料变更需同步本文档 §6 清单与覆盖矩阵；
- 若某类型反复失败 → 该类型 STOP + 专项诊断（可能触发 S-06/S-08），只把可选方案列给用户，
  不自行选路（PLAN-v1 §15）。
