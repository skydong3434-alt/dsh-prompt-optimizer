# Classifier（意图分类器）— 防误判契约与 S-06 稳定性记录

> 状态：**P03-T03 已验收**（2026-10-03）。本文档记录 P03 分类器的防误判契约、
> 测试语料与 **S-06「分类不稳」检查点**的抽查结论；**不新增契约、不改变行为**。
> 真值实现：`src/core/classify.ts`（提示词/解析器/调用侧封装）；
> 测试契约：`test/classify.test.mjs`（c1–c10）、`test/classify-llm.test.mjs`（ll1–ll14）、
> `test/classify-guards.test.mjs`（g1–g10，本页主体）；语料：`test/fixtures/classify-guards.mjs`。

## 1. 防误判三规则（PLAN-v1 §6，写入 system prompt + 测试）

| # | 规则 | 机器锚点 |
|---|---|---|
| 1 | 以**当前输入**为判断对象；历史讨论仅供参考，不得用历史话题覆盖当前请求 | `buildClassifierUser` 把当前输入放在 `<prompt-draft>`（最后读到）；g3/g4/g5 |
| 2 | 区分「当前请求」与「之前讨论过的内容」；讨论只辅助判断意图方向 | 主类型以 mock/模型对当前输入的判定为准，不因历史话题改写；g4/fixture-5 |
| 3 | assistant / agent 建议 ≠ 用户决定；`evidence_quotes` 只能引用用户本人发言 | 逐字证据校验丢弃助手/杜撰条目；`resolveQuoteSource` 把 assistant-only 判为 `UNKNOWN`；g4/g5/g6 |

## 2. 测试语料（test/fixtures/classify-guards.mjs）

| id | 类别 | 场景 | 关键断言 |
|---|---|---|---|
| `referent-plan-above` | referent | 「上面提到的那个方案怎么样」；历史含方案 A/B 与助手建议 | 主类型=review；助手建议证据被丢弃；助手 quote → `UNKNOWN` |
| `multi-intent-analyze-then-execute` | multi-intent | 「先分析…然后直接实现」 | 主类型=execution 不拆分；`missing_constraints` 注入多意图注明；`meta.multiIntent=true` |
| `assistant-long-discussion-background` | assistant-bg | assistant 连续长建议（MiniMax API/512x512），用户只说「先记录、没决定」 | 助手建议被丢弃 → `UNKNOWN`；上下文用户发言 → `CONTEXT_EXPLICIT`（非 raw）；低置信 0.55 |
| `user-explicit-negation` | negation | 用户明确否定「付费 API / CUDA-only」；助手建议接入付费 API | 用户否定 → `USER_EXPLICIT/high` 保留；助手建议被丢弃 |
| `current-request-overrides-history-topic` | current-vs-history | 历史聊旅游规划，当前改口写诗 | 主类型=creative（非 planning）；历史 quote → `CONTEXT_EXPLICIT`（非 `USER_EXPLICIT`） |

另含稳定输入 `STABILITY_RAW_INPUT`（单意图研究请求），同时作为「不得把单意图误判成多意图」的对照。

## 3. 来源判定口径（与 docs/provenance.md 一致）

- raw input 命中 → `valid / raw / USER_EXPLICIT / high`；
- 上下文 user 消息命中 → `valid / context-user / CONTEXT_EXPLICIT / high`；
- 仅 assistant 命中 → `invalid / assistant-only / UNKNOWN / low`；
- 无处命中 → `invalid / none / UNKNOWN / low`。

对「把助手发言塞进 USER_EXPLICIT 记录」的情况，`validateProvenance` 发出
`PROVENANCE_ASSISTANT_ONLY_EVIDENCE` 告警且**不再叠加** `evidenceNotInRaw`；
对照的杜撰证据（无处命中）才是 error 级 `PROVENANCE_EVIDENCE_NOT_IN_RAW`。

## 4. Manual Override 旁路（函数级）

- `parsePromptTypeInput` 只接受七值闭集的小写字面量；大小写变体/非法值/缺省 → `undefined`（走 AUTO）；
- override 合法 → `manualClassifierResult(type)`（`confidence_internal=1`、无证据、理由可辨识）**直达 compiler**；
- g8 以函数级 spy 断言：override 时 mock `llm.stream` 调用次数 = **0**；非法/缺省时才走 AUTO 且恰好调用一次（temp0/512 快照）。

## 5. S-06 稳定性抽查（检查点记录）

**检查点**：S-06「分类不稳」（docs/RUNNER-READY.md §15）——同一输入多次分类必须同结果。

| 项 | 结果 |
|---|---|
| 命令 | `npm run build && node test/classify-guards.test.mjs` |
| 执行日期 | 2026-10-03 |
| 解析层抽查 | 5 个 fixture × 3 次 → 稳定签名（result/meta/issues）**完全一致** |
| 调用层抽查 | 固定 mock 输出、同一输入 × 3 次 → 除 `durationMs` 外**完全一致** |
| 兜底确定性 | `fallbackClassifierResult`（general + 低置信）多次构造一致 |
| override 旁路 | 通过（override 时零分类调用） |
| assistant ≠ explicit | 通过（assistant-only 证据永不升格） |
| **结论** | `S-06 CHECKPOINT: stable=true fixtures=5 runs=3 overrideBypass=ok assistantNotExplicit=ok` |

判定：**S-06 未触发**（分类行为在确定性输入下稳定、来源纪律与 override 旁路均被机器门禁覆盖）。
本抽查基于固定 mock 输出的确定性验证；真实模型下的效果/稳定性回归属 P07（G-3/G-5）。

## 6. 运行方式

```bash
npm run build
node test/classify-guards.test.mjs   # g1–g10 防误判 / override / S-06
npm test                             # 全量门禁（含本套）
```

## 7. 边界

- 本任务只新增测试与语料，**未修改** `ClassifierResult` 契约（改动需 G-1 复审）；
- 未触碰 UI / handler 主路径（接入见 P05）；未复制任何 AGPL 项目源码、模板或测试文本。
