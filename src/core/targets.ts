/**
 * Prompt Target / Target Engine 目录(表驱动,可扩展)。
 *
 * 设计约束(v2 §C3):
 *   - **禁止巨型 if/else**:目标与引擎全部以数据表描述,新增引擎只加一行;
 *   - 目录是**单一真源**:模态、信息责任、别名匹配全部从表读出;
 *   - 纯数据 + 纯函数,零 LLM / 零 Harness / 零 UI 依赖,可独立测试。
 *
 * 语义边界(与 v2 §C1/C5 对齐):
 *   - `PromptTarget` 回答「这份提示词最终给谁、产出什么」;
 *   - `PromptModality` 回答「产物是什么形态」,决定编译契约形态 ——
 *     image / video **不得**被编译成 Goal/Phase/Task/Tests(Phase 2 落地,
 *     本模块先如实标注,不做编译行为变更)。
 */
import type {
  PromptModality,
  PromptTarget,
  ResolvedEngine,
  TargetResolution,
} from "./types.js";
import { PROMPT_TARGETS } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 目标目录
// ─────────────────────────────────────────────────────────────────────────────

export interface TargetSpec {
  id: PromptTarget;
  nameZh: string;
  nameEn: string;
  /** 该目标的原生产物模态。 */
  modality: PromptModality;
  /**
   * 信息责任(Phase 2 的 Target-aware 编译据此组织产出)。
   * 注意:这是「必须交代清楚什么」,不是「必须出现的标题」——v2 §C5。
   */
  responsibilities: readonly string[];
  /** 目标线索词(用户输入里出现即加分;大小写不敏感,中英混排)。 */
  cues: readonly string[];
}

export const TARGET_CATALOG: readonly TargetSpec[] = [
  {
    id: "agent_task",
    nameZh: "Agent 任务",
    nameEn: "Agent task",
    modality: "text",
    responsibilities: [
      "目标与完成定义",
      "边界(允许 / 禁止的动作)",
      "可用的工具与权限范围",
      "验收方式",
    ],
    cues: ["agent", "智能体", "助手", "harness", "dsh", "claude code", "codex", "自动化执行", "帮我做", "去执行", "workflow", "工作流"],
  },
  {
    id: "research",
    nameZh: "调研检索",
    nameEn: "Research",
    modality: "text",
    responsibilities: [
      "研究问题与范围",
      "信息源与时效要求",
      "对比维度",
      "结论形态(结论 / 表格 / 推荐)",
    ],
    cues: ["研究", "调研", "查一下", "检索", "搜索", "对比", "哪个更好", "选型", "research", "survey", "benchmark", "资料"],
  },
  {
    id: "coding",
    nameZh: "编码实现",
    nameEn: "Coding",
    modality: "code",
    responsibilities: [
      "目标行为与接口",
      "技术栈与既有约定",
      "边界条件与错误处理",
      "验证方式(测试 / 复现步骤)",
    ],
    cues: ["代码", "函数", "接口", "api", "报错", "bug", "重构", "实现", "脚本", "sql", "code", "refactor", "debug", "类型", "单测"],
  },
  {
    id: "image_generation",
    nameZh: "图像生成",
    nameEn: "Image generation",
    modality: "image",
    responsibilities: [
      "主体描述(外观 / 动作 / 姿态 / 材质)",
      "场景与环境",
      "风格 / 媒介 / 参考",
      "构图与镜头",
      "光线与色调",
      "画幅比例与画质约束",
      "排除项(negative)",
    ],
    cues: ["画", "插画", "海报", "配图", "出图", "图像", "图片", "封面", "立绘", "生图", "image", "poster", "illustration", "logo", "壁纸"],
  },
  {
    id: "video_generation",
    nameZh: "视频生成",
    nameEn: "Video generation",
    modality: "video",
    responsibilities: [
      "镜头与运镜",
      "主体动作与时间演进",
      "场景与氛围",
      "风格与画质",
      "时长 / 画幅 / 帧率约束",
      "排除项(negative)",
    ],
    cues: ["视频", "短片", "动画", "运镜", "镜头", "分镜", "转场", "mv", "video", "shot", "motion", "sora", "延时"],
  },
  {
    id: "writing",
    nameZh: "文本写作",
    nameEn: "Writing",
    modality: "text",
    responsibilities: [
      "读者与用途",
      "体裁与语气",
      "必须包含 / 必须避免的内容",
      "长度与结构",
    ],
    cues: ["写", "文案", "文章", "稿", "润色", "改写", "翻译", "邮件", "报告", "标题", "摘要", "writing", "copy", "rewrite"],
  },
  {
    id: "data_analysis",
    nameZh: "数据分析",
    nameEn: "Data analysis",
    modality: "structured_data",
    responsibilities: [
      "数据口径与字段定义",
      "分析问题与假设",
      "计算 / 统计方法",
      "产出形态与结论表达",
    ],
    cues: ["数据分析", "统计", "指标", "报表", "可视化", "excel", "csv", "pandas", "sql 分析", "data analysis", "metric", "dashboard", "归因"],
  },
  {
    id: "general",
    nameZh: "通用",
    nameEn: "General",
    modality: "text",
    responsibilities: ["目标", "约束", "期望产出"],
    cues: [],
  },
] as const;

