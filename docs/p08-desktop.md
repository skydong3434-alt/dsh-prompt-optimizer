> ⚠️ **已过时（历史记录）** — 本文描述的是 **V3 之前的旧多阶段架构**（意图分析 / 编辑分诊 / 需求发现 / 编译器 / 校验器 / 策略路由），
> 相关代码已在提交 `435b643` 删除，文中的模块名、文件路径、测试名与 npm 命令**均已失效**。
> 当前实现与文档入口见 [`CURRENT_STATE.md`](../CURRENT_STATE.md) 与 [`docs/README.md`](README.md)。本文仅作历史记录保留。

# P08-T02 桌面端实测与回归证据（Desktop End-to-End Evidence）

> 日期：2026-10-04 ｜ 状态：**完成**
> 环境：DSH Desktop 2.0.15（/Applications/DSH Desktop.app，dsh 0.1.7-rc.2 / cordis 4.0.4）｜ 隔离 profile **apo-dev**（P08-T01 新建，本轮复用）｜ node v22.23.0
> Allowed Scope：**只读验证 + 记录**（未改任何 src/ 产品代码；正式 desktop profile / PAB / 个人工作台 零触碰）
> 出口：**P09-T01**（备份演练/发布）；下一 Human Gate = **G-7**（正式安装许可，唯一允许动正式 profile 的开关）

## 1. 目标与验收口径

任务文件 `tasks/P08-T02-desktop-evidence.md` 要求：全量 build+test → 桌面端交互实测清单 → BASELINE 版本矩阵追加；
并在 G-6 追加验收基础上，对**两项真实桌面验收**给出实测证据（Follow DSH model route 双入口区分 / Fallback billing safety），
以及 KNOWN_NON_BLOCKING_HARNESS_LIMITATION 记录（本轮不修、不重开 P02/P04 模块）。

验收标准（Acceptance）：全绿（npm test）+ 实测通过（四项探针）+ BASELINE 更新。

## 2. 第一层门禁：全量 build + 全量测试

```
npm run build          → lib/index.js + client.js + controller.js + core/* 全部产出（exit 0）
npm test               → 26 个测试文件全部通过（exit 0）
  含：smoke / prompt / controller(c6b 会话模型跟随、c7 undo、c23/c24 dropdown、c25 replace)
      provenance / 七策略 / registry / classify×3 / core-pipeline / compiler / validate
      compiler-integration / host-pipeline / vertical-slice / compat-settings(cs1..cs10 双版本设置)
      settings-i18n / regression schema(14 例) / regression runner(rr1..rr17)
```

证据原始流：`logs/p08-t02/npm-test.log`（不入 git）。

## 3. 真机环境与启动（隔离 profile apo-dev）

启动命令（真实 DSH 2.0.15 CLI，headless 不弹 GUI）：
```
node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile apo-dev --no-open --port 18776
```
启动日志：`[dsh-prompt-optimizer] loaded, POST /dsh-prompt-optimizer/optimize` + `dsh web: http://127.0.0.1:18776/?token=…`。

apo-dev 路由事实（隔离 profile 配置，本轮未改动）：
- `agent-default-model` → `provider: opencode-go, model: deepseek-v4-flash`（**会话默认模型 = opencode-go/deepseek-v4-flash**，真实 UI 会话的 `directoryFor(sessionId).load().current` 即此值）；
- `llm-pi-ai` → 激活 opencode-go provider（端点 https://opencode.ai/zen/go、API key 读 `~/.dsh/.credentials.yaml` 的 OPENCODE_API_KEY、必需头 `x-opencode-session: dsh-apo-dev-smoke`）；
- **未配置任何 DeepSeek fallback**（fallbackModel 默认空）。

## 4. 真实桌面实测清单（四项探针，全部真机 HTTP + 真实 LLM）

探针脚本：`logs/p08-t02/live-probe.mjs`（不入 git；原始 SSE 流证据 `logs/p08-t02/raw-*.txt`）。

### T-1 — 直接 HTTP smoke（无会话上下文）＝ 测试入口行为（G-6 验收 ①a）

请求体**不带 provider/model**（无 session context，等价于脚本直连）→ Host `resolveRoute` 按
"固定模型 → 请求方会话选择 → **第一个可用路由**" 解析到第一 provider（deepseek-official）→
命中 **QUOTA**（Insufficient Balance，DeepSeek 余额不足——即 P07 已知 402 根因）。

