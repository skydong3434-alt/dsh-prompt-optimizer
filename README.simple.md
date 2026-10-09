# 🐣 小白版:三分钟用上「提示词优化」

[← 返回完整中文文档](README.md) | [English](README.en.md)

> 这页是写给第一次接触 dsh 插件的朋友的,全程大白话,不讲技术细节。
> 想看完整功能说明、兼容性、测试覆盖?请回[完整版 README](README.md)。

> ⭐ 本仓库是增强版 **DSH Adaptive Prompt Optimizer**(v0.3.1-apo):装好后**不用选任务类型**,
> 直接输入、点「✨ 优化」就行 —— 它自己判断你要做什么、该写成什么形态、需要改多少。
> **普通请求一次就完成**;只有原文出现指代不明(「那个旧的」「这个」,而且上下文里也找不到
> 对象)时,它才问**一个**关键问题,你答完立刻继续。能自己查的(版本、路径、接口地址这类)
> 不会让你填,也不会为了「补齐规格」反问一串问题。优化完把结果给你检查 ——
> 它**从不替你自动发送**。致谢与出处见 [NOTICE.md](NOTICE.md)。

## 目录

- [这是个啥?](#这是个啥)
- [开始前,你要有这三样东西](#开始前你要有这三样东西)
- [三步装好](#三步装好)
- [怎么用](#怎么用)
- [常见小问题](#常见小问题)
- [卸载](#卸载)

---

## 这是个啥?

一句话:**帮你把发给 AI 的话写得更好。**

你在 DeepSeek 对话框里打了一句"帮我写周报",总觉得太笼统、AI 回答不给力?
装了这个插件,输入框旁边会多一个 ✨「优化」按钮。点一下,它自动把你的话改写成一份表达清晰、要求明确的提示词,像打字机一样一段段显示出来,满意就一键替换。

**不用先想「这算研究还是执行」** —— 你只管写,类型它自己判断。如果你的草稿已经写得很好,它会**原样保留**、一个字都不改;如果只是一点小问题,它就只补那一点,不会推倒重来。

**它长这样:**

| 输入框旁的按钮 | 点完之后的效果 |
|---|---|
| ![发送栏空闲态](docs/screenshots/composer-idle.png) | ![结果面板](docs/screenshots/optimize-panel.png) |

---

## 开始前,你要有这三样东西

1. **一台装了 Node.js 的电脑**(Node 18 或更新版本)
2. **dsh 命令行** —— 就是能在终端跑 `npx @deepseek-ai/dsh web` 的环境
3. **配好的模型** —— 在 dsh 网页版的 设置 → 模型 里,已经配好至少一个模型提供方(比如 DeepSeek 官方 API)

> 三样里缺哪样?先把 [dsh 本体](https://github.com/deepseek-ai)跑起来 —— 本插件是装在它上面的「小挂件」,本体没有它也无处安放。

---

## 三步装好

> **先看这里(本 fork)**:本 fork **没有发布到 npm,Release 里也没有 `.tgz` 资产**,所以下面「下载插件包」拿到的是**上游基线版本**(不含本 fork 的单次调用架构)。装本 fork 请直接用 GitHub 安装:
>
> ```sh
> # 桌面端(DSH Desktop,用应用自带的 CLI,profile 名是 desktop)
> dsh plugin --profile desktop add github:skydong3434-alt/dsh-prompt-optimizer
> # 网页版
> dsh plugin --profile web add github:skydong3434-alt/dsh-prompt-optimizer
> ```
>
> 装完要**完全退出并重启** DSH Desktop(桌面端)/ 重启 `dsh web`(网页版)。下面的三步是上游基线版本的装法,留作对照。

### 第 1 步:下载插件包

打开 [Releases 页面](https://github.com/skydong3434-alt/dsh-prompt-optimizer/releases/latest),下载文件名形如 `y1x1n-dsh-prompt-optimizer-<版本号>.tgz` 的插件包。(本 fork 的 Release 目前只有版本说明,没有这个文件 —— 装本 fork 请看上面的 GitHub 安装。)

### 第 2 步:安装

打开终端,进到下载文件所在的目录,运行(把 `<版本号>` 换成你下载的文件实际名字):

```sh
dsh plugin --profile web add ./y1x1n-dsh-prompt-optimizer-<版本号>.tgz
```

### 第 3 步:重启

关掉 `dsh web` 重新启动,打开网页版界面。

**装好了!** 输入框旁边是不是多了一个 ✨ 按钮?

> 也可以直接从 npm 装:`dsh plugin --profile web add @y1x1n/dsh-prompt-optimizer`(装完同样要重启)。

---

## 怎么用

就三下:

1. **打字**:在输入框里随便写一句话,比如"帮我写周报"
2. **点按钮**:点 ✨「优化」
3. **选结果**:等几秒,面板会出现两段内容 ——「分析诊断」和「优化结果」
   - 觉得好 → 点 **「替换输入框」**,你的草稿就变成优化后的版本了
   - 不满意 → 点 **「重新优化」**,再生成一版
   - 点错了?→ 点 **「撤回」**,一键回到替换前

### 几个实用小开关(可选)

在 设置 → 插件配置 → 「提示词优化」里:

- **嫌等待久?** 把「优化模式」切到 **快速**,等待时间约减半
- **想固定用某个模型优化?** 「优化用模型」里选一个,不选就跟随当前会话
- **优化出来的结果想换英文?** 「输出语言」里切

---

## 常见小问题

<details>
<summary><b>点了 ✨ 没反应?</b></summary>

多半是模型没配好。去 **设置 → 模型** 配好至少一个提供方,再试。
还不行就按 F12 打开浏览器控制台,找 `[dsh-prompt-optimizer]` 开头的红色日志,拿去[提 issue](https://github.com/skydong3434-alt/dsh-prompt-optimizer/issues)。
</details>

<details>
<summary><b>装完找不到 ✨ 按钮?</b></summary>

重启 `dsh web` 了吗?插件装完**必须重启**才生效,光刷新网页不够。
</details>

<details>
<summary><b>升级插件后要做什么?</b></summary>

重启 `dsh web`,然后刷新浏览器页面(建议 Ctrl+F5 强刷)。
</details>

<details>
<summary><b>结果跑到一半断了/被截断?</b></summary>

设置卡里把「最大输出 Token」调高一点(默认 8192,最长 32768)。
</details>

更多问题看[完整版常见问题](README.md#常见问题)。

---

## 卸载

```sh
dsh plugin --profile web remove @y1x1n/dsh-prompt-optimizer
```

然后重启 `dsh web`。

---

觉得好用?给[仓库](https://github.com/skydong3434-alt/dsh-prompt-optimizer)点个 ⭐ 就是最大的支持。有问题欢迎[提 issue](https://github.com/skydong3434-alt/dsh-prompt-optimizer/issues)。