const TARGET_BY_ID = new Map<PromptTarget, TargetSpec>(TARGET_CATALOG.map((spec) => [spec.id, spec]));

/** 取目标规格;未知目标回落 general(不抛错)。 */
export function getTargetSpec(target: PromptTarget | string): TargetSpec {
  return TARGET_BY_ID.get(target as PromptTarget) ?? TARGET_BY_ID.get("general")!;
}

/** 目标 → 原生模态。 */
export function modalityOf(target: PromptTarget | string): PromptModality {
  return getTargetSpec(target).modality;
}

/** 目标线索词匹配得分(命中越多越像该目标;纯数据驱动)。 */
export function targetCueScore(target: PromptTarget | string, haystack: string): number {
  const lowered = haystack.toLowerCase();
  let score = 0;
  for (const cue of getTargetSpec(target).cues) {
    if (lowered.includes(cue.toLowerCase())) score += cue.length >= 3 ? 2 : 1;
  }
  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// 引擎目录(模型 / 工具)
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineSpec {
  id: string;
  name: string;
  /** 归属目标(一个引擎只归属一个主目标,保持路由简单可审计)。 */
  target: PromptTarget;
  modality: PromptModality;
  /** 别名(小写匹配;中英混排;越长的别名优先匹配,避免 "sd" 命中 "sdxl" 之外的词)。 */
  aliases: readonly string[];
}

/**
 * 引擎目录。新增一个引擎 = 加一行;不需要改任何判断逻辑。
 * 覆盖 v2 §C3 点名的引擎,并补充常见同族模型以便识别。
 */
export const ENGINE_CATALOG: readonly EngineSpec[] = [
  // ── Agent / 编码 ──────────────────────────────────────────────────────────
  { id: "dsh", name: "DSH (DeepSeek Harness)", target: "agent_task", modality: "text", aliases: ["dsh", "deepseek harness", "deepseek-harness", "深度求索 harness"] },
  { id: "claude-code", name: "Claude Code", target: "coding", modality: "code", aliases: ["claude code", "claude-code", "claudecode"] },
  { id: "codex", name: "Codex", target: "coding", modality: "code", aliases: ["codex", "openai codex"] },
  { id: "cursor", name: "Cursor", target: "coding", modality: "code", aliases: ["cursor"] },
  { id: "copilot", name: "GitHub Copilot", target: "coding", modality: "code", aliases: ["copilot", "github copilot"] },
  { id: "gemini-cli", name: "Gemini CLI", target: "coding", modality: "code", aliases: ["gemini cli", "gemini-cli"] },
  // ── 图像 ──────────────────────────────────────────────────────────────────
  { id: "gpt-image", name: "GPT Image", target: "image_generation", modality: "image", aliases: ["gpt image", "gpt-image", "dall-e", "dall·e", "dalle"] },
  { id: "midjourney", name: "Midjourney", target: "image_generation", modality: "image", aliases: ["midjourney", "mid journey", "mj "] },
  { id: "flux", name: "Flux", target: "image_generation", modality: "image", aliases: ["flux"] },
  { id: "stable-diffusion", name: "Stable Diffusion", target: "image_generation", modality: "image", aliases: ["stable diffusion", "sdxl", "sd3", "sd1.5", "sd"] },
  { id: "jimeng", name: "即梦", target: "image_generation", modality: "image", aliases: ["即梦", "jimeng", "dreamina"] },
  { id: "nano-banana", name: "Nano Banana (Gemini Image)", target: "image_generation", modality: "image", aliases: ["nano banana", "nanobanana"] },
  { id: "qwen-image", name: "Qwen-Image / 通义万相", target: "image_generation", modality: "image", aliases: ["qwen image", "qwen-image", "通义万相", "万相"] },
  // ── 视频 ──────────────────────────────────────────────────────────────────
  { id: "kling", name: "Kling / 可灵", target: "video_generation", modality: "video", aliases: ["kling", "可灵"] },
  { id: "veo", name: "Veo", target: "video_generation", modality: "video", aliases: ["veo", "google veo"] },
  { id: "seedance", name: "Seedance", target: "video_generation", modality: "video", aliases: ["seedance", "即梦视频"] },
  { id: "runway", name: "Runway", target: "video_generation", modality: "video", aliases: ["runway", "gen-3", "gen3"] },
  { id: "sora", name: "Sora", target: "video_generation", modality: "video", aliases: ["sora"] },
  { id: "pika", name: "Pika", target: "video_generation", modality: "video", aliases: ["pika"] },
  { id: "luma", name: "Luma Dream Machine", target: "video_generation", modality: "video", aliases: ["luma", "dream machine"] },
  { id: "hailuo", name: "海螺 / Hailuo", target: "video_generation", modality: "video", aliases: ["海螺", "hailuo", "minimax hailuo"] },
  { id: "vidu", name: "Vidu", target: "video_generation", modality: "video", aliases: ["vidu"] },
] as const;

const ENGINE_BY_ID = new Map<string, EngineSpec>(ENGINE_CATALOG.map((spec) => [spec.id, spec]));

/** 按 id 取引擎;未知 id 返回 undefined(不抛错)。 */
export function getEngine(id: string): EngineSpec | undefined {
  return ENGINE_BY_ID.get(id);
}

/** 某目标下的全部引擎(表驱动过滤;未知目标返回空数组)。 */
export function enginesForTarget(target: PromptTarget | string): EngineSpec[] {
  return ENGINE_CATALOG.filter((spec) => spec.target === target);
}

/** 全部别名按长度降序(长别名优先,避免短别名吃掉长别名)。 */
const ALIAS_INDEX: readonly { alias: string; spec: EngineSpec }[] = [...ENGINE_CATALOG]
  .flatMap((spec) => spec.aliases.map((alias) => ({ alias: alias.toLowerCase(), spec })))
  .sort((a, b) => b.alias.length - a.alias.length);

/**
 * 极短 ASCII 别名的边界正则缓存。
 *
 * 「sd」这类 2 字母别名如果裸 substring 匹配,会把「SDK」「SDK 开发」误判成
 * Stable Diffusion。ASCII 短别名一律要求词边界;CJK 别名(如「可灵」「即梦」)
 * 没有词边界概念,仍用 substring。
 */
const SHORT_ASCII_BOUNDARY = new Map<string, RegExp>();
function boundaryReFor(alias: string): RegExp {
  let re = SHORT_ASCII_BOUNDARY.get(alias);
  if (!re) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i");
    SHORT_ASCII_BOUNDARY.set(alias, re);
  }
  return re;
}

