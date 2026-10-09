> ⚠️ **已过时（历史记录）** — 本文描述的是 **V3 之前的旧多阶段架构**（意图分析 / 编辑分诊 / 需求发现 / 编译器 / 校验器 / 策略路由），
> 相关代码已在提交 `435b643` 删除，文中的模块名、文件路径、测试名与 npm 命令**均已失效**。
> 当前实现与文档入口见 [`CURRENT_STATE.md`](../CURRENT_STATE.md) 与 [`docs/README.md`](README.md)。本文仅作历史记录保留。

# dsh-adaptive-prompt-optimizer — 无人值守 Runner 操作手册（APO 版）

> 实现：`scripts/unattended_runner.py`（复制自 personal-ai-brain 并最小改造：
> 控制面解析换 `scripts/apo_state.py`，默认门禁 = `npm test` + `apo_state.py`，
> 默认 profile = headless）。规则真值：`AGENTS.md` 与 `CURRENT_STATE.md`。

职责边界：Agent 做事+写状态+提交；Runner 只拉起、复核证据、记账、决定继续/停止。
Runner 不写业务代码、不 commit、不解决冲突，只写 `logs/runner/`。

## 1. 启动（先体检，再 dry-run，再启动）

```bash
bash scripts/runner_doctor.sh          # 0 = OK；1 = 存在 FAIL（git dirty 可容忍）
python3 scripts/unattended_runner.py --project-root "$(pwd)" --dry-run   # 先看决策
python3 scripts/unattended_runner.py --project-root "$(pwd)" --run --max-rounds 20
```

- 每轮：读 `CURRENT_STATE.current_task`（非空续跑）→ 否则读 `next_task` →
  spawn `dsh headless --json <prompt>`（headless profile，无审批）→ 跑两层门禁
  （`npm test` + `python3 scripts/apo_state.py`）→ PASS 记成功进下一轮。
- 单写者：第二个实例拿不到 flock 以退出码 3 退出。
- 参数：`--max-rounds`（默认 20）/ `--max-attempts`（默认 3，超限 STOP）/
  `--round-timeout`（默认 3600s）/ `--gate`（覆盖门禁，可重复）/ `--reconcile-only`。
- 退出码：0 正常；3 已持锁；4 已停止；5 门禁。

## 2. 观察

```bash
bash scripts/runner_status.sh          # 一屏状态：锁/STOP 标志/current.json/state.json/最近事件
bash scripts/runner_watch.sh           # tail -f 当日事件流
# 账本（logs/runner/，不入 git）：state.json / current.json / <date>.jsonl /
#   attempts.log（每轮 stdout/stderr 原文）/ gates.log / STOPPED.md（停止原因+你该做什么）
```

## 3. 停止

```bash
touch logs/runner/STOP                # 优雅停止（每轮起点检查；STOP 不会自动删除，需显式 rm）
# 或信号：
kill -TERM "$(cat logs/runner/runner.lock)"   # SIGTERM → 进程组宽限 20s → SIGKILL
kill -KILL "$(cat logs/runner/runner.lock)"   # 最后手段；之后用 --reconcile-only 对账
```

Runner 自动停止的情形：status=BLOCKED/RECOVERY_REQUIRED、stop_reason 含 blocking 标记词
（含 `blocking human gate`，即 G-1/G-VS 等 Human Gate 触发）、`logs/runner/STOP` 存在、
retry exhausted、达 --max-rounds。真正停止时发系统通知（osascript），每轮成功不通知。

## 4. 恢复（含崩溃对账）

```bash
python3 scripts/unattended_runner.py --project-root "$(pwd)" --reconcile-only  # 先看对账 JSON
bash scripts/runner_status.sh          # 看 STOPPED.md 与最近事件
# 人工处理 stop_reason 指向的问题（如 G-1：用户确认契约定稿后更新 CURRENT_STATE）
rm logs/runner/STOP                    # 若上次是主动停止
python3 scripts/unattended_runner.py --project-root "$(pwd)" --run --max-rounds 20
```

- 未闭合 attempt 一律不计成功；`CURRENT_STATE.current_task` 非空 = 中断恢复，续跑该任务。
- 冲突时以 `CURRENT_STATE.md` 为准，差异记入事件流，不静默覆盖。

## 5. 排障速查

| 症状 | 处置 |
|---|---|
| doctor FAIL（dsh CLI / headless profile / python3 / logs 可写 / 锁 / git dirty） | 按 FAIL 项定位；profile 检查默认 `~/.dsh/profiles/headless` |
| `Runner already active`（退出码 3） | 已有活 Runner，用 status 观察，不要双开 |
| attempts.log 里 attempt stdout/stderr 0 字节 / session_id null / 每轮 ~0.1s | node 不满足 engines 或路径漂移：确认 `node -v` 为 ^22.19 或 >=24（本机实测 ~/.local/bin/node = v22.23.0 可用）；doctor 会暴露 |
| HEAD 未推进但声称完成 | 判 retry；检查是否卡在收尾 |
| 单轮超时 | 判 retry；必要时调大 --round-timeout 或缩小 Task |
| STOPPED.md 出现 | 读它：原因 + 下一步（通常 = Human Gate） |

永远不要：force push / reset --hard / 删真实数据 / 自动解 merge conflict / 安装 launchd
（本阶段禁止）/ 把 logs/ 提交进 git / 触碰正式 DSH profile 与 PAB。

## 6. Claude Code executor 说明（与 dsh-claude-code 面板的关系）

- 本 Runner 每轮拉起的是 **DSH headless agent**（DeepSeek），命令链：
  `node <DSH app>/node_modules/@deepseek-ai/dsh/lib/bin.js headless --json <prompt>`，
  使用 `headless` profile（干净模板，无 dsh-claude-code 插件）。
- 因此无人值守轮次**不经过 dsh-claude-code 插件**，Desktop 右侧「Claude Code」面板
  **不会显示** Runner 的轮次（面板只显示当前进程内活动的委派；tracker 进程本地、不持久化）。
- 若未来需要 Claude Code 执行编码子任务：只能在开启了 dsh-claude-code 的 profile 会话内
  使用 `claude_code` 工具；无人值守 headless 链路若要显示委派需另行设计持久化，属
  **明确不做**的范围（不为了可视化改架构）。
- APO 的编码任务由 headless agent 直接执行（TypeScript + node:test，无第三方依赖需求），
  与 P01-T02 等任务契约兼容。