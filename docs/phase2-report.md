> ⚠️ **已过时（历史记录）** — 本文描述的是 **V3 之前的旧多阶段架构**（意图分析 / 编辑分诊 / 需求发现 / 编译器 / 校验器 / 策略路由），
> 相关代码已在提交 `435b643` 删除，文中的模块名、文件路径、测试名与 npm 命令**均已失效**。
> 当前实现与文档入口见 [`CURRENT_STATE.md`](../CURRENT_STATE.md) 与 [`docs/README.md`](README.md)。本文仅作历史记录保留。

# Phase 2 实施报告 —— 信息责任 + 目标契约 + 未决项处置（v2 升级第二段）

> 对应 `docs/PLAN-v2-adaptive-editor.md` §2「Phase 2」与 **`docs/phase2-contract.md`**
> （用户 2026-10-05 指定的正式语义契约，选项 A）。
> 本报告是**实施记录**（做了什么 / 为什么 / 模块 / 测试 / 验收 / 限制 / Phase 3 前置）。

---

## 1. 本阶段做了什么

| # | 交付 | 落地 |
|---|---|---|
| 1 | **未决项处置契约**（用户 6 条规则的正式化） | `docs/phase2-contract.md` + `src/core/responsibilities.ts` + `src/core/disposition-render.ts` |
| 2 | `required_sections` → **`informationResponsibilities`** | `src/core/types.ts`（`PromptStrategy` / `OutputContract`）+ 7 策略 + 注册表 |
| 3 | **Target-aware Strategy Router** | `src/core/router.ts`（Primary/Supporting + Target + Engine + Modality + Requirement State + Triage） |
| 4 | **Agent / Image / Video 三套编译契约** | `src/core/strategies/agent.ts`、`image.ts`、`video.ts`、`_visual-shared.ts` |
| 5 | **图像 / 视频不再套 Goal/Phase/Task/Tests** | 描述式责任清单 + `visual-no-task-template` 守卫（机械拒绝模板标题） |
| 6 | **`[待补充:]` 退役**（I-1）与「不得反问用户」（I-2） | 编译器改注入处置注记；校验器新增两条 error 规则 |
| 7 | 验收用例 **A / C / D / E** | `test/phase2-fixtures.test.mjs` |
| 8 | Phase 3 准入清单（用户指定风险） | `docs/phase3-prerequisites.md` + `test/responsibilities.test.mjs` rc12 |

## 2. 为什么这样做

1. **用户选择 A（现在就切换，不做 B 过渡）**，理由是继续输出 `[待补充:]` 会让内部语义与
   最终 Prompt 冲突，并把本该由 Agent 完成的工作推回用户。因此 `[待补充:]` 在编译稿中
   **彻底退役**，未决项改为按「谁有能力解决」分派。
2. **用户明确要求不要形成「另一种 Prompt 膨胀」**：不得把 `[待补充: X]` 机械改写成
   「由执行方自行确认 X」。因此处置是**分类分派**（省略 / 动作式 / 条件式 / 用户决定 /
   可选增强），而不是统一替换句式；注入条数另有硬上限（每类 ≤4）。
3. **图像 / 视频是模态问题，不是意图问题**：所以新增**目标维度**并让目标契约与意图策略
   分属两张注册表（`defaultStrategyRegistry` 仍是七意图，`targetContractRegistry` 另存
   三契约）——分类器闭集不受污染，`PROMPT_TYPES` 仍是七值。
4. **`prompt_type` 与 `contract` 分离**：工作意图照旧回答「要做什么」，`contract` 回答
   「产出长什么样」。UI 因此能同时显示「任务类型: 执行」「编译契约: 图像描述式」。

## 3. 契约要点（可执行形式）

| 处置 | 触发 | 编译产出 |
|---|---|---|
| `OMIT` | `AGENT_DISCOVERABLE` + 自然获得 / 纯定位 | 任何位置都不出现 |
| `EXECUTION_RESPONSIBILITY` | 须在行动前调查且影响正确执行 | `## 执行前须知（由执行方自行确认，不需要询问用户）` 下 `- 动手前先确认:X` |
| `CONDITIONAL_BRANCH` | 调查结果决定后续分支 | `## 分支条件（按调查结果选择路径）` 下 `- X:存在则优先复用/沿用,不存在则按新建路径处理` |
| `USER_DECISION` | 非阻塞 `USER_REQUIRED` | **不注入正文**（留台账 / 面板；Phase 3 由 Discovery 追问） |
| `OPTIONAL_ENHANCEMENT` | `OPTIONAL` 且高影响 | 只进建议段 |

不变量：**I-1** 编译稿永不出现 `[待补充:]`/`[TODO:]`；**I-2** 未决项不得写成面向用户的追问；
**I-3** 只允许动作式 / 条件式两种注入句式；**I-4** 每类注入 ≤4 条且去重；
**I-5** blocking `USER_REQUIRED` 一律不进入编译（由分析门拦下）。

