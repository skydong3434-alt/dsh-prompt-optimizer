> ⚠️ **已过时（历史记录）** — 本文描述的是 **V3 之前的旧多阶段架构**（意图分析 / 编辑分诊 / 需求发现 / 编译器 / 校验器 / 策略路由），
> 相关代码已在提交 `435b643` 删除，文中的模块名、文件路径、测试名与 npm 命令**均已失效**。
> 当前实现与文档入口见 [`CURRENT_STATE.md`](../CURRENT_STATE.md) 与 [`docs/README.md`](README.md)。本文仅作历史记录保留。

# RC2 — Decision Stability & Confirmation Semantics 报告

> 窄范围验收轮:只解决 RC 报告暴露的 **1 个 release blocker** + Confirmation 语义。
> 未做任何 future tuning、未新增架构、未发布 / push / 改 tag。
> 复现:`node test/rc2/rc2-decisions.test.mjs`(机械)、`node scripts/rc2-stability.mjs`(真实模型多轮)

---

## 1. Blocker 根因

**同一句 `我想用 dsh 控制 comfyui 生成视频。` 有时阻塞、有时不阻塞** —— 漂移的不是问题措辞,而是产品行为。

根因(两层,第二层是真正的根因):

1. **机械安全层只覆盖「模型已经列出的未知项」**:模型某一轮没列出该决策时,机械层无从纠偏;
   列出来但写成普通 missing 时,旧实现只做「跳过」,不做「就地升级」。
2. **★ 安全层只写在 JSON 解析路径里**:真实环境有 6–8/25 的分析因推理模型预算被吃光而
   走**兜底路径**(`fallbackAnalysisResult`),那条路径**完全不跑安全层** → 那一轮丢失全部阻塞保证。
   这才是「有时阻塞有时不阻塞」的主因(实测阻塞率 13%–100% 波动)。

## 2. 修复方式(通用语义,零特例)

| # | 修复 | 位置 |
|---|---|---|
| 1 | **决策语义类别表**(scope / lifecycle / mvp_vs_full / analysis_vs_execution / reuse_vs_create / architecture_change / mutation_permission / irreversible_permission / delivery_depth / product_direction):满足「读环境得不到唯一答案 + 不同答案显著改变 scope·lifecycle·authority·mutation·delivery depth·direction + 无安全等价默认」即 `USER_REQUIRED + impact=high + blocking` | `core/requirements.ts` |
| 2 | **机械分类把决策类别放在最高优先级**:模型把它写成 `AGENT_DISCOVERABLE` 也拉回 | 同上 |
| 3 | **原文扫描 + 就地升级**:模型漏列 → 补一条(文本用用户原句,不生成问题文案);模型降级 → **就地升级**为阻塞 | `core/analyze.ts::applyDecisionSafety` |
| 4 | **安全层抽成纯函数,解析路径与兜底路径共用** ★(根因修复) | 同上 + `fallbackAnalysisResult` |
| 5 | **模糊目标(机械 REBUILD)= 未定的范围/交付深度决策**,无条件加入;视觉目标(生图/出片)有安全默认 → 豁免 | `vagueGoalDecision` |
| 6 | **§5:只要还有阻塞决策,确认页不出现任何暂定项**;盲授权后才如实展示 | `buildConfirmation` |
| 7 | **§7:Confirmation「目标」= 用户任务目标**(用户目标句 / 本轮原句),**移除** `analysis.rationale` 回落 | 同上 |
| 8 | **同一条要求判定加长度护栏**(`sameRequirement`):避免「ComfyUI 版本」被长句「包含」而误升级 | `requirements.ts` |
| 9 | **已写明规格不算决策**(`isStatedSpecification`):「约束:只看本地可跑的方案」不得被当成评审指令或决策 | `requirements.ts` / `core/router.ts` |
| 10 | 强制为决策时**替换**理由(不再保留「执行方可以直接查到」这种自相矛盾文案) | `analyze.ts` |

## 3. 新增机械 regression(CI 用,不联网)

`test/rc2/rc2-decisions.test.mjs` —— 8 组:

| 组 | 覆盖 |
|---|---|
| rc2-1 | 10 类决策语义识别(scope/lifecycle/mvp/授权/架构/复用/交付深度/方向) |
| rc2-2 | **§3** 8 条高歧义 Prompt:模型漏报 → 阻塞;模型降级 → 仍阻塞;**机械层多次解析结果完全一致** |
| rc2-3 | **§4 双向**:环境事实(版本/路径/API 地址/项目结构/依赖/当前实现/可用接口/配置字段…)不得升级;已写明规格不得成为决策 |
| rc2-4 | 视觉目标豁免(有安全默认),任务型目标不豁免 |
| rc2-5 | **§5** 阻塞决策不得被 PROVISIONAL 绕过;无阻塞时暂定合法 |
| rc2-6 | **§7/§8** 目标 = 用户任务目标(不含诊断词);四类数据源不交叉污染 |
| rc2-7 | 规格行不触发意图覆盖(约束 ≠ 评审指令) |
| rc2-8 | 句子级决策扫描按类别去重 |