/** 别名是否需要词边界(≤3 字符且全 ASCII)。 */
function needsBoundary(alias: string): boolean {
  return alias.length <= 3 && /^[a-z0-9.]+$/i.test(alias);
}

/**
 * 在文本里找引擎(最长别名优先;大小写不敏感)。
 * 返回命中的引擎别名位置信息,便于调用方决定是否采信。
 */
export function findEngine(haystack: string): EngineSpec | undefined {
  if (!haystack) return undefined;
  const lowered = haystack.toLowerCase();
  for (const entry of ALIAS_INDEX) {
    if (needsBoundary(entry.alias)) {
      if (boundaryReFor(entry.alias).test(lowered)) return entry.spec;
      continue;
    }
    if (lowered.includes(entry.alias)) return entry.spec;
  }
  return undefined;
}

/** 归一化一个显式引擎提示(LLM 给出的 id / 名称,或用户原话片段)。 */
export function resolveEngine(hint: string | null | undefined): ResolvedEngine | null {
  const raw = typeof hint === "string" ? hint.trim() : "";
  if (!raw) return null;
  const direct = ENGINE_BY_ID.get(raw.toLowerCase());
  if (direct) return toResolved(direct);
  const found = findEngine(raw);
  if (found) return toResolved(found);
  return { id: null, name: raw, target: null, modality: null };
}

