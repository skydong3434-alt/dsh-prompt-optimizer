# CURRENT STATE

```
project: dsh-adaptive-prompt-optimizer
last_updated: 2026-10-03T22:55:59+08:00
current_phase: P06
current_task: 
status: RUNNING
next_task: P06-T02
machine_gate: PASS
human_review: PASS_G2
phase_status: G-2 已通过（2026-10-03 七策略定稿）。G-2 后追加的 Performance/Effect 验收要求已入 P07 契约：A. per-strategy token/latency 测量（system/context/total input token + latency，不预防性压缩）；B. planning 历史事实误报 case（用户提供的既有完成事实允许引用，守卫只阻止 Optimizer 凭空宣称实施）；C. creative 显式覆盖优先级 case（CURRENT USER EXPLICIT > HISTORICAL USER EXPLICIT > CONTEXT FACT > OPTIMIZER SUGGESTED）。P03 三任务全部完成（classify 纯函数层 1aebeec / 调用侧封装 1e73fb2 / 防误判测试契约 a810ea1）。P04-T01 已完成：compiler core——compilePrompt() 10 步编排（override 七类型直达 registry 且函数级旁路分类、AUTO 分类、缺省 general 兜底、CompileResult 骨架 provenance_ok=false 待 validate）+ COMPILE_PROMPT_STEPS 审计锚点（orchestration/protocol/finalize 三态）+ parseCompileOutput 容错增强（[待补充:]/[TODO:] 中英同构、suggested 标签剥离复用 _shared）+ injectMissingPlaceholders 缺口机械注入（幂等，legacy 零回归）；test/compiler.test.mjs k1..k16，8248c22。P04-T02 已完成：输出守卫 `src/core/validate.ts` 三层 anti-drift 机械校验（①Preservation：explicit/context 逐字 quote 证据复用 P01-T02 provenance + required_sections 齐全 + 要求可寻回 + 术语漂移 raw-only→warn/用户要求→error；②Inference&Suggestion：suggested 混入 explicit/context→error、无标注升级→error、无证据强断言→error、无证据量化（预算/时间/平台/模型）→error；③Unknown：UNKNOWN 记录与 missing_constraints 落地 `[待补充:]` 可定位）+ collectStrategyGuardProblems 汇总策略 guards + validateCompileResult 结构化输出（problems/ok/provenance_ok/layers/strategyGuards）；test/validate.test.mjs v1..v14（含 provenance_ok 与 finalizeCompile/compilePrompt 骨架联动一致）；156b857。P04-T03 已完成：compiler + validator 集成测试 `test/compiler-integration.test.mjs` i1..i13（compilePrompt → finalizeCompile → validateCompileResult 全链路）：七类型 override/AUTO 契约字段矩阵（required_sections 满足、explicit 逐字证据、suggested 独立段、缺口 `[待补充:]` 可见、confidence 映射 High/Medium/Low 全链路一致）；失败注入（空输出/截断/跑偏降级且不伪造 provenance；伪 quote、建议升级、无证据量化与强断言 → error 可定位）；协议解析容错回归（markdown 四段回退 / `(无)` / 重复标记取最后 / think 剥离）；provenance_ok 七类型 finalize↔validate 联动一致；legacy general 零回归；纯函数可复现且零 Host·UI·LLM 依赖；S-07 复审 7/7 类型 × 3 类误标注入（伪证据/建议升级/凭空量化）全部机械拦截。`package.json` 已把本集成测试接入 `npm test` 门禁。gate：`npm test` 19 个测试文件全绿 + `python3 scripts/apo_state.py` PASS（0 FAIL）。P05-T01 已完成：Host 两阶段编排接入 `src/index.ts` handler——AUTO 改用 P03-T02 `classifyViaLlm`（512/temp0/lowest reasoning，失败/解析失败一律 general 兜底，绝不阻塞编译），override 合法 `promptType` 由 `compilePrompt` 函数级直达 registry（零分类调用）；编译载荷改走 P04-T01 `compilePrompt` 10 步编排，模型输出经 `finalizeCompile` 解析后，非 legacy 再跑 P04-T02 三层守卫 `validateCompileResult`（required_sections/术语漂移/建议升级/无证据断言与量化/未知项），`done.provenance_ok` 以更严格结果为准，legacy general 保持既有语义（零回归）；resolveRoute/超时/断连 abort/回退链/CSRF/settings 未改动。新增 `test/host-pipeline.test.mjs` h1..h6（AUTO meta→delta→done 事件序 + 分类/编译调用分离、override 无 classify、分类失败 general+Low、三层守卫决定 done.provenance_ok、legacy 零回归、回退链不变）并接入 `npm test`；`test/vertical-slice.test.mjs` mock 编译产物补全 15 段必出段落以匹配新 validate 契约（仅补全 fixture，断言未放宽）。gate：`npm test` 21 个测试文件全绿 + `python3 scripts/apo_state.py` PASS（0 FAIL）。next=P05-T02（Compatibility Regression）。P05-T02 已完成：兼容性回归（双版本面 + 全量测试）——新增 `test/compat-settings.test.mjs` cs1..cs6（0.2.0 configure/volatile cell、0.1.2+ installSection+setSource、0.1.0-rc.x register+get/watch、settings 缺席回落组合层、webServer/httpServer 双名与幂等挂载）并接入 `npm test`；核心层 tsc（`src/core/**` + `src/prompt.ts` + `src/index.ts`）0 error，client 类型面待 `npm run sync:types` / P06；`BASELINE.md` 追加附录 A（版本矩阵 Node v22.23.0 / cordis 4.0.4 / dsh-llm 0.2.0-rc.2 / TS 5.9.3 + 23/23 测试矩阵 + typecheck 记录 + S-03/S-04 未触发结论）。gate：`npm test` 23 个测试文件全绿（旧三件套 + 七策略 + 分类器 + 编译/守卫 + host pipeline + vertical slice + compat settings，零回归）；`python3 scripts/apo_state.py` PASS（0 FAIL）。P05 阶段出口完成。P06-T01 已完成（4f515db）：UI AUTO 下拉补齐六策略手动覆盖——`controller.ts` 导出 `MANUAL_PROMPT_TYPES`/`TYPE_OPTIONS` 作单一真值源（AUTO 在前；`general` 按 types.ts 契约「兜底不进下拉」排除），`OptimizeButton.tsx` 下拉由 vertical-slice 临时三项（auto/research/general）补齐为 AUTO + research/planning/execution/diagnostic/review/creative，`TYPE_LABEL_KEY` 以 `Record<TypeSelection, MessageKey>` 强约束不漏翻；test/controller.test.mjs c23 增加选项集完整性/与 classify 闭集对齐/general 不在下拉断言，新增 c24 覆盖每个手动类型随请求体发出、重新优化沿用当前所选、切回 AUTO 不携带 promptType。gate：`npm test` 23 个测试文件全绿（controller c1..c24）；`python3 scripts/apo_state.py` PASS（0 FAIL）。下拉渲染手测与 G-4 预览合并到 P06 出口执行。next=P06-T02（ResultDock 四组 provenance 渲染 + 类型徽章/低置信提示/缺口清单）。
latest_commit: 4f515db
auto_continue: true
stop_reason: none
```

> ⚠️ 状态字段纪律：`stop_reason` 不得包含 Runner 的 BLOCKING_STOP_REASONS 任何标记词
> （blocking / merge conflict / schema breaking / contract breaking / architecture change /
> irreversible / transport exhausted / retry exhausted / test failure out of scope /
> scope expanded），否则会被误判停止。G-1 为 Human Gate：`status: GATE_PENDING` +
> `human_review: BLOCKING_G1`，`stop_reason` 使用 "awaiting user confirmation: G-1"
> 这一非标记词表述（详见 AGENTS.md §4 与本文件顶部说明）。

## 任务图（Task Graph, 只读快照）

| Task | 状态 | 说明 | 出口 |
|---|---|---|---|
| P00-T01 fork-and-baseline | DONE | 基线（BASELINE.md, da52f28；tag base-y1x1n-v0.4.0） | — |
| P01-T01 core-contracts | DONE | src/core/types.ts（17f4dee） | — |
| P01-T02 provenance-validator | DONE | provenance.ts 校验器（e32858f） | **G-1（当前）** |
| P01.5-T01 research-strategy | DONE | Research 策略 v0.1（15 段 + 守卫矩阵 + _shared 初版，bb4c6a4） | — |
| P01.5-T02 vertical-slice-e2e | DONE | 端到端（AUTO→…→Replace），3276e1e | **G-VS（当前）** |
| P02-T01 shared-rules | DONE | _shared 完整化：六段规则 + 5 守卫工厂 + invariant A·B（e06bf3b） | — |
| P02-T02 planning-strategy | DONE | planning 策略 v0.1：16 段 + 三铁律 + 守卫（9784dbe） | — |
| P02-T03 execution-strategy | DONE | execution 策略 v0.1：15 段 + 三铁律 + 守卫（543f737） | — |
| P02-T04 diagnostic-strategy | DONE | diagnostic 策略 v0.1：10 段 + 验证先于修改/假设证伪/修复必带复测 + 守卫（e0ec912） | — |
| P02-T05 review-strategy | DONE | review 策略 v0.1：9 段 + 基于原目标审查/不发散/偏离对应需求 + 守卫（11315af） | — |
| P02-T06 creative-strategy | DONE | creative 策略 v0.1：12 段（+Assets）+ 实体保真/无证据不改设定 + 守卫（7c9bde3） | — |
| P02-T07 general-research-integration | DONE | general 策略 v0.1：八板块 + template/intent 双模式；research v0.2.0：provenanceRules 4→7 + invariant A·B（bb37841） | — |
| P02-T08 registry-versioning | DONE | registry 七策略全注册/版本暴露/list/getSections；general 过渡期 legacy（419f999） | **G-2** |
| P03-T01 | DONE | classifier 纯函数层：七类型 + 防误判三规则 + JSON 契约容错（1aebeec） | — |
| P03-T02 | DONE | classifyViaLlm 调用侧封装：硬参数钳制/thinkFilter/超时与失败回退 + mock 单测（1e73fb2） | — |
| P03-T03 | DONE | 防误判规则测试（fixtures 五类 + g1..g10 + S-06 稳定性抽查，a810ea1） | P04 |
| P04-T01 | DONE | compiler core：compilePrompt 10 步编排 + 四段协议解析容错 + 缺口注入（8248c22） | — |
| P04-T02 | DONE | validate.ts 三层守卫（Preservation/Inference&Suggestion/Unknown）+ 策略 guards 汇总 + provenance_ok 联动契约（156b857） | — |
| P04-T03 | DONE | compiler + validator 集成测试：七类型契约矩阵 / provenance_ok 联动 / S-07 复审（16eedb4） | P05 |
| P05-T01 | DONE | host pipeline：handler 两阶段（classifyViaLlm→compilePrompt→finalize→validate）+ SSE meta/delta/done 扩展（9ffb320） | — |
| P05-T02 | DONE | 兼容回归：旧用例零回归证明（S-03，33cd988） | — |
| P06-T01 | DONE | AUTO 下拉 + 手动覆盖：TYPE_OPTIONS 单一真值源 + 逐类型请求体/重优化沿用（4f515db） | — |
| P06-T02..T03 | PENDING | dock 四组 provenance 渲染 / settings+i18n | **G-4** |
| P07-T01..T03 | PENDING | 语料（**G-3**，阈值校准 R-2）/runner/首轮 | **G-5** |
| P08-T01..T02 | PENDING | 隔离冒烟/桌面证据 | **G-6** |
| P09-T01..T02 | PENDING | 备份演练（**G-7** 安装许可）/发布 | DoD 用户终检 |

Gates：G-1 契约+Provenance 定稿 → G-VS 真实体验 → G-2 策略抽审 → G-3 语料集（阈值 DEFERRED_TO_P07_CALIBRATION）→ G-4 UI 预览 → G-5 回归报告 → G-6 隔离体验 → G-7 正式安装许可（唯一动正式 profile 的开关）→ DoD 终检 PASS。

## 无人值守运行说明（简版，详见 docs/runner-ops.md）

- Runner 每轮读取本文件：current_task 非空即续跑；为空读 next_task。
- Agent 收尾协议：完成一个 Task → 更新本文件（current_task 置空 → next_task 设为下一 Task；status/stop_reason 相应更新）→ 一个内容提交 + 一个仅状态同步的提交。
- Human Gate（G-1/G-VS/G-2…）命中时：status 置 GATE_PENDING、human_review 置 BLOCKING_<门禁名>，stop_reason 用 "awaiting user confirmation: <门禁名>"，**不要硬做**。
- 无人值守：不会有人回答提问；需要人工裁决时写 stop_reason 后结束本轮。
- 边界（NON-GOAL）：不碰正式 DSH profile / ~/.dsh 正式配置 / PAB / Personal AI Brain / AI 视频工作流；不安装 launchd；不复制任何 AGPL 代码（linshenkx / zhangjiazhi）。
- 本仓库 git remote：upstream = Y1X1n/dsh-prompt-optimizer（只读）；origin 待用户提供自有仓库 URL。
