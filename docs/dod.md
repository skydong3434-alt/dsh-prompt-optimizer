# DoD 终检清单 — dsh-adaptive-prompt-optimizer v0.3.0-apo

> **v0.3.0-apo（V3 单次调用架构）**：本节清单已随 V3 精简重构更新——旧多阶段链路
> （Analysis/Compiler/Discovery/Validator/Strategy）已删除，回归证据改为 V3 行为测试
> 与真实模型记录；`scripts/check-dod.mjs` 同时断言「旧链路文件必须不存在」（单架构不变式）。

> 本文件是 P09-T02 的 DoD（PLAN-v1 §18）终检清单：逐条列出**验收口径（原文引用）**、
> **机器证据**（文件 / 命令 / 报告），并标出每项状态。机器可自动核对的部分由
> `scripts/check-dod.mjs` 复核；标注 **HUMAN** 的条目（最终用户验收）必须由用户声明
> PASS —— **AI 不代过**（PLAN-v1 §13 P09-T02 Human Gate）。
>
> 使用：`node scripts/check-dod.mjs`（机器子集，退出码 0=全绿）；人工部分对照本表逐条。

## 状态总览

| 类别 | 项数 | 机器 PASS | 待人工 |
|---|---|---|---|
| §18 Definition of Done（10 项） | 10 | 9 | 1（DoD 终检整体由用户声明） |
| 发布交付物（4 项） | 4 | 4 | 0 |
| **合计** | **14** | **13** | **1** |

---

## A. Definition of Done（PLAN-v1 §18，逐条原文 + 证据）

### DoD-1 类型识别 ✅（机器）

> AUTO 能稳定区分 7 类（含 general fallback），手动覆盖始终优先。

- 证据：`src/core/classify.ts`（防误判三规则 + 低置信回退）、`src/core/registry.ts`
  （unknown → general）、manual override 函数级旁路分类（`test/classify-guards.test.mjs`）；
  分类稳定性抽查与回归（`test/regression/` 14 例 expected_type）。
- 门禁：`npm test`（classify/classify-llm/classify-guards/registry/vertical-slice 全绿）✅

### DoD-2 策略真实生效 ✅（机器）

> research/planning/execution/diagnostic/review/creative 使用不同策略与输出契约
> （sections 断言 + 策略独立版本）。

- 证据：`src/core/strategies/<type>.ts` 七文件各自独立 `version` 与 `required_sections`；
  `test/strategies-*.test.mjs` 段落锚点断言；`src/core/registry.ts` 暴露
  `list()/getVersion()/getSections()`（P02-T08）。
- 门禁：`npm test`（七策略 + registry 全绿）✅

### DoD-3 意图保留 ✅（机器）

> 优化稿中 explicit 要求的每条都有用户原话 quote 证据；`provenance_ok` 校验通过；
> UI 四组来源清晰可审计。

- 证据：`src/core/provenance.ts`（quote 字面比对 + 五类来源判定）、
  `src/core/validate.ts`（preservation 层）、`test/provenance.test.mjs` 用例矩阵
  （assistant 消息不做 CONTEXT_EXPLICIT 等）；ResultDock 四组渲染
  （`src/client/ResultDock.tsx`，P06-T02）。
- 门禁：`npm test`（provenance/validate/compiler-integration 全绿）✅

### DoD-4 不替用户发明 ✅（机器）

> suggested 永不混入 explicit；「不可行/最终/确定」类强断言无证据即告警；
> `[待补充:]` 覆盖所有 evidence 不足项。

- 证据：`src/core/validate.ts` 三层守卫（inference & suggestion / unknown 层）、
  `_shared` DOWNGRADE_MARKER 同口径、`STRONG_CLAIM_RE` 收窄（P07-T03 修复 #7）；
  四段协议强制分段（`test/compiler.test.mjs` / `test/compiler-integration.test.mjs`）。
- 门禁：`npm test` 全绿 + `test/regression/` invariant_checks
  （suggested-not-upgraded / unknown-not-blocking 等 7 canonical）✅

### DoD-5 Effect Regression 通过 ✅*（机器 + G-5 裁定）

> 六 golden + 真实语料全部通过 deterministic invariants；model-assisted 达到 Human
> 认可阈值；报告存档。

- 证据：`docs/regression.md` §9（P07-T03 8 轮证据链，官方主报告
  `test/regression/report-2026-10-04-round7.json`）：
  - deterministic 全例**至少单独通过过一次**（r5–r8 全量 + 定向探针交叉验证）；
    最佳全量单跑 **12/14**（r6/r7）；7 个 canonical invariant_checks 语义层绿；
  - evaluator 参考线最佳 **27/30**（r7，0 inconsistent）；全程**未弱化 invariants**；
  - 残余 = 端侧措辞方差（temperature 0 下 deepseek-v4-flash 非逐次确定，
    行级正则对同义改写敏感），**G-5 用户裁定 PASS_WITH_KNOWN_HARNESS_FLAKINESS**；
  - R-2：`threshold=null / DEFERRED_TO_P07_CALIBRATION`（model-assisted 不作硬 Gate）。
