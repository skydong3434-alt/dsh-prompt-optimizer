# P06-T03 — Settings 扩展 + i18n 收尾

**Status**: DONE
**Phase**: P06
## Executor
Claude Code + DSH 验收

## Goal
SettingsCard 新增：默认类型（AUTO 或固定类型）+ 分类调用参数（模型/温度可见项可选）。i18n 全文案收尾（新文案缺失时回退中文）。

## Why
默认类型让"永远 AUTO"与"固定类型工作流"都可配置；settings 双版本接入保持不变。

## Preconditions
P06-T01/T02

## Inputs
PLAN-v1 §10；Y1X1n SettingsCard volatile/configForms 模式

## Allowed Scope
`src/client/SettingsCard.tsx`、settings-face、i18n；Host Config schema 增加字段（volatile）+ 默认值

## Forbidden Scope
重写设置交互（保持 0.1.x/0.2.0 双形态兼容）

## Tools
node/tsc/node:test/git

## Exact Steps
1. Config 增默认 promptType（'auto'）+ 分类 model 可选；volatile 标记
2. SettingsCard 对应字段
3. i18n 全量文案（新键 + 回退）

## Tests
设置读写回归（controller.test + smoke settings 用例）；默认值语义

## Acceptance Criteria
全绿；既有 settings 用例零回归

## Human Gate
**G-4**（UI 基础冒烟预览认可——任务完成后停止等待用户预览；通过后 P07）

## Failure Handling
失败先回修、不绕过断言；3 次 attempt 不过 → retry exhausted = STOP 报告；不确定时停下报告，不自行换大架构。

## Stop Conditions
基线 Stop Conditions S-01..S-11 按阶段适用（PLAN-v1 §15）；触发即写 CURRENT_STATE.stop_reason（非标记词）停止并报告证据等裁决。

## Git Rules
分支 phase/<阶段>；commit 前缀 `p06(t03): `；一个内容提交 + 一个仅 CURRENT_STATE 同步提交；不 force / 不 reset --hard / 不 rewrite / 不 push upstream。
## Next Transition
G-4 → P07-T01（语料固化）

## Manual Test Checklist（G-4 阶段出口执行，dev profile）
> 无头自动化已覆盖数据面（compat-settings cs7..cs10 + settings-i18n s1..s3）；
> 下列为需要真实渲染/预览的手测项，与 P06-T01/T02 的清单一起在 G-4 的 UI 预览中执行
> （不装正式 profile）。

1. 设置页「提示词优化」标签新增「任务类型识别」分组：默认任务类型下拉（AUTO + 六策略）+ 分类用模型（跟随主路由/固定模型，带刷新）。
2. 默认任务类型保持 AUTO：优化一次仍走自动识别（meta 的 prompt_type 来自分类器）。
3. 默认任务类型设为 Planning：发送栏下拉保持 AUTO 时不再出现分类等待，结果类型固定 Planning；发送栏手动选 Research 可覆盖该默认。
4. 分类用模型设为一个小模型：只有类型识别走该模型，编译仍用主路由（各自 provider/model 不同）。
5. 撤销上一次修改：可把默认类型/分类模型与其余设置一起整批还原。
6. 中英界面语言切换：新文案全部有译（缺译回退中文不报错）。