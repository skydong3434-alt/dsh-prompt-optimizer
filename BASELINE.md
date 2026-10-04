# BASELINE — dsh-adaptive-prompt-optimizer

日期：2026-10-03
阶段：P00-T01（Fork & Baseline）✅ 通过

## 环境
- 本地目录：`~/Projects/dsh-adaptive-prompt-optimizer/`
- Node：v22.23.0 / npm 10.9.8（引擎要求 node>=18 ✅）
- 目标宿主：DSH Desktop 2.0.15（dsh 0.1.7-rc.2 / cordis 4.0.4）
- 底座：`@y1x1n/dsh-prompt-optimizer` 0.4.0（MIT），commit daf6fbd（2026-10-03）

## Git
- remote：`upstream` = https://github.com/Y1X1n/dsh-prompt-optimizer.git（只读）
- origin：**待用户提供自有仓库 URL**（gh CLI 不可用，未自动创建；P09 发布前需补齐）
- 基线标签：`base-y1x1n-v0.4.0`

## 验证结果（npm install / build / test）
- `npm install`：+22 packages，无错误
- `npm run build`：lib/index.js + client.js + prompt.js + controller.js 全部产出
- `npm test` 三件套：**smoke: all passed / prompt: all passed / controller: all passed（exit=0）**
  - smoke：真 Context + mock llm 驱动 HTTP handler，成功/错误/边界路径（含 AUTH 失败、mid-stream boom、工具调用拒绝等负路径）
  - prompt：标记协议解析、思考块剥离、上下文预算、输出解析
  - controller：状态机、取消、看门狗、记忆链、发送即关闭、快速模式预览

## 结构核对（对照 REPORT §2.1，无差异）
```
src/index.ts            → Host 入口（HTTP 路由/SSE/模型路由/回退链/CSRF/settings 双版本）
src/prompt.ts           → 纯函数层（双策略/标记协议/上下文预算/thinkFilter）
src/client/             → index.tsx + controller.ts + host-faces.ts + settings-face.ts + i18n.ts
                          + OptimizeButton/ResultDock/SettingsCard/GitHubIcon/SparkleIcon.tsx
test/                   → smoke.mjs + prompt.test.mjs + controller.test.mjs
scripts/build.mjs       → esbuild 四产物
cordis.patch.yml        → insert id: prompt-optimizer
```

## 与 REPORT 一致性结论
- 关键事实无漂移：双版本兼容（webServer/httpServer、configForms/settingsScope、双设置槽位）均如 REPORT 所述；
- 无差异需修正规划；S-01/S-02/S-04 均未触发。

## P00 出口确认
- [x] build + test 全绿
- [x] 结构与 REPORT 一致
- [x] 独立目录 + 独立 remote（origin 待补）
- [x] 未触碰任何正式 DSH profile / ~/.dsh / PAB

## 下一阶段
P01 Core Contracts & Provenance（G-1 出口）

---

# 附录 A — P05-T02 兼容性回归（双版本面 + 全量测试）

日期：2026-10-03 ｜ 检查点：S-03（未大量重写 Host）/ S-04（DSH API 冲突）
结论：**全绿** —— 23 个测试文件（22 既有 + 1 新增）全部通过；core 层 tsc 0 error；settings 双版本能力探测未被破坏。

## A.1 版本矩阵（本次实测）

| 维度 | 实测值 |
|---|---|
| 主机 / OS | macOS 26.5.1（Darwin 25.5.0 arm64） |
| Node / npm | v22.23.0 / 10.9.8 |
| @deepseek-ai/cordis | 4.0.4 |
| @deepseek-ai/dsh-llm | 0.2.0-rc.2 |
| @deepseek-ai/schemastery | 3.18.4 |
| TypeScript / esbuild | 5.9.3 / 0.24.2 |
| 插件版本 / 分支 | 0.4.0 / phase/p01.5-slice |

目标宿主版本面（规划基线见 PLAN-v1 §11.1；既有实测记录见 README「兼容性」）：

