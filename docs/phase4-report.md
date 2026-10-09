> ⚠️ **已过时（历史记录）** — 本文描述的是 **V3 之前的旧多阶段架构**（意图分析 / 编辑分诊 / 需求发现 / 编译器 / 校验器 / 策略路由），
> 相关代码已在提交 `435b643` 删除，文中的模块名、文件路径、测试名与 npm 命令**均已失效**。
> 当前实现与文档入口见 [`CURRENT_STATE.md`](../CURRENT_STATE.md) 与 [`docs/README.md`](README.md)。本文仅作历史记录保留。

# Phase 4 实施报告 —— 产品收口 + 全链路一致性（v2 升级第四段）

> 对应 `docs/PLAN-v2-adaptive-editor.md` §2「Phase 4」与用户给定的 26 条完成标准。
> 证据脚本:`node scripts/phase4-trace.mjs`(文末附录 A–F 即其真实输出)。

---

## What —— 做了什么

| # | 交付 | 落地 |
|---|---|---|
| 1 | **Triage 语义审计与修正**(PATCH 必须有可保留内容;模糊目标 → REBUILD) | `core/triage.ts` |
| 2 | **Discovery 不得修改 Edit Triage**(首轮钉住,逐轮回传) | `src/index.ts` |
| 3 | **Confirmation 四类互斥**(id + 语义双重去重) | `core/discovery.ts` |
| 4 | **Validator 升级为可控回流控制器** | `core/validation-flow.ts` + 宿主 |
| 5 | **主界面移除模式选择器**;自动判断为默认 | `client/OptimizeButton.tsx` |
| 6 | **低优先级「调整判断」高级 override** | `client/ResultDock.tsx` |
| 7 | **六态 UI**(analyzing / discovery_required / requirement_confirmation / compiling / validating / complete) | `controller.deriveStage` + ResultDock |
| 8 | 分析诊断**默认折叠** + 一句结果摘要 | ResultDock |
| 9 | 「已确认需求」改为**真实 Requirement Ledger 视图** | ResultDock + done 下发 ledger |
| 10 | 建议**弱化并默认折叠**;移除「仍需补充/不确定」大杂烩(改四分类) | ResultDock |
| 11 | **general 迁入 v2 契约**(4 项 target-neutral 信息责任,不再 Goal/Phase/Task/Tests) | `strategies/general.ts` + `registry.ts` |
| 12 | **legacy 全部不可达**(可机械验证) | 见附录 F |
| 13 | **再优化 Ledger 对账**(STILL_VALID / CONFLICTING / INVALIDATED) | `core/ledger-reconcile.ts` + 宿主 `mode:'reoptimize'` |
| 14 | **正文明确约束 > 手动 override** | `core/router.ts` `explicitIntentFromInput` |

## Why —— 关键判断

1. **PATCH 的判据错了**(§1 审计结论):旧阶梯只有「空/寒暄」和「无动词且 <12 字」两条 REBUILD 出口,
   `我想用 dsh 控制 comfyui 生成视频。` 有动词 → 落默认 PATCH。但 PATCH 的正式语义是
   「原 Prompt 的结构和表达基本成立」——**必须存在可保留的东西**。修法:PATCH 要求
   ≥1 结构信号 或 ≥1 成稿要素(角色/约束/格式/验收);否则 REBUILD。不是 ComfyUI 特例。
2. **Triage 必须钉住**:回答轮会重新分析,模型的 triage 建议可能改口;因此首轮的裁决随会话回传,
   回答轮**强制沿用**(客户端值只接受封闭枚举,防伪造)。这样「REBUILD 不会因为需求问清楚就偷偷变 PATCH」。
3. **回流必须有界**:Validator 只做机械判定,不引入新 LLM 调用;同一 `reason_code` 第二次即升级
   `HARD_ERROR`(回流修不掉),另有总次数上限(`VALIDATION_RETURN_LIMIT = 2`)。**完整性缺陷不回流**
   (回流解决不了,交付 + `provenance_ok=false` 警示),只有「改 provenance / 改处置 / 重判目标」
   能修好的才回流 —— 否则会把 Validator 变成重试器。
