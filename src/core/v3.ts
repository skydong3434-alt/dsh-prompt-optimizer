/**
 * V3 单次调用核心（自适应提示词优化器）。
 *
 * 产品定位:准确理解用户原始意图 → 判断提示词用途 → 仅在**关键歧义**时提问 →
 * 按用途优化表达 → 不得擅自扩展用户需求。
 *
 * 关键:理解意图 / 识别用途 / 判断歧义 / 生成结果 **属于同一次模型处理的职责**,
 * 不再拆成多次串行模型调用(旧流程:analysis → discovery → confirmation → compile →
 * validate → recovery)。
 *
 * 输出协议(§八):
 *   { "status": "optimized", "usage": "GENERAL|IMAGE|VIDEO|AUDIO|AGENT", "output": "..." }
 *   { "status": "needs_clarification", "question": "..." }
 * 可选叠加 STRUCTURED(严格格式要求)。
 */
import type { ConversationTurn } from "./types.js";

/** 五种主要用途 + 可叠加的结构化约束。 */
export const V3_USAGES = ["GENERAL", "IMAGE", "VIDEO", "AUDIO", "AGENT"] as const;
export type V3Usage = (typeof V3_USAGES)[number];

export interface V3Result {
  status: "optimized" | "needs_clarification";
  usage: V3Usage;
  /** STRUCTURED 叠加(严格 JSON / 固定字段等格式要求)。 */
  structured: boolean;
  output: string;
  question: string;
}

/**
 * 机械用途兜底判定(仅当模型未给出可用 usage 时使用)。
 *
 * **严格**:只有原始输入**明确表达生成用途**或**明确要求面向相应执行 Agent 写指令**才触发;
 * 出现关键词(图片/视频/代码/ComfyUI/Codex/DSH)本身**不算**。
 */
export function inferUsageMechanically(rawInput: string): V3Usage {
  const text = String(rawInput ?? "");
  // 明确要求「写某个生成模型的提示词」
  const asksForGenerationPrompt =
    /(写|生成|做|拟|出一?段|给我)[^。;；\n]{0,12}(提示词|prompt)/i.test(text) ||
    /(提示词|prompt)[^。;；\n]{0,8}(怎么写|如何写)/i.test(text);
  const imageHint = /(生图|文生图|图生图|图片|图像|照片|绘图|插画|midjourney|mj|sd|stable\s*diffusion|dall|flux|二次元|画面|视觉)/i.test(text);
  const videoHint = /(视频|可灵|kling|首帧|尾帧|图生视频|文生视频|运镜|镜头|时长)/i.test(text);
  const audioHint = /(音频|语音|配音|音乐|bgm|tts|音效|歌声)/i.test(text);
  const agentHint =
    /(写给|面向|给)[^。;；\n]{0,10}(codex|agent|智能体|编码代理)[^。;；\n]{0,10}(的)?[^。;；\n]{0,10}(任务|指令|提示词|prompt)/i.test(text) ||
    /(agent|智能体|编码代理|codex)[^。;；\n]{0,10}(任务|指令|提示词|prompt)/i.test(text) ||
    /(代码修复任务|开发任务|实现任务的指令)/.test(text);

  if (asksForGenerationPrompt && videoHint) return "VIDEO";
  if (asksForGenerationPrompt && imageHint) return "IMAGE";
  if (asksForGenerationPrompt && audioHint) return "AUDIO";
  if (agentHint) return "AGENT";
  return "GENERAL";
}

/** 是否含严格结构化要求(可与其他用途叠加)。 */
export function looksStructured(rawInput: string): boolean {
  return /(严格\s*JSON|JSON\s*格式|schema|固定字段|字段要求|严格按.*格式|输出格式[:：])/i.test(String(rawInput ?? ""));
}

