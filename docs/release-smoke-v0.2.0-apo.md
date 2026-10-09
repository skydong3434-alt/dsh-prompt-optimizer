> ⚠️ **已过时（历史记录）** — 本文描述的是 **V3 之前的旧多阶段架构**（意图分析 / 编辑分诊 / 需求发现 / 编译器 / 校验器 / 策略路由），
> 相关代码已在提交 `435b643` 删除，文中的模块名、文件路径、测试名与 npm 命令**均已失效**。
> 当前实现与文档入口见 [`CURRENT_STATE.md`](../CURRENT_STATE.md) 与 [`docs/README.md`](README.md)。本文仅作历史记录保留。

# v0.2.0-apo 发布冒烟记录

> 基线:`895feeb`（RC 最终代码基线）· 构建:本仓库 `npm run build` 产物(`lib/`)
> 驱动:真实宿主处理器 `POST /dsh-prompt-optimizer/optimize`（与 Desktop UI 同一条路由）+
> 真实模型 OpenCode Go / `deepseek-v4-flash`
> 脚本:`node scripts/release-smoke-v0.2.0-apo.mjs`（结果 JSON 落在 `logs/release/`）

**结论:仍未通过发布门禁（NOT_READY_FOR_RELEASE）** —— 见下方 §1/§3。

## 0. 本轮（Release Blocker Fix）进展

| 项 | 状态 |
|---|---|
| H:re-optimize 只改措辞 → 保留已确认要求、不重复询问、直达 complete | ✅ **已修复**（根因:reoptimize 的 gate 未与对账后台账对齐;见 §1 Blocker 3）;regression R3 通过 |
| confirm 两个死循环的 regression | ✅ 新增 `test/release/release-blockers.test.mjs` R1/R2（含「Compiler 仅调用一次」） |
| C / E 终态定性 | ⏳ **部分完成**:已证明产品在**最坏情况**（模型每轮都报新决策）下仍能自行到达终态（3 轮 → confirmation → complete）;C 的失败终态是 `returned`(RETURN_TO_MISSING_RESOLUTION/VF_S…),即**明确终态**而非「无终态」;尚需判定该回流是安全网正常工作还是误报 |
| G 断言误报 | ⏳ 已定位为**测试断言误报**（输出同时含「只检查」约束与「直接修改」字样,后者出现在否定语境）;断言已改为否定感知,尚未重跑确认 |
| 8 项 smoke 全绿 | ❌ 最近一次完整运行 6/8（A/B/D/E/F 通过;C=returned;G=断言误报;H 未跑完） |

> 本轮**未能**在预算内完成一次干净的 8/8 运行;`docs/release-smoke-v0.2.0-apo.md` 的最终数字需在下次运行后更新。

## 1. 本轮发现并修复的 release blocker（真实功能缺陷）

冒烟在基线 `895feeb` 上暴露了 **confirm（确认并优化）路径的两个真实死循环**:
用户点了「确认并优化」却**永远进不了编译**,而界面显示「没有阻塞项」。

### Blocker 1:`confirmBlocked` 忽略 `ready`（轮次上限后永久拒绝）

`evaluateSufficiency` 在达到 Discovery 轮次上限时返回 `ready: true`
（设计契约:「未决项按暂定处理,不再追问」),但 `liveBlocking` 仍非空。
宿主旧写法 `confirmBlocked = liveBlocking.length > 0` → 达上限后**永久拒绝** confirm。

**修复**:`confirmBlocked = liveBlocking.length > 0 && !ready`
（未达上限仍阻塞,fail-closed 不变;达上限按暂定继续,与 sufficiency 契约一致）。

### Blocker 2:confirm 复用了「确认前」的快照 gate

confirm 时 `clientAnalysis` 是用户确认**之前**的分析快照,其 `gate` 仍标 `blocked=true`
（当时确实还没问完)。此刻 `confirmBlocked=false` 已按**当前台账**重算过,但旧写法原样沿用
旧 gate → 流程被送回确认页 → 用户怎么点都进不去。

**修复**:确认时刻以 sufficiency 为准,把快照 gate 归一为不再阻塞
（`blocked:false` / `blocking_items:[]`),并在理由里写明依据。

两处修复都在**宿主 confirm 分支**,未改动 Intent Analysis / Triage / Missing Resolution /
Discovery / Ledger / Decision Safety / Router / Compiler / Validator / Reconciliation /
Target contracts / 分类规则 / regex / 预算 / 阈值。`npm test` 486 断言仍全绿。

## 2. 8 条路径冒烟结果（真实模型,多次运行）

