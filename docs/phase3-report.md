# Phase 3 实施报告 —— Requirement Discovery 完整闭环（v2 升级第三段）

> 对应 `docs/PLAN-v2-adaptive-editor.md` §2「Phase 3」与 `docs/phase3-prerequisites.md`。
> 本报告是**实施记录**（What / Why / Modules / Tests / Acceptance / Known limitations /
> Phase 4 prerequisites），文末附 **ComfyUI 案例完整事件流**（真实运行输出）。

---

## 1. What —— 做了什么

把 Phase 1 的 `blocking USER_REQUIRED → discovery_required → 停止` 升级成完整闭环：

```
blocking USER_REQUIRED
  → Requirement Discovery（Question Planner，1–2 问/轮，依赖分轮，不重复问）
  → 用户回答
  → 重新分析（每轮 1 次）
  → Answer Resolver 更新 Requirement Ledger（带逐字证据）
  → Sufficiency Evaluator 重算 live blocking
  → 未完备 → 下一轮；完备 → Requirement Confirmation
  → 用户确认
  → Compiler（首次运行）→ Validator → Result
```

| # | 交付 | 落地 |
|---|---|---|
| 1 | Phase 3 prerequisite：**取舍型 → USER_REQUIRED + blocking** | `requirements.ts`（`isProductDecision` / `isEnvironmentFact`） |
| 2 | 环境事实**反方向保护**（不得升格为用户决定） | 同上（`ENVIRONMENT_FACT_RE` 优先于用户专属词表） |
| 3 | Question Planner（四维排序 / 依赖分轮 / 1–2≤3 / 去重） | `core/discovery.ts::planQuestions` |
| 4 | Answer Resolver（confirm/reject/supersede/invalidate/not_applicable/derived） | `core/discovery.ts::resolveAnswers` |
| 5 | Sufficiency Evaluator（按**当前**状态重算，不是数字段） | `core/discovery.ts::evaluateSufficiency` |
| 6 | 循环安全保护（最大轮次 / 无新信息 / 无高价值问题） | `planQuestions` + `evaluateSufficiency` |
| 7 | Requirement Confirmation（四组摘要 + 指纹） | `core/discovery.ts::buildConfirmation` |
| 8 | 盲授权纪律（只降不升） | `resolveAnswers` 的 `blind_trust` 分支 |
| 9 | 宿主：`mode: answer | confirm` + `requirement_confirmation` 事件 + **fail-closed 门** | `src/index.ts` |
| 10 | 分析契约扩展（decisions / questions，一次调用同时产出） | `core/analyze.ts` |
| 11 | UI：Discovery 答题面板 + Confirmation 面板 + 「修改理解」 | `client/controller.ts` / `ResultDock.tsx` / `i18n.ts` |
| 12 | 演示与证据工具 | `scripts/phase3-trace.mjs` |

## 2. Why —— 为什么这样做

1. **Discovery 不是问卷**：只解决「必须用户决定 + Agent 查不到 + 不同答案显著改变方案 +
   无安全默认值」的项；停止条件是 `blocking USER_REQUIRED = 0`（decision completeness），
   **不是** UNKNOWN = 0。`evaluateSufficiency` 结合台账**当前状态**判定（CONFIRMED /
   REJECTED / NOT_APPLICABLE / PROVISIONAL / CONDITIONAL / DEFERRED 都算已安全处理），
   可自查项与可选项永不阻塞。
2. **每轮重新计算，不预生成问题队列**：`asked` 记录 + 需求 id 派生的 key 让
   「同一条决策不问第二次」；`depends_on` 实现依赖分轮；`invalidates` 让先答的问题
   直接注销后续问题（Case 3 已验证）。
3. **id 必须跨轮稳定**：模型的 unknowns 下标每轮会漂移，因此未决项 id 改为**内容派生**
   （`unknown-<hash>`），并把模型问题里的 `requirement_id` / `depends_on` 按
   「下标 → 第 N 项」重映射。否则第二轮会把「已回答的决定」当成新问题重复问。
4. **LLM 调用不膨胀**（§20）：一次分析调用同时产出「取舍语义 + 问法/选项 + 是否阻塞」，
   Planner / Sufficiency / Confirmation **全部机械**，确认后**不再调用分析**。
   总预算：首轮 1 次 + 每回答轮 1 次 + 编译 1 次。
5. **session state 放客户端、宿主无状态**：客户端持有 `{ledger, asked, answers, questions,
   round, analysis}`，每轮回传；宿主把它当**不可信输入**净化（`sanitizeSession` +
   `findLedgerViolations`）并 fail-closed。无服务端生命周期 / 内存增长 / 跨会话串扰，
   与既有 `previous`/`context` 传参范式一致。
6. **规则机械化、语义模型化**：`isProductDecision` 等只是**安全网**；语义第一来源是分析
   契约的 `decisions[].kind === 'PRODUCT_DECISION'`。两者都只允许把结论推向安全方向
   （取舍 → 问用户；环境事实 → 可自查），绝不反向降级。

