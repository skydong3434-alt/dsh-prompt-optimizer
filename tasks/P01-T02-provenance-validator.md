# P01-T02 — Provenance Validator（机械校验器）

**Status**: NOT_STARTED（2026-10-03，current）
**Phase**: P01（Core Contracts & Provenance）
**Branch**: phase/p01-contracts

## Goal

交付 `src/core/provenance.ts`（纯函数：五源判定 + quote 机械字面比对 + 记录工厂 + 规范化）与 `test/provenance.test.mjs`（断言矩阵），并在 `scripts/build.mjs` 追加产物段（lib/core/provenance.js）。这是 Provenance 第一优先级的核心防线：**防止优化器把推断伪装成用户要求**。

## Why

插件不能只"生成一份看起来专业的 Prompt"；必须能区分信息来自用户（USER_EXPLICIT / CONTEXT_EXPLICIT / WORKSPACE_FACT）、来自优化器建议（OPTIMIZER_SUGGESTED）、还是证据不足（UNKNOWN）。explicit 要求必须有逐字 quote 证据；assistant 发言永不能作为用户意图证据。

## Preconditions

- P00 基线全绿（build + 三件套测试通过）
- P01-T01 完成（src/core/types.ts 存在，core 层 typecheck 零错误）
- 分支 phase/p01-contracts

## Inputs

- `src/core/types.ts`（ProvenanceRecord / ValidationResult / ProvenanceSource 等契约）
- PLAN-v1 §5（Provenance Design）与 §13 P01-T02 契约

## Allowed Scope

- `src/core/provenance.ts`（新增）
- `test/provenance.test.mjs`（新增）
- `scripts/build.mjs`（仅追加 provenance 产物段，模式与现有段一致）

## Forbidden Scope

- 不得修改 `src/core/types.ts`、`src/index.ts`、`src/prompt.ts`、`src/client/**`
- 不得引入任何新 npm 依赖
- 不得复制 AGPL 项目（linshenkx/zhangjiazhi）代码；quote 比对思想借鉴 WestFox(BSD-3)，独立实现
- 不安装插件、不改 DSH profile、不碰正式环境

## Executor

Claude Code（实现）→ DSH 验收；或 DSH 直接实现（若 Claude Code 委派不可用，二者产出同标准验收）

## Tools

node/tsc/esbuild/scripts/build.mjs、node:test（assert/strict）、git（分支提交）

## Exact Steps

1. 实现 `src/core/provenance.ts`：
   - `normalizeQuoteText(text)`：折叠连续空白、trim、剥离首尾引号（' " ` ‘ ’ “ ”）与首尾句读（。！？,.!?;）、**不做大小写折叠**（逐字保守）
   - `resolveQuoteSource(quote, rawInput, contextTurns)` → `{valid, matchedIn: 'raw'|'context-user'|'assistant-only'|'none', source, confidence}`
   - `validateProvenance(records, rawInput, contextTurns)` → ValidationResult：USER_EXPLICIT 需 raw 证据；CONTEXT_EXPLICIT 需 context-user 证据；WORKSPACE_FACT 可无证据（有则 warn）；SUGGESTED/UNKNOWN 豁免；explicit/context 空 evidence → error
   - `makeProvenanceRecord({text, source, evidence?, confidence?, note?})` → ProvenanceRecord（id 生成）
2. 追加 build.mjs 产物段（entry src/core/provenance.ts → outfile lib/core/provenance.js）
3. 编写 test/provenance.test.mjs 断言矩阵（见 Tests）
4. 本地跑通：`npm run build` + `node test/provenance.test.mjs` + core 层无新增 tsc 错误

## Expected Outputs

- src/core/provenance.ts
- lib/core/provenance.js（构建产物）
- test/provenance.test.mjs（全部通过）
- 提交：内容 + 状态同步（CURRENT_STATE.md 更新为 GATE-PENDING 前保持 RUNNING）

## Tests

矩阵至少覆盖：
- quote 逐字存在于 raw_input → USER_EXPLICIT valid / matchedIn 'raw'
- quote 存在于 context user 消息 → CONTEXT_EXPLICIT valid
- quote 仅存在于 assistant 消息 → invalid + matchedIn 'assistant-only' + validateProvenance 产生 warn 不产生 error（记录其余合规时 ok=true）
- quote 完全不存在 → invalid 'none' + explicit 记录 → error
- 空白变体（多余空格/换行/tab）→ normalize 后匹配
- 首尾引号与句读包裹 → normalize 后匹配
- 英文大小写变体 → 不匹配（保守原则）
- explicit 记录 evidence 为空 → error
- suggested 记录无 evidence → 豁免、无 issue
- workspace_fact 记录 evidence 为空 → 豁免
- makeProvenanceRecord 生成稳定 id + 默认 confidence 'medium'

## Acceptance Criteria

- `node scripts/build.mjs` 成功（含新产物段，原有四产物不受影响）
- `node test/provenance.test.mjs` 全绿
- `npx tsc --noEmit` 中 src/core/ 无新增错误（client 既有 peer 类型错误为基线已知问题，不得修复与之无关）
- 未触碰 Forbidden Scope 内任何文件

## Failure Handling

- 比对误报偏高（如 normalize 过度）→ 收紧规范化前先跑矩阵定位；不绕过断言
- 持续不过 → 按 Runner 重试规则（max-attempts 3）→ retry exhausted = STOP 报告

## Human Gate
G-1（P01-T02 完成后 Human Gate：核心契约与 Provenance 数据结构定稿，用户确认后继续 P01.5）

## Stop Conditions

- S-07（Provenance 机制无法防止重要约束被误标）相关用例失败且无法在 3 次 attempt 内修复
- 其他按 PLAN-v1 §15 Stop Conditions 执行

## Docs Update

- 完成后在 docs/provenance.md 记录五源语义与校验规则摘要（可作为后续 G-1 审阅附件；如时间不足可在 G-1 前补）

## Git Rules

- 分支 phase/p01-contracts；commit 前缀 `p01(t02): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交（遵循收尾协议）
- 不 force、不 rewrite、不 push upstream

## Next Transition

P01-T02 完成 → **GATE G-1**（Human Gate：核心契约 + Provenance 数据结构定稿）→ 用户确认后 P01.5（Research Vertical Slice）。