## 4. 测试与验收证据

`npm test` → **exit 0，412 个断言全绿**（较 Phase 1 的 385 增加 27；既有套件全部更新到新契约）。

| 套件 | 覆盖 |
|---|---|
| `responsibilities.test.mjs`（新） | 6 条规则逐条可执行断言 / 反膨胀（禁止机械改写句式）/ 去重与上限 / I-1·I-2 / 回退路径与 resolution 一致 / **Phase 3 前置 rc12** |
| `router.test.mjs`（新） | 路由优先级（手动 > 视觉 > Agent > 意图 > 兜底）/ 注册表分离 / 视觉守卫拒绝模板标题 / 与 `TARGET_CATALOG` 单一真源一致 |
| `phase2-fixtures.test.mjs`（新） | **C 图像**（描述式、无 Goal/Phase/Task/Tests、零占位符、自然获得项省略）/ **D 视频**（条件式分支 + 用户决定项不注入）/ **A ComfyUI→DSH**（Agent 契约含停止条件）/ **E 乱但完整**（RESTRUCTURE + 处置照常） |
| `phase1-gate`（扩展 p1g7） | 宿主端到端:图像目标 → 描述式契约 + `contract` 随 meta/done 下发 + 零占位符 + 无任务模板标题 |
| 既有 7 个策略套件 | 文案由「必须按顺序包含 N 段」改为「逐项交代 N 项信息责任」；缺口相关 golden 更新为新契约 |
| `compiler` / `compiler-integration` / `validate` / `host-pipeline` / `vertical-slice` | 缺口注入改为处置注记；新增 I-1/I-2 校验；退役占位符相关 golden 更新 |

### 验收标准对照

| # | 标准 | 结果 |
|---|---|---|
| 1 | `required_sections → informationResponsibilities` | ✅ 契约字段 + 7 策略 + 注册表；旧字段保留为 deprecated 别名 |
| 2 | Target-aware 路由 | ✅ `router.ts`；`compilePrompt` 内部路由并可审计（`plan.route`） |
| 3 | Agent / Image / Video 编译契约 | ✅ 三套策略 + `_visual-shared` 工厂 |
| 4 | 图像 / 视频不再套 Goal/Phase/Task/Tests | ✅ 责任清单不含模板标题 + `visual-no-task-template` 守卫机械拒绝 |
| 5 | C / D / E fixtures 与验收 | ✅ `phase2-fixtures.test.mjs`（另加 A） |
| 6 | `AGENT_DISCOVERABLE` 永不再输出 `[待补充:]` | ✅ I-1 校验 + 注入层 + rc5/C/D/E 断言 |
| 7 | 不形成另一种膨胀 | ✅ 五处置分派 + 只两种句式 + ≤4 条上限 + 反膨胀断言 |
| 8 | 旧 golden / fixture 正式更新 | ✅ 10 处既有 fixture/golden 按新契约更新（非删除） |
| 9 | 每阶段自动化测试 | ✅ 3 个新套件 / 26 条新断言 |
| 10 | 插件仍可构建、已安装不受影响 | ✅ `npm run build` 成功；`lib/` 为 desktop 实际入口，产物包含新模块 |

## 5. 已知限制（非阻塞）

1. **处置判定是机械表驱动**（关键词表），没有引入第三次 LLM 调用。语义细腻的未决项可能被
   归到 OMIT（保守方向）。若实践中发现漏判，Phase 3 可把处置并入分析契约（一次调用内完成）。
2. **`USER_DECISION` 只留台账、不进正文**：Phase 2 的面板已展示台账与缺口；真正的追问
   交互属 Phase 3 Discovery。
3. **`general` 仍是 legacy 编译路径**（`prompt.ts` 模板/意图双模式）：因此 general 不经过
   `attachAnalysis` 之外的 v2 契约；与 `required_sections` 收尾一起留待 Phase 3/4 统一。
4. **`injectMissingPlaceholders` 保留为 deprecated 导出**（供旧单测与外部复用），已标注
   「不得再接回编译管线」。
5. **取舍型误降级**：见 `docs/phase3-prerequisites.md` §1（Phase 3 必做，已用测试钉住现状）。

## 6. Phase 3 前置条件

准入清单见 **[phase3-prerequisites.md](./phase3-prerequisites.md)**。要点：

1. **取舍型 / 产品决策不得被降级为「Agent 可调查项」**（用户指定必做）；
   `rc12` 已把现状与目标同时钉住，Phase 3 修好后翻转该断言即为完成证据；
2. 直接复用本阶段资产：三分类 / 五处置 / `USER_DECISION` 问题池 / `question` 字段 / 分析门 / 台账；
3. Discovery 的停止条件是「blocking `USER_REQUIRED` = 0」（决策完备，非信息完备）；
4. Validator 取得改变流程的能力（`return_to_missing_resolution`）；
5. 再优化保留台账（still-valid / conflicting / invalidated）。
