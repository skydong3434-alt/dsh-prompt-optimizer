/**
 * 语义歧义判据（v0.2.0-apo 产品定位纠偏）。
 *
 * 产品定义:Prompt Optimizer 的第一职责是**忠实理解并清晰表达用户真正想说的意思**,
 * 不是替用户补齐执行规格。因此阻塞式追问只允许出现在一种情形:
 * **语义歧义** —— 不回答就不知道用户当前这句话到底是什么意思。
 *
 * 与之相对的是**执行信息不完整**(项目路径 / API / 版本 / workflow / 测试命令 /
 * MVP 还是生产化 / 实现路线 / 具体生成内容):默认不问,保持未决即可。
 *
 * 保守机械判定(三条同时满足才算语义歧义):
 *   1. 出现指代词(这个/那个/它/这些/第 N 种/旧版本…新的…);
 *   2. 该指代在**当前输入内部找不到先行词**:
 *        - 有中心词(「这些任务」)→ 中心词必须在前面出现过;
 *        - 无中心词(「它」「这个」)→ 前面剥掉功能词后必须还有实质内容;
 *   3. **没有可用的对话上下文**(有实质用户发言即视为可确定)。
 *
 * 例(与产品验收样例一致):
 *   「我想用 dsh 控制 comfyui 生成视频。」          → 无指代 → 不歧义 ✓
 *   「帮我把这个优化一下。」(无上下文)              → 无先行词 → 歧义 ✓
 *   「把它改成第二种。」(无上下文)                  → 无先行词 → 歧义 ✓
 *   「继续做这个项目。」(有上下文/无上下文)          → 无上下文 → 歧义 ✓
 *   「我想让 Agent 自动处理这些任务。」(无上下文)    → 中心词「任务」未出现 → 歧义 ✓
 *   「删除旧版本然后安装新的。」(无上下文)           → 成对指代 → 歧义 ✓
 *   「1. 先跑一遍测试 …」「只检查这个项目的问题…」    → 有先行词/无指代 → 不歧义 ✓
 */
import type { ConversationTurn } from "./types.js";

export interface SemanticAmbiguity {
  /** 用户可读的歧义描述(用于生成那一个问题)。 */
  text: string;
  /** 歧义类型。 */
  kind: "unresolved_reference" | "unresolved_old_new";
}

/** 指代词(不含「这/那」单字,避免「这次/那样」等非指代用法误伤)。 */
const REFERENCE_RE =
  /(这个|那个|这些|那些|它们|它|该项目|此项目|上面的|上述的|前述的|前者|后者|第[一二三四五六七八九十0-9]+种|第[一二三四五六七八九十0-9]+个)/g;

/** 「旧的 / 新的」成对指代(未见具体对象)。 */
const OLD_NEW_RE = /(旧版本|老版本|旧版|现有的|原来的)[\s\S]{0,12}(新的|新版|新版本)/;

/** 功能词 / 口语填充:剥掉后若无所剩内容,说明该指代没有先行词。 */
const FILLER_RE =
  /(帮我|帮忙|请|麻烦|把|将|给|对|一下|然后|再|就|先|继续|现在|这次|直接|稍后|并且|需要|想要|我想|我要|我想让|让|做|处理|看看|优化|改成|改为|变成|新建|增加|添加|安装|删除)/g;

/** 上下文里是否有**实质用户发言**(可用于确定指代)。 */
function hasUsableContext(contextTurns: readonly ConversationTurn[]): boolean {
  return contextTurns.some(
    (turn) => turn.role === "user" && String(turn.text ?? "").trim().length >= 4,
  );
}

/** 指代中心词:紧跟在指代词后的中文实词(如「这些**任务**」→ 任务)。 */
function headNounAfter(text: string, endIndex: number): string {
  const rest = text.slice(endIndex);
  const match = rest.match(/^[\u4e00-\u9fff]{1,4}/);
  return match ? match[0] : "";
}

/** 该指代是否**没有先行词**(只认当前输入内部的先行词)。 */
function lacksAntecedent(text: string, index: number, reference: string): boolean {
  const before = text.slice(0, index).replace(FILLER_RE, " ");
  const chunks = before.match(/[\u4e00-\u9fff]{2,}|[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? [];
  const head = headNounAfter(text, index + reference.length);
  // workspace 指代(「这个项目/这段代码」)在**带有具体 workspace 操作**时属 Agent 可自查的
  // 环境事实,不算语义歧义(否则「只检查这个项目的问题」会被误阻塞);
  // 但「继续做这个项目」这类**没有具体操作对象**的说法,指代仍然悬空 → 仍算歧义。
  if (head && /^(项目|仓库|代码|目录|文件|工作区|工程|版本|依赖|配置)/.test(head)) {
    return !/(检查|审查|修改|改动|写入|运行|跑|测试|重构|优化|文件|代码|目录|依赖|配置|编译|部署|扫描|分析)/.test(text);
  }
  if (head) {
    // 中心词必须在前文出现过(或其前文已给出枚举式列表)
    return !before.includes(head) && !/[1-9１-９][.)、]|[-*•]/.test(before);
  }
  return chunks.length === 0;
}

/**
 * 检测语义歧义(保守;只返回**确实无法确定指代**的条目)。
 */
export function detectSemanticAmbiguity(
  rawInput: string,
  contextTurns: readonly ConversationTurn[] = [],
): SemanticAmbiguity[] {
  const text = String(rawInput ?? "");
  if (!text.trim()) return [];
  // 有可用上下文 → 指代可由上下文确定,不打扰用户
  if (hasUsableContext(contextTurns)) return [];

  const found: SemanticAmbiguity[] = [];
  REFERENCE_RE.lastIndex = 0;
  for (const match of text.matchAll(REFERENCE_RE)) {
    const index = match.index ?? 0;
    if (!lacksAntecedent(text, index, match[1] ?? "")) continue;
    found.push({
      text: `「${match[1]}」指代不明:无法从当前输入确定它指的是什么`,
      kind: "unresolved_reference",
    });
  }
  if (OLD_NEW_RE.test(text)) {
    found.push({
      text: "「旧版本 / 新的」指代不明:无法确定要替换的具体对象",
      kind: "unresolved_old_new",
    });
  }
  const seen = new Set<string>();
  return found.filter((item) => (seen.has(item.text) ? false : (seen.add(item.text), true)));
}

/** 该输入是否允许阻塞式追问(供日志/测试断言)。 */
export function allowsBlockingQuestion(
  rawInput: string,
  contextTurns: readonly ConversationTurn[] = [],
): boolean {
  return detectSemanticAmbiguity(rawInput, contextTurns).length > 0;
}