4. **ledger 是 UI 的唯一真值**:「已确认需求」只读 `Requirement Ledger`(USER_EXPLICIT/CONTEXT_EXPLICIT
   且状态有效),**不从编译器输出反推**,否则会把优化器的措辞当成用户要求。
5. **对账不能只在客户端做**:对账结果必须贯穿编译/确认/门禁,因此宿主在分析后立刻把
   `analysis.ledger` 换成对账后的台账(否则编译分支仍读旧台账 —— 这是实现中真实暴露并修掉的问题)。

## Modules

**新增**:`core/validation-flow.ts`、`core/ledger-reconcile.ts`、`test/validation-flow.test.mjs`、
`test/phase4-reconcile.test.mjs`、`test/phase4-final.test.mjs`、`scripts/phase4-trace.mjs`、本报告。
**修改**:`core/triage.ts`(阶梯)、`core/router.ts`(正文约束优先)、`core/discovery.ts`(确认互斥 + containmentRatio)、
`core/strategies/general.ts`(v2 契约)、`core/registry.ts`(legacy 不可达)、`core/compiler.ts`(fast 容错 + 废弃标注)、
`core/validate.ts`(OS 正则 bug + 文案)、`core/types.ts`(回流记录 / 六态)、`src/index.ts`(validating/returned/reoptimize/triage 钉住)、
`client/controller.ts`(六态 + returned + ledger)、`client/ResultDock.tsx`、`client/OptimizeButton.tsx`、`client/i18n.ts`。

## Tests

`npm test` → **exit 0，468 断言全绿**（Phase 3 为 438，净增 30）。

| 套件 | 覆盖 |
|---|---|
| `triage.test.mjs`(更新) | PATCH = 有可保留内容;模糊目标 → REBUILD;严重度合并 |
| `validation-flow.test.mjs`(新,14 组) | 回流矩阵逐条 + 有界性(重复 → HARD_ERROR / 上限)+ 严重度 + 审计描述 |
| `phase4-reconcile.test.mjs`(新,7 组) | 对账 A/B/C/D 四类 + 幂等 + **legacy 可达性**(全部策略/全部路由/正常编译路径) |
| `phase4-final.test.mjs`(新,9 组) | 选择器退场 / 六态派生 / discovery 不显示结果 / confirmation 四类 / general 不走 legacy / 四个分诊级别 / Image·Video 契约 / 再优化 / 回流与硬错误 / ComfyUI triage |
| 既有 26 套件 | 全部通过(general 迁移与 triage 语义变更涉及的 golden 已按新契约更新,非删除) |

## Acceptance —— 对照 §25 的 28 条

