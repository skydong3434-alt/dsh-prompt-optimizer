# BASELINE — dsh-adaptive-prompt-optimizer

日期：2026-10-03
阶段：P00-T01（Fork & Baseline）✅ 通过

## 环境
- 本地目录：`~/Projects/dsh-adaptive-prompt-optimizer/`
- Node：v22.23.0 / npm 10.9.8（引擎要求 node>=18 ✅）
- 目标宿主：DSH Desktop 2.0.15（dsh 0.1.7-rc.2 / cordis 4.0.4）
- 底座：`@y1x1n/dsh-prompt-optimizer` 0.4.0（MIT），commit daf6fbd（2026-10-03）

## Git
- remote：`upstream` = https://github.com/Y1X1n/dsh-prompt-optimizer.git（只读）
- origin：**待用户提供自有仓库 URL**（gh CLI 不可用，未自动创建；P09 发布前需补齐）
- 基线标签：`base-y1x1n-v0.4.0`

## 验证结果（npm install / build / test）
- `npm install`：+22 packages，无错误
- `npm run build`：lib/index.js + client.js + prompt.js + controller.js 全部产出
- `npm test` 三件套：**smoke: all passed / prompt: all passed / controller: all passed（exit=0）**
  - smoke：真 Context + mock llm 驱动 HTTP handler，成功/错误/边界路径（含 AUTH 失败、mid-stream boom、工具调用拒绝等负路径）
  - prompt：标记协议解析、思考块剥离、上下文预算、输出解析
  - controller：状态机、取消、看门狗、记忆链、发送即关闭、快速模式预览

## 结构核对（对照 REPORT §2.1，无差异）
```
src/index.ts            → Host 入口（HTTP 路由/SSE/模型路由/回退链/CSRF/settings 双版本）
src/prompt.ts           → 纯函数层（双策略/标记协议/上下文预算/thinkFilter）
src/client/             → index.tsx + controller.ts + host-faces.ts + settings-face.ts + i18n.ts
                          + OptimizeButton/ResultDock/SettingsCard/GitHubIcon/SparkleIcon.tsx
test/                   → smoke.mjs + prompt.test.mjs + controller.test.mjs
scripts/build.mjs       → esbuild 四产物
cordis.patch.yml        → insert id: prompt-optimizer
```

## 与 REPORT 一致性结论
- 关键事实无漂移：双版本兼容（webServer/httpServer、configForms/settingsScope、双设置槽位）均如 REPORT 所述；
- 无差异需修正规划；S-01/S-02/S-04 均未触发。

## P00 出口确认
- [x] build + test 全绿
- [x] 结构与 REPORT 一致
- [x] 独立目录 + 独立 remote（origin 待补）
- [x] 未触碰任何正式 DSH profile / ~/.dsh / PAB

## 下一阶段
P01 Core Contracts & Provenance（G-1 出口）