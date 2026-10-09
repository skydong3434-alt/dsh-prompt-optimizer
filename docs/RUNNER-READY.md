> ⚠️ **已过时（历史记录）** — 本文描述的是 **V3 之前的旧多阶段架构**（意图分析 / 编辑分诊 / 需求发现 / 编译器 / 校验器 / 策略路由），
> 相关代码已在提交 `435b643` 删除，文中的模块名、文件路径、测试名与 npm 命令**均已失效**。
> 当前实现与文档入口见 [`CURRENT_STATE.md`](../CURRENT_STATE.md) 与 [`docs/README.md`](README.md)。本文仅作历史记录保留。

# UNATTENDED RUNNER READY

日期：2026-10-03 ｜ 状态：**接入检查 + 任务图准备 + dry-run 完成；未正式启动（等你发令）**

## 1. 使用的是哪套旧 Runner

**personal-ai-brain 的 Unattended Runner**（真实使用过，非新设计）：
- 开发记录：`~/Projects/personal-ai-brain/tasks/P00-T05.1…T05.14`（P00-T05 系列，tag `v0.0.3-unattended-runner`）
- 真实运行证据：`~/Projects/personal-ai-brain/logs/runner/`（2026-09-30.jsonl、2026-10-01.jsonl、attempts.log、gates.log、STOPPED.md、launchd out/err）——P15–P25 阶段由 `com.pab.devrunner`（launchd）每日驱动，PAB 已于 2026-10-02 以 v2.0.0 收官
- 现在 PAB 已无任务（CURRENT_STATE: PROJECT_COMPLETE_V2），Runner 骨架闲置——正好最小复用

## 2. Runner 文件 / 入口（APO 已就位）

`~/Projects/dsh-adaptive-prompt-optimizer/`（提交 f2f454b）：

| 文件 | 来源/改造 |
|---|---|
| `scripts/unattended_runner.py`（751 行） | 复制自 PAB，3 处最小改造：控制面解析 `import apo_state as ccp`（原 check_control_plane）；`DEFAULT_GATES` = `npm test` + `python3 scripts/apo_state.py`；`DEFAULT_PROFILE = "headless"` |
| `scripts/apo_state.py`（新增） | 单函数 `parse_state_block`（PAB 同款字段解析）+ 最小状态一致性检查（字段齐全 / current_task 任务文件存在 / stop_reason 与状态一致 / HEAD 核对） |
| `scripts/runner_doctor.sh` | 复制，profile 检查默认指向 `~/.dsh/profiles/headless` |
| `scripts/runner_status.sh` / `runner_watch.sh` | 复制原样 |
| `docs/runner-ops.md` / `AGENTS.md` / `CURRENT_STATE.md` / `tasks/P01-T02-*.md` | APO 版操作手册 / 无人值守协议 / 任务图 / 任务契约 |

入口：`python3 scripts/unattended_runner.py --project-root <repo> --run`。

## 3. current_task

`CURRENT_STATE.md → current_task = P01-T02`（**NOT_STARTED**，2026-10-03 安全边界确认）。
- P01-T01（types.ts）已完成并提交（17f4dee）；
- ⚠️ **待你裁决的残留**：被中止的 claude_code 调用在终止前写入了 `src/core/provenance.ts`（05:55，277 行，逻辑含 QuoteResolution/normalizeQuoteText/validateProvenance/makeProvenanceRecord；**无分号风格与委派要求不符，且无测试、build.mjs 未加产物段、未经验收**）。当前保持 untracked、未删未改未提交；doctor 的 `git: dirty` FAIL 即此残留所致（符合"未收尾"语义）。处置选项：a) 删除重置（彻底 NOT_STARTED）；b) 保留待下次验收时审阅复用。

## 4. next_task

`P01.5-T01`（Research Vertical Slice 第一个任务）。P01-T02 之后是 **GATE G-1**（Human Gate：契约+Provenance 定稿）——收尾协议已写死：`status: GATE_PENDING` + stop_reason 用非标记词（AGENTS.md §4，已规避 PAB 的关键词误判坑）。

## 5. task graph 状态

```
P00-T01 fork-and-baseline      DONE（构建+三件套测试全绿，BASE 标签 base-y1x1n-v0.4.0）
P01-T01 core-contracts         DONE（src/core/types.ts, 17f4dee）
P01-T02 provenance-validator   NOT_STARTED ← current（残留 pending 你的裁决）
GATE:G-1                       PENDING（契约定稿，用户确认后放行）
P01.5-T01 research-strategy    PENDING（Vertical Slice）
P01.5-T02 vertical-slice-e2e   PENDING
GATE:G-VS                      PENDING（真实体验验收）
之后：P02 全策略 → P03/P04/P05/P06 → P07 regression → P08 隔离集成 → P09 release
```

## 6. Claude executor 实际调用链（真实链路，与旧 Runner 完全一致）