| # | 标准 | 结果 |
|---|---|---|
| 1 | 主界面不再要求选择类型 | ✅ p4f1(`<select>` 已从 OptimizeButton 移除) |
| 2 | 点击优化自动判断 | ✅ p4f1 + 附录 A(analyzing → 自动 intent/target/triage) |
| 3 | 手动模式仅作高级 override | ✅ p4f1(「调整判断」在折叠的分析区内) |
| 4 | 六态 UI 真正工作 | ✅ p4f2 + 附录 A(meta→compiling / validating / done→complete) |
| 5 | discovery_required 不显示最终 Prompt | ✅ p4f2(分支级断言) |
| 6 | confirmation 正确展示四类 | ✅ p4f2 + p4f7 + 附录 A |
| 7 | Validator 支持可控回流 | ✅ vf1–vf14 + p4f8 + 附录 E |
| 8 | 回流不会无限循环 | ✅ vf11(重复→HARD_ERROR)/ vf12(上限) |
| 9 | general 不再走 legacy 主路径 | ✅ p4f3 + p4r6 |
| 10 | 生产路径不再依赖 required_sections | ✅ p4f3 + p4r6(compilePrompt 全类型断言) |
| 11 | placeholder 旧逻辑不可达 | ✅ p4f3(`finalizeCompile` 不再调用注入器) |
| 12 | KEEP 保持逐字一致 | ✅ p4f4 + e2e14 + KEEP 硬校验(keepExpected) |
| 13 | PATCH 不退化成重写 | ✅ p4f4(PATCH 需可保留内容;不因目标策略整体重写) |
| 14 | RESTRUCTURE 不大量增加要求 | ✅ p4f4 |
| 15 | REBUILD 仍受反膨胀约束 | ✅ p4f4 + 信息责任数固定(general 4 项 / 视觉 6–7 项) |
| 16 | Image / Video 自动识别且正确契约 | ✅ p4f5 + 附录 C |
| 17 | re-optimize 保留 still-valid | ✅ p4r1 + p4f6 + 附录 D① |
| 18 | 冲突 requirement 被替换 | ✅ p4r2 + 附录 D② |
| 19 | 无关旧 requirement 失效 | ✅ p4r3 + p4f6 + 附录 D③ |
| 20 | Confirmation 无 CONFIRMED/PROVISIONAL 重复 | ✅ d9b + p4f7 + 附录 A(「可先验证控制链路」已被去重) |
| 21 | ComfyUI Triage 经正式审计与测试 | ✅ p4f9(REBUILD + 可读理由)+ e2e14(钉住) |
| 22 | provenance 仍然可靠 | ✅ 三层校验 + 伪造来源回流(h4b)+ 盲授权不产 CONFIRMED |
| 23 | 所有 Phase 1–3 测试继续通过 | ✅ 468 全绿 |
| 24 | 新增 Phase 4 测试全部通过 | ✅ 30 条新断言 |
| 25 | build 成功 | ✅ `npm run build` |
| 26 | lib/ 可由真实 DSH Desktop 加载 | ✅ `lib/` 为 desktop link 入口;smoke 经真实 cordis 加载通过 |
| 27 | 不修改 v0.1.0-apo tag | ✅ 仍指向 `c88e922` |
| 28 | 不发布、不 push | ✅ 无 release / 无 push |

## Known limitations

1. **`validating` 是宿主显式事件**(不是客户端计时器):只有真正跑到校验才会出现;若编译失败提前返回,
   用户看到的是 error 而非 validating —— 这是有意的(不假装阶段)。
2. **`修改理解` 仍是最简形态**(改值 / 重新决定),没有多字段批量编辑器。
3. **对账阈值为机械相似度**(包含率 0.5 / 换向标记词表):极端措辞可能被判 INVALIDATED 而需要重问;
   方向是「宁可少继承,不可污染新任务」。
4. **`classifyViaLlm` / `parseOptimizerOutput` 等 legacy 代码保留**(供旧单测与回归 harness),
   已用可达性测试钉住生产不可达;没有做大范围删除(§12 明确允许)。
5. **UI 未做大规模视觉重设计**(保持 DSH Desktop 风格);窄窗口/键盘可达性按最小要求处理
   (选项为原生 radio/select/input,天然支持键盘;状态用文字标注,不只靠颜色)。
6. **`general` 的 4 项信息责任是固定小集合**:它仍是兜底策略,不追求与具体目标一样细。

## Phase 4 之后的剩余(非本阶段范围)

- 发布 / 推送 / tag(用户明确要求不做);
- 旧 AUTO 下拉的**彻底移除**(现已从主界面移除,`TYPE_OPTIONS` 仍作为高级 override 的数据源保留);
- `prompt.ts` legacy 双模式与 `classifyViaLlm` 的最终删除(需先迁走回归 harness)。

---

## 附录 A–F（`node scripts/phase4-trace.mjs` 真实输出）


════ A. ComfyUI 最终完整 event trace(六态) ════
[dsh-prompt-optimizer] loaded, POST /dsh-prompt-optimizer/optimize

