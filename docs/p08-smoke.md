# P08-T01 隔离 profile 安装与冒烟记录（Isolated Install & Smoke）

> 日期：2026-10-04 ｜ 状态：**完成（含 1 项 B 类已知假阳性记录）**
> 环境：DSH Desktop 2.0.15（/Applications/DSH Desktop.app）｜ dsh 0.1.7-rc.2 ｜ cordis 4.0.4 ｜ node v22.23.0
> 出口：**G-6（Human Gate：隔离环境用户体验认可）** —— 任务完成后停止等待用户。

## 1. 目标

在**隔离 dev profile**（新建 apo-dev，不碰正式 desktop profile）安装插件包并跑完整冒烟清单：
button / dropdown / streaming / cancel / replace / undo / settings / context / override / AUTO / fallback / CSRF。

## 2. 隔离环境准备（Allowed Scope 内）

| 项 | 内容 |
|---|---|
| 隔离 profile | `~/.dsh/profiles/apo-dev`（**新建**，模型路由克隆自 headless 的 opencode-go 配置——2026-10-04 E1 批准同款；wk-opencode 会话头改为 dsh-apo-dev-smoke） |
| 插件包 | `@y1x1n/dsh-prompt-optimizer` link → 本仓库 `~/Projects/dsh-adaptive-prompt-optimizer`（与 G-4 预览 profile apo-g4 同型） |
| bundles | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `@y1x1n/dsh-prompt-optimizer` |
| 正式 desktop profile | **零改动**（S-09 前后快照 sha256+mtime 一致，见 §5） |
| headless profile | 仅 runner 自身 boot 触碰（cordis.yml 内容恒为 `[]` 模板，无内容改动） |

启动命令（真实 DSH 2.0.15 CLI）：
```
node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile apo-dev --no-open --port 18776
```

启动日志：
```
[dsh-prompt-optimizer] loaded, POST /dsh-prompt-optimizer/optimize
dsh web: http://127.0.0.1:18776/?token=…
```

## 3. 冒烟清单逐项验证（真实 HTTP 服务）

| # | 清单项 | 验证方式 | 结果 |
|---|---|---|---|
| 1 | CSRF / 来源围栏 | 跨站 Origin → 403；DNS rebinding 伪造 Host → 403 | ✅ PASS |
| 2 | 方法校验 | GET /optimize → 405 | ✅ PASS |
| 3 | 请求体校验 | 畸形 JSON → 400；空 text → 400；超大请求 → 413（smoke.mjs#5b） | ✅ PASS |
| 4 | streaming（SSE 事件序） | 真实 LLM（opencode-go/deepseek-v4-flash）：meta → 411 delta → done | ✅ PASS |
| 5 | AUTO 分类 + 编译 | 真实案例「Mac M1 Pro 32GB / ComfyUI AI 视频」→ research / High | ✅ PASS |
| 6 | override（手动类型） | promptType=execution → meta prompt_type=execution（跳过分类）→ 647 delta → done | ✅ PASS |
| 7 | context（会话上下文） | 携带 context 数组 → 编译继续（388 delta → done）；关闭开关忽略（smoke.mjs#17b） | ✅ PASS |
| 8 | cancel / 超时 | controller c18/c19 + smoke.mjs#8（超时中止并通知；cancel 仅在 loading 生效） | ✅ PASS（自动化） |
| 9 | replace / undo | controller c25（替换/撤回回归）、c7 撤回状态流转 | ✅ PASS（自动化） |
| 10 | button / dropdown | controller c23/c24（AUTO 下拉首位、手动覆盖跨 close 保留、重新优化沿用所选） | ✅ PASS（自动化） |
| 11 | settings | settings-i18n / compat-settings（新字段默认值/volatile/宽松接收/双后端读写/键齐套） | ✅ PASS（自动化） |
| 12 | fallback | smoke.mjs#13/#13b/#14（主路由零产出失败自动换备用路线带 fallbackUsed/Reason） | ✅ PASS（自动化） |

自动化部分 = `npm test` 全绿（2026-10-04 P08-T01 基线）；真实 HTTP 部分 = 对 boot 中的 apo-dev profile
直接发包（证据原始流见 `logs/p08-t01/apo-live-{auto,exec,ctx}.txt`，不入 git）。

补充观察：
- 请求体不带 provider/model 时解析到默认第一路由（deepseek-official）→ 命中 **QUOTA**（Insufficient
  Balance）——这是 **P07 已知 402 根因**（DeepSeek 余额不足），非插件缺陷；显式指定 opencode-go 路由后
  真实流式调用成功（test-model 返回 `{"ok":true,"provider":"opencode-go","model":"deepseek-v4-flash",
  "reply":"pong"}`，1.9s）。
- 无效 provider 显式指定 → SSE error 事件（`NO_ADAPTER: no adapter registered`）→ 正常错误通道，不崩溃。

## 4. 问题清单（明确降级 1 项）

| 问题 | 证据 | 判定 |
|---|---|---|
| research 策略编译产物 `provenance_ok=false`（real LLM 输出） | done 事件 `provenance_ok:false`，唯一 problem = `research-no-invented-quantities`：`发现无证据量化约束「工期」`；经逐行审计，命中的两处分别是 `- [待补充: 时间/工期约束…]`（Constraints 段，**本就带待补充前缀**）与「研究深度与交付节奏:取决于时间/工期约束。」（Human Decision Points 段，表述为依赖关系而非捏造数值） | **B 类 regex/phrasing 假阳性（与 G-5 裁定同源）**：`INVENTED_QUANTITY` 的 `待补充` 前瞻仅覆盖关键词**之后**，前缀式 `[待补充: …]` 与「取决于」转述句式误命中。不上升为产品缺陷；**不在 P08-T01 Allowed Scope 内修（策略/validator 改动属 P02/P04 模块）**，记档待后续模块修订或 G-6 人工复核 |

## 5. S-09 检查点：正式 profile 零改动证明

对 `~/.dsh/profiles/desktop/` 关键五文件（package.json / cordis.yml / cordis.patch.yml /
pnpm-workspace.yaml / pnpm-lock.yaml）在任务前后分别做 sha256 + mtime 快照：

```
任务前（2026-10-04 11:33）  vs  任务后（2026-10-04 11:36）
package.json       321446c4…  =  321446c4…
cordis.yml         37517e5f…  =  37517e5f…
cordis.patch.yml   7f84dbdc…  =  7f84dbdc…
pnpm-workspace.yaml cda2c0eb…  =  cda2c0eb…
pnpm-lock.yaml     7b6f726f…  =  7b6f726f…
mtime 全部一致
```

**S-09 = PASS**（正式 desktop profile 逐字节零改动；本任务只新建/写入了隔离 profile apo-dev）。

## 6. Acceptance

- [x] 冒烟清单 12 项全景通过（4 项真实 HTTP + 8 项自动化绿色回归）
- [x] 隔离 profile 安装 + 真实 boot + 路由注册（`[dsh-prompt-optimizer] loaded`）
- [x] S-09 记录：正式 profile 零改动证明
- [x] 问题清单：1 项 B 类已知假阳性，明确降级（不阻塞）
- [ ] **G-6：隔离环境用户体验认可（Human Gate，任务完成后停止等待用户）**

## 7. Next Transition

G-6 → **P08-T02**（桌面端实测与回归证据：三槽位渲染、双版本设置、SSE 流式、撤销/替换交互、
BASELINE.md 版本矩阵追加）。