另:`test/host-pipeline.test.mjs::h3b` 专门断言**分析失败 + 模糊目标 → 仍然阻塞、零编译**(根因回归)。

## 4. Decision Stability harness 结果

`node scripts/rc2-stability.mjs --runs 8 --limit 8`(真实模型 OpenCode Go / deepseek-v4-flash,8 轮/条):

| # | Prompt | 机械基线 | 阻塞率 | 判定 |
|---|---|---|---|---|
| 1 | 我想用 dsh 控制 comfyui 生成视频。 | vague_goal_scope | **100%** | ✅ |
| 2 | 帮我做一个 AI 知识库。 | vague_goal_scope | **100%** | ✅ |
| 3 | 把这个工具做成能长期自动运行的。 | lifecycle | **100%** | ✅ |
| 4 | 先看看能不能实现这个功能。 | analysis_vs_execution | **100%** | ✅ |
| 5 | 继续做这个项目。 | scope | **100%** | ✅ |
| 6 | 帮我优化现在这套架构。 | architecture_change | **100%** | ✅ |
| 7 | 我想让 Agent 自动处理这些任务。 | lifecycle | **100%** | ✅ |
| 8 | 帮我把这个原型做完整。 | mvp_vs_full | **100%** | ✅ |

**总判定 PASS。** 语义阻塞决策集稳定:机械基线保证的类别在**每一轮**都出现;
模型有时会**额外**多问 1–2 条(用户明确允许「不同问法」),但不再出现「某一轮整组消失」。

## 5. 相同 ComfyUI 输入多轮 blocking decision 结果

- 修复前:阻塞率 **25–50%**,类别变体含 `(none)`(完全不阻塞)。
- 修复后:**100%**,每轮都含 `vague_goal_scope`;部分轮次额外含 `lifecycle`(模型自己多问)。
- 机械层确定性:同一输入多次解析,阻塞项文本完全一致(rc2-2 断言)。

## 6. 环境事实多轮不会被误问

| 探针 | 问到了环境事实 | 环境事实成为阻塞 | 判定 |
|---|---|---|---|
| 帮我把这段描述整理成提示词,ComfyUI 版本我用最新的 | 0 / 8 | 0 / 8 | ✅ |
| 按现有项目结构写个接入脚本,API 地址和端口我会告诉你 | 0 / 8 | 0 / 8 | ✅ |

环境事实一律落在「Agent 自行调查」(弱显示),不进入问题;`version/路径/API 地址/项目结构/依赖/当前实现/可用接口/配置字段` 全部有 rc2-3 断言。

## 7. Confirmation「目标」修复前后对比

**修复前**(来自 RC1 真实输出):
```
本轮目标:
  用户只给出了一句目标陈述,任务方向清楚但控制方式、素材与规格全空,适合以最小补齐的方式推进而非重写。
```
→ 这是 **optimizer diagnosis / triage 说明**,不是用户目标。

**修复后**(真实输出,`node scripts/rc-comfyui.mjs`):
```
本轮目标:
  我想用 dsh 控制 comfyui 生成视频
```
→ 来自用户任务目标;Discovery 后有更具体的确认值时以「(已确认: …)」机械附加,不编造。
断言:目标不得含 `目标陈述 / 最小补齐 / triage / REBUILD / 诊断`(rc2-6)。

## 8. 全部 npm test

`npm test` → **exit 0,486 断言全绿**(RC1 为 477,新增 rc2 机械 8 组 + h3b)。

## 9. build / DSH Desktop load

`npm run build` 成功;`lib/` 为 Desktop link 入口,`node test/smoke.mjs` 经**真实 cordis** 加载通过。

## 10. 是否还有 release blocker

**没有。** 两个发布前问题都已按根因修复并有机械回归 + 真实模型多轮证据:

- 决策稳定性:100%(8/8 Prompt × 8 轮,机械基线每轮都在)
- 环境事实保护:0 次误问(双向)
- Confirmation 目标语义:已修正为「用户任务目标」,四类数据源不交叉污染
- §5:阻塞决策不可被 PROVISIONAL 绕过(盲授权后才允许)

**结论:READY_FOR_RELEASE**(按要求:未发布、未 push、未改 tag `v0.1.0-apo`)。

### 本轮未做(按要求)

模型族预算表 / 全面 regex 治理 / REBUILD 长度阈值 / 凭空量化指标重构 / 新 Compiler / 新 Target / 新 UI / 发布 / push / tag。

### 附带说明(不是 blocker)

机械安全层补的决策项**不编造选项**(§3 要求:只做安全纠偏),UI 用自由输入 + 「按你的判断继续」承接;
该出口本身就是用户主动授权的合法路径(§5)。