──── 1. optimize(点击优化 → analyzing → discovery_required)
  discovery_required  round=1 questions=2 blocked=true
    Q: 你希望 DSH 怎么使用 ComfyUI?
       ★ 调用已经存在的 ComfyUI 工作流
         自动创建 / 修改工作流
         两者都需要
    Q: 这次主要目标是哪一个?
       ★ 先验证 DSH 能不能成功控制 ComfyUI
         成功生成一个指定视频
         建立以后可以长期运行的自动化流程
    可自查(弱显示): ComfyUI 版本 / workflow 文件位置

──── 2. user_answer → requirement_confirmation
  requirement_confirmation
    目标: 用 dsh 控制 comfyui 生成视频
    你已确认: 用 dsh 控制 comfyui 生成视频 / 复用现有 workflow 还是新建 / 本轮目标是先验证控制链路还是建立长期自动化
    Agent 自行调查: ComfyUI 版本 / workflow 文件位置 / DSH 当前可用的控制方式 / workflow 实际位置
    暂定/条件: (无)

──── 3. confirm(确认并优化)→ compiling → validating → complete
  meta  stage→compiling  prompt_type=execution contract=agent triage=REBUILD
  validating  stage→validating
  done  stage→complete  contract=agent triage=REBUILD optimized=29字

  分析调用=2  编译调用=1
  ★ Compiler 第一次运行发生在第 3 步(confirm 之后、meta 之前);前两步编译调用为 0

════ B. KEEP / PATCH / RESTRUCTURE / REBUILD 前后对比 ════

──── KEEP
  before(216字): 你是一名资深后端工程师,请审查并重构订单服务模块。…
  信号: 结构=numbered-list,bullet-list,labelled-lines 成稿要素=role+约束+格式+验收
  裁决: KEEP  keep_safe=true  理由=输入已具备成稿特征(结构 + 约束/格式/验收),应原样保留
  after: (逐字等于输入 —— KEEP 路径不调用模型)

──── PATCH
  before(39字): 1. 先跑一遍测试
  信号: 结构=numbered-list,labelled-lines 成稿要素=格式+验收
  裁决: PATCH  keep_safe=false  理由=输入已有提示词结构,只需局部补充或修正
  after: (保留 1/2/3 的编号与措辞,只补缺口与执行前须知)

──── RESTRUCTURE
  before(109字): 帮我做个小工具,要求是能读 csv 然后汇总,输出格式要 markdown 表格,输出格式要…
  信号: 结构=(无) 成稿要素=约束+格式
  裁决: RESTRUCTURE  keep_safe=false  理由=信息已基本完整,但组织混乱(缺结构 / 冗长 / 有重复),只需重组不改语义
  after: (去重复、建结构;不新增用户没要求的目标)

──── REBUILD
  before(24字): 我想用 dsh 控制 comfyui 生成视频。
  信号: 结构=(无) 成稿要素=(无)
  裁决: REBUILD  keep_safe=false  理由=只有模糊目标,没有可保留的提示词结构或成稿要素;需先明确需求再从零构建 Prompt
  after: (先经 Discovery 明确取舍,再从零构建;仍受信息责任与反膨胀约束)

════ C. Image / Video 最终输出结构 ════

──── Image Prompt
  路由: visual-target → 契约 image(descriptive)
  信息责任: Subject / Scene / Style / Composition / Lighting & Color / Aspect Ratio / Negative
  禁止: Goal / Phase / Task / Tests / Acceptance(守卫 visual-no-task-template 机械拒绝)

──── Video Prompt
  路由: visual-target → 契约 video(descriptive)
  信息责任: Shot / Action & Timing / Scene & Mood / Style & Quality / Duration & Format / Negative
  禁止: Goal / Phase / Task / Tests / Acceptance(守卫 visual-no-task-template 机械拒绝)

════ D. re-optimize 三种情况的 Ledger trace ════

