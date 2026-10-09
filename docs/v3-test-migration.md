# V3 测试迁移分类（旧架构 → V3）

> ℹ️ **历史档案（当前仍准确）** — 本文记录旧架构测试如何按 A/B/C 分类处置，以及 13 项用户行为回归
> 在 V3 里的对应位置。它**不是使用文档**：里面引用的旧测试文件多数已随 `435b643` 删除。
> 当前实现与文档入口见 [`../CURRENT_STATE.md`](../CURRENT_STATE.md) 与 [`README.md`](README.md)。

> 目的：旧版 513 项断言主要运行在 legacy 多阶段路径上，通过不能证明 V3 正确。
> 本文件把 44 个测试文件按**实际验证内容**分为 A/B/C，并说明处置。
> 分类依据：`grep` 出的模块依赖（文件是否直接 import `lib/core/*` 旧模块）+ 断言内容。

## A 类：保护用户实际行为 → 迁移或保留为 V3 测试

| 文件 | 保护的用户行为 | 处置 |
|---|---|---|
| `test/v3.test.mjs` | V3 全流程：用途判定、协议解析、歧义提问、错误终态、硬约束 | 已是 V3（本轮新增 v3-6/v3-7） |
| `test/smoke.mjs` | cordis 插件能被宿主加载 | 保留（默认走 V3） |
| `test/triage.test.mjs` | 修改幅度判定（用户可见「需要修改多少」） | 保留（`mechanicalTriage` 被 V3 直接使用） |
| `test/settings-i18n.test.mjs` | 设置面板与中英文案（用户可见） | 保留 |
| `test/compat-settings.test.mjs` | 设置项读写兼容 | 保留（去掉 legacy 断言部分） |
| `test/prompt.test.mjs` | 上下文截断 / think 过滤 / 流式解析（输出正确性） | 保留（`prompt.ts` 仍被宿主与客户端使用） |
| `test/controller.test.mjs` | 客户端交互：输入→优化→结果/错误/复制/重新优化 | 迁移：断言 V3 的 SSE 事件面 |
| `test/regression/schema.test.mjs` | 配置 schema 回归（用户可见配置项） | 保留 |
| `test/simplification-corpus.test.mjs` | T1–T15 原意保真：普通输入不得追问 | 迁移为 V3 断言（v3-5 / v3-6 覆盖同构能力） |
| `test/release/release-blockers.test.mjs` | R1–R17 发布阻塞回归（走宿主 SSE） | 迁移：V3 已有等价覆盖（v3-4a…4e、v3-6、v3-7） |
| `test/rc/rc-regression.test.mjs` | 真实语料回归：协议标记泄漏 / 占位符 / 兜底 | 部分迁移：协议标记剥离在 v3-4 覆盖；其余属旧 compiler 内部 → 随旧代码删除 |
| `test/rc2/rc2-decisions.test.mjs` | 决策稳定性 / 确认语义 | 迁移为「V3 无确认状态」断言（v3-7c）；其余属旧 decision-safety → 随旧代码删除 |

## B 类：只验证旧架构内部实现 → 随旧代码删除

| 文件 | 验证对象 |
|---|---|
| `test/analyze.test.mjs` | 旧 Analysis 解析与阻塞判定 |
| `test/classify.test.mjs` / `classify-llm.test.mjs` / `classify-guards.test.mjs` | 旧意图分类 |
| `test/compiler.test.mjs` / `compiler-integration.test.mjs` | 旧 Compiler 协议与装配 |
| `test/core-pipeline.test.mjs` | 旧 分类→编译 串联 |
| `test/host-pipeline.test.mjs` | 旧宿主多阶段流水线 |
| `test/vertical-slice.test.mjs` | 旧端到端切片 |
| `test/discovery.test.mjs` | 旧 Discovery 状态机 |
| `test/requirements.test.mjs` | 旧 Requirement Ledger / gate |
| `test/responsibilities.test.mjs` | 旧 Agent 职责清单 |
| `test/router.test.mjs` | 旧 Target Router |
| `test/targets.test.mjs` | 旧 Target 契约 |
| `test/validate.test.mjs` | 旧 Validator 规则 |
| `test/validation-flow.test.mjs` | 旧校验回流 |
| `test/phase1-gate.test.mjs` / `phase2-fixtures.test.mjs` / `phase3-e2e.test.mjs` / `phase4-reconcile.test.mjs` / `phase4-final.test.mjs` | 旧分阶段实现 |
| `test/provenance.test.mjs` | 旧 provenance 渲染（V3 不再使用该机制） |
| `test/registry.test.mjs` | 旧策略注册表 |
| `test/strategies-*.test.mjs`（8 个） | 旧策略模板（图片/视频保护能力已迁入 v3-7a/7b） |
| `test/regression/run.test.mjs` | 旧编译协议渲染 |

## C 类：重复或失效 → 清理（附原因）