| dsh 版本面 | 优化路由 / 模型调用 | 设置页双版本接入 | 发送栏 / 结果面板 |
|---|---|---|---|
| DSH Desktop 2.0.15 / dsh 0.1.7-rc.2（规划基线） | 同一份构建覆盖 | `settingsScope`（0.1.x 服务） | 沿用 |
| dsh 0.2.0-rc.2（v0.4.0 实测线） | ✅ | `volatile` + `configForms`（`configure({auto:false})` 关闭宿主原生表单） | ✅ |
| dsh 0.1.5-rc.2 / 0.1.2-rc.1 / 0.1.0-rc.7+ | ✅ | `installSection` / `register` 逐级回落 | ✅ |

> 本次为**开发机离线回归**（mock llm + 真 cordis Context），不含真实 desktop profile 端到端（P08 / S-09 范围）；未触碰任何正式 DSH profile / `~/.dsh` / PAB。

## A.2 全量测试矩阵

命令：`npm test`（build + 23 个测试文件）→ **exit 0**

- 旧三件套（P00 基线）：`smoke` ✅ / `prompt` ✅ / `controller` ✅
- 底座纯函数层：`provenance` ✅ / `_shared` ✅ / 七策略（research·planning·execution·diagnostic·review·creative·general）✅ / `registry` ✅
- 分类器：`classify` ✅ / `classify-llm` ✅ / `classify-guards` ✅
- 编译 / 守卫：`core-pipeline` ✅ / `compiler` ✅ / `validate` ✅ / `compiler-integration` ✅
- P05 pipeline：`host-pipeline` ✅ / `vertical-slice` ✅
- **新增 P05-T02**：`compat-settings` ✅（settings 双版本能力探测）

合计 **23/23 通过**。

## A.3 typecheck 记录

- **core 层**（`src/core/**` + `src/prompt.ts` + `src/index.ts`，strict + skipLibCheck）：
  `npx tsc --noEmit ...` → **0 error**（零新增错误）。
- 全量 `npm run typecheck`：仅 `src/client/**` 报模块解析类错误（`@deepseek-ai/dsh-client-*` 类型包未 `npm run sync:types` 拉取，且该层 `ctx.slots` / Context 合并声明缺失），**非本次改动引入**；client 类型面回归归 P06。

## A.4 settings 双版本探测路径回归

新增 `test/compat-settings.test.mjs`（cs1–cs6，纯 mock、零网络、不改产品代码）：

| 用例 | 覆盖路径 | 结果 |
|---|---|---|
| cs1 | 0.2.0 SettingsForms：`configure({auto:false})` + volatile cell 读取 | ✅ |
| cs2 | 0.1.2+ `settings.installSection(ctx,ns,schema,base,hooks)` → `setSource` 实时生效 | ✅ |
| cs3 | 0.1.0-rc.x `settings.register(ns,schema,{base})` → `get()` / `watch()` 生效 | ✅ |
| cs4 | settings 服务缺席 → 组合层配置回落（不抛错） | ✅ |
| cs5 | HTTP 载体双名 `webServer` / `httpServer` | ✅ |
| cs6 | 双载体并存 → `mount` 幂等，两路由各只注册一次 | ✅ |

既有 smoke 用例 11（volatile 引用 cell 解包 / 旧版非法枚举宽松接收）在 A.2 中同步通过。

## A.5 检查点结论

- **S-03（未大量重写 Host）**：P05 仅新增 handler 内部两阶段编排与 SSE `meta` 扩展；路由 / 超时 / 断连 / 回退 / CSRF / settings 分派均未改写，旧用例 100% 通过（`host-pipeline` h5/h6 legacy 零回归）。
- **S-04（DSH API 冲突）**：cordis 4.0.4 / dsh-llm 0.2.0-rc.2 依赖面下 build + 全量测试全绿，无 API 冲突。
- 未触发任何 Stop Condition；兼容基线冻结，可进入 P06。