──── ① 只改措辞(STILL_VALID)
  再优化对账:保留 2 项、被新内容取代 0 项、不再适用 0 项
  ledger-a  CONFIRMED  已有可工作的 workflow
  ledger-b  CONFIRMED  本轮只验证控制链路
  → 重新 Missing Resolution 后:只有新出现的 blocking USER_REQUIRED 才进 Discovery

──── ② 改变一个目标(CONFLICTING)
  再优化对账:保留 0 项、被新内容取代 2 项、不再适用 0 项
  ledger-a  REJECTED  已有可工作的 workflow
  ledger-b  REJECTED  本轮只验证控制链路
  → 重新 Missing Resolution 后:只有新出现的 blocking USER_REQUIRED 才进 Discovery

──── ③ 换成图像任务(INVALIDATED)
  再优化对账:保留 0 项、被新内容取代 0 项、不再适用 2 项
  ledger-a  NOT_APPLICABLE  已有可工作的 workflow
  ledger-b  NOT_APPLICABLE  本轮只验证控制链路
  → 重新 Missing Resolution 后:只有新出现的 blocking USER_REQUIRED 才进 Discovery

════ E. Validator 回流 trace(矩阵) ════
  伪造 USER_EXPLICIT         → RETURN_TO_MISSING_RESOLUTION (VF_FABRICATED_USER_EXPLICIT) requires=provenance_downgrade
  silent assumption        → RETURN_TO_MISSING_RESOLUTION (VF_SILENT_ASSUMPTION) requires=disposition_fix
  blocking USER_REQUIRED   → RETURN_TO_DISCOVERY (VF_BLOCKING_NOT_RESOLVED) requires=discovery
  可自查项被写成待用户提供             → RETURN_TO_MISSING_RESOLUTION (VF_USER_FACING_QUESTION) requires=disposition_fix
  错误 Target Engine 假定      → RETURN_TO_ANALYSIS (VF_TARGET_ASSUMPTION) requires=reanalysis
  Image/Video 出现任务模板标题     → RETURN_TO_MISSING_RESOLUTION (VF_TASK_TEMPLATE_IN_VISUAL) requires=disposition_fix
  KEEP 被改写                 → HARD_ERROR (VF_KEEP_REWRITTEN)
  完整性缺陷(缺必出段落)             → PASS
  同一失败重复                   → HARD_ERROR (VF_REPEATED_FAILURE)  ← 不无限循环
  回流上限                     = 2 次,超出即 HARD_ERROR

════ F. 仍保留但生产不可达的 legacy 清单 ════
  DEPRECATED-BUT-UNREACHABLE   required_sections(策略契约字段)
                                保留为 informationResponsibilities 的别名;路由与守卫都读新字段
  DEPRECATED-BUT-UNREACHABLE   injectMissingPlaceholders()
                                编译管线改用 injectResponsibilityNotes;[待补充:] 出现即校验 error
  DEPRECATED-BUT-UNREACHABLE   parseOptimizerOutput()(legacy 解析)
                                仅 finalizeCompile({legacy:true}) 的显式调用可达(旧单测/回归 harness)
  DEPRECATED-BUT-UNREACHABLE   prompt.ts template/intent 双模式
                                general 已迁入 v2 契约,生产路由不再命中
  DEPRECATED-BUT-UNREACHABLE   LEGACY_GENERAL / isLegacyGeneral
                                不再标记任何策略;测试断言全部策略为 false
  DEPRECATED-BUT-UNREACHABLE   classifyViaLlm / 旧 classifier-only 路由
                                宿主改用 analyzeViaLlm;classifyViaLlm 仅供回归 harness 与单测
  REACHABLE-AS-ADVANCED        compilePrompt({promptType}) 旧 override 入口
                                降级为「调整判断」高级 override,且正文明确约束优先

  机械证据:research=false planning=false execution=false diagnostic=false review=false creative=false general=false agent=false image=false video=false