## 3. Modules

**新增**
| 文件 | 作用 |
|---|---|
| `src/core/discovery.ts` | Planner / Resolver / Sufficiency / 循环保护 / Confirmation / 会话净化 |
| `test/discovery.test.mjs` | 引擎单测（13 组） |
| `test/phase3-e2e.test.mjs` | 宿主端到端闭环 + §19 九类场景（13 组） |
| `scripts/phase3-trace.mjs` | ComfyUI 事件流演示（输出即证据） |
| `docs/phase3-report.md` | 本报告 |

**修改**
| 文件 | 改动 |
|---|---|
| `src/core/requirements.ts` | 取舍型判据 / 环境事实保护 / `mechanicalImpact` 取舍恒高影响 / 未决项 **内容稳定 id** |
| `src/core/types.ts` | Discovery 契约（question/option/answer/asked/round/confirmation/session）+ 两个新 SSE 事件 + `AnalysisResult.decisions/questions` |
| `src/core/analyze.ts` | 契约扩展（decisions/questions 归一化 + `requirement_id`/`depends_on` 重映射）+ 系统提示词新增取舍识别/反向保护/提问纪律/依赖分轮四条铁律 |
| `src/index.ts` | `discovery` 请求解析与净化 · confirm 复用分析（0 次额外调用）· 回答轮重算 · `requirement_confirmation` 事件 · **confirm fail-closed** |
| `src/client/controller.ts` | Discovery 会话视图与动作（`answerDiscovery` / `continueWithJudgement` / `confirmDiscovery` / `reviseUnderstanding` / `submitRevision`）+ `confirmation` 状态 |
| `src/client/ResultDock.tsx` | 答题面板（选项 + 推荐 + 自由回答 + 按你的判断继续）· Confirmation 四组摘要面板 · 「修改理解」编辑面板 |
| `src/client/i18n.ts` | 中英各 20 条新文案 |
| `scripts/build.mjs` / `package.json` | 新模块产物 + 两个新套件入 `npm test` |

## 4. Tests

`npm test` → **exit 0，436 断言全绿**（Phase 2 为 412，净增 24；既有套件零回归）。

| 套件 | 覆盖 |
|---|---|
| `responsibilities.test.mjs`（rc12 已翻转） | 取舍型 6 种自然表达 → `USER_REQUIRED` + `impact=high` + **blocking**；环境事实 6 例不被升格；安全网只向安全方向纠正 |
| `discovery.test.mjs`（新，13 组） | 1–2≤3 上限 · 四维优先级 · **依赖分轮** · 重复/换说法不重问 · Resolver 六种动作 · **盲授权永不 USER_EXPLICIT/CONFIRMED** · Sufficiency 按当前状态重算（7 种状态）· 轮次上限 · Confirmation 四组+指纹 · 动态重算使后续问题失效 · 修改理解保持台账 · 会话净化 |
| `phase3-e2e.test.mjs`（新，13 组） | **ComfyUI 闭环**（0 编译 → 回答 → 确认 → 首次编译）· 循环保护 · 盲授权 · fail-closed①（伪造来源）· fail-closed②（confirm 时仍阻塞 → 编译 0 次）· Case 1/2/3/5/6/7/8/9 |
| 既有 24 套件 | 全部通过（含 Phase 1 门、Phase 2 契约、Image/Video/Agent 契约） |

## 5. Acceptance —— 对照 §23 完成标准

| # | 标准 | 结果 |
|---|---|---|
| 1 | 阻塞决定能真正触发问题（不只是展示） | ✅ 首轮 `discovery_required` 带 1–3 个问题 |
| 2 | 用户能回答 | ✅ 选项 / 自由回答 / 按你的判断继续 |
| 3 | 回答进入 Requirement Ledger | ✅ `USER_EXPLICIT` + 逐字证据 |
| 4 | 每轮回答后重新分析 | ✅ 分析调用数 = 2（首轮 + 回答轮），由 e2e 断言 |
| 5 | 支持多轮 | ✅ 轮次推进 + `round` 回传 |
| 6 | 每轮默认 1–2、最多 3 | ✅ `d1`（含硬上限断言） |
| 7 | 依赖问题分轮 | ✅ `d3` + Case 3 |
| 8 | 已解决问题不重复询问 | ✅ `d4`（同 requirement 换措辞也不问） |
| 9 | 真取舍不被 fallback 吞掉 | ✅ rc12 + e2e（取舍 → blocking → 提问） |
| 10 | 环境事实不被误升格 | ✅ rc12（6 例）+ Case 5 |
| 11 | blocking 清零即停 | ✅ `d8` + e2e1 |
| 12 | UNKNOWN 无需清零 | ✅ `d8`（可自查/可选不阻塞） |
| 13 | 支持「按你的判断继续」 | ✅ `d7` + e2e3 |
| 14 | 盲授权不产生 USER_EXPLICIT / CONFIRMED | ✅ `d7` + e2e3（只检查盲授权项） |
| 15 | 有 Requirement Confirmation | ✅ 四组摘要 + 指纹 |
| 16 | 确认后才进 Compiler | ✅ **e2e1：确认前编译调用 = 0，确认后 = 1** |
| 17 | Discovery 不改变 Edit Triage | ✅ `d10` + e2e1（PATCH 全程不变） |
| 18 | ComfyUI 完整端到端 | ✅ e2e1 + `scripts/phase3-trace.mjs` |
| 19 | Image / Video / 完整 Prompt 不发生错误 Discovery | ✅ Case 6/7/8/9 |
| 20 | 所有旧测试 + 新测试全绿 | ✅ 436 断言 / exit 0 |
| 21 | build 成功 | ✅ `npm run build` |
| 22 | 插件仍可由真实 DSH Desktop 入口加载 | ✅ `lib/` 为 desktop link 入口，产物含 discovery；`test/smoke.mjs` 经真实 cordis 加载通过 |
| 23 | 不修改 tag/release、不 push | ✅ `v0.1.0-apo` 仍指向 `c88e922`；无 release/push |