```
Runner (unattended_runner.py, Python, 前台进程)
  → spawn: node "/Applications/DSH Desktop.app/.../@deepseek-ai/dsh/lib/bin.js"
           headless --json "<无人值守提示词>"
  → 即: dsh --profile headless ... （headless 是 profile 名简写）
  → DSH headless agent（DeepSeek 模型，当前 profile=desktop 的默认模型路由）
  → 在仓库 cwd 内执行 Task（写代码/跑 npm test/提交）
  → NDJSON 事件流（session/turn_start/turn_end/final）由 Runner 解析记账
```

- **执行者是 DSH headless agent（DeepSeek），不是 Claude CLI**；
- headless profile 是干净模板（`~/.dsh/profiles/headless/cordis.patch.yml = []`，无审批、无插件）——与 PAB 实际使用一致（PAB 的 spawn 命令同样不传 profile，走 headless 简写）。

## 7. 是否经过 dsh-claude-code

**否（明确结论）**：
- headless profile 未安装 dsh-claude-code（实测 profile 目录无 node_modules/该包）；
- 旧 Runner 从未经过 dsh-claude-code 插件；本 APO Runner 同样不经；
- PAB 曾建 `pab-runner` profile（approval never 补丁）但 spawn 链实际用 headless 简写；APO 沿用 headless，**零配置修改**。

## 8. Claude Code 面板是否能看到无人值守委派

**不能（明确结论，不假装）**：
- dsh-claude-code 的 tracker 是 **process-local、不持久化**（源码注释："The mirror is process-local and not persisted: a DSH restart empties it"）；
- 无人值守 headless 是独立进程、无 web UI；右层面板只显示**当前桌面进程内活动的委派**；
- 若要在面板看到 delegation，只能在启用 dsh-claude-code 的桌面 profile 会话内手动调用 `claude_code`（如刚才被中止的那次）——**这不是 Runner 链路的产物**；
- 让 headless 委派在面板可见需要改 tracker 持久化——**明确不做**（不为了可视化改架构）。

## 9–13. 命令集

```bash
# start（启动前：doctor → dry-run → run）
bash scripts/runner_doctor.sh
python3 scripts/unattended_runner.py --project-root "$(pwd)" --dry-run
python3 scripts/unattended_runner.py --project-root "$(pwd)" --run --max-rounds 20

# status / watch
bash scripts/runner_status.sh
bash scripts/runner_watch.sh

# graceful stop / resume
touch logs/runner/STOP                       # stop：每轮起点检查；STOP 不自动删除
rm logs/runner/STOP                          # resume 前必须显式解除
python3 scripts/unattended_runner.py --project-root "$(pwd)" --reconcile-only   # 崩溃对账
python3 scripts/unattended_runner.py --project-root "$(pwd)" --run --max-rounds 20
```

退出码：0 正常 / 3 已持锁（单写者）/ 4 已停止 / 5 门禁；账本在 `logs/runner/`（state.json/current.json/<date>.jsonl/attempts.log/gates.log/STOPPED.md，不入 git）。

## 14. Human Gates（Runner 会在此停下等你）

G-0 已确认（项目名/目录/upstream-origin）→ **G-1**（P01-T02 后：契约+Provenance 定稿）→ **G-VS**（Vertical Slice 真实体验）→ G-2 策略抽审 → G-3（延后到 P07 校准）→ G-4/G-5/G-6 → **G-7**（正式安装许可，唯一动正式 profile 的开关）。
Runner 侧机制：`status: GATE_PENDING` + 非标记词 stop_reason → `plan.action=stopped` → 通知停止（osascript）；你确认后更新 CURRENT_STATE 再 resume。

## 15. Stop Conditions（沿用 S-01..S-11）

S-01 基线不过 / S-02 与 REPORT 不符 / S-03 需大量重写 / S-04 DSH API 冲突 / S-05 license 风险 / S-06 分类不稳 / S-07 provenance 失效 / S-08 effect regression 反噬 / S-09 污染正式 profile / S-10 需改 PAB / S-11 连续 3 次验收不过。任何一条：Runner 写 stop_reason 停止，报告证据，等裁决——不自行换大架构。

## 16. dry-run 结果

```
decision: run     → task_id: P01-T02     → would_spawn: yes     （exit 0）
apo_state 自检：  PASS（0 FAIL，含 HEAD 核对 INFO）
runner_doctor：  6/7 OK；唯一 FAIL = git: dirty（即 provenance.ts 残留，待你裁决）
```

- 首次 dry-run 曾误判 `stopped`：因我的 stop_reason 说明文字含 "blocking human gate" 标记词——已修复（状态字段纪律写入 CURRENT_STATE 提示 + AGENTS.md），复测正确 `run`；
- 环境实测：dsh App bundle 可解析（node ~/.local/bin/node v22.23.0）、headless profile 存在、python3.14、logs 可写、锁空闲。

## 17. 启动前置条件（等你发令）

1. **裁决 provenance.ts 残留**（删除重置 / 保留待审）；
2. （可选确认项，非必须）是否给 headless profile 加显式 `approval: never` 补丁作为双保险——PAB 曾这样做过（pab-runner），但真实 spawn 走 headless 简写；APO 默认保持零配置改动，你若要求再加；
3. origin 仓库 URL（push 前置，本地开发不受影响）；
4. 你的明确指令："启动无人值守开发"——在此之前 Runner 不运行。