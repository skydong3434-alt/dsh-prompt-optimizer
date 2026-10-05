# Phase 2 Compiler 语义契约 —— 未决项的编译处置（正式）

> **状态：正式契约（用户 2026-10-05 明确指定，实现即以此为准）。**
> 适用范围：所有策略的编译路径（含 legacy general）。改动本契约需用户裁决。
> 基线：`docs/PLAN-v2-adaptive-editor.md` §0 §C6 §C11；决策：选项中选 **A**（现在就切换，
> 不做 B 的过渡），并在 Phase 2 正式更新旧 golden / fixture。

---

## 1. 原则（用户原话，逐字保留）

> - 如果执行 Agent 在正常工作过程中自然会获得该信息，而且无需特别提醒，则 **直接省略**；
> - 如果该信息必须在行动前调查，并且会影响正确执行，则把它写成 **execution responsibility**，
>   例如"修改前先检查当前版本和可用接口"；
> - 如果调查结果决定后续执行分支，则写成 **conditional branch**，
>   例如"若已有 workflow 则优先复用，否则再进入创建/修改路径"；
> - `AGENT_DISCOVERABLE` **永远不得再输出成面向用户的 `[待补充:]`**；
> - `OPTIONAL` 默认省略，除非确实能显著改善结果；
> - 只有 **blocking `USER_REQUIRED`** 才允许阻止生成，并留给 Phase 3 Requirement Discovery 解决。

用户同时给出的约束（防止「另一种膨胀」）：

> 不要把所有 `[待补充:]` 机械替换成"由执行方自行确认 XXX"，避免形成另一种 Prompt 膨胀。

## 2. 可执行化：五种处置（disposition）

| disposition | 触发条件 | 编译产出 |
|---|---|---|
| `OMIT` | `AGENT_DISCOVERABLE` 且（自然获得 / 纯定位类信息） | **不出现**在任何位置（正文与清单都不出现） |
| `EXECUTION_RESPONSIBILITY` | `AGENT_DISCOVERABLE` 且须在**行动前调查**、且影响正确执行 | `## 执行前须知（由执行方自行确认，不需要询问用户）` 下的一条**动作式**指令 |
| `CONDITIONAL_BRANCH` | `AGENT_DISCOVERABLE` 且调查结果**决定后续分支** | `## 分支条件（按调查结果选择路径）` 下的一条**条件式**指令 |
| `USER_DECISION` | 非阻塞 `USER_REQUIRED`（只有用户能定、但不影响本次执行） | **不注入编译稿**；保留在 Requirement Ledger（`OPEN`）与面板清单，Phase 3 Discovery 才追问 |
| `OPTIONAL_ENHANCEMENT` | `OPTIONAL` 且 `impact === 'high'`（确实显著改善结果） | 进**建议**段（`OPTIMIZER_SUGGESTED`），永不进要求段 |

**不变量**

| # | 不变量 | 机械可验证方式 |
|---|---|---|
| I-1 | 编译稿中**永不出现** `[待补充:]` / `[TODO:]` | 全文正则扫描（含 legacy 路径） |
| I-2 | 任何 `AGENT_DISCOVERABLE` 项**不得**成为面向用户的追问 | 不得出现「请先回答/请你确认/待你补充」等句式 |
| I-3 | `EXECUTION_RESPONSIBILITY` / `CONDITIONAL_BRANCH` 只出现为**动作式**（`动手前先…`）或**条件式**（`…则…，否则…`）指令 | 两句式之一 |
| I-4 | 注入条数**有上限**（每类 ≤ 4 条，去重后） | 计数断言 |
| I-5 | `blocking USER_REQUIRED` 一律不进入编译（由分析门拦下） | 宿主门禁测试 |

## 3. 与 v2 其它约束的关系

- `[待补充:]` 退役不是「不再暴露缺口」：缺口仍在 (a) Requirement Ledger、(b) ResultDock 缺口/台账区、
  (c) `EXECUTION_RESPONSIBILITY` / `CONDITIONAL_BRANCH` 指令中显式可见。
- 守卫 `unknownNotBlocking`（invariant A：UNKNOWN ≠ BLOCKING）继续生效；本契约新增
  **I-1/I-2 机械守卫**（`responsibilityDiscipline`）。
- 策略侧的 `missing_constraints` 载荷由「必须落成 `[待补充:]`」改为**按类别交付**：
  编译说明里给出各未决项的处置类别，让模型在正文里以对应句式表达。

## 4. Phase 3 前置条件（用户指定，记入 Phase 3，不返工）

当前「拿不准 → `AGENT_DISCOVERABLE`」的保守 fallback 在 Phase 1/2 保留，但 **Phase 3 必须增加测试**，
确保真正的 user preference / product decision 不会被误降级成「Agent 可调查项」。基准反例：

> 「只验证一次链路还是建设长期自动化」永远不能靠检查环境得到答案。

对应的 Phase 3 测试要求（写入 Phase 3 任务）：

1. 「取舍型」陈述（不做/还是/要么…要么/长期 vs 一次/方案 A 还是 B）**必须**判为 `USER_REQUIRED`；
2. 该类项若影响方向（`impact === 'high'`）→ 必须 `blocking`，由 Discovery 追问，不得静默降级；
3. 反例断言：环境/仓库/文档中**不可能**存在该问题的答案（测试以「不得出现 AGENT_DISCOVERABLE」的形式表达）。
