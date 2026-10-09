# v0.3.1-apo — 设置卡槽位注册修复 + 安装与溯源说明

> 发布标识：`v0.3.1-apo`（2026-10-10，本 fork 的第二版可发布版本）。上一版
> `v0.3.0-apo`（V3 单次调用架构首发）；`v0.1.0-apo` 为首个可发布版本；
> `v0.2.0-apo`（v2「自适应提示词编辑器」）**从未打 tag、从未发布**。
> `package.json` 的名义版本沿用上游 `0.4.0`（派生包名不变，见 NOTICE §3）。

---

## 这一版做了什么

在 v0.3.0-apo 基础上的**最小范围发布**，只解决一件事 + 对齐发布信息，不改任何产品逻辑：

- **修复「设置 → 插件列表」在 DSH 2.0.x 下的同步失败**。旧写法把 `settings.plugins.tab`
  （0.2.0）与 `settings.plugin.item`（0.1.x）两个候选槽位**并挂注册**在同一个 inject
  回调里。DSH 2.0.x 对**未声明槽位的注册直接抛错**（不再静默忽略），于是打开「插件」
  设置页时本插件客户端同步失败（界面提示「本页面的插件未能完成同步」）。
  修法是把两个候选槽位改成**各自独立的 inject 回调内注册**：槽位的 inject 回调只在
  宿主声明了该槽位时触发，回调被触发本身就是「该槽位已被声明」的证明；
  任一代宿主上恰好挂载一次，绝不注册未声明的槽位。
- **安装与溯源信息对齐到本 fork 的发布仓库**（`skydong3434-alt/dsh-prompt-optimizer`）：
  README（中 / 英 / 小白版）的徽章、Releases / Stars / issue 链接与「从 GitHub 安装」
  命令全部指向本 fork；**明确标注本 fork 未发布到 npm、Release 不附带 tarball 资产**，
  因此「从 npm 安装」「从 Release 安装」装到的是**上游基线**，装本 fork 必须用
  `dsh plugin --profile <profile> add github:skydong3434-alt/dsh-prompt-optimizer`。
- **NOTICE 溯源表更新**：标注 V3 精简重构后「落地位置」列——哪些模块已删除、
  这些思想仍保留在现役实现何处；并明确 upstream（`Y1X1n`，只读署名来源）与
  origin（`skydong3434-alt`，发布目标）的区分。上游版权与 MIT 署名保留不变。

## 怎么修（技术要点）

`src/client/index.tsx` 的 `apply()` 不再使用「先建一张卡、并挂两次注册」的
`mountSettingsCard` 帮助函数，改为对两个候选槽位分别：

```ts
slotsAny.inject('settings.plugins.tab', () =>
  slotsAny.register({ name: 'settings.plugins.tab', id: SETTINGS_ENTRY_ID, order: 30, label: () => translate('panel.title'), inject: () => ({}) }, createSettingsCard(ctx, settings.face)))
slotsAny.inject('settings.plugin.item', () =>
  slotsAny.register({ name: 'settings.plugin.item', key: SETTINGS_ENTRY_ID }, createSettingsCard(ctx, settings.face)))
```

附带两处 `src/index.ts` 的类型层面小修：恢复 `DiscoveryInput` 最小结构声明
（V3 仍读取客户端回传的 `answers` / `asked`，类型本身随旧链路 `v3:false` 回退分支
一并删除），以及 `PROMPT_TYPES` 的 includes 调用改为 `(PROMPT_TYPES as readonly string[])`。

## 怎么用 / 怎么装

1. 在 DSH Desktop 的输入区写下请求，点「✨ 优化」——行为与 v0.3.0-apo 完全一致
   （普通请求一次模型调用完成；真正的语义歧义才问一个关键问题）。
2. **本 fork 的安装**（重点）：

   ```sh
   # 桌面端（DSH Desktop，用应用自带的 CLI，profile 名是 desktop）
   dsh plugin --profile desktop add github:skydong3434-alt/dsh-prompt-optimizer
   # 网页版
   dsh plugin --profile web add github:skydong3434-alt/dsh-prompt-optimizer
   ```

   装完**完全退出并重启** DSH Desktop（网页版则重启 `dsh web`）。
   ⚠️ 不要用「从 npm 安装」或「从 Release 下载 tarball」——那装到的是上游基线。

## 验证与门禁

| 门禁 | 结果 |
| --- | --- |
| `npm test`（确定性测试） | **107 组全绿** |
| `npm run build` | **exit 0** |
| `npm run typecheck` | **exit 0** |
| DSH Desktop **真实 UI 人工验收** | **PASS**（用户本人执行：刷新页面后设置页不再出现 Slot 同步错误，Prompt Optimizer 设置卡片显示正常，优化功能正常） |

- 槽位同步失败的根因与修复记录：[`ui-acceptance-m03813.md`](ui-acceptance-m03813.md)（35 项台账）+ [`p08-desktop.md`](p08-desktop.md) §7 后续更正
- 完整变更记录：[`../CHANGELOG.md`](../CHANGELOG.md)

## 已知限制

- 与 v0.3.0-apo 相同：模型波动仍然存在（规则与机械核对挡住方向性错误，但不宣称「永不误判」）；
  推理型模型的思考剥离与长输入耗时、澄清措辞由模型生成、复杂研究/评估类请求输出较长。
- 本 fork 的 GitHub Release **不附带 tarball 资产**（发布说明只以文本形式发布），
  这是「从 Release 安装会拿到上游」的原因，属有意为之：fork 安装一律走 GitHub 源码安装。

## 升级说明

- 从 `v0.3.0-apo` 升级：直接按上面「本 fork 的安装」更新即可，无破坏性变更。
- 从 `v0.1.0-apo` / 上游任意版本升级：行为差异同 v0.3.0-apo 所述（无需选任务类型、
  普通请求单次调用等）。
- 运行版本一致性提醒：DSH Desktop 的宿主模块**只在进程启动时加载一次**。
  更新代码并重新构建之后，必须**完整重启 DSH Desktop** 才会生效；刷新页面只更换客户端 bundle。