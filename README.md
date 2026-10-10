# dsh-prompt-optimizer

> ⭐ **本仓库 = DSH Adaptive Prompt Optimizer**（独立发布包 `@skydong3434-alt/dsh-prompt-optimizer`，派生自上游 `@y1x1n/dsh-prompt-optimizer`，MIT）。
> 从「固定模板式 Prompt 扩写器」升级为**自适应提示词编辑器**：自动判断任务意图、
> Prompt 类型、目标模型与需要修改多少，只在真正需要你决定时问少量关键问题，
> 且**不自动发送 / 不自动执行 / 不自动决策**。
> 发布版本 `v0.3.2-apo`（上一版 `v0.3.1-apo`、`v0.3.0-apo`；`v0.1.0-apo` 为首个可发布版本；`v0.2.0-apo` 的 v2 编辑器架构已由 V3 替换，未发布）；设计来源与 License 边界见 [NOTICE.md](NOTICE.md)；
> 变更记录见 [CHANGELOG.md](CHANGELOG.md)；发布说明见 [docs/release-notes-v0.3.2-apo.md](docs/release-notes-v0.3.2-apo.md)。

**中文** | [English](README.en.md) | [🐣 小白版](README.simple.md)

[![CI](https://github.com/skydong3434-alt/dsh-prompt-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/skydong3434-alt/dsh-prompt-optimizer/actions/workflows/ci.yml)
[![npm (upstream)](https://img.shields.io/npm/v/@y1x1n/dsh-prompt-optimizer?label=npm%20(upstream)&color=cb3837)](https://www.npmjs.com/package/@y1x1n/dsh-prompt-optimizer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/skydong3434-alt/dsh-prompt-optimizer?label=release)](https://github.com/skydong3434-alt/dsh-prompt-optimizer/releases/latest)
[![Stars](https://img.shields.io/github/stars/skydong3434-alt/dsh-prompt-optimizer?logo=github)](https://github.com/skydong3434-alt/dsh-prompt-optimizer/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

DeepSeek Harness 插件:在会话输入框(发送栏)旁提供一个「优化」按钮(✨ 图标),一键分析并优化当前输入的提示词草稿,**结果经 SSE 流式逐段上屏**。优化调用默认复用当前会话的模型路由(每次点击实时读取,会话里切换模型立即生效)。

- **Host 半侧**:注册 `POST /dsh-prompt-optimizer/optimize`(SSE 流式)与 `POST /dsh-prompt-optimizer/test-model`(连通性探活)两条路由,调用 `ctx.llm` 完成「分析 + 改写」。
- **Client 半侧**:向 `conversation.input.right` 槽位注入按钮,向 `conversation.input.dock` 注入结果面板(输入卡上方整行、与 TodoDock 同族,新会话界面也渲染,且不遮挡输入框),向设置页注入可折叠的设置卡片(优先 `settings.plugins.tab`(0.2.0+),并兼容 0.1.x 的 `settings.plugin.item`;**只在宿主确实声明了该槽位时才注册**,不会因未声明槽位抛错)。界面文案跟随 DSH 界面语言(中文 / English)。

## 目录

- [本 fork 增强（DSH Adaptive Prompt Optimizer）](#本-fork-增强dsh-adaptive-prompt-optimizer)
- [功能](#功能)
- [安装](#安装)
  - [从 npm 安装(推荐,最简)](#从-npm-安装推荐最简)
  - [从 Release 安装(tarball,免构建)](#从-release-安装tarball免构建)
  - [本地源码安装(tarball)](#本地源码安装tarball)
  - [从 GitHub 安装](#从-github-安装)
  - [卸载](#卸载)
- [兼容性](#兼容性)
- [常见问题](#常见问题)
- [验证状态](#验证状态)
- [工作原理](#工作原理)
- [开发](#开发)
- [安全说明](#安全说明)
- [贡献者](#贡献者)
- [License](#license)

> 🐣 **第一次用 dsh 插件?** 直接看[小白版指南](README.simple.md):三步装好、点按钮就用,全程大白话。

## 本 fork 增强（DSH Adaptive Prompt Optimizer）

### 怎么用（两步）

1. 在输入框写下你的 Prompt（口语化也行）
2. 点「优化」

**通常不需要选择任务类型** —— 主界面已经没有类型下拉了。

### 系统会自动判断

| 判断项 | 说明 |
|---|---|
| 任务意图 | 你到底要做什么（研究 / 规划 / 执行 / 排查 / 评审 / 创作…） |
| Prompt 类型 | 该用哪种提示词形态（结构化任务指令 / 图像描述 / 视频描述 / Agent 任务） |
| 目标模型 | 产物要交给谁用（例如 ComfyUI、可灵 / Kling、编码 Agent、DSH Agent） |
| 需要修改多少 | 按「最小必要修改」原则决定（见下） |

### 需要修改多少

| 情况 | 处理 |
|---|---|
| 你的草稿已经足够好 | **尽量不动**：允许最小必要修改，不机械要求变长 |
| 结构与措辞基本成立 | 只补少量缺口，**不重排、不加章节** |
| 信息齐了但组织混乱 | 去重、重排，**不新增**你没提过的目标 |
| 只有模糊目标 | 从零构建，但**仍只写完成任务真正需要的信息** |

> 修改量是模型内部按上述原则自行把握的；当前结果面板只显示「用途 + 本轮摘要」，不再显示档位。

### 会问你什么、不会问你什么

- **普通请求一次完成**：直接产出优化后的提示词，不做多轮分析，也不会为了「补齐规格」而反问你。
- **只在有语义歧义时问一个问题**：原文出现指代不明（「那个旧的」「这个」）且上下文里也找不到对象时，
  才提**一个**关键问题；你回答后立即继续优化，**不会重复确认**。
- **不问实现细节**：路径、接口地址、版本、技术选型、workflow、测试命令、MVP 还是正式版这类
  可以由执行方自己确认的信息，**不会要求你填写**。
- **不擅自扩展任务方向**：目标描述不会被改写成规划任务，想法交流不会被改写成执行任务，
  模型建议不会被写成你的明确要求。

### 典型支持的任务

Research（研究调研）· Planning（项目规划）· Execution / Coding（直接执行与编码）·
Diagnostic（故障排查）· Review（代码 / 架构评审）· Creative（创作）·
Image Generation（生图提示词）· Video Generation（文生 / 图生 / 首尾帧视频提示词）

> 兼容性说明:插件对**任何** DSH 会话模型都可用(它复用你当前的会话模型路由),
> 但不同模型的输出质量与稳定性不同 —— 尤其是**推理型模型**在分析阶段需要较大的输出预算,
> 我们不做「所有模型完美适配」的承诺。见 [CHANGELOG](CHANGELOG.md) 与发布说明中的已知限制。

### 保留的既有能力

- **硬性约束核对**：交付前在本地核对输入里的硬性约束（「不要 / 不得 / 禁止 / 只检查 /
  不修改」等）是否仍在结果中；有缺失就在面板上标出「来源校验未通过」，由你逐条复核。
  **不替用户发明约束**，也不会把优化器自己的建议混成你的要求。
- **不自动发送 / 不自动执行 / 不自动决策**：结果面板只给你检查与替换，发送仍由你按。
- **License 清洁**：设计来源与致谢见 [NOTICE.md](NOTICE.md)；AGPL 零复制由
  `scripts/check-license-contamination.mjs` 扫描保证。

![结果面板:优化稿流式上屏,可替换/复制/重新优化;徽章显示实际路由与用时](docs/screenshots/optimize-panel.png)

| | |
|---|---|
| ![发送栏空闲态:✨ 优化按钮位于模型选择旁,空输入时禁用](docs/screenshots/composer-idle.png) | ![面板错误态:上游模型错误完整透传,可一键重试](docs/screenshots/panel-error.png) |
| ![设置卡折叠态:标题栏显示关键摘要](docs/screenshots/settings-collapsed.png) | ![设置卡展开态:模型 / 调用参数 / 上下文 等分组配置](docs/screenshots/settings-expanded.png) |

## 功能

- 发送栏工具行右侧新增「优化」按钮(输入为空时禁用,优化中带呼吸动画);完成后模型徽章处展示实际路由与总用时。
- 点击后实时读取当前会话的 provider/model 发起辅助调用,**一次模型调用完成优化**(不再有「分析 → 编译」多轮链路),结果逐段流式显示在输入卡上方的面板里。
- **自动判断用途**:通用任务指令 / 生图提示词 / 视频提示词 / 音频提示词 / 面向执行 Agent 的指令;需要严格 JSON 时按结构化输出。**只有输入明确要求**「写一段生图/视频提示词」或「写给某个执行 Agent」才进入对应用途,只出现关键词不算。
- **只在真有歧义时提问**:仅当出现无法从输入或上下文确定的指代(「这个/那个/它」等)时才问,**每轮最多 1 个、最多 2 轮**;可点「保持未确定,直接优化」继续。不会追问实现细节(接口方式 / 版本 / workflow / 测试命令 / 技术选型)。
- **不擅自扩展任务方向**:一句目标描述不会被改写成「制定方案 / 直接实施」这类规划或执行任务;生图/视频模板只在明确要求时套用。
- **重新优化**:在同一份草稿上再次点优化会复用上一次的请求参数重跑,不会把上一轮结果混进模型输入(上一版架构的「记忆链」已随多轮链路一起移除)。
- **斜杠命令安全**:「/goal 帮我……」这类输入只优化正文,替换时自动拼回命令前缀,不会把命令词改坏;只敲命令没有正文时直接提示、不发无意义请求。
- **上下文感知**:默认携带当前会话的近期对话作为参考(**用户消息优先保底**——agentic 会话里 assistant 步骤碎片远多于用户输入,纯按时间取样会把你的真实诉求挤出去),总量 ≤8 条 / 1600 字符;上下文只用于理解意图,不代替草稿本身。可在设置卡关闭。
- 结果面板:**优化后的完整提示词** + **本轮摘要**(用途:GENERAL / IMAGE / VIDEO / AUDIO / AGENT,结构化时另标);操作:**替换输入框**(可**撤回**,在替换内容上继续编辑时撤回入口自动失效)/ 复制 / 重新优化 / 关闭。**发送消息后或清空输入框时面板自动关闭。**
- **取消不丢内容**:优化中按 Esc 取消,面板定格展示已生成的部分,可直接查看、「重新优化」续跑或关闭;非加载状态按 Esc 直接关闭面板。客户端另带**超时看门狗**(设置超时秒数 + 5s 余量):Host 挂死或网络黑洞时不再无限转圈,直接落明确的超时错误。
- 面板按会话隔离:切换会话后旧结果不会飘到别的会话,也不会误替换别的会话的输入框。
- **流式自动跟随滚动**:实况内容增长时贴住底部,向上滚动即暂停跟随,滚回底部附近自动恢复。
- 面板样式全部走 Harness 官方设计令牌(`--dsw-alias-*`),明暗主题自动跟随。
- 输出被截断时会展示已生成部分并明确提示,不会整段消失。
- **协议与格式容错**:模型的思考内容与内部协议信封**不会**出现在实时预览或结果里(预览在协议开始处截断);模型未按内部协议输出时按纯文本兜底,空产出显示为明确的技术错误、不会伪装成「需要澄清」。
- 设置 → 插件配置 → 「提示词优化」卡片(默认收起,点击标题栏展开;所有改动可一步撤销——底部「撤销上一次修改」,内存栈最近 20 次):
  - **模型**:优化用模型(**跟随当前会话**(默认),或从模型目录固定一个,provider/model 下拉、目录可手动刷新)/ 模型连通性(「测试连接」,32 token / 20s 封顶探活,显示实际路由与耗时)
  - **调用参数**:输出语言(中文 / English);推理强度:降到最低档(默认,推理模型首 token 前的空转显著缩短)/ 跟随会话;最大输出 Token(默认 8192)、超时时间(默认 120s)、采样温度(默认 0.2,悬停见设计依据)
  - **上下文**:携带上下文开关(默认开):关闭后仅看草稿本身,不读取会话历史
  - ⚠️ **已知不一致(待后续版本清理)**:卡片里仍保留上一版架构的开关 —— **回退模型**、
    **提示词类型**、**分类模型**、**优化模式(完整 / 快速)**、**输出上限自适应**。当前单次调用流程
    **不读取**这些设置,改动它们不会影响优化结果。

## 安装

前提:已安装 `dsh` CLI(`npx @deepseek-ai/dsh web` 可用的环境)。

> **装本 fork 的正式方式 = GitHub 源码安装(下方第一小节,推荐)**。
> 本 fork **未发布到 npm、也未在 Release 中提供 tarball 资产**,因此「上游基线安装」一节
> 装到的是**上游基线代码**(不含本 fork 的 V3 单次调用架构与增强)——只有在你确实想用
> 上游版本时才用那一节。

### 从 GitHub 安装(推荐,装本 fork)

> ✅ **`v0.3.2-apo` 已发布**:见 [GitHub Release v0.3.2-apo](https://github.com/skydong3434-alt/dsh-prompt-optimizer/releases/tag/v0.3.2-apo)
> (tag `v0.3.2-apo` → commit `6ac2b17`)。下面的命令可直接使用。

```sh
dsh plugin --profile web add github:skydong3434-alt/dsh-prompt-optimizer#v0.3.2-apo
```

Git 安装拉取的是源码,本包通过 `prepare` 脚本在安装时自包含构建(只需 Node,不依赖 monorepo
环境)。pnpm ≥10 首次会拒绝运行构建脚本,按终端提示把包名加入该 profile 的
`pnpm-workspace.yaml` 的 `allowBuilds` 后重试即可。建议锁定正式 Release Tag(如上面的
`#v0.3.2-apo`);开发期也可锁定分支或 commit:`github:skydong3434-alt/dsh-prompt-optimizer#<sha>`。

### 本地源码安装(开发本 fork)

```sh
cd dsh-prompt-optimizer
npm install --legacy-peer-deps           # prepare 钩子会自动构建 lib/
dsh plugin --profile web add /绝对路径/dsh-prompt-optimizer   # 目录形式(macOS/Linux)
# 或:先 npm pack 再装 tarball(Windows 推荐)
npm pack                                  # 产出 skydong3434-alt-dsh-prompt-optimizer-0.3.2.tgz
dsh plugin --profile web add ./skydong3434-alt-dsh-prompt-optimizer-0.3.2.tgz
```

然后(重新)启动 `dsh web`,打开 Web UI 即可在发送栏旁看到按钮。

> **Windows 注意**:`dsh plugin add ./目录` 走 pnpm 的 `link:`,目前会把盘符冒号错解析成协议
> 分隔符,生成失效符号链接(`node_modules/<pkg>` 指向不存在的路径),表现为插件不加载。
> Windows 本地安装请用上面的 **tarball 形式**;目录链接形式在 macOS/Linux 正常。

### 上游基线安装(非本 fork)

以下命令装到的是**上游 `@y1x1n/dsh-prompt-optimizer`**,不含本 fork 的任何增强;仅需要
上游基线时使用。

```sh
# 从 npm 安装(上游基线)
dsh plugin --profile web add @y1x1n/dsh-prompt-optimizer

# 从 Releases 下载上游 tarball(文件名形如 y1x1n-dsh-prompt-optimizer-<版本号>.tgz)后安装(上游基线)
dsh plugin --profile web add ./y1x1n-dsh-prompt-optimizer-<版本号>.tgz
```

### 卸载

```sh
dsh plugin --profile web remove @skydong3434-alt/dsh-prompt-optimizer
```

> 注:如果此前装过**上游基线**(`@y1x1n/dsh-prompt-optimizer`),它与本包互不隶属,需分别卸载。

## 兼容性

> **当前发行线(v0.3.2-apo;上游名义版本为 0.4.0)适配 DeepSeek Harness**:
>
> | dsh 版本 | 优化路由 / 模型调用 | 设置页(含 GitHub 入口) | 发送栏按钮 / 结果面板 |
> |---|---|---|---|
> | **0.2.0-rc.2(Web + 官方桌面端)** | ✅ 实测 | ✅ 实测(volatile 配置 + 原生风格设置卡) | ✅ 实测 |
> | **0.1.5-rc.2** | ✅ 实测 | ✅ 实测 | ✅ 实测 |
> | **0.1.5-rc.1** | ✅ 实测 | ✅ 实测 | ✅ 实测 |
> | **0.1.2-rc.1 / 0.1.2-alpha.5** | ✅ 实测 | ✅ 实测 | ✅ 实测 |
> | **0.1.1-rc.2 及以下**(0.1.0-rc.7+) | ✅ 实测 | ✅ 实测 | ✅ 实测 |
>
> 同一份构建覆盖 0.1.0-rc.7 至 0.2.0 全线;此标注自 v0.3.15 起在每个 Release 说明中固定维护,更早 Release 的说明已回溯补注。

- **v0.4.0 适配 dsh 0.2.0-rc.2(2026-10-03,Windows,真实 profile 端到端)**:①设置迁移——0.2.0 移除 `settingsScope` 服务与 `settings.plugin.item` 槽位,设置改由宿主按插件 Config schema 自动生成表单;本插件 Config 全字段声明 `.volatile()`(volatile 字段经引用 cell 原位更新,**修改设置不重挂载插件**),客户端经 `configForms` 读写;设置卡对 0.2.0 的 `settings.plugins.tab` 与 0.1.x 的 `settings.plugin.item` **各自独立探测** —— 在各自的 inject 回调里注册(回调被触发即证明宿主已声明该槽位),**绝不注册未声明的槽位**(DSH 2.0.x 对未声明槽位的注册会直接抛错并中断该插件的客户端同步;见 CHANGELOG v0.3.1-apo);②设置卡按 0.2.0 官方设计语言重做(平铺行布局、官方同款分段控件与开关、`configure({auto:false})` 关闭宿主原生表单避免重复);③消息源 `kind:'plugin'` 以结构断言跨过 0.2.0 收窄后的联合类型(运行时按 merge-extensible 容忍);④已在 **0.2.0-rc.2 Web**(按钮、SSE 面板、模型目录 RPC、设置卡读写与撤销、配置写入 profile 补丁且插件不重启)与**官方桌面端**(Electron `DeepSeek Harness 0.2.0-rc.2`,desktop profile 经应用自带 CLI 安装,发送栏按钮与设置卡 UIA 实测)通过验证。
- **官方桌面端安装**:桌面应用首次启动初始化 `desktop` profile 后,完全退出应用,用应用自带 CLI 安装并重启:`"E:\Deepseek-Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @skydong3434-alt/dsh-prompt-optimizer`(macOS/Linux 路径见应用安装目录);不要用 npm 版 CLI 管理桌面保留 profile。**注意**:桌面 profile 的依赖键必须与 `package.json` 的 `name` 严格一致 —— 只改仓库包名而不改 profile(或反之)会让宿主在准备 profile 时抛 `profile package identity is invalid` 并**终止启动**;改完必须**完整重启**应用(宿主只在进程启动时加载一次插件模块)。

- 开发基线:`@deepseek-ai/*` **0.1.5-rc.1**(v0.3.17 起,`sync:types` 钉同一版本);已实测通过 **0.1.0-rc.8**(2026-08-20,Windows,真实 profile 安装 + Web 路由/客户端 bundle/会话历史 RPC/端到端 LLM 调用)、复测通过 **0.1.1-rc.2**(2026-08-27)、适配并通过 **0.1.2-rc.1 与 0.1.2-alpha.5**(2026-09-05/06)、**0.1.5-rc.1**(2026-09-10,真实 profile 端到端冒烟:组合层注入、路由 SSE、client bundle、发送栏按钮与结果面板、设置卡片)与 **0.1.5-rc.2**(2026-09-11,全链路复测:组合层注入、Host 加载、路由契约 405/400/200、SSE 端到端 155 帧 delta、四种策略路径、client bundle 槽位与设置卡 API 全部通过,69 项测试全绿)。
- 已在 **macOS** 端通过自动化实测(2026-09-02,macOS 26.5(Darwin 25.5.0),Node.js v26.0.0,`npm install --legacy-peer-deps` 后 `sync:types` / `typecheck` / `build` / `npm test` 全部通过,62 项测试全绿);CI 现同时在 ubuntu-latest 与 macos-latest 上跑 typecheck + 全量测试(@ruijiaang-lab,#3)。
- **dsh-settings API 兼容层**:0.1.2 线重写了设置 API(独立函数 `installSettingsSection` 移除,改为 `ctx.settings` 服务的 `installSection` 方法)。0.3.16+ 运行时按能力探测自动分派:新 API 存在则走新接口,否则内联等价实现(register+watch+卸载回落),settings 服务整体缺席时回落组合层配置。
- **客户端类型面随 0.1.2/0.1.5 迁移**(v0.3.17 适配):`dsh-client-runtime` 包已从上游移除,`ClientContext` 即 cordis 的 `Context`;`SettingsScope` 迁至 `@deepseek-ai/dsh-client-ui-settings/client`(其 `SettingsScopeBinder` 自带 `ctx.settingsScope` 的 Context 合并,插件不再重复声明,否则合并冲突);`ctx.slots` 的合并由 `@deepseek-ai/dsh-client-ui-renderer/client` 提供。`HistoryEntry` / `ModelProviderGroup` 迁入未发布的 `dsh-api-session-controller`,插件改在 `src/client/host-faces.ts` 自带最小结构面,不再追上游类型。
- **会话模型与目录(v0.3.17 起真实可用)**:模型目录走连接层通用 RPC `session/modelCatalog`(`/api` 通道,载荷信封要求恰好一个纯对象 `args` 字段,零参方法即 `{ args: {} }`);「跟随会话」读取官方会话模型目录服务 `ctx.modelDirectories`(`dsh-client-ui-model-selection` 提供,与 /model 弹窗共用同一份目录,其 `current` 即会话实际将使用的模型)。该服务经**独立的可选 inject** 捕获——不能并进主 inject,否则无此服务的宿主会让客户端永远等不到就绪;缺席时回落 Host 回退解析。
- **会话历史(上下文)仍是缺口**:`connection.api.sessions.history` 这一旧查询面在发布版(0.1.0-rc.7 → 0.1.5)从未声明、浏览器运行时也不提供,插件按可选结构面调用,缺席时按无上下文优化并告警;真实路径需要 `session/follow`/`session/page` 流(还要先从 follow 首帧取 `throughSeq`),待接入。
- **客户端槽位 props 双形态**:0.1.2 起 composer 槽位改为 session scope,组件经 standard hooks(`useInput`/`useSession`)读取会话与草稿状态,注册需采用「注入回调内 scope 化注册 + `inject(sessionId)` 钩子」的官方双层形态。组件按 props 形态自动分派(0.1.2 走 hooks,旧版读直传快照),两种宿主共用同一份构建。
- **client bundle 注册 id**:`lib/client.js` 的 loader id 必须等于插件 npm 包名(宿主 client-modules 按包名校验注册);client 注入列表已随 0.1.2 移除已合并的 `dsh-client-runtime`。0.1.5 起 bundle 以 `/plugins/??<id>/client.js,…&rev=<hash>` 组合 URL 提供,单插件裸路径不再单独暴露(以 boot manifest 里的组合 URL 为准)。
- HTTP 载体服务名在发布版间漂移过(npm 0.0.1-rc.x 类型包叫 `httpServer`,0.1.0-rc.x 运行时叫 `webServer`):本插件用 `ctx.inject` 同时等待两个名字,且不做静态硬依赖——即使服务名再次变化,也只会使本插件的路由不注册(10 秒后日志告警),不会拖垮整个 Harness 启动。
- **客户端协议口径**:`/dsh-prompt-optimizer/optimize` 预校验失败返回 400/405/409/413(普通 JSON),成功后进入 SSE 流,模型错误经 `error` 事件传达;`/dsh-prompt-optimizer/test-model` **无论成败一律 HTTP 200**,由 body 的 `ok` 字段区分(探活是应用层语义,刻意不走传输层状态码)——对接方请以 `ok` 为准。
- 客户端与 Host 需同版本(SSE 协议是私有约定):升级插件后请重启 `dsh web` 并刷新浏览器页面。

## 常见问题

- **点了「优化」没有反应?** 打开浏览器 Console 查看 `[dsh-prompt-optimizer]` 开头的日志;常见原因是未配置任何模型(先在 设置 → 模型 里配好提供方),或面板所需的上游槽位尚未就绪(刷新页面)。
- **提示「未找到可用模型」?** 会话没有选择可路由的模型,且设置卡里也没有固定模型;两者补其一即可。也可以展开设置卡点「测试连接」确认路由可用。
- **设置卡显示「模型目录加载失败」?** v0.3.17 起目录改走宿主 `session/modelCatalog` RPC,正常应能列出全部提供方与模型;仍失败时提示会附上具体原因(点「刷新」重试)。注意「跟随会话」依赖宿主的会话模型目录服务(`ctx.modelDirectories`),个别宿主形态缺席时优化调用会回落到 Host 的第一个可用路由(Console 有对应告警)。
- **结果被截断?** 面板会出现截断提示；到设置卡调高「最大输出 Token」即可（上一版的「输出上限自适应」在当前单次调用流程中不生效）。
- **换了会话模型没生效?** 每次点击都会实时查询会话当前模型;若仍不对,看 Console 是否有 `会话模型查询失败` 的警告(此时会用第一个可用路由兜底)。注意:设置卡里固定了模型时会话选择不生效。
- **优化调用偶发超时 / RATE_LIMIT 失败?** 这类瞬态错误的重试由宿主在**提供方层**统一处理(dsh 0.1.1+ 的提供方配置内置重试策略,默认覆盖 `RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE`)。到 设置 → 模型 → 对应提供方 里调整重试次数与退避,而不是调本插件的「超时时间」——后者只管单次调用的总时长。
- **设置页找不到卡片?** 0.3.0 的严格枚举 schema 与旧版设置文档冲突会导致卡片不渲染,0.3.1 起已修复(未知枚举值自动回落默认);确认版本 ≥0.3.1 并刷新页面。
- **卸载后按钮还在?** 插件集合变更需重启 `dsh web` 才生效;刷新页面不够。

## 验证状态

> 以下为**上游版本**的验证历史（保留原文，便于对照）。**v0.3.0-apo 之前的条目描述的是已被
> V3 单次调用架构整体替换掉的上一版链路**（多轮「分析 + 编译」、双策略、记忆链、快速模式、
> `[待补充:]` 占位符等），仅作历史对照，不代表当前行为。本 fork 当前版本的发布前真实验收记录见
> [docs/ui-acceptance-m03813.md](docs/ui-acceptance-m03813.md)（35 项真实 UI 人工测试台账，最终 5/5 PASS）。

已在真实环境验证(dsh 0.1.0-rc.8 实测 + 0.1.1-rc.2 复测,Windows,详见「兼容性」);macOS 端自动化实测通过(2026-09-02,macOS 26.5,62 项测试全绿,CI 亦常驻 macos-latest 跑全量测试);**v0.3.16 起 0.1.2 线(dsh 0.1.2-rc.1 / 0.1.2-alpha.5)完成端到端实测**(发送栏按钮、结果面板、设置卡片、优化路由与 SSE);**v0.3.17 起 0.1.5-rc.1 完成端到端实测**(2026-09-10,Windows,真实 profile + 浏览器驱动:发送栏「优化」按钮随输入启停、点击后面板打开并按 SSE 透传上游错误、设置卡片折叠摘要与展开配置齐全),**并在 0.1.5-rc.2 上完成全链路复测**(2026-09-11:组合层注入、Host 加载、路由契约、SSE 端到端、四种策略路径、client bundle 槽位与设置卡 API 全项通过);v0.3.9–0.3.11 另在**第三方免费模型**(openrouter 的 `minimax/minimax-m3:free`,不输出标记格式)上完成端到端实测:模板/意图双策略、保真逐要素保留、待补充标记、记忆链与取消保留等行为均按设计工作,并据此修复了快速模式的格式误报。

- 组合层加载:`--dump-config` 出现 `# == @skydong3434-alt/dsh-prompt-optimizer` 层(旧身份为 `@y1x1n/dsh-prompt-optimizer`);
- Host:启动日志 `[dsh-prompt-optimizer] loaded`,优化路由与测试路由的 400/405/409/413 各路径行为正确,SSE 流式输出实测正常;
- Client:bundle 被 client-modules 扫描收录并出现在页面 boot manifest(0.1.5 起以 `/plugins/??<ids>&rev=<hash>` 组合 URL 提供),插件行出现在模块清单中;
- 端到端:真实调用 `ctx.llm`(DeepSeek 路由)完成「分析 + 优化」,标记解析正确(`wellFormed: true`)。
- 自动化测试(`npm test`,共 62 例):
  - `test/smoke.mjs`:28 项 Host 冒烟用例(真实 cordis Context + mock 服务,覆盖路由解析优先级、空字符串/畸形配置、400/405/409/413、SSE 事件流、max-tokens 截断、超时、快速模式、推理钳档、旧版设置文档归一化、连接测试、回退链与回退原因透传、tool-calls 防御、输出上限自适应、上下文注入与硬开关、策略选择、记忆链注入与截断、来源围栏);
  - `test/prompt.test.mjs`:13 项元提示词解析用例(标记空白变体、降级路径、流式实况解析、流式缓冲压缩、token 估算、上下文载荷与预算收敛、策略分叉、保真纪律与示例、记忆链载荷);
  - `test/controller.test.mjs`:21 项客户端纯逻辑用例(SSE 帧解析、合帧节流、连接中断、跳过会话查询、撤回流转、retry、close 中止、cancel 取消保留已生成部分及其状态门槛、客户端超时看门狗、历史提取过滤与失败降级、斜杠前缀拆分与空命令拦截、记忆链传递与门槛、发送即关闭判定、耗时记录、上下文取样用户消息保底)。

## 工作原理

```
点击「优化」
  → Client 拆分斜杠命令前缀(/goal 等只优化正文),并行拉取当前会话模型选择
    (session.models RPC,每次点击实时查询;设置里固定了模型时跳过,Host 固定值优先)
    与会话近期对话(session.history RPC,最近 8 条/1600 字符封顶,可在设置卡关闭)
  → POST /dsh-prompt-optimizer/optimize { text, provider, model, reasoningEffort, context? }
  → Host 组装一条 system + user 消息并调用 ctx.llm.stream() —— **一次模型调用完成优化**
    (路由解析:设置固定值 → 会话选择 → 第一个可用路由;输出语言 / 温度 / 最大输出 Token / 推理强度按设置)
  → 模型按内部协议返回 { status: 'optimized' | 'needs_clarification', usage, structured, output, question }
  → status = 'needs_clarification':下发一个问题(可「保持未确定,直接优化」),用户回答后再调用一次
    status = 'optimized':本地做硬性约束核对,并拦截「擅自扩展任务方向」与「特殊用途模板漂移」
  → text-delta 经 SSE 推送,面板实时显示(模型思考与协议信封在预览前剥掉,不外泄)
  → done 携带 optimized / usage / structured / provenance_ok;空产出落 error(VF_EMPTY_OUTPUT),不伪装成澄清
  → 一键替换输入框(可撤回,自动拼回斜杠前缀)/ 复制 / 重新优化;发送消息后面板自动关闭
  → 优化中 Esc = 取消(cancelled 态,保留已生成的部分);客户端看门狗在 Host 无响应时兜底超时
```

## 开发

```sh
npm install --legacy-peer-deps   # 安装依赖并触发构建
npm run sync:types               # 同步客户端类型包(见下)
npm run typecheck                # tsc --noEmit
npm run build                    # 产出 lib/{index,client,prompt,controller,client/settings-face,core/*}.js
npm test                         # 9 套测试:smoke / v3 / prompt / controller / compat-settings /
                                 #   settings-i18n / triage / identity / migrate-desktop-identity
```

### 关于 `sync:types`

上游 monorepo 只发布了部分 `@deepseek-ai/*` 包(其余 `publishConfig: restricted`),客户端类型包的传递依赖无法直接从 npm 安装。`scripts/sync-types.mjs` 的处理方式:

1. 对已发布的包,`npm pack` 后直接解压进 `node_modules`(绕开 npm 依赖树解析);
2. 对未发布的包(如 `dsh-type-meta`),扫描全部 `.d.ts` 引用并生成最小占位包(`skipLibCheck` 下仅要求模块可解析)。

这些包只参与类型检查;运行时一律由 Harness 页面/进程提供(`react`、`@deepseek-ai/*` 均为外部依赖)。

### 目录结构

```
dsh-prompt-optimizer/
├── package.json          # dsh.bundle + dsh.client 双 manifest
├── cordis.patch.yml      # 组合层:插入 Host 插件行
├── src/
│   ├── index.ts          # Host 插件:设置命名空间 + 两条 HTTP 路由 + V3 单次调用流程
│   ├── prompt.ts         # 流式文本收集、预览清洗、token 估算等纯函数
│   ├── core/
│   │   ├── v3.ts         # V3 核心:用途判定、系统提示词、协议解析、安全核对、扩展/漂移拦截
│   │   ├── triage.ts     # 机械复杂度判定(KEEP / PATCH / RESTRUCTURE / REBUILD)
│   │   └── types.ts      # 共享类型
│   └── client/
│       ├── index.tsx     # Client 入口:槽位注册
│       ├── controller.ts # 按钮/面板共享的状态机与 SSE 消费(独立产物,可单测)
│       ├── host-faces.ts # 宿主客户端服务的最小结构面(自带定义,跨版本稳定)
│       ├── settings-face.ts # 设置面适配层(多版本 settings API)
│       ├── i18n.ts       # 界面文案 zh/en 字典,跟随 DSH 界面语言
│       ├── OptimizeButton.tsx   # 发送栏按钮
│       ├── ResultDock.tsx       # 输入卡上方的结果面板(流式实况 + 撤回)
│       ├── SettingsCard.tsx     # 设置页折叠卡片
│       ├── SparkleIcon.tsx      # 手绘 ✨ 图标
│       └── GitHubIcon.tsx       # GitHub 图标(设置卡标题栏仓库入口)
├── scripts/
│   ├── build.mjs         # esbuild:Host ESM + Client lazy-CJS factory + 客户端设置面产物
│   ├── sync-types.mjs
│   ├── migrate-desktop-identity.mjs  # Desktop profile 独立身份原子迁移(备份/回退/幂等)
│   ├── v3-real-check.mjs # 真实模型行为验证(调用次数 / 原意保留 / 不得擅自增加)
│   ├── check-dod.mjs / check-license-contamination.mjs
│   └── prompt-probe.mjs  # 提示词实证探针:对运行实例发真实优化请求
└── test/                 # smoke / v3 / prompt / controller / compat-settings / settings-i18n /
                          #   triage / identity / migrate-desktop-identity
```

## 安全说明

- HTTP 路由注册在 dsh 自带的 Web 服务器上。默认监听 `127.0.0.1`;若把 dsh 暴露到局域网(`0.0.0.0`),本插件的优化接口同样可被局域网调用——它会消耗你配置的模型额度,请知悉。
- 两条路由均带**来源围栏**:带 `Origin` 头的请求(浏览器 POST 必带)必须与 `Host` 同源,且 `Host` 必须是回环地址或本机实际地址——网页侧的跨站伪造请求(CSRF)与 DNS rebinding 会被 403 拒绝;不带 `Origin` 的命令行调用不受影响。
- 插件不持有任何 API Key:模型调用全部经由 Harness 已配置的 `ctx.llm` 路由。

## 贡献者

感谢以下贡献者为本项目提交改进(见 [贡献指南](CONTRIBUTING.md)):

- [@ruijiaang-lab](https://github.com/ruijiaang-lab) — 贡献指南([#2](https://github.com/Y1X1n/dsh-prompt-optimizer/pull/2))

## License

MIT（保留上游 [Y1X1n/dsh-prompt-optimizer](https://github.com/Y1X1n/dsh-prompt-optimizer)
署名与 [@ruijiaang-lab](https://github.com/ruijiaang-lab) 致谢）。

本 fork 设计来源（WestFox BSD-3 借鉴设计 / linshenkx、zhangjiazhi **AGPL 仅思想零复制**）
与依赖 License 一览见 **[NOTICE.md](NOTICE.md)**；AGPL 污染检查：
`node scripts/check-license-contamination.mjs`（PASS）。