```
sse_events=2 types=[meta,error]
meta.prompt_type=general confidence=Low          # 分类小调用失败 → general 兜底（既有降级路径）
error="模型调用失败(QUOTA): Insufficient Balance (request_id: 57174f31-…)"
```

**判定**：按 G-6 验收口径——脚本直连无会话上下文，客户端 controller 不注入 DSH 会话模型，回落第一 provider
属**测试入口行为**，非产品缺陷。真实 UI 会话不经过此路径（见 T-2）。

### T-2 — 真实 DSH UI session 等价路径（G-6 验收 ①b：Follow DSH model route）＝ PASS

**链路（代码事实 + 真机求证）**：
1. 客户端 controller（`src/client/controller.ts#optimize`，即 UI 内真实运行代码）在点击时经
   `getSessionModelDirectories()` → `modelDirectories.directoryFor(sessionId).load()` 读取**会话当前模型**，
   将 `current.provider/current.model` 作为 body `provider/model` 发送（controller.test **c6b** 断言：
   "body 带会话当前 provider"=sess-p / model=sess-m；服务缺席/固定模型时才走 Host 回退）；
2. apo-dev 真实会话默认模型 = **opencode-go / deepseek-v4-flash**（§3 配置事实）→ 真实 UI 会话发出的 body
   provider/model = opencode-go/deepseek-v4-flash；
3. Host `resolveRoute` 优先级：固定模型 → **body provider/model** → 第一可用路由；body 已带
   opencode-go/deepseek-v4-flash → 实际路由 = opencode-go，**不回落第一 provider、不落 deepseek-official、
   不直接请求 api.deepseek.com**；
4. 真机求证：以会话等价载荷 POST（body provider=opencode-go/model=deepseek-v4-flash）→
   **done 事件回声实际调用路由**。

```
sse_events=759 types=[meta,delta×758,done]      # 真实流式：meta → 758 帧 delta → done
meta.prompt_type=research confidence=High
done.provider=opencode-go done.model=deepseek-v4-flash fallbackUsed=false wellFormed=true
```

**判定**：`assert 实际路由 = opencode-go` **成立**（done 回声 + 真实流式成功 = 实际经 opencode-go 端点完成调用）。
真实 UI 会话（有会话上下文）**不**回落第一 provider → 无 route defect，**G-7 前无需修**。

### T-3 — Fallback billing safety：默认 fallbackModel 为空（G-6 验收 ②默认分支）＝ PASS

请求体显式带**主路路由 = 无效 provider**（`no-such-provider-xyz/no-such-model`），**未配置 fallbackModel**
（默认空）→ Host 路由链 `routes=[主路由]` 仅一项 → 主路由零产出失败后**无第二条路由可换** →
SSE 明确 **error 事件**，不产生任何 provider 切换、不静默调用 deepseek-official。

```
sse_events=2 types=[meta,error]
error="模型调用失败(NO_ADAPTER): no adapter registered for provider \"no-such-provider-xyz\""
```

**判定**：`主模型失败 → 明确报错（SSE error 事件），不静默换 provider` **成立**。无隐式 fallback → **PASS**。

### T-4 — Fallback billing safety：显式配置 fallbackModel 才启用（G-6 验收 ②显式分支）＝ PASS

通过**启动期 `--patch` 覆盖层**（`logs/p08-t02/fallback-patch.yml`，**不改 profile 本体文件**）显式配置
`fallbackModel: opencode-go/deepseek-v4-flash` 后重启同 profile：同一无效主路由失败 → **自动换显式回退路由**
→ done 流式成功并携带 `fallbackUsed=true + fallbackReason`。

```
boot 日志: [dsh-prompt-optimizer] 主路由 no-such-provider-xyz/no-such-model 失败,尝试回退路由: Error: …
sse_events=208 types=[meta,delta×207,done]
done.provider=opencode-go done.model=deepseek-v4-flash fallbackUsed=true
fallbackReason="模型调用失败(NO_ADAPTER): no adapter registered for provider \"no-such-provider-xyz\""
```

**判定**：`fallback 仅当显式设置 fallbackModel 时启用；默认空 → 明确报错` **双向成立**（T-3/T-4 对照）。
无隐式 fallback → **PASS**。测试后已以默认配置重启、profile 逐字节复原（§6）。

## 5. KNOWN_NON_BLOCKING_HARNESS_LIMITATION（记录，不修——G-6 验收 ③）

