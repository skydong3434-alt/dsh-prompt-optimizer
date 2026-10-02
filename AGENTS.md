# AGENTS.md — dsh-adaptive-prompt-optimizer 执行协议（无人值守版）

> 本文件是 RUNNER 内 Agent 开工/收尾的真值。规则精简自 personal-ai-brain 的
> 无人值守协议（用户自有项目，复用其机制）；产品契约另见 PLAN-v1/v1.1。

## 1. 角色与边界

- 本仓库 = DSH Adaptive Prompt Optimizer（MIT，基于 Y1X1n fork）。Agent 在此仓库内开发插件。
- **NON-GOAL（永不触碰）**：正式 DSH profile（desktop）/ ~/.dsh 正式配置 / Personal AI Brain / AI 视频工作流 / PAB 写入 / 自动拦截发送 / Project Router / Orchestrator / Claude Code 自动执行下游任务 / 自动决策。
- License 边界：upstream Y1X1n = MIT（保留署名）；WestFox = BSD-3（可借鉴设计）；**linshenkx / zhangjiazhi = AGPL，只允许读思想，禁止复制任何源码/模板文本/测试**。
- Runner 只拉起、复核、记账；Agent 做事 + 写状态 + 提交；**Runner 不写业务代码、不 commit、不解决冲突**。

## 2. 开工协议（每轮 agent 必须）

1. 读 `CURRENT_STATE.md`（权威任务指针）、本文件、`PLAN-v1.md` / `PLAN-v1.1.md`（契约）、当前任务文件 `tasks/<current_task>-*.md` 全文；
2. 明确五要素：当前目标 / 当前状态 / 允许修改范围（Allowed Scope）/ 下一步 / 验收标准（Acceptance Criteria）；
3. 检查 git 分支与工作区（不要在错误分支/脏工作区上开工）；
4. 若 current_task 为空而 next_task 非空：按 next_task 创建任务文件（脚手架：复制既有任务模板）后执行。

## 3. 执行纪律

1. 严格执行任务文件的 Allowed/Forbidden Scope；不得扩大范围；
2. 每次改动可构建：跑 `npm run build`（或该阶段指定构建）；
3. 每个 Task 的测试必须真实运行通过（unit + 该任务指定集成/回归）才算完成证据；
4. 不伪造证据：声称"测试通过"必须给出真实命令输出；声称"完成"必须有 git HEAD 推进 + 状态同步；
5. 无人在场：不要提问；需要人工裁决 → 写 stop_reason 后结束本轮（见 §4）。

## 4. 收尾协议（每个 task 完成后必须）

1. 更新 `CURRENT_STATE.md`：
   - `current_task` 置空；`next_task` 设为下一 Task（按任务图/规划）；
   - `status` 相应更新；`latest_commit` 更正为内容提交后的 HEAD（或下轮核对）；
   - **若下一节点是 Human Gate（G-1/G-VS/G-2…）**：`status: GATE_PENDING`，`stop_reason: "blocking human gate: <门禁名>"`——Runner 读到 blocking 词即停止。
2. 一个内容 commit（前缀 `pXX(tXX): summary`）+ 一个仅状态同步的 commit；
3. 不得 force push / reset --hard / 改写历史 / 删除真实数据 / 自动解 merge conflict；
4. 收尾后在事件流可见处留一句完成摘要（提交信息内）。

## 5. 测试与门禁

- Runner 每轮跑 `npm test` + `python3 scripts/apo_state.py`（两层门禁）；
- 门禁红 → 该轮判 retry（最多 3 次）→ retry exhausted = STOP；
- 触发 PLAN-v1 §15 Stop Conditions 中任何一条 → 写入 stop_reason 并停止，不自行换大架构。

## 6. 无人值守提示词（Runner 注入的固定要求）

1. 严格按本文件与 CURRENT_STATE.next_task 指向的 Task 执行；
2. 读 AGENTS.md、CURRENT_STATE.md、PLAN-v1/v1.1、该 Task 文件全文；
3. 按 §2 开工协议核对五要素；按 §4 收尾协议更新 CURRENT_STATE / 提交；
4. 一个 Task = 一个内容提交 + 一个仅 CURRENT_STATE 的状态同步提交；
5. 完成后把 current_task 置空、next_task 指向下一个 Task；
6. 若命中 BLOCKING HUMAN GATE，停下并把 stop_reason 写入 CURRENT_STATE，不要硬做；
7. 这是无人值守执行：没有人会回答你的提问。需要人工裁决时，写到 CURRENT_STATE.stop_reason 后结束本轮。