## 6. Known limitations

1. **问题措辞依赖模型**：选项/问法来自分析契约；模型没给时会退回 requirement 文本
   （可读但不如模型措辞自然）。机械层保证「问不问、问几个、能不能重复问」不受模型影响。
2. **台账状态机的 `supersede` 只做到「原条目保留 + 新值 derived」**：没有做条目版本链
   （`superseded_by` 指针），审计时看 note 即可。
3. **`修改理解` 只支持「改值 / 重新决定」**，没有做多字段批量编辑器（§14 允许的最简形态）。
4. **`general` 仍是 legacy 编译路径**（Phase 2 遗留）：若某次分析落到 general，编译走
   `prompt.ts` 老路径（不套 v2 契约）。
5. **UI 未做完整六态收尾**：本阶段实现了 `discovery` / `confirmation` 两个新态与最小闭环，
   但状态机动画、错误态打磨、AUTO 选择器降级仍属 Phase 4。
6. **Discovery 轮次上限 3**：达到上限即按暂定停止并交确认（安全保护，非产品目标）。

## 7. Phase 4 prerequisites

1. **Validator 回流**：让 `validateCompileResult` 能返回
   `action: 'accept' | 'return_to_missing_resolution'`，把「编译后发现的需求缺口」
   送回 Discovery / Missing Resolution（本阶段只做到 fail-closed，未做回流）。
2. **六态 UI 收尾**：`analyzing / discovery_required / requirement_confirmation /
   compiling / validating / complete` 完整状态机 + 阶段文案 + 选择器降级为高级覆盖。
3. **`general` legacy 迁移**：与 `required_sections` 收尾一起，把 general 纳入 v2 契约。
4. **再优化保留台账**：`previous` 路径要带上 Requirement Ledger 并把旧需求分类为
   still-valid / conflicting / invalidated（Phase 1 PLAN §C13）。
5. **Discovery 的可访问性与移动端**：radio/textarea 的键盘与触屏体验、长选项换行。

---

## 附:ComfyUI 案例完整事件流（`node scripts/phase3-trace.mjs` 的真实输出）

输入：`我想用 dsh 控制 comfyui 生成视频。`

```
──── 1. optimize(首次)
  discovery_required round=1 | blocked=true | questions=2
    Q: 你希望 DSH 怎么使用 ComfyUI?            [选项 3, 有推荐]
    Q: 这次主要目标是哪一个?                    [选项 3, 有推荐]
    可自查(弱显示): ComfyUI 版本 / workflow 文件位置 / API 地址
  → 编译调用 0 次;无 optimized_prompt

──── 2. user_answer(选择推荐项)
  requirement_confirmation
    goal: 用 dsh 控制 comfyui 生成视频
    你已确认: 用 dsh 控制 comfyui 生成视频 / 工作流来源(复用 vs 创建) / 本轮目标(验证 vs 长期自动化)
    Agent 自行调查: ComfyUI 版本 / workflow 文件位置 / API 地址 / DSH 当前可用的控制方式 /
                    ComfyUI 访问方式与 API 能力 / workflow 实际位置
    暂定/条件: 可先验证控制链路 [PROVISIONAL]
  → 编译调用仍然 0 次

──── 3. confirm(确认并优化)
  meta  prompt_type=execution contract=agent triage=PATCH
  done  contract=agent optimized=314字 triage=PATCH
  (delta × 1)

分析调用总数=2  编译调用次数=1
```

**Compiler 第一次被调用的位置**：第 3 步 `confirm` 之后（`meta` 之前），即宿主在
「净化后的台账无 live blocking」校验通过后才调用 `compilePrompt`。第 1、2 步的编译
调用次数均为 0 —— 这由 `test/phase3-e2e.test.mjs` 的 `e2e1` 用计数断言钉住。