- T-2 真实输出 `done.provenance_ok=false`，唯一 problem（用 `validateCompileResult` 对真实输出做机械复核）：
  `VALIDATION_UNEVIDENCED_QUANTIFICATION: 发现无证据量化约束「模型声称支持 Apple」(模型/引擎/框架)`；
  命中的原始句为 **Continue-search Conditions 段的转述条件句**：
  「当平台限制未验证时（如**某模型声称支持 Apple Silicon 但无实测**）」。
- 归属：与 G-5 裁定、P08-T01 记录**同源的 phrasing-sensitive regex 假阳性族**（deterministic 量化守卫无法区分
  转述/条件/报告性措辞与捏造硬约束；既有两个已知表面为「[待补充: 时间/工期约束]」前缀式与「取决于时间/工期约束」
  转述，本表面为「声称支持…但无实测」条件句——同一 `research-no-invented-quantities` 守卫、同一根因）。
- 处置：按 G-6 裁决**本轮不修改、不重开 P02/P04 模块**；固化入已知限制清单，后续单独治理
  deterministic regex / semantic invariant 边界。不构成产品缺陷，不阻塞 P09；不影响 G-7 前必须修清单。

## 6. 隔离/正式环境零污染证明

| 检查项 | 结果 |
|---|---|
| 正式 desktop profile | S-09 沿用 P08-T01 快照口径；本轮全程未读未写 `~/.dsh/profiles/desktop/**`、未碰 PAB / 个人工作台 / AI 视频工作流 |
| apo-dev profile 本体 | cordis.patch.yml / cordis.yml / package.json 任务前后 sha256 一致（T-4 用 `--patch` 覆盖层，不改 profile 文件） |
| 会话模型目录服务 | 本轮未新建/修改任何真实会话数据；未读取正式 profile 会话目录 |
| 遗留进程 | 本轮探针结束后已关闭 apo-dev 实例 |

## 7. 与任务 Goal 的对应（三槽位渲染 / 双版本设置 / SSE 流式 / 撤销·替换）

| 验收项 | 证据 |
|---|---|
| 三槽位渲染（conversation.input.right / conversation.input.dock / settings 双槽位） | 客户端 `src/client/index.tsx` 三槽位注册（button + dock + settings.plugins.tab / settings.plugin.item 双版本各挂一次，宿主只声明自己认识的那一个）；controller.test c23/c24（AUTO 下拉、跨 close 保留）、compat-settings cs1..cs10（双设置后端），`npm test` 全绿 |
| 双版本设置接入（0.1.x settingsScope / 0.2.0 configForms） | compat-settings cs1..cs6 + settings-face 双后端；本轮真机为 0.1.x 线（dsh 0.1.7-rc.2），`npm test` 全绿 |
| SSE 流式 | T-2/T-4 真实 meta→delta×N→done 完整事件序（758 / 207 帧，真实 LLM） |
| 撤销/替换交互 | controller.test c7（撤回状态流转）、c25（替换/撤回回归）+ G-6 已裁决真人/既定自动化通过；`npm test` 全绿 |
| 版本矩阵 | BASELINE.md 附录 B（本轮追加，§8） |

> **后续更正（v0.3.1-apo）**：上表「`settings.plugins.tab` / `settings.plugin.item` 双版本各挂一次，宿主只声明自己认识的那一个」在当时的 dsh 0.1.x / 0.2.0-rc.2 上成立（未声明槽位的注册被**静默忽略**）。DSH 2.0.x 改为**对未声明槽位的注册直接抛错**，同一实现会导致「设置 → 插件列表」出现同步失败报错；现已在各自的 inject 回调内注册（回调被触发即证明该槽位已声明）。此处保留原验收记录不动，更正见 `CHANGELOG.md` v0.3.1-apo。

## 8. Acceptance 核对

- [x] `npm run build && npm test` 全绿（exit 0）
- [x] 真实桌面四项探针通过：T-1（测试入口行为记录）/ T-2（Follow DSH model route = opencode-go，**PASS**）/ T-3（默认空 fallback → 明确报错，**PASS**）/ T-4（显式 fallbackModel → fallbackUsed，**PASS**）
- [x] KNOWN_NON_BLOCKING_HARNESS_LIMITATION 记录（不修，同一假阳性族新增一个转述表面）
- [x] BASELINE.md 追加 附录 B（版本矩阵）
- [x] 隔离/正式环境零污染（§6）
- [ ] **G-7 Human Gate**（下一节点：唯一正式安装许可点，Runner 读到 blocking 词即停止）

## 9. Next Transition

**P09-T01**（备份演练 + 安装演练）→ P09-T02（发布产物）→ DoD 用户终检；出口 Human Gate G-7。