修复后多次运行的结果**不稳定**(同一路径在不同运行里 PASS/FAIL 翻转),
原因是真实模型每轮会**新报出不同数量**的阻塞决策,而本脚本的轮次预算固定。
把「模型多问几轮」也算进去的完整运行里,产品会正确走到 `compiling→validating→complete`。

| 路径 | 内容 | 最近一次 | 备注 |
|---|---|---|---|
| A | KEEP:完整 Prompt → 原文逐字保持 | **PASS** | 逐字一致,编译调用 = 0 |
| B | PATCH:只局部修补 | **PASS** | 原条目保留,闭环到达 complete |
| C | RESTRUCTURE:重新整理不新增目标 | FAIL(波动) | 另一次运行 PASS(157→1666 字) |
| D | REBUILD + Discovery 六态闭环 | **PASS** | Discovery 前编译 = 0;目标=用户目标;自查项未被问;最终 2354 字 |
| E | Image:自动 Image contract | FAIL(波动) | 另一次运行 PASS(`contract=image`,无任务模板) |
| F | Video/Kling | **PASS** | `contract=video engine=kling`,描述式,无任务模板 |
| G | 硬约束「只检查,不修改任何文件」 | **PASS** | 约束保留,无越权改写指令 |
| H | Re-optimize:仅改措辞 | FAIL | 首次闭环成功,但再优化时**重复询问**且台账丢失 |

**未达成发布门禁要求的「8 项全部通过」**。

## 3. 待查（release blocker 候选）

1. **C / E 的间歇失败**:最后一轮返回既非 `done` 也非 `requirement_confirmation`
   （疑似 `error` / `returned` 事件）。需要判定是**提供方瞬时错误**还是
   **Validator 硬错误**（例如执行关键责任缺失在回流上限后升级为 HARD_ERROR）。
   若是后者,属于真实产品缺陷,必须先修。
2. **H 的再优化对账失败**:`重复询问=true 保留 CONFIRMED=0 台账=0` ——
   再优化时台账没有带回,既重复询问又丢失已确认要求。这与 RC1/RC2 的
   `mode:'reoptimize'` 契约不符,需要单独取证（是宿主未回传、还是脚本回声不对）。

## 4. 真实 DSH Desktop GUI 步骤（需用户本人确认）

浏览器信任围栏禁止外部注入,以下**必须由用户手动完成**（这是 Human Gate,不由 Agent 代过）:

1. 用**准备发布的构建**（`npm run build` 产物)重载 DSH Desktop。
2. A:粘贴一份完整 Prompt → 点「优化」→ 确认输出与输入**逐字一致**。
3. B:输入 `1. 先跑一遍测试 / 2. 再看失败日志 / 3. 输出格式:Markdown 表格` → 点「优化」
   → 若弹出少量问题先回答 → 确认只做局部修补,原有条目与措辞保留。
4. C:输入一段信息完整但重复啰嗦的需求 → 确认只被重新整理,没有新增你没提过的目标。
5. D:输入 `我想用 dsh 控制 comfyui 生成视频。` → 观察状态序
   `analyzing → discovery_required → 回答 → requirement_confirmation → confirm → compiling → validating → complete`;
   确认确认页「目标」是你的目标、「你已确认」是你真实选的答案、Agent 自查项没有被要求填写。
6. E:输入生图提示词需求 → 确认走 Image 描述式契约,没有 Goal/Phase/Task 模板。
7. F:输入「根据这张首帧写可灵视频提示词…」→ 确认识别 Video + Kling,产出描述式视频提示词。
8. G:输入「帮我看看这段代码有没有并发问题。只检查,不修改任何文件。」
   → 确认最终提示词没有突破「不修改文件」。
9. H:先完成一次带确认的优化,然后**只改无关措辞**再优化 → 确认已确认要求被保留、不重复询问。

## 5. 门禁状态

| 门禁项 | 状态 |
|---|---|
| Final RC baseline = `895feeb` | ✅ |
| `npm test` 486 断言 | ✅ 全绿 |
| `npm run build` | ✅ 成功 |
| cordis / DSH Desktop load | ✅ 真实 cordis 加载通过（`test/smoke.mjs`） |
| **8 项真实 smoke 全部通过** | ❌ **未达成**（6/8,且存在间歇失败与 H 的确定性失败） |
| README / CHANGELOG / Release Notes | ✅ 已更新 |
| version metadata 一致 | ✅（`v0.2.0-apo` 于 NOTICE/CHANGELOG/README/check-dod） |
| `v0.1.0-apo` 仍指向 `c88e922` | ✅ 未移动 |
| 无意外功能代码修改 | ❌ 含 2 处 release-blocker 修复（宿主 confirm 分支,已单独提交） |
| 无新的 release blocker | ❌ 见 §3 |

**结论:NOT_READY_FOR_RELEASE。** 未创建 tag、未 push、未发布。
