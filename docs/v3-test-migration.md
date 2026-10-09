# V3 测试迁移分类（旧架构 → V3）

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