const SYSTEM_ZH = `你是「自适应提示词优化器」。你的唯一职责是:准确理解用户想表达什么,判断这段提示词的实际用途,仅在**关键歧义**时提问,然后按用途把表达优化得更清楚。你不替用户做需求工程。

# 一次做完(不要分步)
在同一次回答里完成:理解意图 → 判断用途 → 判断是否存在关键歧义 → 生成优化后的提示词。

# 用途判断(严格)
usage ∈ {GENERAL, IMAGE, VIDEO, AUDIO, AGENT};GENERAL 是默认。
- 只有原始输入**明确表达对应生成用途**(如「帮我写一段可灵图生视频提示词」「写个二次元生图提示词」)才用 IMAGE/VIDEO/AUDIO。
- 只有**明确要求面向相应执行 Agent 写指令**(如「帮我写给 Codex 的代码修复任务」)才用 AGENT。
- **仅出现关键词不算**:提到图片/视频/代码/ComfyUI/Codex/DSH 不改变用途。
  例:「我想用 DSH 控制 ComfyUI 生成视频」→ **GENERAL**(用户要的是控制能力,不是让你写一条视频提示词)。
- 严格 JSON / 固定字段等格式要求 → 追加 structured=true(与用途可叠加)。

# 关键歧义(极少发生)
只有**不回答就不知道用户这句话到底是什么意思**时,才 status="needs_clarification":
- 指代不明且无法从输入/上下文确定(「帮我把这个优化一下」「把它改成第二种」);
- 关键对象缺失,导致无法确定要做什么。
**不要**问执行期信息:项目路径 / API / 版本 / workflow / 测试命令 / 技术选型 /
MVP 还是生产化 / 实现路线 / 具体生成内容(题材、时长)。这些**保持未确定**,
在正文里写明「由执行方自行确认」或「目前尚未确定,后续调研」即可。
每轮最多 1 个问题;能不问就不问。

# 优化原则
1. 忠实保留用户原意,不得擅自增加功能、技术路线或产品范围。
2. 原文已清楚 → 最小必要修改(可近乎原样保留)。
3. 原文混乱 → 可重新组织表达。
4. 不强制固定章节模板;模板只是表达指导,缺字段不算错。
5. 不得把 AI 推断写作用户的明确要求(推断只能写成建议或待确认)。
6. 允许使用上下文里已有的明确信息,但不得虚构事实。
7. 缺少可选参数不等于必须提问;Agent 能自查的不问用户。
8. 高风险 / 不可逆操作(删除、覆盖、推送、发布、付费)保留条件式安全边界。
9. 长度匹配任务复杂度:简单想法不要写成长篇规格书。

# 用途适配(按需,不机械补齐)
- IMAGE:主体 / 构图 / 场景 / 风格 / 视觉约束(需要才写)。
- VIDEO:动作 / 时间顺序 / 镜头 / 连续性 / 首尾帧(需要才写)。
- AUDIO:声音 / 情绪 / 节奏(需要才写)。
- AGENT:目标 / 上下文 / 操作要求 / 限制 / 验收(需要才写)。
- STRUCTURED:保留用户指定的格式与字段要求。

# 输出格式(严格 JSON,不要任何额外文字)
{"status":"optimized"|"needs_clarification","usage":"GENERAL|IMAGE|VIDEO|AUDIO|AGENT","structured":true|false,"output":"优化后的提示词(仅 status=optimized)","question":"要问用户的那一个问题(仅 status=needs_clarification)"}`;

const SYSTEM_EN = `You are an adaptive prompt optimizer. Your only job: understand what the user means, decide the prompt's actual usage, ask ONLY when a critical ambiguity blocks understanding, then improve the wording for that usage. You do not do requirements engineering.

# Do it in one pass
Understand intent -> decide usage -> detect critical ambiguity -> produce the optimized prompt.

# Usage (strict)
usage in {GENERAL, IMAGE, VIDEO, AUDIO, AGENT}; GENERAL is the default.
- Use IMAGE/VIDEO/AUDIO only when the input explicitly asks for that generation prompt.
- Use AGENT only when the input explicitly asks for instructions aimed at a coding/execution agent.
- Keywords alone do NOT change usage. Mentioning image/video/code/ComfyUI/Codex/DSH keeps GENERAL.
- Strict JSON / fixed fields -> structured=true (combinable).

# Critical ambiguity (rare)
Ask only when you cannot tell what the user's sentence means (unresolved reference with no context).
Never ask for execution details (paths, APIs, versions, workflows, test commands, tech choice,
MVP vs production, implementation route, specific content/length). Keep them unresolved instead.

# Principles
Preserve intent; minimal edit when already clear; reorganize when messy; no fixed section template;
never invent user requirements; suggestions must be marked as suggestions; keep safety boundaries for
irreversible actions; length should match the task's complexity.

# Output (strict JSON only)
{"status":"optimized"|"needs_clarification","usage":"GENERAL|IMAGE|VIDEO|AUDIO|AGENT","structured":true|false,"output":"...","question":"..."}`;