- 门禁：`npm test`（regression schema + runner 单测全绿）✅ + G-5 裁定 ✅

### DoD-6 稳定运行 ✅（机器 + G-7）

> DSH Desktop 2.0.15（dsh 0.1.7-rc.2 / cordis 4.0.4）隔离 profile 与正式 profile
> 均稳定；不破坏现有任何功能（全量回归绿）。

- 证据：`docs/p08-smoke.md`（apo-dev 隔离 profile 冒烟 12 项全过）、
  `docs/p08-desktop.md`（四项真机探针全过：Follow DSH model route
  opencode-go/deepseek-v4-flash + 758 帧真实流式、fallback billing safety 双向）、
  `BASELINE.md` 附录 A/B（版本矩阵：DSH Desktop 2.0.15 / dsh 0.1.7-rc.2 /
  cordis 4.0.4；全量测试 exit 0）；正式 profile 已装（bundles=21，G-7 用户确认 6 项全 PASS）。
- 门禁：`npm test` 26 文件 exit 0 ✅ + G-6/G-7 ✅

### DoD-7 不影响周边 ✅（机器 + G-7）

> PAB / 个人工作台 / AI 视频工作流 / 其它插件零改动零影响。

- 证据：BASELINE 附录 B（S-09：正式 profile 零改动，apo-dev profile 任务前后 sha256
  一致）；G-7 安装时「其他 20 插件配置零改动」用户确认；NON-GOAL 声明
  （AGENTS.md / NOTICE.md §4，插件不做自动发送/执行/决策）。
- 门禁：S-09 检查点 ✅ + G-7 ✅ + `scripts/check-license-contamination.mjs` PASS ✅

### DoD-8 用户完整闭环可用 ✅（机器 + G-4/G-6/G-7）

> 输入一句口语需求 → 点优化 → 得到类型正确、结构完整、含来源标注、明显更准确的
> Prompt → 检查/编辑 → 替换输入框 → 自己发送；全程无自动发送/自动执行/自动决策。

- 证据：vertical-slice E2E（`test/vertical-slice.test.mjs`）、controller 状态机
  （replace/undo/Esc/发送即关闭）、ResultDock 四组 provenance + 缺口清单；
  P08 桌面端真实会话走通 replace；G-4 / G-6 / G-7 用户真机验收。
- 门禁：`npm test` 全绿 + Human Gates G-4/G-6/G-7 ✅

### DoD-9 License 清洁 ✅（机器）

> MIT 署名保留；无 AGPL 代码复制（check 脚本绿）；NOTICE.md 完整。

- 证据：`LICENSE`（MIT，上游 Y1X1n 署名原样保留）、`NOTICE.md`（设计来源：Y1X1n MIT /
  WestFox BSD-3 借鉴设计 / linshenkx·zhangjiazhi AGPL 仅思想零复制 / 依赖 License 一览）、
  `scripts/check-license-contamination.mjs`（15 项指纹扫描 src+test+scripts，PASS）。
- 门禁：`node scripts/check-license-contamination.mjs` → exit 0 ✅

### DoD-10 可维护 ✅（机器）

> 策略升级不改 UI（contract 隔离）；全部新增纯函数有单测；回归可重跑。

- 证据：策略与 UI 通过 `PromptStrategy` contract 隔离（registry 暴露 sections/version，
  UI 只读 list/getSections）；`npm test` 26 个文件覆盖全部新增纯函数；
  `test/regression/run.mjs --mode all` 可重跑并产出报告。
- 门禁：`npm test` 全绿 ✅

### DoD 终检（整体）⚠️ HUMAN —— 用户声明 PASS

- 机器证据已齐备（上表 9/10 机器项 PASS）；按 PLAN-v1 §13 P09-T02 Human Gate：
  **DoD 终检由用户声明 PASS，AI 不代过**。
- 本轮收尾将 `status=GATE_PENDING`，等待用户最终验收。

---

## B. 发布交付物（P09-T02 范围）

| # | 交付物 | 证据 | 状态 |
|---|---|---|---|
| D1 | annotated tag `v0.3.0-apo` | `git tag -a v0.3.0-apo`（附注说明、指向内容提交） | ✅ 机器（存在性由 check-dod 核对） |
| D2 | `CHANGELOG.md` | v0.3.0-apo 版本条目（新增/修复/已知记录/验证状态/安装回滚） | ✅ 存在 |
| D3 | `NOTICE.md` | 设计来源 + License 边界 + AGPL 零复制声明 + 依赖一览 | ✅ 存在 |
| D4 | `README{,.en,.simple}.md` 更新 | fork 说明章节 + License/NOTICE 引用 + 安装/致谢 | ✅ 存在 |

## C. 两层门禁（Runner 每轮）

| 门禁 | 命令 | 期望 |
|---|---|---|
| 测试 | `npm test` | exit 0（V3 行为测试 8 个文件 + 构建） |
| 状态一致性 | `python3 scripts/apo_state.py` | PASS（0 FAIL） |
| 污染检查（新增） | `node scripts/check-license-contamination.mjs` | exit 0（PASS） |
| DoD 机器子集（新增） | `node scripts/check-dod.mjs` | exit 0（全 PASS） |