| 文件 | 原因 |
|---|---|
| `test/rc/corpus.mjs` | 仅为 `rc-regression` 提供数据；后者删除后成为死数据 |
| `test/regression/run.mjs` | 与 `run.test.mjs` 同为旧协议测试的公共夹具，随 B 类一起删除 |

## 必须保留的回归能力 → V3 覆盖位置

| 能力 | V3 覆盖 |
|---|---|
| 原意保护 | v3-6（保留率）+ v3-7b（原意原样传递） |
| 防止擅自补充需求 | v3-6（扩展检测）+ 真实模型 `v3-real-check` |
| 防止 AI 建议冒充用户要求 | v3-7b（系统规则断言） |
| 关键歧义提问 | v3-4b、v3-5、真实模型「歧义」两例 |
| 非必要问题不强制提问 | v3-4a、v3-5、v3-7c |
| 用户补充后继续优化 | v3-4b、真实模型「用户补充后继续」 |
| 防止反复确认 | v3-7c（V3 无确认状态）+ 宿主机械保证「已收到回答不得再问」 |
| 最小必要修改 | v3-6、真实模型 `maxLen`/保留率 |
| 图片提示词内容保护 | v3-7a/7b + 真实模型 IMAGE 用例 |
| 视频提示词内容保护 | v3-7a/7b + 真实模型 VIDEO 用例 |
| 特殊用途准确识别 | v3-5（14 例用途清单） |
| 已有硬约束不丢失 | v3-4d |
| 技术错误正确显示 | v3-4c、v3-4e |

## 删除顺序（分批，每批后必须 `npm test` + `npm run build` 全绿）

1. 摘除 `src/index.ts` 的 legacy 分支与 `v3:false` 开关 → 编译报错暴露无引用模块。
2. 删除 B 类模块（`src/core/*` 旧链路 + `src/core/strategies/*`）与 `disposition-render.ts`。
3. 删除 B/C 类测试文件与 `package.json` 注册项。
4. 复跑全量测试、构建、cordis 加载 smoke、真实模型行为验证。


---

## 实际执行记录(方案 B,分两批)

### 第 1 批:测试迁移(commit `c0f741c`)

删除 B/C 类 38 个测试文件;`test/smoke.mjs` 由「旧多阶段标记协议」重写为
**V3 宿主半冒烟 20 例**(路由与参数校验、来源围栏、模型选择与回退、连接测试、
超时、技术错误呈现、V3 事件序、澄清问答、硬约束与用途映射);
`test/compat-settings.test.mjs` 与 `test/controller.test.mjs` 去掉旧链路依赖。

**该批发现并修复的真实缺陷(超时无终态)**:V3 分支在 `abort.signal.aborted` 时
直接 `throw`,而外层 catch 首行对 aborted 静默返回(那是给「客户端断连」的),
导致**模型超时既没有产物也没有错误**。已改为显式下发
`{type:'error', reason_code:'VF_TIMEOUT'}`。回归:`test/smoke.mjs` 用例 9。

### 第 2 批:源码删除(删除旧链路 + `v3:false` 回退)

| 删除对象 | 规模 |
|---|---|
| `src/core/` 旧模块 18 个(analyze/classify/compiler/discovery/validate/validation-flow/ledger-reconcile/provenance-recovery/provenance/patch-scope/semantic-ambiguity/router/responsibilities/targets/registry/requirements/disposition-render/context) | ≈ 8.0k 行 |
| `src/core/strategies/` 12 个文件 | ≈ 5.7k 行 |
| `src/index.ts` 旧分支(`if (cfg.v3 !== false)` 起的整段)+ `v3` 配置项 | 1597 → 867 行 |
| `src/core/types.ts` 旧契约类型(58/63 个导出未被 V3 使用) | 853 → 66 行 |
| `test/regression/`(旧策略语料 fixtures + runner + 报告存档)、`scripts/{gvs-demo,phase3-trace,phase4-trace,rc-comfyui,rc-validate,rc2-stability,release-diag,release-smoke-cE-repeat,release-smoke-v0.2.0-apo,simplification-smoke}.mjs` | 只服务旧链路 |

**保留的共享安全能力**:`src/core/v3.ts`(协议解析、用途推断、机械安全
`assessV3Safety`、意图扩展拦截、特殊用途模板漂移拦截、协议信封泄漏防护、
`stripProtocolMarkers`)、`src/core/triage.ts`(机械分诊)、`src/core/types.ts`
(最小契约)、`src/prompt.ts`(上下文预算与元提示)。

**分类修正**:`test/regression/schema.test.mjs` 原判 A,复核后实为 B
(只校验旧 `defaultStrategyRegistry` 语料契约),随旧语料删除;
`scripts/check-dod.mjs` 的回归证据与 core 契约核对项改写为 V3,
并新增**单架构不变式**(旧链路文件必须不存在)。