/** 构造单次调用的消息(可携带上下文与用户的澄清回答)。 */
export function buildV3Messages(input: {
  rawInput: string;
  contextTurns?: readonly ConversationTurn[];
  /** 上一轮的提问与用户回答(有则一并给出,避免重复提问)。 */
  clarification?: { question: string; answer: string };
  language?: "zh" | "en";
}): { role: "system" | "user"; content: string }[] {
  const system = input.language === "en" ? SYSTEM_EN : SYSTEM_ZH;
  const parts: string[] = [];
  const context = (input.contextTurns ?? []).filter((turn) => String(turn.text ?? "").trim());
  if (context.length > 0) {
    parts.push(
      "<conversation-context>\n" +
        context.map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.text}`).join("\n") +
        "\n</conversation-context>",
    );
  }
  if (input.clarification) {
    parts.push(`<clarification>\n问:${input.clarification.question}\n用户答:${input.clarification.answer}\n</clarification>`);
  }
  parts.push(`<user-input>\n${input.rawInput}\n</user-input>`);
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** 从模型输出里取出第一个平衡的 JSON 对象(容忍 ```json 围栏与前后文字)。 */
function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const source = fenced ? fenced[1]! : text;
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 解析单次调用的输出。
 * 容错:JSON 不可用时,把整段文本当作优化结果(usage 由机械兜底推断)——
 * 绝不因为格式问题把用户挡在门外。
 */
export function parseV3Output(text: string, rawInput: string): V3Result {
  const raw = String(text ?? "").trim();
  const json = extractJsonObject(raw);
  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const status = parsed.status === "needs_clarification" ? "needs_clarification" : "optimized";
      const usageRaw = String(parsed.usage ?? "").toUpperCase();
      const usage = (V3_USAGES as readonly string[]).includes(usageRaw)
        ? (usageRaw as V3Usage)
        : inferUsageMechanically(rawInput);
      const question = String(parsed.question ?? "").trim();
      const output = String(parsed.output ?? "").trim();
      if (status === "needs_clarification" && question) {
        return { status, usage, structured: parsed.structured === true, output: "", question };
      }
      if (output) {
        return {
          status: "optimized",
          usage,
          structured: parsed.structured === true || looksStructured(rawInput),
          output,
          question: "",
        };
      }
    } catch {
      /* 落到下面的纯文本兜底 */
    }
  }
  // 兜底:把模型给的内容当优化结果(去掉可能的协议围栏)
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  return {
    status: "optimized",
    usage: inferUsageMechanically(rawInput),
    structured: looksStructured(rawInput),
    output: cleaned,
    question: "",
  };
}

/**
 * V3 本地机械安全检查(**不调用模型**)。
 *
 * 只做两件确定性的事:
 *   ① 硬约束保留:用户明确写下的「不要/禁止/只检查」类约束不得在优化稿里消失;
 *   ② 不可逆动作边界:若优化稿把删除/覆盖/推送/发布写成无条件指令,标记为需注意。
 * 这两项都不阻塞交付(交由 UI 警示),避免旧流程那种「安全网拒绝交付」。
 */
export interface V3SafetyAssessment {
  hardConstraintKept: boolean;
  /** 用户原输入里的硬约束短语(用于说明)。 */
  constraints: string[];
  /** 优化稿是否出现无条件的不可逆指令。 */
  irreversibleUnconditional: boolean;
}

const HARD_CONSTRAINT_RE =
  /(不要|不得|禁止|只检查|不修改|勿|别|仅限|不可|不能|不允许|无需)[^\n。;；]{0,20}/g;
const IRREVERSIBLE_RE = /(删除|覆盖|清空|推送|发布|付费|rm\s+-rf|git\s+push)/;
const CONDITIONAL_RE = /(确认|经你同意|前提|条件|需先|除非|不要直接|未经)/;

export function assessV3Safety(input: {
  rawInput: string;
  optimizedPrompt: string;
}): V3SafetyAssessment {
  const raw = String(input.rawInput ?? '');
  const out = String(input.optimizedPrompt ?? '');
  const constraints = (raw.match(HARD_CONSTRAINT_RE) ?? []).map((s) => s.trim()).filter(Boolean);
  // 硬约束保留:约束里的关键词(去掉否定词本身)仍应出现在优化稿中
  const kept = constraints.filter((constraint) => {
    const key = constraint.replace(/^(不要|不得|禁止|只检查|不修改|勿|别|仅限|不可|不能|不允许|无需)/, '').trim();
    if (!key) return true;
    const tokens = key.match(/[\u4e00-\u9fff]{2,}|[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? [];
    if (tokens.length === 0) return true;
    const hits = tokens.filter((t) => out.includes(t)).length;
    return hits / tokens.length >= 0.5;
  });
  const irreversibleUnconditional =
    IRREVERSIBLE_RE.test(out) && !CONDITIONAL_RE.test(out);
  return {
    hardConstraintKept: constraints.length === 0 || kept.length === constraints.length,
    constraints,
    irreversibleUnconditional,
  };
}