function toResolved(spec: EngineSpec): ResolvedEngine {
  return { id: spec.id, name: spec.name, target: spec.target, modality: spec.modality };
}

// ─────────────────────────────────────────────────────────────────────────────
// 目标解析(确定性兜底路径:LLM 不可用 / 未给出时使用)
// ─────────────────────────────────────────────────────────────────────────────

/** 模态 → 目标(引擎反过来决定目标时的映射)。 */
export function targetForModality(modality: PromptModality): PromptTarget {
  switch (modality) {
    case "image":
      return "image_generation";
    case "video":
      return "video_generation";
    case "code":
      return "coding";
    case "structured_data":
      return "data_analysis";
    default:
      return "general";
  }
}

/**
 * 确定性目标解析:先看用户提到的引擎(最可靠的信号),再看目标线索词,最后落 general。
 * LLM 给出的 target 优先于本函数(见 analyze.ts),本函数只作为兜底与一致性校验。
 */
export function resolveTargetDeterministic(input: {
  raw_input: string;
  /** 可选:历史用户消息(仅用户发言可作为线索)。 */
  context_texts?: readonly string[];
}): TargetResolution {
  const haystack = [input.raw_input, ...(input.context_texts ?? [])].join("\n");
  // 1) 引擎线索最强:用户点名了引擎,目标由引擎决定。
  const engine = findEngine(input.raw_input) ?? findEngine(haystack);
  const cues = PROMPT_TARGETS.filter((target) => target !== "general")
    .map((target) => ({ target, score: targetCueScore(target, haystack) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (engine) {
    const evidence = evidenceFor(input.raw_input, engine.aliases);
    return {
      target: engine.target,
      modality: engine.modality,
      engine: toResolved(engine),
      confidence: evidence.length > 0 ? "high" : "medium",
      evidence,
      rationale: `输入提到 ${engine.name},目标按引擎归为「${getTargetSpec(engine.target).nameZh}」`,
    };
  }
  if (cues.length > 0) {
    const best = cues[0]!;
    const spec = getTargetSpec(best.target);
    return {
      target: best.target,
      modality: spec.modality,
      engine: null,
      confidence: cues.length > 1 && cues[1]!.score === best.score ? "low" : "medium",
      evidence: evidenceFor(haystack, spec.cues),
      rationale: `输入线索指向「${spec.nameZh}」`,
    };
  }
  return {
    target: "general",
    modality: "text",
    engine: null,
    confidence: "low",
    evidence: [],
    rationale: "未发现明确的目标或引擎线索,按通用目标处理",
  };
}

/** 从文本里挑出命中给定线索词的逐字片段(用于 UI 证据展示)。 */
function evidenceFor(text: string, cues: readonly string[]): string[] {
  const lowered = text.toLowerCase();
  const hits: string[] = [];
  for (const cue of cues) {
    const at = lowered.indexOf(cue.toLowerCase());
    if (at < 0) continue;
    const start = Math.max(0, at - 8);
    const end = Math.min(text.length, at + cue.length + 8);
    const snippet = text.slice(start, end).trim();
    if (snippet && !hits.includes(snippet)) hits.push(snippet);
    if (hits.length >= 3) break;
  }
  return hits;
}

/** 目标是否为「视觉模态」(Phase 2 的编译契约切换依据)。 */
export function isVisualTarget(target: PromptTarget | string): boolean {
  const modality = modalityOf(target);
  return modality === "image" || modality === "video";
}
