# P08-T02 — 桌面端实测与回归证据

**Status**: PENDING
**Phase**: P08
## Executor
DSH

## Goal
DSH Desktop 2.0.15 真机实测（隔离环境）：三槽位渲染、双版本设置接入、SSE 流式、撤销/替换交互；环境版本矩阵记录。

## Why
正式安装前的最后真实证据；S-04 终检。

## Preconditions
P08-T01

## Inputs
DSH 2.0.15（cordis 4.0.4 / dsh 0.1.7-rc.2）；全量测试

## Allowed Scope
只读验证 + 记录

## Forbidden Scope
正式 profile

## Tools
DSH Desktop UI、npm test、截图工具

## Exact Steps
1. 全量 `npm run build && npm test`
2. 桌面端交互实测清单（含 lighthouse 风格 UI 检查）
3. 版本矩阵写入 BASELINE.md 追加节

## G-6 追加验收（2026-10-04 用户裁决，P08-T02 必须新增两项真实桌面验收）

### 1. Follow DSH model route（真实 UI session 必验）
- 场景：DSH 当前模型 = opencode-go / deepseek-v4-flash（桌面与隔离 apo-dev 同款路由），执行 APO AUTO optimize。
- 必须确认实际调用：`provider=opencode-go, model=deepseek-v4-flash`。
- **不得**：因请求未显式带 provider 而选择 provider 列表第一项；落到 deepseek-official；产生 DeepSeek 402；直接访问 api.deepseek.com。
- **双入口区分（必须分别记录）**：
  - a. 直接 HTTP smoke（无 session context）：若回落第一 provider（deepseek-official / 402）→ 记为**测试入口行为**（脚本无会话，客户端 controller 不注入 DSH 会话模型），非产品缺陷；
  - b. 真实 DSH UI session（有会话上下文）：客户端从 `modelDirectories.directoryFor(sessionId).load().current` 读 DSH 会话模型并作为 body provider/model 发送 → 断言实际路由 = opencode-go。
- **判据**：若 (b) 真实 UI 会话也回落第一 provider → **BLOCKING route defect，G-7 前必须修**；仅 (a) 回落 → 记录即可。

### 2. Fallback billing safety
- fallback 仅当用户/配置**显式设置 fallbackModel** 时启用。
- 默认 `fallbackModel` 为空时：主模型失败 → **明确报错**（SSE error 事件，不静默换 provider）。
- **不得**：主模型失败 → 自动寻找其他 provider → 特别是不得静默调用 deepseek-official（避免产生非预期付费）。
- 判据：当前实现已满足 → 记 PASS；存在隐式 fallback → **G-7 前必须修**。

### 3. KNOWN_NON_BLOCKING_HARNESS_LIMITATION（记录，不修）
- `research-no-invented-quantities` 对「[待补充: 时间/工期约束]」与「取决于时间/工期约束」存在 phrasing-sensitive regex false positive（与 G-5 裁定同源）。
- 本轮不修改；不重新打开 P02/P04 模块；后续单独治理 deterministic regex / semantic invariant 边界。


## Tests
全量回归 + 实测清单

## Acceptance Criteria
全绿 + 实测通过 + BASELINE 更新

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p08(t02): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
P09-T01
## Human Gate
无（该阶段无独立 Human Gate，或见 Next Transition）
