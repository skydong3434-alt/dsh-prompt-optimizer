# CURRENT STATE

```
project: dsh-adaptive-prompt-optimizer
last_updated: 2026-10-09T17:06:00+08:00
current_phase: V3_CREATION_BOUNDARY_TIGHTENING
current_task: 落实用户 m03556「IMAGE / VIDEO 创作边界最终调整」(专业优化 vs 擅自创作的边界 / IMAGE / VIDEO / 首尾帧 / 用户已指定镜头必须保留)
status: DONE_AWAITING_USER_UI_ACCEPTANCE
next_task: 用户重启 DSH Desktop 后做人工 UI 验收(G-8)
machine_gate: PASS (npm test 105 组 / build exit 0 / v3-real-check 真实 UI 模型 32 例硬失败 0)
human_review: PENDING_USER_UI_ACCEPTANCE
creation_boundary_m03556: **收紧「专业化完善」与「擅自创作」的边界**。新增 `# 专业化完善与创作扩写的边界(IMAGE / VIDEO 重点)`:允许 6 项(已有元素之间的关系/已有动作的自然过程/时间顺序与运动连续性/**已有**镜头要求的表达/已有环境所隐含的自然特征/清晰度与可控性);默认禁止 8 项(擅自指定摄影机角度、擅自决定固定或运动镜头、擅自增加未指定景别、擅自添加具体布光方案、擅自增加景深虚化、擅自设计服装发型身份、擅自增加新人物道具动作情节、无参考帧时确定可能冲突的运动路径);用户明确要求丰富细节/创意发挥/设计镜头时允许在原有约束内创作;**原文明确指定**景别/机位/布光/镜头运动时必须保留并专业化完善。`# 优化原则` 第 2 层「构图与光影」→「已有环境的自然光影」。`# IMAGE` 改为「重点提升」5 项(主体描述/主体与背景空间关系/已有风格表达/环境自然特征/画面信息组织与清晰度)+「不要为了补齐模板强行加入景别、机位、布光和构图方案」,示例删除「侧后方打光」。`# VIDEO` 改为「重点提升」5 项(动作起点过程结束/动作时间关系/**已有**镜头运动描述/角色与场景连续性/首尾帧过渡)+「不要把专业优化理解为重新导演一段视频」。`# VIDEO 子类型` 首尾帧补「没有实际参考帧时,不得假定具体的身体姿态和运动路径」。`# 优化质量` 第 7 条明确「平台名/模式名是否逐字还在」+ 新增「平台与生成模式必须逐字保留……写丢平台名 = 不合格」(案例C #1 真实丢了「可灵」)。**未新增模块、未恢复多阶段流程、未新增机械拦截系统,普通请求仍 1 次模型调用。** 测试新增 `test/v3.test.mjs` 第 6c 组;`scripts/v3-real-check.mjs` 新增 `mustNotMatch` 判据 + 案例 G(用户已指定景别/镜头/布光必须保留)。
quality_upgrade_m03336: **核心原则从「忠实改写」升级为「原意保护 + 合理专业化完善」**。三层:①原文明确要求必须保留;②对已有要求的专业化细化(表达结构/逻辑关系/分析维度/已有动作的过程/时间与空间关系/已有环境的自然光影/连续性约束/有助于执行的通用要求)允许并鼓励;③新增独立目标或改变核心创作设定默认禁止(用户明确要求丰富细节/增强创意时可在原目标内扩写);原文已足够优秀时允许**最小必要修改**,不机械要求变长。新增 `# GENERAL:任务提示词的专业优化`(细化评估维度,不是把问句写正式)、`# IMAGE:生图提示词的专业优化`(完善主体与背景关系/空间层次/自然光影/风格表达;仍不得增加服装/发型/新人物/新动作/无关道具,不强制填满全部元素)、`# VIDEO:视频提示词的专业优化`(必须写清已有动作的起点/发展过程/结束状态,不能只做同义词替换)、`# VIDEO 子类型`(文生/图生/首尾帧/多参考图/多镜头/延长/编辑)、`# AUDIO`、`# 优化质量`(7 条自检)。`# 不得扩展任务方向` → `# 不得改变任务方向`(同一件事的细化 vs 换一件事);`# 关键歧义` 补「只有目标描述时可问一个方向问题,不得替用户选择」。**未新增任何模块,普通请求仍 1 次模型调用。** 注:m03556 已在 ② 之上进一步收紧 —— 镜头/景别/机位/布光/景深虚化与人物设定均属**擅自创作**,仅当原文明确指定时才可写。
rule_tuning_m03069: **①忠实优化模式**:IMAGE/VIDEO/AUDIO 默认只改善表达/动作顺序/画面连续性/描述准确度,不得凭空增加服装/外貌/道具/场景元素/光影色调/动作/情节;仅用户明确要求「丰富细节/增强创意/自由发挥」时才扩写;中英提示词各加一段(含逐字反例「深色外套」)。**②AGENT 判定**:不得靠代码/仓库/bug/函数/接口/测试/脚本等关键词判定,「优化一下这段代码」→ GENERAL(提示词反例 + 新增用例 `GENERAL-代码关键词不得判 AGENT`)。**③文档整理**:新增 `docs/README.md`(当前有效 / 历史已过时清单)与 `tasks/README.md`;23 份旧架构文档顶部加「已过时」横幅保留为历史。**④模型路由**:UI 用会话模型 `opencode-go/deepseek-v4.1-flash`,`scripts/v3-real-check.mjs` 默认模型与 provider 对齐(见下节)。**⑤未新增任何架构模块**,正常请求仍 1 次模型调用。注:m03336 已在 ① 之上放宽 —— 光影/色调/画面连续性现属**允许的专业化完善**,仅「新增独立创作设定(新人物/新情节/新服装)」仍禁止。
phase_status: **V3 单次调用架构已落地并完成精简(方案 B 分批执行)**。历史:v0.1.0-apo 已收官(annotated tag `v0.1.0-apo` → c88e922,不得移动);v2 四个 Phase 全部完成但**未发布**。当前:`src/core/v3.ts` 单次模型调用完成优化(默认路径),旧多阶段链路(Analysis/Compiler/Discovery/Validator/Strategy,约 13.7k 行)与 `v3:false` 回退分支已删除,`src/core/` 只剩 v3.ts / triage.ts / types.ts;`npm test` = 102 断言全绿,`node scripts/check-dod.mjs` 仅剩「v0.2.0-apo tag 未创建」(打标签由用户执行)。
v3_track: **用户 7 步令(m01789)驱动的精简重构,方案 B 分批执行**。①意图扩展修复 DONE(提示词硬规则 + `detectIntentExpansion` 机械兜底);②测试迁移 DONE(44 文件 A/B/C 分类,见 docs/v3-test-migration.md;commit c0f741c);③真实行为验证 DONE(scripts/v3-real-check.mjs);④旧架构删除 DONE(commit 435b643);⑤执行保护 持续。
ui_acceptance_fix: **用户真实 UI 验收失败修复(m02408)DONE(待人工验收)**。①擅自扩展任务:根因是运行中宿主为旧构建(`lib/` 12:37 构建 vs 宿主 10:59 启动)+ 机械兜底短语不全 → 提示词硬规则 + 补齐 `实现方式/控制流程/实施限制/方案或指南/整体思路/覆盖以下要点/列出优劣`;真实模型复测 3/3 只输出原句理顺版(1 次调用,~6s)。②不必要澄清:根因是提示词未区分「妨碍优化这句话」与「执行时才知道」→ 新增「缺一个名字/标识不算歧义」+ 逐字反例;复测 3/3 直接整理为分析请求(1 次调用,~6s),真歧义仍会提问。③特殊用途:模型识别正确(VIDEO),机械纠正层补 `优化|润色|改进` 动词;UI 旧字段(任务类型/把握度/提示词目标/编辑分诊)造成误读 → 移除。④UI 精简:结果面板默认只有「优化后的提示词 + 替换/复制/重新优化/关闭」,判断依据收进默认折叠的「优化说明」,澄清页只留问题与继续操作。**⑤复测另发现两个真实缺陷(已修)**:推理模型 `minimax-m3` 把思考直接写进 `content`(reasoning_content 为空),思考里的 `{...}` 片段被旧解析当成协议信封 → 「严格 JSON 输出 agent 任务指令」稳定空产出(`VF_EMPTY_OUTPUT`);修法 = `stripThinking` + `extractProtocolEnvelope`(只认 `status` 为 optimized/needs_clarification 的平衡 JSON)。宿主原样转发模型增量 → 快速模式预览泄漏思考与内部协议;修法 = 只下发 `previewableText`(剥思考 + 协议处截断)。测试:`test/v3.test.mjs` 第 9 组 + `test/smoke.mjs` 1b。**⑥另两个真实缺陷**:中文提示词被改写成英文(IMAGE 连续 2 次输出 `anime style illustration…`;提示词缺「与输入同语言」规则 → 中英提示词新增「输出语言」段,复测 4/4 中文);协议 `output` 给成对象时交付 `[object Object]`(严格 JSON 用例;修法 = `asText` 序列化非字符串 output/question)。
latest_commit: 53f196d feat(v3): IMAGE / VIDEO 创作边界收紧(专业优化 vs 擅自创作)
auto_continue: false
stop_reason: awaiting user confirmation: V3 真实体验(G-8)
```

## 模型路由（真实 UI 用的是哪个模型）— m03069 ④ 已核对

**结论:UI 里的优化请求用的是「当前会话的模型」,桌面端默认 = `opencode-go/deepseek-v4.1-flash`。**

- 客户端在每次优化前读会话当前模型并随请求发出(`src/client/controller.ts` → `directories.directoryFor(sessionId).load().current`
  → body 里的 `provider`/`model`);该服务(`@deepseek-ai/dsh-client-ui-model-selection`)在桌面端**确实加载**,
  所以「跟随会话」这条路是通的。会话当前模型 = `profiles/desktop/cordis.patch.yml` 的 `agent-default-model`
  = `opencode-go` / `deepseek-v4.1-flash`(会话内换模型则随之改变)。
- Host 端优先级(`resolveRoute`):设置里固定的 `model` → 请求体 `provider/model` → 第一个可用路由。
- **实测证据**(对运行中的宿主 `POST /dsh-prompt-optimizer/optimize`):
  - 带 `{"provider":"opencode-go","model":"deepseek-v4.1-flash"}` → `done.provider/model = opencode-go / deepseek-v4.1-flash`
  - 不带 provider/model(等价于没有会话信息) → `done.provider/model = opencode-go / minimax-m3`(**回退到该 provider 列表的第一个模型**)
- ⚠️ **教训**:此前「UI 实际跑 minimax-m3」的结论来自**一次没有会话信息的 curl 探测**,量到的是回退路由,不是 UI 路由。
  所以 `scripts/v3-real-check.mjs` 的默认模型已从 `deepseek-v4-flash` 改为 **`deepseek-v4.1-flash`**(可用
  `APO_PROVIDER` / `APO_MODEL` 覆盖);换默认值前必须先核对 UI 实际路由,否则测的不是用户看到的行为。

## 本轮规则调整（m03069 ①②,只改提示词与测试,未加模块）

- **①IMAGE/VIDEO/AUDIO 忠实优化模式**:默认只做忠实优化 —— 可以改善表达 / 动作顺序 / 画面连续性 / 描述准确度;
  **不得**凭空增加人物服装、外貌、道具、场景元素、光影色调风格、人物动作或情节;只有用户明确要求
  「丰富细节 / 增强创意 / 自由发挥」时才可扩写;并写明「这条规则不是让你少改」以免降低优化能力。
  真实失败反例(深色外套 / 神情沉静 / 霓虹灯光 / 电影感冷色调)已写进提示词与测试。
- **②AGENT 不靠关键词判定**:出现代码 / 仓库 / bug / 函数 / 接口 / 测试等词不等于要一份执行任务书;
  「优化一下这段代码」→ GENERAL。唯一判据是用户是否明确要「一份给某个执行方去执行的任务指令」。
- **③文档整理**:新增 `docs/README.md`(当前有效 / 历史文档索引)与 `tasks/README.md`;
  23 份旧架构文档加上「⚠️ 已过时(历史记录)」标记后保留。
- **⑤不加新架构模块**:本轮只改 `src/core/v3.ts` 提示词规则、测试与文档,正常请求仍是 1 次模型调用。

## 历史快照（以下内容描述已删除的旧多阶段架构,仅作记录）

> 注:旧架构文档(`docs/PLAN-v1.md`、`docs/phase{1,2,3,4}-report.md`、`tasks/P0*` 等)描述的是**已删除的旧多阶段架构**,
> 已统一加上「已过时」标记并集中索引在 `docs/README.md`;当前实现见 `src/core/v3.ts`,当前文档入口见 `docs/README.md`。

> ⚠️ 状态字段纪律：`stop_reason` 不得包含 Runner 的 BLOCKING_STOP_REASONS 任何标记词
> （blocking / merge conflict / schema breaking / contract breaking / architecture change /
> irreversible / transport exhausted / retry exhausted / test failure out of scope /
> scope expanded），否则会被误判停止。G-1 为 Human Gate：`status: GATE_PENDING` +
> `human_review: BLOCKING_G1`，`stop_reason` 使用 "awaiting user confirmation: G-1"
> 这一非标记词表述（详见 AGENTS.md §4 与本文件顶部说明）。

## 任务图（Task Graph, 只读快照）

| Task | 状态 | 说明 | 出口 |
|---|---|---|---|
| P00-T01 fork-and-baseline | DONE | 基线（BASELINE.md, da52f28；tag base-y1x1n-v0.4.0） | — |
| P01-T01 core-contracts | DONE | src/core/types.ts（17f4dee） | — |
| P01-T02 provenance-validator | DONE | provenance.ts 校验器（e32858f） | **G-1** |
| P01.5-T01 research-strategy | DONE | Research 策略 v0.1（15 段 + 守卫矩阵 + _shared 初版，bb4c6a4） | — |
| P01.5-T02 vertical-slice-e2e | DONE | 端到端（AUTO→…→Replace），3276e1e | **G-VS** |
| P02-T01 shared-rules | DONE | _shared 完整化：六段规则 + 5 守卫工厂 + invariant A·B（e06bf3b） | — |
| P02-T02 planning-strategy | DONE | planning 策略 v0.1：16 段 + 三铁律 + 守卫（9784dbe） | — |
| P02-T03 execution-strategy | DONE | execution 策略 v0.1：15 段 + 三铁律 + 守卫（543f737） | — |
| P02-T04 diagnostic-strategy | DONE | diagnostic 策略 v0.1：10 段 + 验证先于修改/假设证伪/修复必带复测 + 守卫（e0ec912） | — |
| P02-T05 review-strategy | DONE | review 策略 v0.1：9 段 + 基于原目标审查/不发散/偏离对应需求 + 守卫（11315af） | — |
| P02-T06 creative-strategy | DONE | creative 策略 v0.1：12 段（+Assets）+ 实体保真/无证据不改设定 + 守卫（7c9bde3） | — |
| P02-T07 general-research-integration | DONE | general 策略 v0.1：八板块 + template/intent 双模式；research v0.2.0：provenanceRules 4→7 + invariant A·B（bb37841） | — |
| P02-T08 registry-versioning | DONE | registry 七策略全注册/版本暴露/list/getSections；general 过渡期 legacy（419f999） | **G-2** |
| P03-T01 | DONE | classifier 纯函数层：七类型 + 防误判三规则 + JSON 契约容错（1aebeec） | — |
| P03-T02 | DONE | classifyViaLlm 调用侧封装：硬参数钳制/thinkFilter/超时与失败回退 + mock 单测（1e73fb2） | — |
| P03-T03 | DONE | 防误判规则测试（fixtures 五类 + g1..g10 + S-06 稳定性抽查，a810ea1） | P04 |
| P04-T01 | DONE | compiler core：compilePrompt 10 步编排 + 四段协议解析容错 + 缺口注入（8248c22） | — |
| P04-T02 | DONE | validate.ts 三层守卫（Preservation/Inference&Suggestion/Unknown）+ 策略 guards 汇总 + provenance_ok 联动契约（156b857） | — |
| P04-T03 | DONE | compiler + validator 集成测试：七类型契约矩阵 / provenance_ok 联动 / S-07 复审（16eedb4） | P05 |
| P05-T01 | DONE | host pipeline：handler 两阶段（classifyViaLlm→compilePrompt→finalize→validate）+ SSE meta/delta/done 扩展（9ffb320） | — |
| P05-T02 | DONE | 兼容回归：旧用例零回归证明（S-03，33cd988） | — |
| P06-T01 | DONE | AUTO 下拉 + 手动覆盖：TYPE_OPTIONS 单一真值源 + 逐类型请求体/重优化沿用（4f515db） | — |
| P06-T02 | DONE | ResultDock 四组 provenance 定稿 + 缺口清单独立 + 低置信类型黄条（1f3d530） | — |
| P06-T03 | DONE | settings 新字段（默认类型/分类模型）+ i18n 收尾（3dc97af） | **G-4** |
| P07-T01 | DONE | 语料固化：14 例 fixtures + schema 校验 + invariant_checks + docs/regression.md（f6f7466） | **G-3** |
| P07-T02 | DONE | regression runner：双通道 + 开销测量 + 报告（cc3aed0） | — |
| P07-T03 | DONE（G-5 裁定） | 首轮真实回归 8 轮 + 13 项纪律修复 + 报告存档（1d3de70）；deterministic 12/14 最佳单跑，残余端侧措辞方差；G-5 = PASS_WITH_KNOWN_HARNESS_FLAKINESS | **G-5** |
| P08-T01 | DONE | 隔离 profile apo-dev 安装 + 冒烟 12 项全过 + S-09 零改动证明（docs/p08-smoke.md） | **G-6** |
| P08-T02 | DONE | 桌面端实测/回归证据：四项真机探针全过（Follow DSH model route=opencode-go + fallback billing safety 双向验证）+ KNOWN_NON_BLOCKING_HARNESS_LIMITATION 记档 + BASELINE 附录 B（e26f960；docs/p08-desktop.md） | — |
| P09-T01 | DONE | 备份演练 + G-7 授权正式安装（备份 ~/.dsh/backups/apo/g7-install-20261004-140136/、bundles=21、未回滚；backup-profile.sh 随 P09-T02 入库 c88e922） | **G-7（已过，2026-10-04）** |
| P09-T02 | DONE | 发布产物 v0.1.0-apo：NOTICE/CHANGELOG/README/DoD 终检 + license 污染检查 + annotated tag（c88e922） | **DoD 终检（已过）** |
| V2-P1 | DONE | v2 升级 Phase 1：分析阶段（意图/目标/分诊/缺失解析）+ 阻塞门（discovery_required，零编译调用）+ KEEP 零改写；385 断言全绿（docs/PLAN-v2-adaptive-editor.md、docs/phase1-report.md） | — |
| V2-P4 | DONE | v2 升级 Phase 4:产品收口 —— Validator 可控回流(有界+reason code)、六态 UI、主界面移除模式选择器 + 低优先级「调整判断」、general 迁入 v2 契约、legacy 全部不可达、再优化 Ledger 对账、Triage 语义审计(PATCH 需可保留内容);468 断言全绿(docs/phase4-report.md、scripts/phase4-trace.mjs) | — |
| V2-P3 | DONE | v2 升级 Phase 3:Requirement Discovery 完整闭环（blocking → 提问 → 回答 → 重新分析 → 台账更新 → 确认 → 首次编译）;取舍型 → USER_REQUIRED+blocking、环境事实不升格、盲授权不产 CONFIRMED、confirm fail-closed;436 断言全绿（docs/phase3-report.md、docs/phase3-prerequisites.md、scripts/phase3-trace.mjs） | — |
| V3 | DONE | V3 单次调用重构:默认路径一次模型调用完成优化;意图扩展拦截、特殊用途模板漂移拦截、协议信封泄漏防护、超时终态修复;旧链路 13.7k 行 + 38 测试文件删除;101 断言全绿(130458d/c0f741c/435b643) | **G-8(用户实测)** |
| V2-P2 | DONE | v2 升级 Phase 2（用户裁决选项 A）：`informationResponsibilities` + Target-aware Router + Agent/Image/Video 契约（图像视频不再套 Goal/Phase/Task/Tests）+ 未决项五处置（`[待补充:]` 退役）；412 断言全绿（docs/phase2-contract.md、docs/phase2-report.md、docs/phase3-prerequisites.md） | — |

Gates：G-1 契约+Provenance 定稿 → G-VS 真实体验 → G-2 策略抽审 → G-3 语料集（阈值 DEFERRED_TO_P07_CALIBRATION）→ G-4 UI 预览 → G-5 回归报告 → G-6 隔离体验 → G-7 正式安装许可（唯一动正式 profile 的开关）→ **DoD 终检（当前）：用户声明 PASS 即项目完成**（详见 docs/dod.md；AI 不代过）。

## 无人值守运行说明（简版，详见 docs/runner-ops.md）

- Runner 每轮读取本文件：current_task 非空即续跑；为空读 next_task。
- Agent 收尾协议：完成一个 Task → 更新本文件（current_task 置空 → next_task 设为下一 Task；status/stop_reason 相应更新）→ 一个内容提交 + 一个仅状态同步的提交。
- Human Gate（G-1/G-VS/G-2…）命中时：status 置 GATE_PENDING、human_review 置 BLOCKING_<门禁名>，stop_reason 用 "awaiting user confirmation: <门禁名>"，**不要硬做**。
- 无人值守：不会有人回答提问；需要人工裁决时写 stop_reason 后结束本轮。
- 边界（NON-GOAL）：不碰正式 DSH profile / ~/.dsh 正式配置 / PAB / Personal AI Brain / AI 视频工作流；不安装 launchd；不复制任何 AGPL 代码（linshenkx / zhangjiazhi）。
- 本仓库 git remote：upstream = Y1X1n/dsh-prompt-optimizer（只读）；origin 待用户提供自有仓库 URL。
- **项目里程碑**：P00–P09 全部 Task DONE；tag v0.1.0-apo 已建；DoD 机器证据齐备（docs/dod.md），等待用户最终 Human Product Acceptance 声明 PASS。