# v0.3.2-apo 发布说明

> **发布状态：已发布（2026-10-10）。**
> 正式 Release：<https://github.com/skydong3434-alt/dsh-prompt-optimizer/releases/tag/v0.3.2-apo>
> Tag `v0.3.2-apo` → commit `6ac2b17`（main）。
> 发布前置条件已满足：本地独立插件身份迁移完成、DSH Desktop 真实 UI 由用户人工验收通过。
> 本文中的 `#v0.3.2-apo` 安装命令**已可用**。

---

## 这一版做了什么

### 1. 独立插件身份（本版的核心）

把本 fork 从「沿用上游同名派生包」升级为**独立插件身份**：

| 位置 | 变更 |
| --- | --- |
| `package.json` `name` | `@y1x1n/dsh-prompt-optimizer` → **`@skydong3434-alt/dsh-prompt-optimizer`** |
| `package.json` `version` | 沿用的上游 `0.4.0` → **`0.3.2`**（与 fork 发行线 `v0.3.x-apo` 对齐） |
| `cordis.patch.yml` 插入行 `name` | 同步为新包名 |
| `lib/client.js` 的 client-modules loader id | 由构建脚本从 `package.json` 生成，已随新名重建 |
| `package-lock.json` | 随包名与版本再生 |

**保持不变（运行时契约，与包名无关，因此既有配置可无损迁移）**：

- Host 插件服务名 `prompt-optimizer`
- 优化路由 `/dsh-prompt-optimizer/optimize`、测试路由 `/dsh-prompt-optimizer/test-model`
- 设置命名空间 / 设置卡 id `prompt-optimizer`

也就是说：设置卡里的模型、模式、超时等配置在新包名下继续有效，不需要重新配置。

### 2. 安装与文档统一

- README（中 / 英 / 小白版）的安装章节重排为「**GitHub 源码安装（推荐，装本 fork）→ 本地源码安装 → 上游基线安装（明确标注非本 fork）**」。
- 卸载命令改为新包名；npm 徽章标注为「上游基线」。
- 不再把上游 npm 包作为本 fork 的推荐安装方式。

### 3. 类型与测试

- `npm install` 重新解析依赖后客户端类型包被剪枝，`tsc` 报 TS2307；已补齐并固定
  `@deepseek-ai/dsh-client-connection` / `dsh-client-ui-conversation` / `dsh-client-ui-renderer` /
  `dsh-client-ui-settings-plugins` / `dsh-client-ui-slots` 到与运行中 DSH Desktop 一致的 `0.2.0-rc.2`。
- `src/client/controller.ts` 增加一处显式空值守卫（`state.last && …`）：新版类型面里 `SessionId` 可为
  `null`，语义不变。
- 新增 `test/identity.test.mjs`（id1–id6），并挂入 `npm test`：
  包名 / lockfile / cordis 插入名 / 构建产物 loader id / 无旧名残留 / 运行时契约不变式。

**未改动**：V3 优化器核心（`src/core/v3.ts`）、Host 主流程（`src/index.ts`）、提示词规则。
**普通请求仍然是一次模型调用。**

## 为什么重要

- 沿用上游同名派生包时，本 fork 与上游 npm 包、以及其它 fork 在**包名层面无法区分**：安装、
  卸载、组合层引用、客户端 loader id 校验都会互相干扰。
- 独立身份之后：可以与上游基线**并存或分别卸载**，README 的安装说明也不再指向别人。
- 原作者的 MIT 许可与署名**原样保留**（见 `NOTICE.md`）。

## 怎么用

**本地源码安装（当前推荐，与桌面端一致的开发方式）**

```sh
cd dsh-adaptive-prompt-optimizer
npm install --legacy-peer-deps     # prepare 钩子会构建 lib/
dsh plugin --profile <你的 profile> add /绝对路径/dsh-adaptive-prompt-optimizer
```

**GitHub 源码安装（正式发布方式，v0.3.2-apo 已发布）**

```sh
dsh plugin --profile <你的 profile> add github:skydong3434-alt/dsh-prompt-optimizer#v0.3.2-apo
```

## 升级说明（重要）

从旧身份升级到本版时，**下列五处必须在同一个时间窗内全部一致**，只改一半会导致 DSH Desktop
**无法启动**：

1. `package.json` 的 `name`
2. `cordis.patch.yml` 插入行的 `name`
3. `lib/client.js` 的 loader id（重新 `npm run build`）
4. **profile 的依赖键**（`~/.dsh/profiles/<profile>/package.json` 的 `dependencies`）
5. **profile 的 `node_modules/<新包名>` 软链**

原因：DSH Desktop 2.0.17 的宿主在准备 profile 时会校验
`<profile>/node_modules/<依赖键>/package.json` 的 `name` 是否**严格等于**该依赖键
（`package-overlay-*.js` 的 `readCandidate`）；不一致直接抛
`profile package identity is invalid for <旧包名>` 并终止启动。该抛错发生在插件代码被加载
之前，因此与优化器代码无关。

另外两条务必注意：

- **必须完整退出并重启 DSH Desktop**：宿主只在进程启动时 import 一次插件模块，刷新页面只换
  renderer 的客户端 bundle，救不了宿主。
- 升级前请备份 `~/.dsh/profiles/<profile>/package.json`，并记录原有依赖键与软链目标。

## 验证与门禁

| 项 | 结果 |
| --- | --- |
| `npm run build` | exit 0 |
| `npm run typecheck` | 0 错误 |
| `npm test` | 全绿（含 `test/identity.test.mjs` id1–id6） |
| `node scripts/check-dod.mjs` | 打 tag 前预期 1 FAIL = tag 项（符合预期） |
| `node scripts/check-license-contamination.mjs` | PASS |
| 隔离 profile 加载验证 | 见 `CHANGELOG.md` v0.3.2-apo 段（组合层 / 宿主加载 / 路由契约 / client bundle 新 id、旧名零残留） |
| **DSH Desktop 真实 UI 人工验收** | **待用户执行**（本版发布的前置条件） |

## 已知限制

- 本版**尚未**在真实 DSH Desktop UI 上完成人工验收；`GitHub 源码安装`路径也**尚未**实测
  （代码尚未推送）。这两项完成前不发布。
- `package.json` 的 `version` 由上游 `0.4.0` 改为 `0.3.2`，在 npm 语义顺序上低于上游名义版本。
  这是**有意选择**：让包版本与 fork 发行线 `v0.3.x-apo` 对齐，避免与 GitHub Release 版本号混淆。
- 优化质量仍受模型波动影响（推理模型的时间预算、措辞差异），与本次身份迁移无关。
- 身份迁移只改「包名与安装地址」，**不改变**优化行为。

## 回退方式

若迁移后 DSH Desktop 无法启动：

1. 用迁移前的 profile 备份恢复 `~/.dsh/profiles/<profile>/package.json`（依赖键回到旧包名）。
2. 删除 `node_modules/<新包名>` 软链（或把它从 profile 的 `dependencies` 中移除）。
3. 保持该 bundle 处于禁用状态（`desktopDeselectedBundles`），即可让 Desktop 恢复可启动。
4. 项目代码不会丢失：身份迁移的变更集已保存在分支 `phase/p01.6-identity`。