**第 2 批后**:`npm test` = 101 断言全绿;`npm run build` exit 0;
`node scripts/check-dod.mjs` 仅剩「annotated tag v0.2.0-apo 不存在」
(打标签由用户执行,本轮不 tag)。


---

## 最终验收记录(2026-10-09)

### 机器门禁

| 门禁 | 命令 | 结果 |
|---|---|---|
| 测试 | `npm test` | exit 0,**101 断言全绿**(build + smoke 20 例 + v3 9 组 + prompt/controller/compat-settings/settings-i18n/triage) |
| 构建 | `npm run build` | exit 0 |
| 宿主冒烟 | `node test/smoke.mjs` | `smoke: all passed` |
| DoD 机器子集 | `node scripts/check-dod.mjs` | 仅剩「annotated tag v0.2.0-apo 不存在」(打标签由用户执行) |

### 真实模型行为验证(`scripts/v3-real-check.mjs --runs 2`)

**20/20 全过,硬失败 0 例**(日志 `logs/v3/real-2026-10-09T04-37-02-947Z.json`)。

| 用例 | 用途判定 | 模型调用 | 耗时 | 说明 |
|---|---|---|---|---|
| GENERAL-目标描述(核心回归) | GENERAL | 1 | 4.8 / 7.6 s | 输出仅原句,无「可行方案」 |
| GENERAL-想法讨论 | GENERAL | 1 | 4.9 / 9.6 s | 未被改写成执行任务 |
| GENERAL-清晰提示词最小修改 | GENERAL | 1 | 17.5 / 12.6 s | 原意保留 0.98 |
| IMAGE-生图提示词 | IMAGE | 1 | 6.4 / 14.5 s | 视觉要素保留 |
| VIDEO-文生视频提示词 | VIDEO | 1 | 11.1 / 24.6 s | 镜头/主体保留 |
| AUDIO-配音提示词 | AUDIO | 1 | 3.8 / 8.3 s | 「女声」等要素保留 |
| AGENT-代码任务指令 | AGENT | 1 | 18.9 / 16.6 s | 未被写成通用长模板 |
| STRUCTURED-严格 JSON | AGENT | 1 | 9.6 / 3.5 s | 字段 title/steps/verify 齐备 |
| 歧义-指代不明(补充后继续) | GENERAL | **2** | 8.0 / 13.3 s | 1 个问题 → 回答 → 交付,不重复问 |
| 歧义-保持未确定后必须输出 | GENERAL | **2** | 13.0 / 66.0 s | 「保持未确定」后仍交付 |

- **正常请求 = 1 次模型调用**(8/10 用例);只有真歧义才 2 次(提问 + 回答后继续)。
- 模型端耗时方差大(3.5–80 s),属推理模型端侧方差;未见新的循环或超时。

### 本轮真实缺陷修复(均由验证发现,非推测)

1. **超时无终态**(第 1 批):超时时既无产物也无错误 → 显式下发 `VF_TIMEOUT`。
2. **协议信封泄漏**:被截断的内部 JSON 曾被当正文交付 → `looksLikeProtocolEnvelope` 拦截。
3. **已回答仍追问**:带 `<clarification>` 时仍可能再提问 → 机械保证强制 `optimized`。
4. **用途漏判**:明确要求「agent 任务指令」的输入偶尔被判 GENERAL → 机械明确证据优先(`reconcileUsage`)。
5. **格式-only 输入被反问**:只给字段没给内容的输入被追问任务目标 → 规则禁止提问,未指定写「待确认」。
6. **特殊用途要素丢失**:AUDIO 输出曾把「女声」写成更泛的说法 → 规则要求逐项保留。

### 度量修正(测试侧,避免假失败)

- 澄清用例的原意保留改以**答案内容**为基准(指代句在回答后本就不会原样出现);
  「保持未确定」不算内容补充。
- 格式契约用例(`mustContain`)以**字段齐备**为保真判据,不做原文字符覆盖率检查。
- `mustContain` 支持同义替代(「女声 / 女性声音」)。
- 模型侧空产出(产品已如实下发技术错误)标记 `modelSideEmpty`,不计产品硬失败。

### 仍存在的遗留

- **客户端 UI 仍按 v2 结构**:结果面板/六态状态机的区块在 V3 下部分为空
  (V3 的 `ledger`/`unknowns` 为空数组)。功能不受影响(宿主事件序与澄清交互已由
  `test/smoke.mjs` 覆盖),但 UI 精简尚未做,需用户在 DSH 实测确认观感。
- **用途判定仍有边界**:模型对「既是 GENERAL 又是特殊用途」的输入偶有摇摆,
  已用机械明确证据兜底;无明确证据时仍以模型判断为准。
- 历史文档(`docs/PLAN-v1.md`、`docs/phase*-report.md`、`tasks/P0*`)描述的是已删除的旧架构,
  仅作历史保留。
