> ⚠️ **已过时（历史记录）** — 本文描述的是 **V3 之前的旧多阶段架构**（意图分析 / 编辑分诊 / 需求发现 / 编译器 / 校验器 / 策略路由），
> 相关代码已在提交 `435b643` 删除，文中的模块名、文件路径、测试名与 npm 命令**均已失效**。
> 当前实现与文档入口见 [`CURRENT_STATE.md`](../CURRENT_STATE.md) 与 [`docs/README.md`](README.md)。本文仅作历史记录保留。

# Phase 3 前置条件（用户指定，Phase 2 不返工）

> 本文是 **Phase 3 的准入清单**：这些事在 Phase 2 有意不做（避免返工），但 Phase 3
> 必须完成，且必须有测试钉住。来源：用户 2026-10-05 指令。

## 1. 取舍型 / 产品决策不得被降级为「Agent 可调查项」（**必须修**）

Phase 1/2 的保守 fallback 是「拿不准 → `AGENT_DISCOVERABLE`（不打扰用户）」。
这个方向在多数情况下是对的（避免无谓追问），但它有一个**危险的错向**：

> 「只验证一次链路还是建设长期自动化」这类问题**永远不能靠检查环境得到答案**——
> 它是用户的产品决策 / 偏好取舍，而不是仓库里能查到的事实。

现状（Phase 2 结束时，已用测试钉住）：

| 检查项 | 现状 | Phase 3 目标 |
|---|---|---|
| `isTradeoffStatement()` 取舍型判据原语 | ✅ 已提供（`responsibilities.ts`） | 接入判定链 |
| 「要不要 / 是否要」等明确偏好措辞 → `USER_REQUIRED` | ✅ 已达成（用户专属词表命中） | 保持 |
| 纯取舍句式（「A 还是 B」「一次 vs 长期」）→ `USER_REQUIRED` | ❌ 仍落 `AGENT_DISCOVERABLE` | **必须改为 `USER_REQUIRED`** |
| 该类项高影响 → `blocking=true`（由 Discovery 追问） | ❌ 现不阻塞 | **必须按影响面判定** |
| `blocking` 只允许出现在 `USER_REQUIRED` 上 | ✅ 硬不变量（Phase 3 也不得破坏） | 保持 |

**入口证据**：`test/responsibilities.test.mjs` 的 `rc12` 块把「现状」与「目标」同时写死。
Phase 3 修好后，必须把该块的 expected 从 `AGENT_DISCOVERABLE` 改为 `USER_REQUIRED`，
并补一条 `blocking` 判定断言——这一步就是 Phase 3 的完成证据。

**新增测试要求（Phase 3）**

1. 构造一组「取舍 / 偏好 / 产品决策」语料（≥8 条），逐条断言
   `classification === 'USER_REQUIRED'`，且**不得**出现 `AGENT_DISCOVERABLE`；
2. 高影响取舍 → `blocking === true`，由 Requirement Discovery 追问（分析门拦住生成）；
3. 反向断言：真正的环境事实（依赖版本 / 接口签名 / 文件路径）**不得**被误升格为
   `USER_REQUIRED`（避免从「过度追问」荡到「过度忽略」）；
4. 端到端：含取舍型阻塞项的输入 → 宿主只下发 `discovery_required`，零编译调用。

## 2. 本阶段已就位、Phase 3 直接复用的资产

| 资产 | 位置 | Phase 3 用法 |
|---|---|---|
| 三分类与 blocking 判定 | `core/requirements.ts` | Discovery 的「必答 vs 可查 vs 可选」输入 |
| 处置分派（五处置） | `core/responsibilities.ts` | Discovery 问题优先级与「问了会改变什么」的依据 |
| `USER_DECISION` 类目 | 同上 | **就是 Discovery 的问题池**（Phase 2 刻意不注入正文） |
| Question 字段 | `MissingResolutionItem.question` | 分析阶段已要求模型给出建议问法 |
| 分析门 | `core/requirements.ts` `computeAnalysisGate` | 唯一允许阻断生成的开关 |
| 台账（来源 / 状态分离） | `core/types.ts` / `requirements.ts` | Discovery 每轮更新状态（OPEN → CONFIRMED/PROVISIONAL…） |
| 盲授权纪律 | `applyBlindTrust` | 「按你的判断继续」只降不升 |