## 下一阶段
P06 UI Integration（G-4 出口）

---

# 附录 B — P08-T02 桌面端实测版本矩阵（Isolated Desktop Integration）

日期：2026-10-04 ｜ 检查点：S-04（DSH API 冲突）/ S-09（正式 profile 零改动）
结论：**全绿** —— 全量测试 26 文件 exit 0；真实 DSH Desktop 2.0.15（apo-dev 隔离 profile）四项真机探针全部通过。

## B.1 版本矩阵（本轮实测）

| 维度 | 实测值 |
|---|---|
| 主机 / OS | macOS 26.5.1（Build 25F80，Darwin arm64） |
| Node / npm | v22.23.0 / 10.9.8 |
| 目标宿主 | DSH Desktop 2.0.15（/Applications/DSH Desktop.app） |
| dsh | 0.1.7-rc.2 |
| @deepseek-ai/cordis | 4.0.4 |
| @deepseek-ai/dsh-llm（宿主运行时） | 0.1.7-rc.2（repo devDep 0.2.0-rc.2 为双版本回归另一面） |
| 插件版本 / 分支 | @y1x1n/dsh-prompt-optimizer 0.4.0 / phase/p01.5-slice |
| 隔离 profile | `~/.dsh/profiles/apo-dev`（P08-T01 新建；本轮仅复用，文件逐字节未改） |
| 会话默认模型 | opencode-go / deepseek-v4-flash（agent-default-model，与 headless 同款 E1 批准路由） |
| 模型端点 | https://opencode.ai/zen/go（providers.opencode-go；API key 读 ~/.dsh/.credentials.yaml 的 OPENCODE_API_KEY；头 x-opencode-session: dsh-apo-dev-smoke） |
| 插件回退模型 | fallbackModel 默认空（未配置任何 DeepSeek fallback，宁可明确失败不静默产生计费） |
| APO HTTP 端口 | 18776（--no-open，headless boot） |

## B.2 实测结论（探针摘要，证据细节见 docs/p08-desktop.md）

| # | 探针 | 结果 |
|---|---|---|
| T-1 | 直接 HTTP smoke（无 session context，不带 provider/model）→ 回落第一 provider deepseek-official → QUOTA 明确报错 | 测试入口行为（记录，非缺陷） |
| T-2 | 真实 UI session 等价载荷（body provider=opencode-go/model=deepseek-v4-flash）→ done 回声 opencode-go/deepseek-v4-flash + 758 帧真实流式 | **PASS**（Follow DSH model route；真实 UI 会话不回落第一 provider） |
| T-3 | fallbackModel 默认空 + 无效主路由 → SSE 明确 error，无任何 provider 切换 | **PASS**（Fallback billing safety：默认不隐式回退） |
| T-4 | 显式配置 fallbackModel（--patch 覆盖层）→ done.fallbackUsed=true + fallbackReason | **PASS**（Fallback billing safety：仅在显式配置时启用） |

KNOWN_NON_BLOCKING_HARNESS_LIMITATION：research `provenance_ok=false` 为 phrasing-sensitive
deterministic regex 假阳性族（本次表面「声称支持…但无实测」条件句；G-5/P08-T01 既有表面
「[待补充: 时间/工期约束]」前缀式与「取决于…」转述同源）——记录、不修、不重开 P02/P04 模块。

## B.3 检查点结论

- **S-04**：cordis 4.0.4 / dsh-llm 0.1.7-rc.2 宿主面下真实 boot + 全量测试全绿，无 API 冲突。
- **S-09**：正式 desktop profile 零改动（本轮未读未写 `~/.dsh/profiles/desktop/**`；apo-dev profile
  本体 sha256 任务前后一致，T-4 仅用启动期 `--patch` 覆盖层）。
- 未触发任何 Stop Condition；桌面端实测证据封存（docs/p08-desktop.md），可进入 P09（G-7 前不再动正式 profile）。

## 下一阶段
P09-T01 Backup & Install Drill（G-7 出口）